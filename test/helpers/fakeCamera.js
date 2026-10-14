// -----------------------------------------------------------------------------
// A fake camera for the tests: an HTTP server on 127.0.0.1 (never the
// network) with routes playing a snapshot URL, an MJPEG stream (with and
// without Content-Length per part), Basic and Digest authentication,
// redirects, a camera that never answers, and a raw TCP camera for the
// malformed answers of old firmwares. Digest is checked here with its own
// code, straight from RFC 7616, so a bug in src/auth.js is not mirrored.
// -----------------------------------------------------------------------------

import http from 'node:http';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

export async function startFakeCamera() {
  const routes = new Map();
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://camera').pathname;
    requests.push({ path, url: req.url, headers: req.headers });
    const handler = routes.get(path);
    if (!handler) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    handler(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    requests,
    route(path, handler) {
      routes.set(path, handler);
    },
    url(path, { user, pass } = {}) {
      const auth = user
        ? `${encodeURIComponent(user)}${pass === undefined ? '' : `:${encodeURIComponent(pass)}`}@`
        : '';
      return `http://${auth}127.0.0.1:${port}${path}`;
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A JPEG snapshot URL. */
export function snapshot(jpeg, { contentType = 'image/jpeg', length = true } = {}) {
  return (req, res) => {
    const headers = { 'content-type': contentType };
    if (length) {
      headers['content-length'] = jpeg.length;
    }
    res.writeHead(200, headers);
    res.end(jpeg);
  };
}

/**
 * An endless MJPEG stream cycling over `frames`. `stats` tells how many
 * connections were opened and closed (the client must hang up after its frame).
 */
export function stream(
  frames,
  {
    boundary = 'frame',
    declared = boundary,
    contentLength = true,
    intervalMs = 15,
    chunkSize = 0,
    contentType = `multipart/x-mixed-replace; boundary=${declared}`,
  } = {},
) {
  const stats = { opened: 0, closed: 0, sent: 0 };
  const handler = (req, res) => {
    stats.opened += 1;
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
    let index = 0;
    const writeNext = () => {
      const frame = frames[index % frames.length];
      index += 1;
      const head = `--${boundary}\r\nContent-Type: image/jpeg\r\n${
        contentLength ? `Content-Length: ${frame.length}\r\n` : ''
      }\r\n`;
      const part = Buffer.concat([Buffer.from(head, 'latin1'), frame, Buffer.from('\r\n')]);
      if (chunkSize > 0) {
        for (let i = 0; i < part.length; i += chunkSize) {
          res.write(part.subarray(i, i + chunkSize));
        }
      } else {
        res.write(part);
      }
      stats.sent += 1;
    };
    writeNext();
    const timer = setInterval(writeNext, intervalMs);
    res.on('close', () => {
      clearInterval(timer);
      stats.closed += 1;
    });
  };
  return Object.assign(handler, { stats });
}

/** A camera that accepts the connection and never answers. */
export const hang = () => () => {};

export const status =
  (code, body = '', headers = { 'content-type': 'text/html' }) =>
  (req, res) => {
    res.writeHead(code, headers);
    res.end(body);
  };

export const redirect =
  (location, code = 302) =>
  (req, res) => {
    res.writeHead(code, { location });
    res.end();
  };

/** Basic authentication in front of `inner`. */
export function basic(inner, { user, pass, realm = 'camera' }) {
  const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  return (req, res) => {
    if (req.headers.authorization === expected) {
      inner(req, res);
      return;
    }
    res.writeHead(401, { 'www-authenticate': `Basic realm="${realm}"` });
    res.end('unauthorized');
  };
}

const parseAuthorization = (header) => {
  const params = {};
  for (const [, key, quoted, bare] of String(header).matchAll(
    /(\w+)=(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g,
  )) {
    params[key.toLowerCase()] = quoted ?? bare;
  }
  return params;
};

/**
 * Digest authentication (RFC 7616) in front of `inner`. `challenges` lists
 * the WWW-Authenticate values sent (several headers, as real cameras do).
 * `nonceUses`: after that many accepted requests the nonce is declared stale.
 */
export function digest(
  inner,
  {
    user,
    pass,
    realm = 'IP Camera',
    algorithm = 'MD5',
    qop = 'auth',
    opaque = 'b2c3',
    nonceUses = Infinity,
    challenges,
  },
) {
  const state = { nonce: randomBytes(8).toString('hex'), uses: 0, seenNc: new Set(), accepted: 0 };
  const hashOf = (alg) => ({ MD5: 'md5', 'SHA-256': 'sha256' })[alg.replace(/-sess$/i, '')];
  const challenge = (stale) =>
    challenges?.(state.nonce, stale) ?? [
      `Digest realm="${realm}", ${qop ? `qop="${qop}", ` : ''}nonce="${state.nonce}", opaque="${opaque}", algorithm=${algorithm}${stale ? ', stale=true' : ''}`,
    ];
  const refuse = (res, stale = false) => {
    res.writeHead(401, { 'www-authenticate': challenge(stale), 'content-type': 'text/html' });
    res.end('<html>401</html>');
  };
  const handler = (req, res) => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Digest ')) {
      refuse(res);
      return;
    }
    const p = parseAuthorization(header.slice(7));
    const alg = p.algorithm ?? 'MD5';
    const H = (text) => createHash(hashOf(alg)).update(text).digest('hex');
    let ha1 = H(`${user}:${realm}:${pass}`);
    if (/-sess$/i.test(alg)) {
      ha1 = H(`${ha1}:${p.nonce}:${p.cnonce}`);
    }
    const ha2 = H(`${req.method}:${p.uri}`);
    const expected = p.qop
      ? H(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`)
      : H(`${ha1}:${p.nonce}:${ha2}`);
    if (p.username !== user || p.response !== expected || p.uri !== req.url) {
      refuse(res);
      return;
    }
    if (p.nonce !== state.nonce || state.uses >= nonceUses) {
      state.nonce = randomBytes(8).toString('hex');
      state.uses = 0;
      refuse(res, true);
      return;
    }
    if (p.qop && state.seenNc.has(`${p.nonce}:${p.nc}`)) {
      refuse(res); // a replayed nonce count
      return;
    }
    state.seenNc.add(`${p.nonce}:${p.nc}`);
    state.uses += 1;
    state.accepted += 1;
    inner(req, res);
  };
  return Object.assign(handler, { state });
}

/** A camera speaking raw bytes (malformed HTTP of old firmwares). */
export async function startRawCamera(answer) {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', () => socket.end(answer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
