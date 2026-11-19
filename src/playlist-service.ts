import { db } from './db.js';
import type { Track } from './audio-source.js';

export interface PlaylistSummary {
  id: string;
  name: string;
  trackCount: number;
  createdAt: Date;
}

export interface PlaylistTrack extends Track {
  id: string;
}

export interface PlaylistQuota {
  count: number;
  limit: number;
  specialMember: boolean;
}

interface InMemPlaylist {
  id: string;
  guildId: string;
  ownerId: string;
  name: string;
  createdAt: Date;
  tracks: PlaylistTrack[];
}

const inMemoryPlaylists = new Map<string, InMemPlaylist>();
let memPlaylistSeq = 1;
let memTrackSeq = 1;

async function findPlaylist(guildId: string, ownerId: string, name: string) {
  try {
    const result = await db.query(
      `SELECT id, name FROM playlists WHERE guild_id = $1 AND owner_id = $2 AND LOWER(name) = LOWER($3) LIMIT 1`,
      [guildId, ownerId, name]
    );
    return result.rows[0] as { id: string; name: string } | undefined;
  } catch {
    for (const p of inMemoryPlaylists.values()) {
      if (p.guildId === guildId && p.ownerId === ownerId && p.name.toLowerCase() === name.toLowerCase()) {
        return { id: p.id, name: p.name };
      }
    }
    return undefined;
  }
}

export async function createPlaylist(guildId: string, ownerId: string, name: string): Promise<number> {
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > 50) throw new Error('Playlist names must be between 1 and 50 characters.');

  try {
    const connection = await db.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${guildId}:${ownerId}:playlist-limit`]);
      const duplicate = await connection.query(
        'SELECT 1 FROM playlists WHERE guild_id = $1 AND owner_id = $2 AND LOWER(name) = LOWER($3) LIMIT 1',
        [guildId, ownerId, cleanName]
      );
      if (duplicate.rowCount) throw new Error('You already have a playlist with that name.');
      const count = await connection.query('SELECT COUNT(*)::int AS count FROM playlists WHERE guild_id = $1 AND owner_id = $2', [guildId, ownerId]);
      const limitResult = await connection.query(
        'SELECT max_playlists FROM playlist_limits WHERE guild_id = $1 AND user_id = $2',
        [guildId, ownerId]
      );
      const limit = Number(limitResult.rows[0]?.max_playlists ?? 2);
      if (Number(count.rows[0]?.count ?? 0) >= limit) throw new Error(`You have reached your ${limit}-playlist limit in this server.`);
      await connection.query('INSERT INTO playlists (guild_id, owner_id, name) VALUES ($1, $2, $3)', [guildId, ownerId, cleanName]);
      await connection.query('COMMIT');
      return limit;
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      if (error instanceof Error && 'code' in error && (error as { code?: string }).code === '23505') {
        throw new Error('You already have a playlist with that name.');
      }
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    if (error instanceof Error && (error.message.includes('already have a playlist') || error.message.includes('reached your'))) {
      throw error;
    }
    // Fallback to in-memory store
    for (const p of inMemoryPlaylists.values()) {
      if (p.guildId === guildId && p.ownerId === ownerId && p.name.toLowerCase() === cleanName.toLowerCase()) {
        throw new Error('You already have a playlist with that name.');
      }
    }
    const count = [...inMemoryPlaylists.values()].filter(p => p.guildId === guildId && p.ownerId === ownerId).length;
    if (count >= 3) throw new Error('You have reached your 3-playlist limit in this server.');
    const id = String(memPlaylistSeq++);
    inMemoryPlaylists.set(id, {
      id,
      guildId,
      ownerId,
      name: cleanName,
      createdAt: new Date(),
      tracks: []
    });
    return 3;
  }
}

export async function listPlaylists(guildId: string, ownerId: string): Promise<PlaylistSummary[]> {
  try {
    const result = await db.query(
      `SELECT p.id::text, p.name, p.created_at AS "createdAt", COUNT(t.id)::int AS "trackCount"
       FROM playlists p LEFT JOIN playlist_tracks t ON t.playlist_id = p.id
       WHERE p.guild_id = $1 AND p.owner_id = $2
       GROUP BY p.id ORDER BY p.created_at ASC`,
      [guildId, ownerId]
    );
    return result.rows as PlaylistSummary[];
  } catch {
    return [...inMemoryPlaylists.values()]
      .filter(p => p.guildId === guildId && p.ownerId === ownerId)
      .map(p => ({
        id: p.id,
        name: p.name,
        trackCount: p.tracks.length,
        createdAt: p.createdAt
      }));
  }
}

export async function getPlaylistQuota(guildId: string, ownerId: string): Promise<PlaylistQuota> {
  try {
    const result = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM playlists WHERE guild_id = $1 AND owner_id = $2) AS count,
         COALESCE((SELECT max_playlists FROM playlist_limits WHERE guild_id = $1 AND user_id = $2), 2)::int AS playlist_limit`,
      [guildId, ownerId]
    );
    const row = result.rows[0] as { count: number; playlist_limit: number } | undefined;
    const count = Number(row?.count ?? 0);
    const limit = Number(row?.playlist_limit ?? 2);
    return { count, limit, specialMember: limit === 3 };
  } catch {
    const count = [...inMemoryPlaylists.values()].filter(p => p.guildId === guildId && p.ownerId === ownerId).length;
    return { count, limit: 3, specialMember: true };
  }
}

