// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTIONS, MIN_REFRESH_SECONDS, OFFLINE_AFTER, SCENE_TRIGGERS } from '../src/constants.js';
import { BOUNDS, DEFAULTS } from '../src/config.js';
import { nextHealth } from '../src/triggers.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const index = read('index.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      yield* texts(item, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.gladys_version, />=5\.1\.0/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-mjpeg-camera:${manifest.version}`);
  assert.equal(manifest.version, JSON.parse(read('package.json')).version);
  assert.deepEqual(manifest.transports, ['local'], 'the transport badges are local');
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.config_schema[0].description.en, /Not affiliated with any camera maker/);
  assert.match(
    manifest.config_schema[0].description.en,
    /RTSP camera integration built into Gladys/,
  );
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('the configuration matches the code', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.equal(fields.cameras.default, undefined);
  assert.equal(DEFAULTS.cameras, '');
  assert.equal(fields.refresh_seconds.default, DEFAULTS.refresh_seconds);
  assert.deepEqual(
    [fields.refresh_seconds.min, fields.refresh_seconds.max],
    BOUNDS.refresh_seconds,
  );
  assert.match(
    fields.refresh_seconds.description.en,
    new RegExp(`${MIN_REFRESH_SECONDS} at least`),
  );
  assert.equal(fields.allow_self_signed.default, DEFAULTS.allow_self_signed);
  assert.equal(fields.camera_password.type, 'secret', 'a password is never a plain field');
  assert.equal(Object.keys(DEFAULTS).length + 2, manifest.config_schema.length, 'intro + secret');
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(index.includes(`onAction(ACTIONS.${name}`), name);
  }
  assert.ok(index.includes('onGetImage('), 'Gladys asks for fresh images');
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key).sort(),
    Object.values(SCENE_TRIGGERS).sort(),
  );
});

test('the trigger variables are what the events carry', () => {
  const ctx = { deviceId: 'ext:x:camera:abc', name: 'Garden' };
  let health = nextHealth(undefined, { ok: true }, { ...ctx, now: 0 }).health;
  const events = [];
  for (let i = 1; i <= OFFLINE_AFTER + 1; i += 1) {
    const step = nextHealth(health, i <= OFFLINE_AFTER ? { ok: false, error: 'x' } : { ok: true }, {
      ...ctx,
      now: i * 60_000,
    });
    health = step.health;
    events.push(...step.events);
  }
  const triggers = Object.fromEntries(manifest.scene_triggers.map((t) => [t.key, t]));
  for (const event of events) {
    const trigger = triggers[event.key];
    const fields = trigger.fields.map((f) => f.key);
    const variables = trigger.variables.map((v) => v.key);
    assert.deepEqual(Object.keys(event.data).sort(), [...fields, ...variables].sort(), event.key);
    for (const variable of trigger.variables) {
      assert.equal(typeof event.data[variable.key], variable.type, `${event.key}.${variable.key}`);
    }
  }
  assert.equal(events.length, 2);
  assert.match(triggers.camera_offline.description.en, new RegExp(`${OFFLINE_AFTER} captures`));
});
