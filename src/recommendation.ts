import { MOOD_PRESETS, MOOD_NAMES, type CatalogueCandidate, type MoodName } from './dj-types.js';

function norm(value: string): string { return value.trim().toLowerCase(); }

function rangeFit(value: number | null, range: [number, number]): number {
  if (value === null || !Number.isFinite(value)) return 0.42;
  if (value >= range[0] && value <= range[1]) return 1;
  const distance = value < range[0] ? range[0] - value : value - range[1];
  const width = Math.max(1, range[1] - range[0]);
  return Math.max(0, 1 - distance / (width * 0.9));
}

export function scoreTrackForMood(track: CatalogueCandidate, mood: MoodName): number {
  const preset = MOOD_PRESETS[mood];
  const genres = new Set(track.genreTags.map(norm));
  const tags = new Set(track.moodTags.map(norm));
  const genreScore = preset.genres.some((tag) => genres.has(tag)) ? 1 : 0;
  const tagScore = preset.tags.some((tag) => tags.has(tag)) ? 1 : 0;
  const bpmScore = rangeFit(track.bpm, preset.bpm);
  const energyScore = rangeFit(track.energy, preset.energy);
  // Mood tags are the strongest signal; tempo and energy fill gaps when metadata is partial.
  return tagScore * 0.46 + genreScore * 0.24 + bpmScore * 0.16 + energyScore * 0.14;
}

export function inferMoodFromTracks(tracks: CatalogueCandidate[]): MoodName {
  if (!tracks.length) return 'chill';
  const totals = new Map<MoodName, number>(MOOD_NAMES.map((mood) => [mood, 0]));
  for (const track of tracks) {
    for (const mood of MOOD_NAMES) totals.set(mood, (totals.get(mood) ?? 0) + scoreTrackForMood(track, mood));
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'chill';
}

export function recommendTracks(
  candidates: CatalogueCandidate[], mood: MoodName, count: number, recentlyPlayedIds: Set<number> = new Set()
): CatalogueCandidate[] {
  const limit = Math.max(1, Math.min(10, Math.trunc(count)));
  const fresh = candidates.filter((track) => !recentlyPlayedIds.has(track.id));
  const pool = fresh.length > 0 ? fresh : candidates;
  const remaining = [...pool];
  const chosen: CatalogueCandidate[] = [];
  const artists = new Map<string, number>();
  const genres = new Map<string, number>();

  while (remaining.length && chosen.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const track = remaining[i]!;
      const artist = norm(track.artist ?? 'unknown');
      const mainGenre = norm(track.genreTags[0] ?? 'unknown');
      const artistPenalty = (artists.get(artist) ?? 0) * 0.17;
      const genrePenalty = (genres.get(mainGenre) ?? 0) * 0.07;
      const score = scoreTrackForMood(track, mood) - artistPenalty - genrePenalty + Math.random() * 0.025;
      if (score > bestScore) { bestScore = score; bestIndex = i; }
    }
    const [selected] = remaining.splice(bestIndex, 1);
    if (!selected) break;
    chosen.push(selected);
    const artist = norm(selected.artist ?? 'unknown');
    const genre = norm(selected.genreTags[0] ?? 'unknown');
    artists.set(artist, (artists.get(artist) ?? 0) + 1);
    genres.set(genre, (genres.get(genre) ?? 0) + 1);
  }
  return chosen;
}


export function recommendBalancedTracks(
  candidates: CatalogueCandidate[], count: number, recentlyPlayedIds: Set<number> = new Set()
): CatalogueCandidate[] {
  const limit = Math.max(1, Math.min(10, Math.trunc(count)));
  const fresh = candidates.filter((track) => !recentlyPlayedIds.has(track.id));
  const pool = fresh.length > 0 ? fresh : candidates;
  const remaining = [...pool];
  const chosen: CatalogueCandidate[] = [];
  const artists = new Map<string, number>();
  const genres = new Map<string, number>();
  while (remaining.length && chosen.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const track = remaining[i]!;
      const artist = norm(track.artist ?? 'unknown');
      const genre = norm(track.genreTags[0] ?? 'unknown');
      const metadataCompleteness = [track.artist, track.bpm, track.energy, track.genreTags.length, track.moodTags.length]
        .filter((value) => value !== null && value !== undefined && value !== '').length / 5;
      const score = metadataCompleteness * 0.25 - (artists.get(artist) ?? 0) * 0.5 - (genres.get(genre) ?? 0) * 0.15 + Math.random() * 0.03;
      if (score > bestScore) { bestScore = score; bestIndex = i; }
    }
    const [selected] = remaining.splice(bestIndex, 1);
    if (!selected) break;
    chosen.push(selected);
    const artist = norm(selected.artist ?? 'unknown');
    const genre = norm(selected.genreTags[0] ?? 'unknown');
    artists.set(artist, (artists.get(artist) ?? 0) + 1);
    genres.set(genre, (genres.get(genre) ?? 0) + 1);
  }
  return chosen;
}
