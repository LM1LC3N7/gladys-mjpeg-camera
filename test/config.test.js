// -----------------------------------------------------------------------------
// The `cameras` grammar, the camera ids (forever) and the refresh bounds.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraId, normalizeConfig, parseCameras, refreshSeconds } from '../src/config.js';

test('entries: URL then an optional name after a space or |, commas or new lines', () => {
  const { cameras, invalid } = parseCameras(
    'http://192.168.1.50:81/stream Garden gate, http://admin:p%40ss@192.168.1.20/cgi-bin/snapshot.cgi|Front door\n' +
      'ftp://nas/cam.jpg, not a url, http://192.168.1.50:81/stream Duplicate, https://cam.local/image.jpg',
  );
  assert.deepEqual(
    cameras.map((c) => [c.name, c.host, c.url]),
    [
      ['Garden gate', '192.168.1.50:81', 'http://192.168.1.50:81/stream'],
      ['Front door', '192.168.1.20', 'http://192.168.1.20/cgi-bin/snapshot.cgi'],
      ['Camera cam.local', 'cam.local', 'https://cam.local/image.jpg'],
    ],
  );
  assert.equal(cameras[1].username, 'admin');
  assert.equal(cameras[1].password, 'p@ss', 'percent-decoded');
  assert.ok(!cameras[1].url.includes('admin'), 'the URL kept has no credentials');
  assert.deepEqual(invalid, [3, 4], 'positions only: an entry may carry a password');
});

test('the camera id ignores credentials, so a new password keeps the device', () => {
  const id = cameraId('http://192.168.1.20/snapshot.cgi?chn=1');
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(cameraId('http://admin:new@192.168.1.20/snapshot.cgi?chn=1&pwd=x&user=admin'), id);
  assert.notEqual(cameraId('http://192.168.1.20/snapshot.cgi?chn=2'), id, 'another channel');
  // Pinned: changing the hash would duplicate every camera of every user.
  assert.equal(
    cameraId('http://192.168.1.50:81/stream'),
    cameraId('http://192.168.1.50:81/stream#x'),
  );
  assert.equal(cameraId('http://192.168.1.50:81/stream'), '569cb4a61ad9');
});

test('a user without a password takes the shared one; the defaults and bounds', () => {
  const config = normalizeConfig({
    cameras: 'http://viewer@192.168.1.30/image.jpg',
    camera_password: 'shared',
    refresh_seconds: 2,
    allow_self_signed: true,
  });
  assert.equal(config.cameras[0].password, 'shared');
  assert.equal(config.refreshSeconds, 5, 'the core takes 12 images a minute');
  assert.equal(config.allowSelfSigned, true);
  assert.deepEqual(normalizeConfig({}), {
    cameras: [],
    invalid: [],
    refreshSeconds: 10,
    allowSelfSigned: false,
  });
  assert.equal(refreshSeconds(0), 0, 'on demand only');
  assert.equal(refreshSeconds('abc'), 10);
  assert.equal(refreshSeconds(99999), 3600);
  const many = Array.from({ length: 20 }, (_, i) => `http://10.0.0.${i}/cam.jpg`).join(',');
  assert.equal(parseCameras(many).cameras.length, 16);
});
