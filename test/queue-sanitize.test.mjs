import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeStoredTracks, toStoredTrack } from '../dist/queue-sanitize.js';

const good = { title: 'Song', url: 'https://audio.example.net/a.mp3', requestedBy: '123456789012345678' };

test('round-trips a stored track with metadata', () => {
  const stored = toStoredTrack({ ...good, artist: 'Artist', catalogueTrackId: 7, genreTags: ['pop'], moodTags: ['party'], language: 'english', bpm: 120, energy: 0.8 });
  const restored = sanitizeStoredTracks(JSON.parse(JSON.stringify([stored])), 100);
  assert.deepEqual(restored, [stored]);
});

test('drops non-array payloads and malformed entries', () => {
  assert.deepEqual(sanitizeStoredTracks({ not: 'array' }, 100), []);
  const restored = sanitizeStoredTracks([null, 5, 'x', { title: 'x' }, { ...good, requestedBy: 'not-a-snowflake' }, { ...good, url: 42 }, good], 100);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].title, 'Song');
});

test('discards unknown fields and out-of-range metadata', () => {
  const [track] = sanitizeStoredTracks([{ ...good, evil: 'x', bpm: 9000, energy: 7, catalogueTrackId: -3, genreTags: ['pop', { a: 1 }, 5], moodTags: 'party' }], 100);
  assert.equal(track.evil, undefined);
  assert.equal(track.bpm, undefined);
  assert.equal(track.energy, undefined);
  assert.equal(track.catalogueTrackId, undefined);
  assert.deepEqual(track.genreTags, ['pop']);
  assert.equal(track.moodTags, undefined);
});

test('respects the maximum queue size', () => {
  const many = Array.from({ length: 10 }, () => ({ ...good }));
  assert.equal(sanitizeStoredTracks(many, 3).length, 3);
});
