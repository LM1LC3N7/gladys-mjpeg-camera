// -----------------------------------------------------------------------------
// JPEG structure, without decoding anything. Pure.
//
// A JPEG is SOI (FF D8), segments (FF xx + a 16-bit length), and after each
// SOS (FF DA) entropy-coded data where FF is followed by 00 (stuffing) or a
// restart marker (FF D0-D7); the image ends at EOI (FF D9). Walking the
// segments by their length is what finds the END of the first image of a
// stream: an EXIF thumbnail carries its own SOI/EOI inside the APP1 segment,
// so the first FF D9 of the bytes is not always the end of the frame.
// -----------------------------------------------------------------------------

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const STANDALONE = (code) => code === 0x01 || code === 0xd8 || (code >= 0xd0 && code <= 0xd7);

/** Does the buffer start like a JPEG (SOI then a marker)? */
export function isJpeg(bytes, offset = 0) {
  return (
    bytes.length >= offset + 3 &&
    bytes[offset] === 0xff &&
    bytes[offset + 1] === 0xd8 &&
    bytes[offset + 2] === 0xff
  );
}

/** Offset of the first SOI (FF D8 FF) at or after `from`, or -1. */
export function findSoi(bytes, from = 0, end = bytes.length) {
  for (let i = Math.max(0, from); i + 2 < end; i += 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
      return i;
    }
  }
  return -1;
}

/** { width, height } from the frame header (SOFn), or undefined. */
export function jpegSize(bytes) {
  if (!isJpeg(bytes)) {
    return undefined;
  }
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) {
      return undefined;
    }
    const code = bytes[i + 1];
    if (code === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (STANDALONE(code)) {
      i += 2;
      continue;
    }
    if (code === 0xd9 || code === 0xda) {
      return undefined; // no frame header before the image data
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (SOF.has(code) && i + 8 < bytes.length) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (length < 2) {
      return undefined;
    }
    i += 2 + length;
  }
  return undefined;
}

/**
 * Finds where the JPEG starting at `start` ends, incrementally: call `scan`
 * again when more bytes arrived, it resumes where it stopped. Returns the
 * offset just after EOI, or -1 while the image is incomplete. Throws on bytes
 * that cannot be a JPEG (the caller then falls back on another strategy).
 */
export class JpegScanner {
  constructor(start = 0) {
    this.pos = start + 2; // after SOI
    this.entropy = false;
  }

  scan(bytes, end = bytes.length) {
    let i = this.pos;
    for (;;) {
      if (this.entropy) {
        // Entropy-coded data: skip to the next real marker.
        while (i + 1 < end) {
          if (bytes[i] === 0xff) {
            const next = bytes[i + 1];
            if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
              i += 2;
              continue;
            }
            if (next !== 0xff) {
              break;
            }
          }
          i += 1;
        }
        if (i + 1 >= end) {
          this.pos = i;
          return -1;
        }
        this.entropy = false;
      }
      // At a marker: FF, optional fill bytes FF, then the code.
      if (i >= end) {
        this.pos = i;
        return -1;
      }
      if (bytes[i] !== 0xff) {
        throw new Error('not a JPEG structure');
      }
      let m = i + 1;
      while (m < end && bytes[m] === 0xff) {
        m += 1;
      }
      if (m >= end) {
        this.pos = i;
        return -1;
      }
      const code = bytes[m];
      if (code === 0xd9) {
        return m + 1;
      }
      if (STANDALONE(code)) {
        i = m + 1;
        continue;
      }
      if (m + 2 >= end) {
        this.pos = i;
        return -1;
      }
      const length = (bytes[m + 1] << 8) | bytes[m + 2];
      if (length < 2) {
        throw new Error('not a JPEG structure');
      }
      const next = m + 1 + length;
      if (next > end) {
        this.pos = i; // the segment is not complete yet: read it again later
        return -1;
      }
      i = next;
      if (code === 0xda) {
        this.entropy = true;
      }
    }
  }
}
