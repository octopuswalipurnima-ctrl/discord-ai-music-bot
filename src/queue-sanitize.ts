import type { Track } from './audio-source.js';

const TAG_PATTERN = /^[\p{L}\p{N} _&'+#.\-]{1,40}$/u;

function stringTags(value: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value.filter((item): item is string => typeof item === 'string' && TAG_PATTERN.test(item)).slice(0, maxItems);
  return tags.length ? tags : undefined;
}

/** Shape a Track for Redis: only known fields, bounded lengths. */
export function toStoredTrack(track: Track): Track {
  return {
    title: track.title.slice(0, 200),
    url: track.url,
    requestedBy: track.requestedBy,
    ...(track.artist ? { artist: track.artist.slice(0, 120) } : {}),
    ...(track.catalogueTrackId ? { catalogueTrackId: track.catalogueTrackId } : {}),
    ...(track.genreTags?.length ? { genreTags: track.genreTags.slice(0, 12) } : {}),
    ...(track.moodTags?.length ? { moodTags: track.moodTags.slice(0, 7) } : {}),
    ...(track.language ? { language: track.language.slice(0, 32) } : {}),
    ...(track.bpm ? { bpm: track.bpm } : {}),
    ...(track.energy !== undefined ? { energy: track.energy } : {})
  };
}

/**
 * Validate and rebuild tracks read back from Redis. Redis content is untrusted input:
 * unknown fields are dropped and every field is type-checked and bounded.
 */
export function sanitizeStoredTracks(parsed: unknown, maxItems: number): Track[] {
  if (!Array.isArray(parsed)) return [];
  const result: Track[] = [];
  for (const item of parsed) {
    if (result.length >= maxItems) break;
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.title !== 'string' || !raw.title.trim()) continue;
    if (typeof raw.url !== 'string' || raw.url.length > 2000) continue;
    if (typeof raw.requestedBy !== 'string' || !/^\d{1,24}$/.test(raw.requestedBy)) continue;
    const track: Track = { title: raw.title.slice(0, 200), url: raw.url, requestedBy: raw.requestedBy };
    if (typeof raw.artist === 'string' && raw.artist) track.artist = raw.artist.slice(0, 120);
    if (typeof raw.catalogueTrackId === 'number' && Number.isInteger(raw.catalogueTrackId) && raw.catalogueTrackId > 0) {
      track.catalogueTrackId = raw.catalogueTrackId;
    }
    const genres = stringTags(raw.genreTags, 12);
    if (genres) track.genreTags = genres;
    const moods = stringTags(raw.moodTags, 7);
    if (moods) track.moodTags = moods;
    if (typeof raw.language === 'string' && raw.language) track.language = raw.language.slice(0, 32);
    if (typeof raw.bpm === 'number' && Number.isFinite(raw.bpm) && raw.bpm >= 30 && raw.bpm <= 250) track.bpm = raw.bpm;
    if (typeof raw.energy === 'number' && Number.isFinite(raw.energy) && raw.energy >= 0 && raw.energy <= 1) track.energy = raw.energy;
    result.push(track);
  }
  return result;
}
