// -----------------------------------------------------------------------------
// The only place that talks to the network: one capture of a camera, over
// node:http / node:https (a streamed body, a lenient parser for old cameras,
// self-signed certificates on demand: three things `fetch` cannot do without
// another dependency). The rules (see CLAUDE.md):
//   - http: and https: only, at every redirect too, at most MAX_REDIRECTS;
//   - one deadline for the whole capture: connection, redirects,
//     authentication and the first frame;
//   - the first complete JPEG is kept and the connection closed at once (an
//     MJPEG stream never ends by itself); a frame is bounded (MAX_FRAME_BYTES);
//   - credentials: never sent before the camera asks (401), then Digest when
//     it offers Digest (the password never travels in clear text), Basic
//     otherwise; only to the camera's own origin (or the same host upgraded
//     to https); never in an error message, which never contains the URL.
// The tests run it against a fake camera listening on 127.0.0.1.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { basicAuthorization, digestAuthorization, parseChallenges, pickChallenge } from './auth.js';
import { ACCEPT, HTTP_TIMEOUT, MAX_FRAME_BYTES, MAX_REDIRECTS, USER_AGENT } from './constants.js';
import { FrameError, FrameReader, KINDS, parseContentType } from './mjpeg.js';

/**
 * A failed capture. `code` is one of: http, auth, timeout, too_large,
 * not_jpeg, redirects, protocol, tls, network. The message never contains
 * the URL (it may carry a password or a token).
 */
export class FetchError extends Error {
  constructor(code, message, { status } = {}) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.status = status;
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const CERTIFICATE_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME/;
const HANDSHAKE_CODES = /^ERR_SSL|^ERR_TLS|^EPROTO$/;

/**
 * What a camera's connection remembers between captures: the answered
 * challenge (so the next capture authenticates at once, Digest with the next
 * nonce count) and whether its HTTP answers need the lenient parser.
 */
export function createSession() {
  return { auth: undefined, lenient: false };
}

/** Credentials go to the camera's own origin, or to its host upgraded to https. */
function trusted(first, url) {
  return (
    url.origin === first.origin || (url.hostname === first.hostname && url.protocol === 'https:')
  );
}

function checkProtocol(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError('protocol', `refused ${url.protocol} URL (http and https only)`);
  }
}

function headerValues(rawHeaders, name) {
  const values = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === name) {
      values.push(rawHeaders[i + 1]);
    }
  }
  return values;
}

/** The Authorization header for the next request, from what the session learned. */
function authorization(session, camera, url) {
  const auth = session.auth;
  if (!auth) {
    return undefined;
  }
  if (auth.challenge.scheme === 'basic') {
    return basicAuthorization(camera.username, camera.password);
  }
  auth.nc += 1;
  return digestAuthorization({
    challenge: auth.challenge,
    username: camera.username,
    password: camera.password,
    uri: `${url.pathname}${url.search}`,
    nc: auth.nc,
  });
}

/** One GET; resolves once the status line and headers arrived. */
function get(url, { headers, signal, allowSelfSigned, lenient }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      url,
      {
        method: 'GET',
        headers,
        agent: false,
        signal,
        rejectUnauthorized: !allowSelfSigned,
        insecureHTTPParser: lenient,
      },
      (res) => {
        // The body is read by `firstFrame` (its iterator sees the errors) or
        // dropped by `close`: a reset after that must not crash the process.
        res.on('error', () => {});
        resolve({ req, res });
      },
    );
    // Errors after the answer arrived surface on the body: keep this one quiet.
    req.on('error', reject);
    req.end();
  });
}

const close = ({ req, res }) => {
  res.resume();
  req.destroy();
};

/** Read the answer up to its first frame, then close the connection. */
async function firstFrame({ req, res }, reader) {
  try {
    for await (const chunk of res) {
      const frame = reader.push(chunk);
      if (frame) {
        return frame;
      }
    }
    return reader.end();
  } finally {
    req.destroy();
  }
}

/** Turn any error into a FetchError without the address. */
function failure(err, signal, timeout) {
  if (err instanceof FetchError) {
    return err;
  }
  if (err instanceof FrameError) {
    return new FetchError(err.code, err.message);
  }
  if (signal.aborted || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return new FetchError('timeout', `no image within ${Math.round(timeout / 1000)} s`);
  }
  // Keep the code only (ECONNREFUSED, EHOSTUNREACH…): messages can quote the address.
  const code = err?.code ?? err?.cause?.code;
  if (code && CERTIFICATE_CODES.test(code)) {
    return new FetchError(
      'tls',
      `certificate not trusted (${code}): enable "Accept self-signed certificates" for a camera of your network`,
    );
  }
  if (code && HANDSHAKE_CODES.test(code)) {
    // Old firmwares often speak only TLS 1.0/1.1, refused by Node 22.
    return new FetchError('tls', `TLS handshake failed (${code}): try the camera's http address`);
  }
  return new FetchError('network', code ? `network error (${code})` : 'network error');
}

