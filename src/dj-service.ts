import ytSearch from 'yt-search';
import { db } from './db.js';
import { config } from './config.js';
import { log } from './logger.js';
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
  try {
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
    if (result.rows.length > 0) {
      return result.rows.map((row) => toCandidate(row as Record<string, unknown>));
    }
  } catch {}

  // Fallback to searching YouTube directly if database is offline or empty
  try {
    const ytRes = await ytSearch(search);
    return ytRes.videos.slice(0, limit).map((v, i) => ({
      id: 900000 + i,
      title: v.title,
      artist: v.author?.name || null,
      album: null,
      url: v.url,
      durationSeconds: v.seconds,
      genreTags: [],
      moodTags: [],
      language: null,
      bpm: null,
      energy: null
    }));
  } catch {
    return [];
  }
}

export async function getCatalogueTrack(guildId: string, trackId: number): Promise<Track | null> {
  try {
    const result = await db.query(
      `SELECT id, title, artist, album, source_url, duration_seconds, genre_tags, mood_tags, language, bpm, energy
         FROM music_catalogue_tracks WHERE guild_id = $1 AND id = $2 AND active = TRUE`,
      [guildId, trackId]
    );
    const row = result.rows[0];
    if (row) return toTrack(toCandidate(row as Record<string, unknown>), '');
  } catch {}
  return null;
}

export async function removeCatalogueTrack(guildId: string, trackId: number): Promise<boolean> {
  const result = await db.query(
    `UPDATE music_catalogue_tracks SET active = FALSE WHERE guild_id = $1 AND id = $2 AND active = TRUE`,
    [guildId, trackId]
  );
  return (result.rowCount ?? 0) > 0;
}

const inMemoryDjMode = new Map<string, DjMode>();

export async function setGuildDjMode(guildId: string, mode: DjMode, actorId: string): Promise<void> {
  inMemoryDjMode.set(guildId, mode);
  let selectedMood: MoodName | null = null;
  let autoEnabled = false;
  if (mode === 'auto') autoEnabled = true;
  else if (mode !== 'off') selectedMood = mode;
  try {
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
  } catch {
    // Non-fatal when running in memory mode
  }
}

export async function getGuildDjMode(guildId: string): Promise<DjMode> {
  try {
    const result = await db.query<{ mood: string | null; auto_enabled: boolean }>(
      'SELECT mood, auto_enabled FROM guild_dj_settings WHERE guild_id = $1', [guildId]
    );
    const row = result.rows[0];
    if (!row) return 'off';
    if (row.auto_enabled) return 'auto';
    return row.mood && MOOD_NAMES.includes(row.mood as MoodName) ? row.mood as MoodName : 'off';
  } catch {
    return inMemoryDjMode.get(guildId) ?? 'auto';
  }
}

async function getRecentPlayedTracks(guildId: string, limit: number): Promise<CatalogueCandidate[]> {
  try {
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
  } catch {
    return [];
  }
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
  try {
    const [effectiveMood, countResult] = await Promise.all([
      mode === 'off' ? Promise.resolve('balanced' as const) : getEffectiveGuildMood(guildId),
      db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM music_catalogue_tracks WHERE guild_id = $1 AND active = TRUE', [guildId])
    ]);
    return { mode, effectiveMood, catalogueCount: Number(countResult.rows[0]?.count ?? 0) };
  } catch {
    const effectiveMood = mode === 'off' ? 'balanced' as const : await getEffectiveGuildMood(guildId);
    return { mode, effectiveMood, catalogueCount: 0 };
  }
}

const CURATED_MOOD_TRACKS: Record<string, Array<{ title: string; artist: string }>> = {
  chill: [
    { title: 'Sunflower', artist: 'Post Malone, Swae Lee' },
    { title: 'Heat Waves', artist: 'Glass Animals' },
    { title: 'Daylight', artist: 'David Kushner' },
    { title: 'Stay', artist: 'The Kid LAROI, Justin Bieber' },
    { title: 'Golden Hour', artist: 'JVKE' }
  ],
  party: [
    { title: 'Blinding Lights', artist: 'The Weeknd' },
    { title: 'Levitating', artist: 'Dua Lipa' },
    { title: 'Starboy', artist: 'The Weeknd' },
    { title: 'Uptown Funk', artist: 'Mark Ronson, Bruno Mars' },
    { title: 'Can\'t Hold Us', artist: 'Macklemore & Ryan Lewis' }
  ],
  gaming: [
    { title: 'Enemy', artist: 'Imagine Dragons' },
    { title: 'Legends Never Die', artist: 'League of Legends' },
    { title: 'The Search', artist: 'NF' },
    { title: 'Warriors', artist: 'Imagine Dragons' },
    { title: 'Believer', artist: 'Imagine Dragons' }
  ],
  focus: [
    { title: 'Weightless', artist: 'Marconi Union' },
    { title: 'Clair de Lune', artist: 'Claude Debussy' },
    { title: 'Experience', artist: 'Ludovico Einaudi' },
    { title: 'River Flows in You', artist: 'Yiruma' },
    { title: 'Nuvole Bianche', artist: 'Ludovico Einaudi' }
  ],
  romantic: [
    { title: 'Perfect', artist: 'Ed Sheeran' },
    { title: 'Until I Found You', artist: 'Stephen Sanchez' },
    { title: 'All of Me', artist: 'John Legend' },
    { title: 'Just the Way You Are', artist: 'Bruno Mars' },
    { title: 'Dandelions', artist: 'Ruth B.' }
  ],
  sad: [
    { title: 'Someone You Loved', artist: 'Lewis Capaldi' },
    { title: 'Glimpse of Us', artist: 'Joji' },
    { title: 'Arcade', artist: 'Duncan Laurence' },
    { title: 'Another Love', artist: 'Tom Odell' },
    { title: 'Lovely', artist: 'Billie Eilish, Khalid' }
  ],
  nostalgic: [
    { title: 'Take On Me', artist: 'a-ha' },
    { title: 'Everybody Wants to Rule the World', artist: 'Tears for Fears' },
    { title: 'Dreams', artist: 'Fleetwood Mac' },
    { title: 'Africa', artist: 'Toto' },
    { title: 'In the End', artist: 'Linkin Park' }
  ]
};

