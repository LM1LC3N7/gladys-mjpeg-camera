// -----------------------------------------------------------------------------
// The health of a camera, capture after capture -> scene events. Pure.
//
//   unknown --success--> online            (nothing fires: the first reading)
//   unknown --N failures--> offline        (nothing fires either)
//   online  --N failures--> offline        camera_offline
//   offline --success--> online            camera_online, only after a
//                                          camera_offline: events come in pairs
// N is OFFLINE_AFTER consecutive failed captures: one lost frame of a busy
// ESP32-CAM is not an outage.
// -----------------------------------------------------------------------------

import { OFFLINE_AFTER, SCENE_TRIGGERS } from './constants.js';

export const INITIAL_HEALTH = Object.freeze({ state: 'unknown', failures: 0 });

/**
 * One capture outcome: { ok: true } or { ok: false, error }.
 * Returns { health, events } (events: [{ key, data }]).
 */
export function nextHealth(previous = INITIAL_HEALTH, outcome, { now, deviceId, name }) {
  const events = [];
  if (outcome.ok) {
    if (previous.state === 'offline' && previous.announced) {
      events.push({
        key: SCENE_TRIGGERS.ONLINE,
        data: {
          camera: deviceId,
          name,
          offline_minutes: Math.max(0, Math.round((now - previous.since) / 60_000)),
        },
      });
    }
    const since = previous.state === 'online' ? previous.since : now;
    return { health: { state: 'online', failures: 0, since }, events };
  }
  const failures = previous.failures + 1;
  const error = String(outcome.error ?? '').slice(0, 200);
  if (previous.state === 'offline' || failures < OFFLINE_AFTER) {
    return { health: { ...previous, failures, error }, events };
  }
  const announced = previous.state === 'online';
  if (announced) {
    events.push({
      key: SCENE_TRIGGERS.OFFLINE,
      data: { camera: deviceId, name, error, failures },
    });
  }
  return { health: { state: 'offline', failures, error, since: now, announced }, events };
}
