import { scoreTrackForMood } from './recommendation.js';
import type { CatalogueCandidate, MoodName } from './dj-types.js';

export type TasteEventType = 'play' | 'like' | 'dislike';

export interface TasteEvent {
  eventType: TasteEventType;
  title: string;
  artist: string | null;
  genreTags: string[];
  moodTags: string[];
  catalogueTrackId: number | null;
}

export interface MusicRequestIntent {
  mood?: MoodName;
  genres: string[];
  keywords: string[];
  language?: string;
  energy?: 'low' | 'medium' | 'high';
}

export interface TasteProfile {
  totalPlays: number;
  likes: number;
  dislikes: number;
  topGenres: string[];
  topArtists: string[];
  topMoods: string[];
  genreWeights: Record<string, number>;
  artistWeights: Record<string, number>;
  moodWeights: Record<string, number>;
  recentlyPlayedIds: number[];
}

const normalise = (value: string): string => value.trim().toLowerCase();

function addWeight(target: Map<string, number>, key: string, weight: number): void {
  const value = normalise(key);
  if (!value) return;
  target.set(value, (target.get(value) ?? 0) + weight);
}

function asWeights(values: Map<string, number>): Record<string, number> {
  const max = Math.max(1, ...[...values.values()].map((value) => Math.abs(value)));
  return Object.fromEntries([...values.entries()].map(([key, value]) => [key, value / max]));
}

function positiveTop(values: Map<string, number>, count = 5): string[] {
  return [...values.entries()].filter(([, score]) => score > 0.05)
    .sort((a, b) => b[1] - a[1]).slice(0, count).map(([key]) => key);
}

export function buildTasteProfile(events: TasteEvent[]): TasteProfile {
  const artists = new Map<string, number>();
  const genres = new Map<string, number>();
  const moods = new Map<string, number>();
  const recentIds: number[] = [];
  let totalPlays = 0;
  let likes = 0;
  let dislikes = 0;

  for (const event of events) {
    const weight = event.eventType === 'like' ? 3 : event.eventType === 'dislike' ? -4 : 0.2;
    if (event.eventType === 'play') {
      totalPlays++;
      if (event.catalogueTrackId !== null && recentIds.length < 30) recentIds.push(event.catalogueTrackId);
    } else if (event.eventType === 'like') likes++;
    else dislikes++;

    if (event.artist) addWeight(artists, event.artist, weight);
    for (const genre of event.genreTags) addWeight(genres, genre, weight);
    for (const mood of event.moodTags) addWeight(moods, mood, weight);
  }

  return {
    totalPlays, likes, dislikes,
    topGenres: positiveTop(genres), topArtists: positiveTop(artists), topMoods: positiveTop(moods),
    genreWeights: asWeights(genres), artistWeights: asWeights(artists), moodWeights: asWeights(moods),
    recentlyPlayedIds: recentIds
  };
}

function averageTrackWeights(tags: string[], weights: Record<string, number>): number {
  const values = tags.map((tag) => weights[normalise(tag)]).filter((value): value is number => value !== undefined);
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function requestScore(track: CatalogueCandidate, intent: MusicRequestIntent): number {
  const mood = intent.mood ? scoreTrackForMood(track, intent.mood) : 0.5;
  const genres = intent.genres.length
    ? track.genreTags.some((tag) => intent.genres.includes(normalise(tag))) ? 1 : 0
    : 0.5;
  const haystack = `${track.title} ${track.artist ?? ''} ${track.album ?? ''}`.toLowerCase();
  const keyword = intent.keywords.length
    ? intent.keywords.filter((word) => haystack.includes(normalise(word))).length / intent.keywords.length
    : 0.5;
  const language = intent.language
    ? (track.language ?? '').toLowerCase() === intent.language.toLowerCase() ? 1 : 0
    : 0.5;
  let energy = 0.5;
  if (intent.energy && track.energy !== null) {
    energy = intent.energy === 'low' ? 1 - track.energy
      : intent.energy === 'high' ? track.energy
        : 1 - Math.abs(track.energy - 0.5) * 2;
  }
  return mood * 0.42 + genres * 0.28 + keyword * 0.14 + language * 0.08 + energy * 0.08;
}

export function scoreTrackForTaste(
  track: CatalogueCandidate,
  profile: TasteProfile,
  intent?: MusicRequestIntent
): number {
  const artist = track.artist ? profile.artistWeights[normalise(track.artist)] ?? 0 : 0;
  const genre = averageTrackWeights(track.genreTags, profile.genreWeights);
  const mood = averageTrackWeights(track.moodTags, profile.moodWeights);
  const hasTaste = Object.keys(profile.artistWeights).length + Object.keys(profile.genreWeights).length + Object.keys(profile.moodWeights).length > 0;
  const taste = hasTaste ? artist * 0.28 + genre * 0.52 + mood * 0.20 : 0.5;
  if (!intent) return taste * 0.88 + (track.artist && track.genreTags.length && track.moodTags.length ? 0.12 : 0);
  return taste * 0.42 + requestScore(track, intent) * 0.58;
}

export function recommendForTaste(
  candidates: CatalogueCandidate[],
  profile: TasteProfile,
  count: number,
  intent?: MusicRequestIntent
): CatalogueCandidate[] {
  const limit = Math.max(1, Math.min(10, Math.trunc(count)));
  const recent = new Set(profile.recentlyPlayedIds);
  const fresh = candidates.filter((track) => !recent.has(track.id));
  const remaining = [...(fresh.length >= Math.min(limit, candidates.length) ? fresh : candidates)];
  const selected: CatalogueCandidate[] = [];
  const artists = new Map<string, number>();
  const genres = new Map<string, number>();

  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index++) {
      const track = remaining[index]!;
      const artist = normalise(track.artist ?? 'unknown');
      const genre = normalise(track.genreTags[0] ?? 'unknown');
      const preference = scoreTrackForTaste(track, profile, intent);
      const diversityPenalty = (artists.get(artist) ?? 0) * 0.13 + (genres.get(genre) ?? 0) * 0.055;
      const score = preference - diversityPenalty;
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    }
    const [track] = remaining.splice(bestIndex, 1);
    if (!track) break;
    selected.push(track);
    const artist = normalise(track.artist ?? 'unknown');
    const genre = normalise(track.genreTags[0] ?? 'unknown');
    artists.set(artist, (artists.get(artist) ?? 0) + 1);
    genres.set(genre, (genres.get(genre) ?? 0) + 1);
  }
  return selected;
}

