import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendTracks, recommendBalancedTracks, inferMoodFromTracks } from '../dist/recommendation.js';

const track = (id, overrides = {}) => ({
  id, title: `Track ${id}`, artist: `Artist ${id}`, album: null, url: `https://audio.example.com/${id}.mp3`,
  durationSeconds: 180, genreTags: ['ambient'], moodTags: ['chill'], language: 'en', bpm: 82, energy: 0.25,
  ...overrides
});

test('mood ranking prefers high-energy party tracks over chill tracks', () => {
  const chill = track(1);
  const party = track(2, { genreTags: ['edm'], moodTags: ['party'], bpm: 128, energy: 0.9 });
  const result = recommendTracks([chill, party], 'party', 1);
  assert.equal(result[0].id, 2);
});

test('AI shuffle excludes recently played tracks when enough alternatives exist', () => {
  const tracks = [track(1), track(2), track(3)];
  const result = recommendTracks(tracks, 'chill', 2, new Set([1, 2]));
  assert.deepEqual(result.map((item) => item.id), [3]);
});

test('recommendation introduces artist variety for similarly scored tracks', () => {
  const tracks = [
    track(1, { artist: 'Same Artist' }),
    track(2, { artist: 'Same Artist' }),
    track(3, { artist: 'Different Artist' })
  ];
  const result = recommendTracks(tracks, 'chill', 2);
  assert.notEqual(result[0].artist, result[1].artist);
});

test('auto mood inference recognizes chill metadata', () => {
  const tracks = [track(1), track(2), track(3)];
  assert.equal(inferMoodFromTracks(tracks), 'chill');
});

test('balanced shuffle selects a queue and avoids repeated artists', () => {
  const tracks = [
    track(1, { artist: 'Artist A', genreTags: ['pop'] }),
    track(2, { artist: 'Artist A', genreTags: ['pop'] }),
    track(3, { artist: 'Artist B', genreTags: ['rock'] }),
    track(4, { artist: 'Artist C', genreTags: ['jazz'] })
  ];
  const result = recommendBalancedTracks(tracks, 3);
  assert.equal(result.length, 3);
  assert.equal(new Set(result.map((item) => item.artist)).size, 3);
});
