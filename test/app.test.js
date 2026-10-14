// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and the fake camera on
// 127.0.0.1: discovery, periodic images, the fresh image Gladys asks for,
// offline/online, downscaling, the test button, and no secret anywhere.
// -----------------------------------------------------------------------------

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MjpegCameraApp } from '../src/app.js';
import { parseCameras } from '../src/config.js';
import { ACTIONS, MAX_IMAGE_LENGTH, SCENE_TRIGGERS } from '../src/constants.js';
import { buildCameraDevice } from '../src/devices.js';
import { digest, snapshot, startFakeCamera, status, stream } from './helpers/fakeCamera.js';
import { createFakeTimers } from './helpers/fakeTimers.js';
import { noisyJpeg, tinyJpeg } from './helpers/jpegs.js';

const START = Date.parse('2026-10-14T08:00:00Z');
const A = tinyJpeg({ seed: 1 });
const B = tinyJpeg({ seed: 2 });

let cam;
before(async () => {
  cam = await startFakeCamera();
});
after(() => cam.close());

/** Created devices for the cameras of a `cameras` text, as Gladys hands them back. */
function created(gladysLike, text) {
  return parseCameras(text).cameras.map((camera) => buildCameraDevice(gladysLike, camera));
}

async function setup({ config, create = true }) {
  const selector = { externalId: (suffix) => `ext:mjpeg-camera:${suffix}` };
  const devices = create ? created(selector, config.cameras) : [];
  const gladys = createFakeGladys({ selector: 'mjpeg-camera', config, devices });
  const timers = createFakeTimers();
  const clock = { now: START };
  const logs = [];
  const log = (...args) => logs.push(args.join(' '));
  const app = new MjpegCameraApp({
    gladys,
    logger: { debug: log, info: log, warn: log, error: log },
    now: () => clock.now,
    timers,
    captureOptions: { timeout: 500 },
  });
  gladys.onScanRequest(() => app.publishDevices());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));
  gladys.onGetImage((device) => app.getImage(device));
  gladys.onAction(ACTIONS.TEST, () => app.testCameras());
  gladys.onConfigUpdated((next) => app.start(next));
  await gladys.connect();
  return { app, gladys, timers, clock, logs, devices };
}

const image = (jpeg) => `image/jpg;base64,${jpeg.toString('base64')}`;

test('discovery offers the typed cameras; nothing is read before they are added', async () => {
  cam.route('/d1', snapshot(A));
  const config = {
    cameras: `${cam.url('/d1')} Garden, ${cam.url('/d2?pwd=t0k3n', { user: 'admin', pass: 's3cret' })}|Porch, rtsp://cam/live`,
  };
  const before = cam.requests.length;
  const { app, gladys } = await setup({ config, create: false });
  await app.start(config);
  const devices = gladys.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.name),
    ['Garden', 'Porch'],
  );
  assert.match(devices[0].external_id, /^ext:mjpeg-camera:camera:[0-9a-f]{12}$/);
  assert.deepEqual(
    devices[0].features.map((f) => [f.category, f.type, f.external_id.endsWith(':image')]),
    [['camera', 'image', true]],
  );
  assert.deepEqual(devices[1].params, [{ name: 'host', value: `127.0.0.1:${cam.port}` }]);
  assert.doesNotMatch(JSON.stringify(devices), /s3cret|t0k3n|admin|\/d2/);
  assert.equal(cam.requests.length, before, 'no capture for a camera not added');
  assert.match(gladys.fake.connectionStatus.message.en, /2 cameras waiting in Discovery.*entry 3/);
  assert.equal(app.timer !== undefined, true);
});