export async function grantPlaylistEntitlement(guildId: string, userId: string, grantedBy: string): Promise<void> {
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${guildId}:${userId}:playlist-limit`]);
    await connection.query(
      `INSERT INTO playlist_limits (guild_id, user_id, max_playlists, granted_by)
       VALUES ($1, $2, 3, $3)
       ON CONFLICT (guild_id, user_id) DO UPDATE
         SET max_playlists = 3, granted_by = EXCLUDED.granted_by, created_at = NOW()`,
      [guildId, userId, grantedBy]
    );
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

export async function revokePlaylistEntitlement(guildId: string, userId: string): Promise<boolean> {
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${guildId}:${userId}:playlist-limit`]);
    const result = await connection.query(
      'DELETE FROM playlist_limits WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId]
    );
    await connection.query('COMMIT');
    return Boolean(result.rowCount);
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

export async function addPlaylistTrack(
  guildId: string, ownerId: string, playlistName: string, track: Track
): Promise<void> {
  const playlist = await findPlaylist(guildId, ownerId, playlistName);
  if (!playlist) throw new Error('I could not find that playlist. Use `/playlist list` to see your playlists.');

  try {
    const count = await db.query('SELECT COUNT(*)::int AS count FROM playlist_tracks WHERE playlist_id = $1', [playlist.id]);
    if (Number(count.rows[0]?.count ?? 0) >= 500) throw new Error('A playlist can contain at most 500 tracks.');
    await db.query(
      'INSERT INTO playlist_tracks (playlist_id, title, source_url, added_by) VALUES ($1, $2, $3, $4)',
      [playlist.id, track.title, track.url, ownerId]
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('at most 500')) throw error;
    const mem = inMemoryPlaylists.get(playlist.id);
    if (mem) {
      if (mem.tracks.length >= 500) throw new Error('A playlist can contain at most 500 tracks.');
      mem.tracks.push({
        id: String(memTrackSeq++),
        title: track.title,
        url: track.url,
        requestedBy: ownerId
      });
    }
  }
}

export async function getPlaylistTracks(guildId: string, ownerId: string, playlistName: string): Promise<PlaylistTrack[]> {
  const playlist = await findPlaylist(guildId, ownerId, playlistName);
  if (!playlist) throw new Error('I could not find that playlist.');
  try {
    const result = await db.query(
      `SELECT id::text, title, source_url AS url, added_by AS "requestedBy"
       FROM playlist_tracks WHERE playlist_id = $1 ORDER BY id ASC`,
      [playlist.id]
    );
    return result.rows as PlaylistTrack[];
  } catch {
    const mem = inMemoryPlaylists.get(playlist.id);
    return mem ? [...mem.tracks] : [];
  }
}

export async function removePlaylistTrack(guildId: string, ownerId: string, playlistName: string, position: number): Promise<string> {
  if (!Number.isInteger(position) || position < 1) throw new Error('Track position must be 1 or higher.');
  const playlist = await findPlaylist(guildId, ownerId, playlistName);
  if (!playlist) throw new Error('I could not find that playlist.');
  try {
    const selected = await db.query(
      'SELECT id, title FROM playlist_tracks WHERE playlist_id = $1 ORDER BY id ASC OFFSET $2 LIMIT 1',
      [playlist.id, position - 1]
    );
    if (!selected.rows[0]) throw new Error('There is no track at that position.');
    await db.query('DELETE FROM playlist_tracks WHERE id = $1', [selected.rows[0].id]);
    return String(selected.rows[0].title);
  } catch (error) {
    if (error instanceof Error && error.message.includes('no track at that position')) throw error;
    const mem = inMemoryPlaylists.get(playlist.id);
    if (!mem || position > mem.tracks.length) throw new Error('There is no track at that position.');
    const removed = mem.tracks.splice(position - 1, 1)[0];
    return removed?.title ?? 'Unknown Track';
  }
}

export async function deletePlaylist(guildId: string, ownerId: string, playlistName: string): Promise<void> {
  const playlist = await findPlaylist(guildId, ownerId, playlistName);
  if (!playlist) throw new Error('I could not find that playlist.');
  try {
    await db.query('DELETE FROM playlists WHERE id = $1', [playlist.id]);
  } catch {
    inMemoryPlaylists.delete(playlist.id);
  }
}

export async function renamePlaylist(guildId: string, ownerId: string, oldName: string, newName: string): Promise<void> {
  const playlist = await findPlaylist(guildId, ownerId, oldName);
  if (!playlist) throw new Error('I could not find that playlist.');
  const cleanName = newName.trim();
  if (!cleanName || cleanName.length > 50) throw new Error('Playlist names must be between 1 and 50 characters.');
  const duplicate = await findPlaylist(guildId, ownerId, cleanName);
  if (duplicate && duplicate.id !== playlist.id) throw new Error('You already have a playlist with that name.');
  try {
    await db.query('UPDATE playlists SET name = $1 WHERE id = $2', [cleanName, playlist.id]);
  } catch {
    const mem = inMemoryPlaylists.get(playlist.id);
    if (mem) mem.name = cleanName;
  }
}
