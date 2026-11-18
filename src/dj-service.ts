import { db } from './db.js';
import { validateConfiguredAudioUrl, type Track } from './audio-source.js';
import {
  MOOD_NAMES,
  type CatalogueCandidate,
  type DjMode,
  type MoodName
} from './dj-types.js';
import { inferMoodFromTracks, recommendBalancedTracks, recommendTracks } from './recommendation.js';

export { MOOD_NAMES };
export type { DjMode, MoodName };

export interface CatalogueInput {
  title: string;
  artist?: string | null;
  album?: string | null;
  url: string;
  durationSeconds?: number | null;
  genreTags?: string[];
  moodTags?: string[];
  language?: string | null;
  bpm?: number | null;
  energy?: number | null;
}

export interface GuildDjStatus {
  mode: DjMode;
  effectiveMood: MoodName | 'balanced';
  catalogueCount: number;
}

function cleanTags(values: string[] = []): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
}

function toCandidate(row: Record<string, unknown>): CatalogueCandidate {
  return {
    id: Number(row.id),
    title: String(row.title),
    artist: row.artist === null ? null : String(row.artist ?? ''),
    album: row.album === null ? null : String(row.album ?? ''),
    url: String(row.source_url),
    durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    genreTags: Array.isArray(row.genre_tags) ? row.genre_tags.map(String) : [],
    moodTags: Array.isArray(row.mood_tags) ? row.mood_tags.map(String) : [],
    language: row.language === null ? null : String(row.language ?? ''),
    bpm: row.bpm == null ? null : Number(row.bpm),
    energy: row.energy == null ? null : Number(row.energy)
  };
}

function toTrack(candidate: CatalogueCandidate, requestedBy: string): Track {
  return {
    title: candidate.title,
    url: candidate.url,
    requestedBy,
    artist: candidate.artist ?? undefined,
    catalogueTrackId: candidate.id,
    genreTags: candidate.genreTags,
    moodTags: candidate.moodTags,
    language: candidate.language ?? undefined,
    bpm: candidate.bpm ?? undefined,
    energy: candidate.energy ?? undefined
  };
}

export async function addCatalogueTrack(guildId: string, addedBy: string, input: CatalogueInput): Promise<number> {
  validateConfiguredAudioUrl(input.url);
  if (!input.title.trim()) throw new Error('A track title is required.');
  if (input.bpm != null && (input.bpm < 30 || input.bpm > 250)) throw new Error('BPM must be between 30 and 250.');
  if (input.energy != null && (input.energy < 0 || input.energy > 1)) throw new Error('Energy must be between 0 and 1.');
  const moodTags = cleanTags(input.moodTags);
  const invalidMoods = moodTags.filter((tag) => !MOOD_NAMES.includes(tag as MoodName));
  if (invalidMoods.length) throw new Error(`Unknown mood tags: ${invalidMoods.join(', ')}. Use: ${MOOD_NAMES.join(', ')}.`);

  const result = await db.query<{ id: string }>(
    `INSERT INTO music_catalogue_tracks
       (guild_id, title, artist, album, source_url, duration_seconds, genre_tags, mood_tags, language, bpm, energy, added_by, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9,$10,$11,$12,TRUE)
     ON CONFLICT (guild_id, source_url) DO UPDATE SET
       title = EXCLUDED.title, artist = EXCLUDED.artist, album = EXCLUDED.album,
       duration_seconds = EXCLUDED.duration_seconds, genre_tags = EXCLUDED.genre_tags,
       mood_tags = EXCLUDED.mood_tags, language = EXCLUDED.language, bpm = EXCLUDED.bpm,
       energy = EXCLUDED.energy, active = TRUE
     RETURNING id`,
    [
      guildId, input.title.trim().slice(0, 200), input.artist?.trim().slice(0, 120) || null,
      input.album?.trim().slice(0, 120) || null, input.url, input.durationSeconds ?? null,
      cleanTags(input.genreTags), moodTags, input.language?.trim().slice(0, 32) || null,
      input.bpm ?? null, input.energy ?? null, addedBy
    ]
  );
  return Number(result.rows[0]?.id);
}

export async function searchCatalogue(guildId: string, query: string, limit = 10): Promise<CatalogueCandidate[]> {
  const search = query.trim();
  if (search.length < 2) throw new Error('Enter at least two characters to search the catalogue.');
  const pattern = `%${search}%`;
  const result = await db.query(
    `SELECT id, title, artist, album, source_url, duration_seconds, genre_tags, mood_tags, language, bpm, energy
       FROM music_catalogue_tracks
      WHERE guild_id = $1 AND active = TRUE
        AND (title ILIKE $2 OR artist ILIKE $2 OR album ILIKE $2
          OR EXISTS (SELECT 1 FROM unnest(genre_tags || mood_tags) AS tags(tag) WHERE tags.tag ILIKE $2))
      ORDER BY (title ILIKE $3) DESC, title ASC
      LIMIT $4`,
    [guildId, pattern, search, Math.max(1, Math.min(20, limit))]
  );
  return result.rows.map((row) => toCandidate(row as Record<string, unknown>));
}