test('a created camera: an image at start, then every refresh_seconds', async () => {
  const live = stream([A, B]);
  cam.route('/stream', live);
  const config = { cameras: `${cam.url('/stream')} Garden`, refresh_seconds: 10 };
  const { app, gladys, timers, clock } = await setup({ config });
  await app.start(config);
  assert.equal(gladys.fake.cameraImages.length, 1);
  assert.equal(gladys.fake.cameraImages[0].image, image(A));
  assert.equal(timers.intervals()[0].ms, 10_000);
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: true,
    message: { en: '1 camera, an image every 10 s.', fr: '1 caméra, une image toutes les 10 s.' },
  });
  assert.deepEqual(
    gladys.fake.transports.map((t) => t.transport),
    ['local'],
  );
  assert.equal(gladys.fake.sceneEvents.length, 0, 'the first reading fires nothing');
  await timers.runIntervals();
  assert.equal(gladys.fake.cameraImages.length, 1, 'not due yet');
  clock.now += 10_000;
  await timers.runIntervals();
  assert.equal(gladys.fake.cameraImages.length, 2);
  assert.equal(gladys.fake.transports.length, 1, 'the badge is sent on change only');
});

test('onGetImage: a fresh frame, one capture shared by concurrent requests', async () => {
  let served = 0;
  cam.route('/slow', (req, res) => {
    served += 1;
    setTimeout(() => snapshot(B)(req, res), 50);
  });
  const config = { cameras: `${cam.url('/slow')} Door`, refresh_seconds: 0 };
  const { app, gladys, devices, clock } = await setup({ config });
  await app.start(config);
  assert.equal(served, 0, 'on demand only: nothing at start');
  const answers = await Promise.all([1, 2, 3].map(() => gladys.fake.getImage(devices[0])));
  assert.deepEqual(
    answers.map((a) => a.data.image),
    [image(B), image(B), image(B)],
  );
  assert.equal(served, 1);
  clock.now += 5_000;
  await gladys.fake.getImage(devices[0]);
  assert.equal(served, 2, 'a later request captures again');
  const unknown = await gladys.fake.getImage({
    external_id: 'ext:mjpeg-camera:camera:0123456789ab',
  });
  assert.equal(unknown.success, false);
  assert.equal(gladys.fake.cameraImages.length, 0, 'an answered image is not published');
  assert.match(gladys.fake.connectionStatus.message.en, /images on demand only/);
});

test('offline after 3 failed captures, back online: one event each, badge and status', async () => {
  const camera = { down: false };
  cam.route('/flaky', (req, res) => (camera.down ? status(500)(req, res) : snapshot(A)(req, res)));
  const config = { cameras: `${cam.url('/flaky')} Garden` };
  const { app, gladys, timers, clock, devices } = await setup({ config });
  await app.start(config);
  camera.down = true;
  for (let i = 0; i < 3; i += 1) {
    clock.now += 10_000;
    await timers.runIntervals();
  }
  assert.deepEqual(gladys.fake.sceneEvents, [
    {
      key: SCENE_TRIGGERS.OFFLINE,
      data: { camera: devices[0].external_id, name: 'Garden', error: 'HTTP 500', failures: 3 },
    },
  ]);
  assert.equal(gladys.fake.transports.at(-1).transport, 'unreachable');
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: false,
    message: {
      en: '1 of 1 camera unreachable: Garden: HTTP 500. Retrying every 60 s.',
      fr: '1 caméra sur 1 injoignable : Garden : HTTP 500. Nouvel essai toutes les 60 s.',
    },
  });
  // Offline: tried again after a minute, not at every refresh.
  const requests = cam.requests.length;
  clock.now += 10_000;
  await timers.runIntervals();
  assert.equal(cam.requests.length, requests);
  camera.down = false;
  clock.now += 60_000;
  await timers.runIntervals();
  assert.deepEqual(
    gladys.fake.sceneEvents.map((e) => e.key),
    [SCENE_TRIGGERS.OFFLINE, SCENE_TRIGGERS.ONLINE],
  );
  assert.equal(gladys.fake.sceneEvents[1].data.offline_minutes, 1);
  assert.equal(gladys.fake.transports.at(-1).transport, 'local');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a frame over 150 KB is downscaled, flagged, and read every 30 s at most', async () => {
  const big = noisyJpeg({ width: 640, height: 480 });
  cam.route('/uxga', snapshot(big));
  const config = { cameras: `${cam.url('/uxga')} Garage`, refresh_seconds: 10 };
  const { app, gladys, timers, clock } = await setup({ config });
  await app.start(config);
  const [published] = gladys.fake.cameraImages;
  assert.ok(published.image.length <= MAX_IMAGE_LENGTH);
  const badge = gladys.fake.transports.at(-1);
  assert.equal(badge.degraded, true);
  assert.match(badge.message.en, /640×480 downscaled to \d+×\d+/);
  assert.match(gladys.fake.connectionStatus.message.en, /downscaled \(Garage\).*lower resolution/);
  clock.now += 10_000;
  await timers.runIntervals();
  assert.equal(gladys.fake.cameraImages.length, 1, 'spared: 30 s between two downscales');
  clock.now += 20_000;
  await timers.runIntervals();
  assert.equal(gladys.fake.cameraImages.length, 2);
});