const MOOD_ALIASES: Array<[MoodName, string[]]> = [
  ['chill', ['chill', 'relax', 'relaxing', 'calm', 'lofi', 'sleepy', 'unwind', 'slow', 'soft', 'quiet']],
  ['party', ['party', 'dance', 'club', 'celebrate', 'workout', 'gym']],
  ['gaming', ['gaming', 'game', 'hype', 'phonk', 'intense', 'battle']],
  ['focus', ['focus', 'study', 'work', 'concentrate', 'instrumental']],
  ['romantic', ['romantic', 'love', 'date', 'soft', 'couple']],
  ['sad', ['sad', 'heartbreak', 'emotional', 'cry', 'melancholy']],
  ['nostalgic', ['nostalgic', 'nostalgia', 'retro', 'oldies', 'throwback', '2000s', '90s']]
];

const STOP_WORDS = new Set([
  'play', 'some', 'music', 'songs', 'song', 'please', 'for', 'me', 'a', 'an', 'the', 'with', 'like',
  'something', 'that', 'is', 'are', 'i', 'want', 'to', 'give', 'find', 'more', 'less', 'my', 'taste',
  'in', 'on', 'and', 'or', 'of', 'from', 'about', 'good', 'best', 'slow', 'soft', 'quiet',
  'relaxing', 'relax', 'calm', 'sleepy', 'unwind', 'hindi', 'english', 'eng', 'punjabi', 'tamil', 'korean',
  'low', 'energy', 'high', 'fast', 'mid', 'tempo', 'medium'
]);

export function parseMusicRequestLocally(request: string): MusicRequestIntent {
  const text = request.trim().toLowerCase();
  const words = text.match(/[a-z0-9+#']+/g) ?? [];
  const mood = MOOD_ALIASES.find(([, aliases]) => aliases.some((alias) => text.includes(alias)))?.[0];
  const knownGenres = ['lofi', 'phonk', 'edm', 'electronic', 'hip-hop', 'hiphop', 'rap', 'pop', 'rock', 'jazz', 'classical', 'acoustic', 'ambient', 'instrumental', 'rnb', 'soul', 'metal', 'house', 'disco', 'piano'];
  const genres = knownGenres.filter((genre) => text.includes(genre)).map((genre) => genre === 'hiphop' ? 'hip-hop' : genre);
  const language = /\b(hindi|bollywood)\b/.test(text) ? 'hindi'
    : /\b(english|eng)\b/.test(text) ? 'english'
      : /\b(punjabi)\b/.test(text) ? 'punjabi'
        : /\b(tamil)\b/.test(text) ? 'tamil'
          : /\b(korean|k-pop)\b/.test(text) ? 'korean' : undefined;
  const energy = /\b(low energy|slow|soft|quiet)\b/.test(text) ? 'low'
    : /\b(high energy|fast|hype|energetic)\b/.test(text) ? 'high'
      : /\b(mid tempo|medium energy)\b/.test(text) ? 'medium' : undefined;
  const keywords = [...new Set(words.filter((word) => word.length > 2 && !STOP_WORDS.has(word) && !MOOD_ALIASES.some(([, aliases]) => aliases.includes(word)) && !knownGenres.includes(word)))].slice(0, 6);
  return { mood, genres, keywords, language, energy };
}
