// -----------------------------------------------------------------------------
// JPEG fixtures, generated (no binary committed): tiny frames of one colour,
// a noisy frame too big for Gladys, a frame with an EXIF thumbnail.
// -----------------------------------------------------------------------------

import jpeg from 'jpeg-js';

/** A small JPEG of one colour; `seed` changes the colour (tells frames apart). */
export function tinyJpeg({ width = 32, height = 24, seed = 0 } = {}) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (seed * 70) & 255;
    data[i + 1] = (120 + seed * 30) & 255;
    data[i + 2] = 200;
    data[i + 3] = 255;
  }
  return jpeg.encode({ data, width, height }, 80).data;
}

/** A frame that compresses badly: over 150 KB well before a camera's size. */
export function noisyJpeg({ width = 640, height = 480, quality = 92 } = {}) {
  const data = Buffer.alloc(width * height * 4);
  let x = 12345;
  for (let i = 0; i < data.length; i += 4) {
    // A xorshift: deterministic noise, the same frame on every run.
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    data[i] = x & 255;
    data[i + 1] = (x >>> 8) & 255;
    data[i + 2] = (x >>> 16) & 255;
    data[i + 3] = 255;
  }
  return jpeg.encode({ data, width, height }, quality).data;
}

/**
 * `main` with an APP1 "Exif" segment holding `thumbnail` (a whole JPEG, so
 * an FF D9 well before the end of the frame), as cameras write them.
 */
export function withThumbnail(main, thumbnail) {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), thumbnail]);
  const header = Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255]);
  return Buffer.concat([main.subarray(0, 2), header, payload, main.subarray(2)]);
}
