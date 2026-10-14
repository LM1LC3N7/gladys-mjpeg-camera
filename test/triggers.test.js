// -----------------------------------------------------------------------------
// Health transitions -> camera_offline / camera_online, one per transition.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_HEALTH, nextHealth } from '../src/triggers.js';
import { OFFLINE_AFTER, SCENE_TRIGGERS } from '../src/constants.js';

const ctx = (now) => ({ now, deviceId: 'ext:cam:camera:abc', name: 'Garden' });

function run(outcomes, start = INITIAL_HEALTH) {
  let health = start;
  const events = [];
  outcomes.forEach((ok, i) => {
    const step = nextHealth(
      health,
      ok ? { ok: true } : { ok: false, error: 'timeout' },
      ctx(i * 60_000),
    );
    health = step.health;
    events.push(...step.events);
  });
  return { health, events };
}

test('the first reading fires nothing, success or failure', () => {
  assert.deepEqual(run([true]).events, []);
  const dead = run(Array(OFFLINE_AFTER + 2).fill(false));
  assert.equal(dead.health.state, 'offline');
  assert.deepEqual(dead.events, [], 'never seen online: nothing to announce');
  assert.deepEqual(run([...Array(OFFLINE_AFTER).fill(false), true]).events, [], 'pairs only');
});

test('online -> offline after N failures, once; offline -> online, once', () => {
  const lost = [true, false, false];
  assert.deepEqual(run(lost).events, [], 'two lost frames are not an outage');
  const { health, events } = run([true, ...Array(OFFLINE_AFTER + 3).fill(false), true, true]);
  assert.equal(health.state, 'online');
  assert.deepEqual(
    events.map((e) => e.key),
    [SCENE_TRIGGERS.OFFLINE, SCENE_TRIGGERS.ONLINE],
  );
  assert.deepEqual(events[0].data, {
    camera: 'ext:cam:camera:abc',
    name: 'Garden',
    error: 'timeout',
    failures: OFFLINE_AFTER,
  });
  assert.equal(events[1].data.offline_minutes, 4, 'from the outage to the first image');
});