async function getCuratedFallbackTracks(moodOrQuery: string, count: number, requestedBy: string): Promise<Track[]> {
  const normalized = moodOrQuery.toLowerCase();
  let songList = CURATED_MOOD_TRACKS['chill']!;
  for (const [key, list] of Object.entries(CURATED_MOOD_TRACKS)) {
    if (normalized.includes(key)) {
      songList = list;
      break;
    }
  }
  const slice = songList.slice(0, count);
  const resolved: Track[] = [];
  for (const song of slice) {
    try {
      const res = await ytSearch(`${song.title} ${song.artist}`);
      const v = res.videos[0];
      if (v) {
        resolved.push({
          title: song.title,
          artist: song.artist,
          url: v.url,
          durationSeconds: v.seconds,
          requestedBy
        });
      }
    } catch {}
  }
  return resolved;
}

export async function generateAiTracksWithOpenRouter(prompt: string, count: number, requestedBy: string): Promise<Track[]> {
  const apiKey = config.AI_API_KEY;
  const baseUrl = config.AI_API_BASE_URL || 'https://openrouter.ai/api/v1';
  const model = config.AI_MODEL || 'openai/gpt-4o-mini';

  if (!apiKey) {
    return getCuratedFallbackTracks(prompt, count, requestedBy);
  }

  try {
    const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/octopuswalipurnima-ctrl/discord-ai-music-bot',
        'X-Title': 'Discord AI Music Bot'
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        model,
        temperature: 0.7,
        messages: [
          {
            role: 'system',
            content: 'You are an expert AI music DJ. Given a music mood, genre, or user request, return a JSON array of real, popular song recommendations. Each item must be an object with "title" and "artist" string keys. Example: [{"title": "Song Title", "artist": "Artist Name"}]. Output valid JSON array only, without any markdown or code blocks.'
          },
          {
            role: 'user',
            content: `Recommend ${count} great songs for: ${prompt}`
          }
        ]
      })
    });

    if (!response.ok) {
      log('warn', 'openrouter_ai_response_error', { status: response.status });
      return getCuratedFallbackTracks(prompt, count, requestedBy);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim() || '';

    let songList: Array<{ title: string; artist: string }> = [];
    try {
      const cleaned = content.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) songList = parsed;
      else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).songs)) {
        songList = (parsed as any).songs;
      }
    } catch {
      log('warn', 'ai_json_parse_failed', { content });
    }

    if (!songList.length) {
      return getCuratedFallbackTracks(prompt, count, requestedBy);
    }

    const resolved: Track[] = [];
    for (const song of songList.slice(0, count)) {
      if (!song.title) continue;
      try {
        const query = `${song.title} ${song.artist || ''}`.trim();
        const searchRes = await ytSearch(query);
        const v = searchRes.videos[0];
        if (v) {
          resolved.push({
            title: song.title,
            artist: song.artist || v.author?.name,
            url: v.url,
            durationSeconds: v.seconds,
            requestedBy
          });
        }
      } catch (err) {
        log('warn', 'yt_search_song_failed', { song, error: err });
      }
    }

    if (resolved.length > 0) return resolved;
    return getCuratedFallbackTracks(prompt, count, requestedBy);
  } catch (error) {
    log('warn', 'ai_track_generation_error', { error });
    return getCuratedFallbackTracks(prompt, count, requestedBy);
  }
}

export async function getAiShuffleTracks(guildId: string, count: number, requestedBy: string): Promise<{ mood: MoodName | 'balanced'; tracks: Track[] }> {
  let mode: DjMode = 'auto';
  try {
    mode = await getGuildDjMode(guildId);
  } catch {}
  const mood = mode === 'off' ? 'balanced' as const : await getEffectiveGuildMood(guildId).catch(() => 'chill' as MoodName);

  try {
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
    if (candidates.length > 0) {
      const recentlyPlayed = new Set(recentResult.rows.map((row) => Number(row.catalogue_track_id)));
      const selected = mood === 'balanced'
        ? recommendBalancedTracks(candidates, count, recentlyPlayed)
        : recommendTracks(candidates, mood, count, recentlyPlayed);
      if (selected.length > 0) {
        return { mood, tracks: selected.map((track) => toTrack(track, requestedBy)) };
      }
    }
  } catch (dbErr) {
    log('info', 'db_catalogue_fallback_to_ai', { error: dbErr });
  }

  // Fallback to OpenRouter AI generation
  const aiTracks = await generateAiTracksWithOpenRouter(`mood: ${mood}`, count, requestedBy);
  return { mood, tracks: aiTracks };
}

export async function recordCataloguePlay(guildId: string, catalogueTrackId: number | undefined): Promise<void> {
  if (!catalogueTrackId) return;
  await db.query(
    'INSERT INTO guild_track_history (guild_id, catalogue_track_id) VALUES ($1,$2)',
    [guildId, catalogueTrackId]
  );
}