/**
 * Capture the first frame of a camera.
 *   camera: { url (without credentials), username, password }
 * Resolves { jpeg (a Buffer starting with SOI), kind ('snapshot' | 'stream'),
 * contentType }. Throws a FetchError.
 */
export async function captureFrame(
  camera,
  {
    session = createSession(),
    timeout = HTTP_TIMEOUT,
    maxBytes = MAX_FRAME_BYTES,
    maxRedirects = MAX_REDIRECTS,
    allowSelfSigned = false,
  } = {},
) {
  const signal = AbortSignal.timeout(Math.max(1, timeout));
  try {
    const first = new URL(camera.url);
    first.username = '';
    first.password = '';
    const hasCredentials = Boolean(camera.username || camera.password);
    let url = first;
    let hops = 0;
    let answered = 0;
    let fresh = false;
    for (;;) {
      checkProtocol(url);
      const headers = { 'User-Agent': USER_AGENT, Accept: ACCEPT, Connection: 'close' };
      const sendsAuth = hasCredentials && trusted(first, url) && Boolean(session.auth);
      if (sendsAuth) {
        headers.Authorization = authorization(session, camera, url);
      }
      let exchange;
      try {
        exchange = await get(url, { headers, signal, allowSelfSigned, lenient: session.lenient });
      } catch (err) {
        // An old camera with a malformed HTTP answer: once more, leniently.
        if (!session.lenient && String(err?.code ?? '').startsWith('HPE_')) {
          session.lenient = true;
          continue;
        }
        throw err;
      }
      const { res } = exchange;
      const status = res.statusCode;
      if (REDIRECTS.has(status)) {
        const location = res.headers.location;
        close(exchange);
        if (!location) {
          throw new FetchError('http', `HTTP ${status} without a Location`, { status });
        }
        if (hops >= maxRedirects) {
          throw new FetchError('redirects', `more than ${maxRedirects} redirects`);
        }
        hops += 1;
        url = new URL(location, url);
        url.username = '';
        url.password = '';
        continue;
      }
      if (status === 401 && hasCredentials && trusted(first, url)) {
        const challenges = parseChallenges(headerValues(res.rawHeaders, 'www-authenticate'));
        const challenge = pickChallenge(challenges);
        close(exchange);
        if (!challenge && challenges.length > 0) {
          // Never answer an unknown scheme (or Digest auth-int) with Basic.
          const schemes = [...new Set(challenges.map((c) => c.scheme))].join(', ');
          throw new FetchError('auth', `unsupported authentication (${schemes})`, { status });
        }
        const stale = String(challenge?.params?.stale).toLowerCase() === 'true';
        // A fresh answer refused is a wrong password; an old nonce is retried.
        if (sendsAuth && fresh && !stale) {
          throw new FetchError('auth', 'user name or password refused (HTTP 401)', { status });
        }
        if (answered >= 3) {
          throw new FetchError('auth', 'authentication loop (HTTP 401)', { status });
        }
        if (!challenge && sendsAuth) {
          throw new FetchError('auth', 'user name or password refused (HTTP 401)', { status });
        }
        // No WWW-Authenticate at all: some cameras still take Basic.
        session.auth = { challenge: challenge ?? { scheme: 'basic', params: {} }, nc: 0 };
        answered += 1;
        fresh = true;
        continue;
      }
      if (status === 401 || status === 403) {
        close(exchange);
        throw new FetchError(
          'auth',
          hasCredentials
            ? `access refused (HTTP ${status})`
            : `the camera asks for a user name and password (HTTP ${status})`,
          { status },
        );
      }
      if (status < 200 || status > 299) {
        close(exchange);
        throw new FetchError('http', `HTTP ${status}`, { status });
      }
      const type = parseContentType(res.headers['content-type']);
      const length = Number(res.headers['content-length']);
      if (!type.multipart && Number.isFinite(length) && length > maxBytes) {
        close(exchange);
        throw new FetchError(
          'too_large',
          `image over ${Math.round(maxBytes / 1024 / 1024)} MB (lower the camera resolution)`,
        );
      }
      const reader = new FrameReader({ boundary: type.boundary, maxBytes });
      const jpeg = await firstFrame(exchange, reader);
      if (!jpeg) {
        throw new FetchError('not_jpeg', `not a JPEG image (${type.mime || 'no content type'})`);
      }
      return {
        jpeg,
        kind: type.multipart ? KINDS.STREAM : KINDS.SNAPSHOT,
        contentType: type.mime,
      };
    }
  } catch (err) {
    throw failure(err, signal, timeout);
  }
}
