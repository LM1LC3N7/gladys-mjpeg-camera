// -----------------------------------------------------------------------------
// JPEG structure and the first frame of an answer (snapshot, multipart with
// and without Content-Length, raw stream), fed whole or byte by byte.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JpegScanner, findSoi, isJpeg, jpegSize } from '../src/jpeg.js';
import { FrameError, FrameReader, parseContentType } from '../src/mjpeg.js';
import { tinyJpeg, withThumbnail } from './helpers/jpegs.js';

const A = tinyJpeg({ width: 40, height: 30, seed: 1 });
const B = tinyJpeg({ width: 40, height: 30, seed: 2 });

const part = (frame, { boundary = 'frame', length = true } = {}) =>
  Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: image/jpeg\r\n${length ? `Content-Length: ${frame.length}\r\n` : ''}\r\n`,
    ),
    frame,
    Buffer.from('\r\n'),
  ]);

/** Feed `bytes` in chunks of `size`; returns the first frame (or end()). */
function read(bytes, options = {}, size = bytes.length) {
  const reader = new FrameReader(options);
  for (let i = 0; i < bytes.length; i += size) {
    const frame = reader.push(bytes.subarray(i, i + size));
    if (frame) {
      return { frame, consumed: Math.min(bytes.length, i + size) };
    }
  }
  return { frame: reader.end(), consumed: bytes.length, ended: true };
}

test('JPEG basics: SOI, size from the frame header, structural end past a thumbnail', () => {
  assert.ok(isJpeg(A));
  assert.ok(!isJpeg(Buffer.from('<html>')));
  assert.deepEqual(jpegSize(A), { width: 40, height: 30 });
  assert.equal(findSoi(Buffer.concat([Buffer.from('xx'), A])), 2);
  const exif = withThumbnail(A, tinyJpeg({ width: 8, height: 8 }));
  assert.ok(exif.indexOf(Buffer.from([0xff, 0xd9])) < exif.length - 2, 'an early FF D9');
  assert.deepEqual(jpegSize(exif), { width: 40, height: 30 });
  assert.equal(new JpegScanner(0).scan(exif), exif.length);
  // Incomplete: -1, then resumes.
  const scanner = new JpegScanner(0);
  assert.equal(scanner.scan(exif, exif.length - 1), -1);
  assert.equal(scanner.scan(exif), exif.length);
});

test('content types: the boundary, quoted or not, multipart or not', () => {
  assert.deepEqual(
    parseContentType('multipart/x-mixed-replace;boundary=123456789000000000000987654321'),
    {
      mime: 'multipart/x-mixed-replace',
      multipart: true,
      boundary: '123456789000000000000987654321',
    },
  );
  assert.equal(
    parseContentType('multipart/x-mixed-replace; boundary="--myboundary"').boundary,
    '--myboundary',
  );
  assert.deepEqual(parseContentType('image/jpeg'), {
    mime: 'image/jpeg',
    multipart: false,
    boundary: undefined,
  });
  assert.equal(parseContentType(undefined).mime, '');
});

test('a multipart stream with Content-Length: the first frame, whole or byte by byte', () => {
  const body = Buffer.concat([part(A), part(B)]);
  for (const size of [body.length, 1000, 7, 1]) {
    const { frame, consumed } = read(body, { boundary: 'frame' }, size);
    assert.deepEqual(frame, A, `chunks of ${size}`);
    assert.ok(consumed - size < part(A).length, 'stops at the first frame');
  }
});

test('a multipart stream without Content-Length (ESP32-CAM): the JPEG structure ends the frame', () => {
  const exif = withThumbnail(A, tinyJpeg({ width: 8, height: 8 }));
  const body = Buffer.concat([part(exif, { length: false }), part(B, { length: false })]);
  for (const size of [body.length, 64, 1]) {
    assert.deepEqual(read(body, { boundary: 'frame' }, size).frame, exif, `chunks of ${size}`);
  }
});

test('dashes and wrong boundaries: declared "--b" sent "--b", or not sent at all', () => {
  const body = Buffer.concat([
    part(A, { boundary: 'myboundary' }),
    part(B, { boundary: 'myboundary' }),
  ]);
  assert.deepEqual(read(body, { boundary: '--myboundary' }).frame, A);
  // A camera announcing a boundary it never sends: the first SOI after 64 KB of nothing.
  const raw = Buffer.concat([part(A, { boundary: 'other' }), part(B, { boundary: 'other' })]);
  assert.deepEqual(read(raw, { boundary: 'frame', maxPreamble: 16 }).frame, A);
  // A raw concatenation of JPEGs (no multipart at all).
  assert.deepEqual(read(Buffer.concat([A, B]), {}, 5).frame, A);
});

test('a Content-Length counting the trailing CRLF still ends on EOI', () => {
  const head = Buffer.from(`--frame\r\nContent-Length: ${A.length + 2}\r\n\r\n`);
  const body = Buffer.concat([head, A, Buffer.from('\r\n--frame\r\n')]);
  assert.deepEqual(read(body, { boundary: 'frame' }).frame, A);
});

test('a snapshot: the body is the frame; a truncated or HTML body is handled at the end', () => {
  assert.deepEqual(read(A).frame, A);
  const cut = A.subarray(0, A.length - 2);
  const truncated = read(cut);
  assert.ok(truncated.ended);
  assert.deepEqual(truncated.frame, cut, 'a JPEG without its EOI is still an image');
  assert.equal(read(Buffer.from('<html><body>Login</body></html>')).frame, undefined);
});

test('bounded: a frame over the limit, or no JPEG at all, stops the reading', () => {
  const big = Buffer.concat([part(A), part(B)]);
  assert.throws(
    () => read(big, { boundary: 'frame', maxBytes: 100 }, 50),
    (err) => err instanceof FrameError && err.code === 'too_large',
  );
  assert.throws(
    () => read(Buffer.alloc(5000, 0x41), { maxBytes: 1000, maxPreamble: 1000 }, 100),
    (err) => err instanceof FrameError && err.code === 'not_jpeg',
  );
});
