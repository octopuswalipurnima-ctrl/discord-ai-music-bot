export const MOOD_NAMES = [
  'chill', 'party', 'gaming', 'focus', 'romantic', 'sad', 'nostalgic'
] as const;

export type MoodName = typeof MOOD_NAMES[number];
export type DjMode = MoodName | 'auto' | 'off';

export interface MoodPreset {
  label: string;
  description: string;
  genres: string[];
  tags: string[];
  bpm: [number, number];
  energy: [number, number];
}

export const MOOD_PRESETS: Record<MoodName, MoodPreset> = {
  chill: {
    label: 'Chill', description: 'Relaxed, mellow and low-pressure music',
    genres: ['lofi', 'ambient', 'acoustic', 'indie', 'downtempo'],
    tags: ['chill', 'relaxed', 'mellow', 'lofi', 'ambient'], bpm: [60, 112], energy: [0.12, 0.52]
  },
  party: {
    label: 'Party', description: 'Upbeat dance-floor energy',
    genres: ['dance', 'edm', 'pop', 'house', 'disco'],
    tags: ['party', 'dance', 'upbeat', 'energetic', 'club'], bpm: [105, 155], energy: [0.62, 1]
  },
  gaming: {
    label: 'Gaming', description: 'High-energy electronic, rock and hype tracks',
    genres: ['electronic', 'rock', 'trap', 'phonk', 'metal'],
    tags: ['gaming', 'hype', 'intense', 'power', 'battle'], bpm: [95, 170], energy: [0.55, 1]
  },
  focus: {
    label: 'Focus', description: 'Low-distraction instrumental and ambient music',
    genres: ['classical', 'ambient', 'instrumental', 'jazz', 'piano'],
    tags: ['focus', 'study', 'instrumental', 'calm', 'concentration'], bpm: [45, 105], energy: [0.02, 0.38]
  },
  romantic: {
    label: 'Romantic', description: 'Warm love songs and smooth R&B',
    genres: ['rnb', 'soul', 'acoustic', 'pop', 'slow'],
    tags: ['romantic', 'love', 'soft', 'intimate', 'date night'], bpm: [55, 118], energy: [0.18, 0.58]
  },
  sad: {
    label: 'Sad', description: 'Emotional, reflective and slower music',
    genres: ['indie', 'acoustic', 'piano', 'sad pop', 'ballad'],
    tags: ['sad', 'emotional', 'melancholic', 'heartbreak', 'reflective'], bpm: [48, 105], energy: [0.02, 0.43]
  },
  nostalgic: {
    label: 'Nostalgic', description: 'Retro, classic and throwback sounds',
    genres: ['classic pop', 'retro', 'oldies', 'disco', 'classic rock'],
    tags: ['nostalgic', 'retro', 'throwback', 'classic', 'old school'], bpm: [65, 138], energy: [0.22, 0.76]
  }
};

export interface CatalogueCandidate {
  id: number;
  title: string;
  artist: string | null;
  album: string | null;
  url: string;
  durationSeconds: number | null;
  genreTags: string[];
  moodTags: string[];
  language: string | null;
  bpm: number | null;
  energy: number | null;
}
