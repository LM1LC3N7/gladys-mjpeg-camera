// -----------------------------------------------------------------------------
// The camera image: as is when it fits, else halved and re-encoded until the
// `image/jpg;base64,...` string fits the core's 150 * 1024 characters.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { IMAGE_PREFIX, MAX_IMAGE_LENGTH } from '../src/constants.js';
import { ImageError, MAX_JPEG_BYTES, cameraImage, shrink } from '../src/image.js';
import { jpegSize } from '../src/jpeg.js';
import { noisyJpeg, tinyJpeg } from './helpers/jpegs.js';

test('the budget is the SDK bound, prefix included', async () => {
  const gladys = createFakeGladys();
  await gladys.connect();
  const id = gladys.externalId('camera:000000000000');
  const padding = (n) => IMAGE_PREFIX + 'A'.repeat(n - IMAGE_PREFIX.length);
  await gladys.publishCameraImage(id, padding(MAX_IMAGE_LENGTH));
  await assert.rejects(gladys.publishCameraImage(id, padding(MAX_IMAGE_LENGTH + 1)), /maximum/);
  assert.equal(MAX_JPEG_BYTES, 115185);
  const exact = Buffer.alloc(MAX_JPEG_BYTES);
  assert.ok(IMAGE_PREFIX.length + exact.toString('base64').length <= MAX_IMAGE_LENGTH);
  assert.ok(
    IMAGE_PREFIX.length + Buffer.alloc(MAX_JPEG_BYTES + 1).toString('base64').length >
      MAX_IMAGE_LENGTH,
  );
});

test('a frame that fits is sent untouched', () => {
  const frame = tinyJpeg({ width: 64, height: 48 });
  const result = cameraImage(frame);
  assert.equal(result.image, `image/jpg;base64,${frame.toString('base64')}`);
  assert.equal(result.factor, 1);
  assert.deepEqual([result.width, result.height], [64, 48]);
});

test('a frame over 150 KB is halved until it fits, and still a JPEG', () => {
  const frame = noisyJpeg({ width: 640, height: 480 });
  assert.ok(frame.length > MAX_JPEG_BYTES, `${frame.length} bytes`);
  const result = cameraImage(frame);
  assert.ok(result.image.length <= MAX_IMAGE_LENGTH);
  assert.ok(result.factor >= 2);
  assert.deepEqual(result.original, { width: 640, height: 480, bytes: frame.length });
  const out = Buffer.from(result.image.slice(IMAGE_PREFIX.length), 'base64');
  assert.deepEqual(jpegSize(out), { width: 640 / result.factor, height: 480 / result.factor });
  // The next frame starts at the factor that worked.
  assert.equal(cameraImage(frame, { factorHint: result.factor }).factor, result.factor);
});

test('shrink averages blocks; a frame that cannot fit or decode is refused', () => {
  const data = Uint8Array.from([
    0, 0, 0, 255, 200, 100, 50, 255, 100, 50, 0, 255, 100, 50, 250, 255,
  ]);
  const { data: out, width, height } = shrink({ data, width: 2, height: 2 }, 2);
  assert.deepEqual([width, height], [1, 1]);
  assert.deepEqual([...out], [100, 50, 75, 255]);
  const corrupt = Buffer.concat([tinyJpeg().subarray(0, 200), Buffer.alloc(MAX_JPEG_BYTES, 7)]);
  assert.throws(
    () => cameraImage(corrupt),
    (err) => err instanceof ImageError,
  );
  // A 30 MP header (jpeg-js guard): refused before any big allocation.
  const header = jpeg.encode(
    { data: Buffer.alloc(16 * 16 * 4, 128), width: 16, height: 16 },
    50,
  ).data;
  const sof = header.indexOf(Buffer.from([0xff, 0xc0]));
  const huge = Buffer.concat([header, Buffer.alloc(MAX_JPEG_BYTES)]);
  huge.writeUInt16BE(5000, sof + 5);
  huge.writeUInt16BE(6000, sof + 7);
  assert.throws(
    () => cameraImage(huge),
    (err) => err.code === 'too_large' && /lower the camera resolution/.test(err.message),
  );
});