test('the test button: one capture each, kind, size and time, or the error', async () => {
  cam.route('/t-stream', stream([A]));
  cam.route('/t-missing', status(404));
  const config = {
    cameras: `${cam.url('/t-stream')} Garden, ${cam.url('/t-missing')} Porch`,
    refresh_seconds: 0,
  };
  const { gladys } = await setup({ config, create: false });
  await gladys.fake.configUpdated(config);
  const result = await gladys.fake.action(ACTIONS.TEST, {});
  assert.equal(result.success, true);
  const [ok, failed] = result.data.message.en.split('\n');
  assert.match(
    ok,
    new RegExp(`^OK Garden \\(127\\.0\\.0\\.1:${cam.port}\\): MJPEG stream, 32×24, 1 KB, \\d+ ms$`),
  );
  assert.equal(failed, `FAILED Porch (127.0.0.1:${cam.port}): HTTP 404`);
  assert.match(result.data.message.fr, /^OK Garden .*: flux MJPEG/);
  assert.equal(gladys.fake.sceneEvents.length + gladys.fake.transports.length, 0, 'not added yet');
});

test('a camera added in Discovery shows an image at once, even on demand', async () => {
  cam.route('/added', snapshot(A));
  const config = { cameras: `${cam.url('/added')} Shed`, refresh_seconds: 0 };
  const { app, gladys } = await setup({ config, create: false });
  await app.start(config);
  assert.equal(app.timer, undefined, 'on demand: no timer');
  await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
  assert.deepEqual(
    gladys.fake.cameraImages.map((i) => i.image),
    [image(A)],
  );
  assert.match(gladys.fake.connectionStatus.message.en, /^1 camera, images on demand only/);
});

test('no secret in a status, an event, a badge, a log line or the test output', async () => {
  const guarded = digest(snapshot(A), { user: 'admin', pass: 'right' });
  cam.route('/cgi-bin/snapshot.cgi', guarded);
  const url = cam.url('/cgi-bin/snapshot.cgi?pwd=t0k3n', { user: 'admin', pass: 's3cret' });
  const config = { cameras: `${url} Front` };
  const { app, gladys, timers, clock, logs } = await setup({ config });
  await app.start(config);
  for (let i = 0; i < 3; i += 1) {
    clock.now += 60_000;
    await timers.runIntervals();
  }
  const test = await gladys.fake.action(ACTIONS.TEST, {});
  assert.match(test.data.message.en, /FAILED Front .*refused \(HTTP 401\)/);
  const everything = JSON.stringify([
    gladys.fake.connectionStatuses,
    gladys.fake.sceneEvents,
    gladys.fake.transports,
    gladys.fake.discoveredDevices,
    logs,
    test,
  ]);
  assert.doesNotMatch(everything, /s3cret|t0k3n/);
  assert.ok(!cam.requests.some((r) => /s3cret/.test(r.headers.authorization ?? '')), 'Digest only');
});
