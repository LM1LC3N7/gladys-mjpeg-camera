// -----------------------------------------------------------------------------
// A captured JPEG -> the camera image Gladys accepts: `image/jpg;base64,...`,
// 150 * 1024 characters at most (prefix included). A frame too big is
// decoded, halved (box filter) and re-encoded at quality 75 until it fits,
// with jpeg-js (pure JS, no dependency of its own) under memory guards sized
// for a 256 MB container. Pure, but CPU-heavy: app.js runs one at a time.
// -----------------------------------------------------------------------------

import jpeg from 'jpeg-js';
import { IMAGE_PREFIX, MAX_IMAGE_LENGTH, RESIZE } from './constants.js';
import { jpegSize } from './jpeg.js';

/** The longest JPEG (bytes) whose camera image still fits. */
export const MAX_JPEG_BYTES = Math.floor((MAX_IMAGE_LENGTH - IMAGE_PREFIX.length) / 4) * 3;

export class ImageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImageError';
    this.code = code;
  }
}

export const toCameraImage = (bytes) => `${IMAGE_PREFIX}${bytes.toString('base64')}`;

/** Average `factor` x `factor` blocks of an RGBA image (a box filter). */
export function shrink({ data, width, height }, factor) {
  const w = Math.max(1, Math.floor(width / factor));
  const h = Math.max(1, Math.floor(height / factor));
  const out = new Uint8Array(w * h * 4);
  const area = factor * factor;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        let i = ((y * factor + dy) * width + x * factor) * 4;
        for (let dx = 0; dx < factor; dx += 1, i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / area);
      out[o + 1] = Math.round(g / area);
      out[o + 2] = Math.round(b / area);
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * The camera image of a captured frame:
 *   { image, width, height, bytes, factor }
 * `factor` is 1 when the frame was sent as is, else the divisor of its
 * dimensions (2, 4, 8…); `width`/`height`/`bytes` describe what is sent.
 * `factorHint` starts at the factor the previous frame of the camera needed.
 */
export function cameraImage(frame, { factorHint = 2 } = {}) {
  const size = jpegSize(frame);
  if (frame.length <= MAX_JPEG_BYTES) {
    return {
      image: toCameraImage(frame),
      width: size?.width,
      height: size?.height,
      bytes: frame.length,
      factor: 1,
      original: { width: size?.width, height: size?.height, bytes: frame.length },
    };
  }
  let decoded;
  try {
    decoded = jpeg.decode(frame, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: RESIZE.MAX_RESOLUTION_MP,
      maxMemoryUsageInMB: RESIZE.MAX_MEMORY_MB,
    });
  } catch (err) {
    if (/maxResolutionInMP|maxMemoryUsageInMB|memory/i.test(err.message)) {
      const dims = size ? `${size.width}×${size.height}` : 'frame';
      throw new ImageError(
        'too_large',
        `${dims} is too big to downscale here (over ${RESIZE.MAX_RESOLUTION_MP} MP): lower the camera resolution`,
      );
    }
    throw new ImageError('not_jpeg', 'the frame is not a readable JPEG');
  }
  for (let factor = Math.max(2, factorHint); ; factor *= 2) {
    if (Math.floor(decoded.width / factor) < RESIZE.MIN_WIDTH) {
      throw new ImageError(
        'too_large',
        'frame over 150 KB even downscaled: lower the camera resolution or quality',
      );
    }
    const small = shrink(decoded, factor);
    const bytes = jpeg.encode(small, RESIZE.QUALITY).data;
    if (bytes.length <= MAX_JPEG_BYTES) {
      return {
        image: toCameraImage(bytes),
        width: small.width,
        height: small.height,
        bytes: bytes.length,
        factor,
        original: { width: decoded.width, height: decoded.height, bytes: frame.length },
      };
    }
  }
}
