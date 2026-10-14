// -----------------------------------------------------------------------------
// The first complete JPEG of an HTTP answer, fed chunk by chunk. Pure (no
// I/O): http.js pushes the bytes and aborts the connection as soon as a frame
// comes out.
//
// Three shapes are handled:
//   - a snapshot (image/jpeg): the body is one JPEG;
//   - an MJPEG stream (multipart/x-mixed-replace; boundary=...): parts
//     "--boundary", headers, a blank line, a JPEG. With a Content-Length per
//     part (mjpg-streamer, motion) the length gives the end of the frame;
//     without it (ESP32-CAM sketches, many IP cameras) the JPEG structure
//     does (jpeg.js), and the next boundary is the last resort;
//   - a raw stream of JPEGs, or a boundary declared wrong: the first SOI.
// -----------------------------------------------------------------------------

import { MAX_FRAME_BYTES, MAX_PREAMBLE_BYTES } from './constants.js';
import { JpegScanner, findSoi, isJpeg } from './jpeg.js';

export const KINDS = { SNAPSHOT: 'snapshot', STREAM: 'stream' };

/** A frame cannot be read: `code` is too_large or not_jpeg. */
export class FrameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FrameError';
    this.code = code;
  }
}

/** "multipart/x-mixed-replace; boundary=frame" -> { mime, multipart, boundary }. */
export function parseContentType(value) {
  const [type = '', ...params] = String(value ?? '').split(';');
  const mime = type.trim().toLowerCase();
  let boundary;
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq !== -1 && param.slice(0, eq).trim().toLowerCase() === 'boundary') {
      boundary = param
        .slice(eq + 1)
        .trim()
        .replace(/^"(.*)"$/, '$1');
    }
  }
  return { mime, multipart: mime.startsWith('multipart/'), boundary: boundary || undefined };
}

const CRLFCRLF = Buffer.from('\r\n\r\n');
const LFLF = Buffer.from('\n\n');

export class FrameReader {
  /**
   * `boundary`: the multipart boundary, if any. Cameras disagree on the
   * dashes (declared "--frame", sent "--frame" or "----frame"): the leading
   * dashes are ignored and the bare token is searched.
   */
  constructor({ boundary, maxBytes = MAX_FRAME_BYTES, maxPreamble = MAX_PREAMBLE_BYTES } = {}) {
    const token = String(boundary ?? '').replace(/^-+/, '');
    this.token = token ? Buffer.from(token, 'latin1') : undefined;
    this.maxBytes = maxBytes;
    this.maxPreamble = maxPreamble;
    this.buf = Buffer.alloc(0);
    this.len = 0;
    this.phase = 'head';
    this.searchFrom = 0;
    this.frameStart = -1;
    this.frameEnd = -1;
    this.scanner = undefined;
    this.moved = false;
  }

  get bytes() {
    return this.buf.subarray(0, this.len);
  }