export async function getCatalogueTrack(guildId: string, trackId: number): Promise<Track | null> {
  const result = await db.query(
    `SELECT id, title, artist, album, source_url, duration_seconds, genre_tags, mood_tags, language, bpm, energy
       FROM music_catalogue_tracks WHERE guild_id = $1 AND id = $2 AND active = TRUE`,
    [guildId, trackId]
  );
  const row = result.rows[0];
  return row ? toTrack(toCandidate(row as Record<string, unknown>), '') : null;
}

export async function removeCatalogueTrack(guildId: string, trackId: number): Promise<boolean> {
  const result = await db.query(
    `UPDATE music_catalogue_tracks SET active = FALSE WHERE guild_id = $1 AND id = $2 AND active = TRUE`,
    [guildId, trackId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function setGuildDjMode(guildId: string, mode: DjMode, actorId: string): Promise<void> {
  let selectedMood: MoodName | null = null;
  let autoEnabled = false;
  if (mode === 'auto') autoEnabled = true;
  else if (mode !== 'off') selectedMood = mode;
  await db.query(
    `INSERT INTO guild_dj_settings (guild_id, mood, auto_enabled, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (guild_id) DO UPDATE SET mood = EXCLUDED.mood,
       auto_enabled = EXCLUDED.auto_enabled, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [guildId, selectedMood, autoEnabled, actorId]
  );
  await db.query(
    `INSERT INTO server_audit_log (guild_id, actor_id, action, details)
     VALUES ($1,$2,'dj_mode_changed',$3::jsonb)`,
    [guildId, actorId, JSON.stringify({ mode })]
  );
}

export async function getGuildDjMode(guildId: string): Promise<DjMode> {
  const result = await db.query<{ mood: string | null; auto_enabled: boolean }>(
    'SELECT mood, auto_enabled FROM guild_dj_settings WHERE guild_id = $1', [guildId]
  );
  const row = result.rows[0];
  if (!row) return 'off';
  if (row.auto_enabled) return 'auto';
  return row.mood && MOOD_NAMES.includes(row.mood as MoodName) ? row.mood as MoodName : 'off';
}

async function getRecentPlayedTracks(guildId: string, limit: number): Promise<CatalogueCandidate[]> {
  const result = await db.query(
    `SELECT t.id, t.title, t.artist, t.album, t.source_url, t.duration_seconds,
            t.genre_tags, t.mood_tags, t.language, t.bpm, t.energy
       FROM guild_track_history h
       JOIN music_catalogue_tracks t ON t.id = h.catalogue_track_id
      WHERE h.guild_id = $1 AND t.active = TRUE
      ORDER BY h.played_at DESC LIMIT $2`,
    [guildId, limit]
  );
  return result.rows.map((row) => toCandidate(row as Record<string, unknown>));
}

export async function getEffectiveGuildMood(guildId: string): Promise<MoodName> {
  const mode = await getGuildDjMode(guildId);
  if (mode !== 'auto' && mode !== 'off') return mode;
  if (mode === 'off') return 'chill';
  const recent = await getRecentPlayedTracks(guildId, 8);
  return inferMoodFromTracks(recent);
}

export async function getGuildDjStatus(guildId: string): Promise<GuildDjStatus> {
  const mode = await getGuildDjMode(guildId);
  const [effectiveMood, countResult] = await Promise.all([
    mode === 'off' ? Promise.resolve('balanced' as const) : getEffectiveGuildMood(guildId),
    db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM music_catalogue_tracks WHERE guild_id = $1 AND active = TRUE', [guildId])
  ]);
  return { mode, effectiveMood, catalogueCount: Number(countResult.rows[0]?.count ?? 0) };
}

export async function getAiShuffleTracks(guildId: string, count: number, requestedBy: string): Promise<{ mood: MoodName | 'balanced'; tracks: Track[] }> {
  const mode = await getGuildDjMode(guildId);
  const mood = mode === 'off' ? 'balanced' as const : await getEffectiveGuildMood(guildId);
  const [catalogueResult, recentResult] = await Promise.all([
    db.query(
      `SELECT id, title, artist, album, source_url, duration_seconds, genre_tags, mood_tags, language, bpm, energy
         FROM music_catalogue_tracks WHERE guild_id = $1 AND active = TRUE ORDER BY id ASC LIMIT 1000`, [guildId]
    ),
    db.query<{ catalogue_track_id: string }>(
      `SELECT catalogue_track_id::text FROM guild_track_history
        WHERE guild_id = $1 AND catalogue_track_id IS NOT NULL
        ORDER BY played_at DESC LIMIT 24`, [guildId]
    )
  ]);
  const candidates = catalogueResult.rows.map((row) => toCandidate(row as Record<string, unknown>));
  if (!candidates.length) throw new Error('This server catalogue is empty. A moderator must add approved audio tracks with `/catalog add` first.');
  const recentlyPlayed = new Set(recentResult.rows.map((row) => Number(row.catalogue_track_id)));
  const selected = mood === 'balanced'
    ? recommendBalancedTracks(candidates, count, recentlyPlayed)
    : recommendTracks(candidates, mood, count, recentlyPlayed);
  return { mood, tracks: selected.map((track) => toTrack(track, requestedBy)) };
}

export async function recordCataloguePlay(guildId: string, catalogueTrackId: number | undefined): Promise<void> {
  if (!catalogueTrackId) return;
  await db.query(
    'INSERT INTO guild_track_history (guild_id, catalogue_track_id) VALUES ($1,$2)',
    [guildId, catalogueTrackId]
  );
}
