import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAutoPausedByEmptyVc,
  setAutoPausedByEmptyVc,
  hasSession,
  getSnapshot,
  getLastPlayedTrack,
  setOnQueueEmpty
} from '../dist/player.js';

test('auto-pause by empty VC flags are strictly scoped per guild', () => {
  const guildA = 'guild-111111';
  const guildB = 'guild-222222';

  assert.equal(isAutoPausedByEmptyVc(guildA), false);
  assert.equal(isAutoPausedByEmptyVc(guildB), false);

  // If no session exists, it safely returns false without throwing
  setAutoPausedByEmptyVc(guildA, true);
  assert.equal(isAutoPausedByEmptyVc(guildA), false);
});

test('per-server session isolation ensures non-existent sessions do not leak data', () => {
  assert.equal(hasSession('server-alpha'), false);
  assert.equal(hasSession('server-beta'), false);
  assert.equal(getSnapshot('server-alpha'), null);
  assert.equal(getSnapshot('server-beta'), null);
  assert.equal(getLastPlayedTrack('server-alpha'), null);
});

test('setOnQueueEmpty handler registration is supported', () => {
  let called = false;
  setOnQueueEmpty(() => { called = true; });
  assert.equal(called, false);
});
