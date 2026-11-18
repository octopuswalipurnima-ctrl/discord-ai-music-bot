import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTasteProfile,
  parseMusicRequestLocally,
  recommendForTaste,
  scoreTrackForTaste
} from '../dist/taste-recommendation.js';

const track = (id, overrides = {}) => ({
  id, title: `Track ${id}`, artist: `Artist ${id}`, album: null,
  url: `https://audio.example.com/${id}.mp3`, durationSeconds: 180,
  genreTags: ['ambient'], moodTags: ['chill'], language: 'en', bpm: 82, energy: 0.25,
  ...overrides
});

test('profile learns positive genre and artist preferences from likes', () => {
  const profile = buildTasteProfile([
    { eventType: 'like', title: 'A', artist: 'Artist A', genreTags: ['pop'], moodTags: ['party'], catalogueTrackId: 1 },
    { eventType: 'play', title: 'B', artist: 'Artist A', genreTags: ['pop'], moodTags: ['party'], catalogueTrackId: 2 }
  ]);
  assert.equal(profile.likes, 1);
  assert.equal(profile.totalPlays, 1);
  assert.deepEqual(profile.topGenres, ['pop']);
  assert.deepEqual(profile.topArtists, ['artist a']);
});

test('disliked genre receives a negative preference score', () => {
  const profile = buildTasteProfile([
    { eventType: 'dislike', title: 'No', artist: 'Artist X', genreTags: ['metal'], moodTags: ['gaming'], catalogueTrackId: 1 }
  ]);
  const metal = track(2, { genreTags: ['metal'], moodTags: ['gaming'], artist: 'Artist X' });
  const pop = track(3, { genreTags: ['pop'], moodTags: ['party'], artist: 'Artist B' });
  assert.ok(scoreTrackForTaste(pop, profile) > scoreTrackForTaste(metal, profile));
});

test('recommendations avoid recent plays and use personal genre preferences', () => {
  const profile = buildTasteProfile([
    { eventType: 'like', title: 'A', artist: 'Artist A', genreTags: ['pop'], moodTags: ['party'], catalogueTrackId: 1 },
    { eventType: 'play', title: 'A', artist: 'Artist A', genreTags: ['pop'], moodTags: ['party'], catalogueTrackId: 1 }
  ]);
  const result = recommendForTaste([
    track(1, { artist: 'Artist A', genreTags: ['pop'], moodTags: ['party'] }),
    track(2, { artist: 'Artist B', genreTags: ['metal'], moodTags: ['gaming'] }),
    track(3, { artist: 'Artist C', genreTags: ['pop'], moodTags: ['party'] })
  ], profile, 1);
  assert.equal(result[0].id, 3);
});

test('natural language parser infers mood, genre and language', () => {
  const intent = parseMusicRequestLocally('play some chill Hindi lofi songs for relaxing');
  assert.equal(intent.mood, 'chill');
  assert.ok(intent.genres.includes('lofi'));
  assert.equal(intent.language, 'hindi');
});

test('assistant intent can match artist or track keywords without a mood', () => {
  const intent = parseMusicRequestLocally('play songs by Daft Punk');
  assert.ok(intent.keywords.includes('daft'));
  assert.ok(intent.keywords.includes('punk'));
  assert.equal(intent.mood, undefined);
});