  append(chunk) {
    if (this.len + chunk.length > this.buf.length) {
      const next = Buffer.allocUnsafe(
        Math.max(this.buf.length * 2, this.len + chunk.length, 65536),
      );
      this.buf.copy(next, 0, 0, this.len);
      this.buf = next;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
  }

  tooLarge() {
    return new FrameError(
      'too_large',
      `frame over ${Math.round(this.maxBytes / 1024 / 1024)} MB (lower the camera resolution)`,
    );
  }

  frame(start, end) {
    if (end - start > this.maxBytes) {
      throw this.tooLarge();
    }
    return Buffer.from(this.buf.subarray(start, end));
  }

  /** Push the next bytes; returns the first complete frame, else undefined. */
  push(chunk) {
    this.append(chunk);
    if (this.frameStart === -1 && this.len > this.maxPreamble + this.maxBytes) {
      throw new FrameError('not_jpeg', 'no JPEG image in the answer');
    }
    if (this.frameStart !== -1 && this.len - this.frameStart > this.maxBytes) {
      throw this.tooLarge();
    }
    for (;;) {
      this.moved = false;
      const frame = this.step();
      if (frame || !this.moved) {
        return frame;
      }
    }
  }

  /** Move the state machine on: `push` then runs the next step at once. */
  go(phase, changes = {}) {
    Object.assign(this, changes, { phase, moved: true });
  }

  /** One step of the state machine. */
  step() {
    const bytes = this.bytes;
    switch (this.phase) {
      case 'head':
        return this.head(bytes);
      case 'length':
        return this.byLength(bytes);
      case 'scan':
        return this.byStructure(bytes);
      case 'boundary':
        return this.byBoundary(bytes);
      default:
        return undefined; // 'tail': only the end of the body tells
    }
  }

  /** Looking for the start of the first frame. */
  head(bytes) {
    if (this.token) {
      const at = bytes.indexOf(this.token, this.searchFrom);
      if (at === -1) {
        if (this.len > this.maxPreamble) {
          // The declared boundary never came: look for the first SOI instead.
          this.go('head', { token: undefined, searchFrom: 0 });
          return undefined;
        }
        this.searchFrom = Math.max(0, this.len - this.token.length);
        return undefined;
      }
      const crlf = bytes.indexOf(CRLFCRLF, at);
      const lf = bytes.indexOf(LFLF, at);
      const blank = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf : lf;
      if (blank === -1) {
        return undefined; // the part headers are not complete yet
      }
      const bodyStart = blank + (blank === crlf ? 4 : 2);
      const headers = bytes.subarray(at + this.token.length, blank).toString('latin1');
      const lengthMatch = /(?:^|\n)\s*content-length\s*:\s*(\d+)/i.exec(headers);
      if (bodyStart + 8 > this.len) {
        return undefined;
      }
      const soi = findSoi(bytes, bodyStart, Math.min(this.len, bodyStart + 8));
      if (soi === -1) {
        // Not a JPEG right after the headers: look for one further on.
        this.go('head', { token: undefined, searchFrom: bodyStart });
        return undefined;
      }
      const length = lengthMatch ? Number(lengthMatch[1]) : 0;
      if (length > this.maxBytes) {
        throw this.tooLarge();
      }
      if (length > 0) {
        this.go('length', { frameStart: soi, frameEnd: bodyStart + length });
      } else {
        this.go('scan', { frameStart: soi, scanner: new JpegScanner(soi) });
      }
      return undefined;
    }
    const soi = findSoi(bytes, this.searchFrom);
    if (soi === -1) {
      this.searchFrom = Math.max(0, this.len - 2);
      return undefined;
    }
    this.go('scan', { frameStart: soi, scanner: new JpegScanner(soi) });
    return undefined;
  }

  /** The part announced its length: trust it if it ends on EOI. */
  byLength(bytes) {
    if (this.len < this.frameEnd) {
      return undefined;
    }
    // Some cameras count a trailing CRLF in the length: look for EOI near the end.
    for (let i = this.frameEnd - 2; i >= Math.max(this.frameStart, this.frameEnd - 8); i -= 1) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
        return this.frame(this.frameStart, i + 2);
      }
    }
    this.go('scan', { scanner: new JpegScanner(this.frameStart) });
    return undefined;
  }

  /** Walk the JPEG segments up to EOI. */
  byStructure(bytes) {
    try {
      const end = this.scanner.scan(bytes, this.len);
      return end === -1 ? undefined : this.frame(this.frameStart, end);
    } catch {
      // Not a clean JPEG structure: the next boundary, or the end of the body.
      this.go(this.token ? 'boundary' : 'tail', { searchFrom: this.frameStart + 2 });
      return undefined;
    }
  }

  /** The frame ends where the next part starts. */
  byBoundary(bytes) {
    const at = bytes.indexOf(this.token, this.searchFrom);
    if (at === -1) {
      this.searchFrom = Math.max(this.frameStart, this.len - this.token.length);
      return undefined;
    }
    let end = at;
    while (end > this.frameStart && (bytes[end - 1] === 0x2d || bytes[end - 1] <= 0x20)) {
      end -= 1; // the "--" of the delimiter and the CRLF before it
    }
    return this.frame(this.frameStart, end);
  }

  /**
   * The body ended (a snapshot, or a stream the camera closed): the frame in
   * progress, if it looks like a JPEG, even without its EOI (some cameras
   * omit it); otherwise undefined.
   */
  end() {
    const bytes = this.bytes;
    let start = this.frameStart;
    if (start === -1) {
      start = findSoi(bytes, 0);
    }
    if (start === -1 || !isJpeg(bytes, start)) {
      return undefined;
    }
    let end = this.phase === 'length' ? Math.min(this.len, this.frameEnd) : this.len;
    // Bytes after a final EOI (a CRLF, padding) are not part of the image.
    for (let i = end - 2; i >= Math.max(start, end - 8); i -= 1) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
        end = i + 2;
        break;
      }
    }
    return this.frame(start, end);
  }
}
