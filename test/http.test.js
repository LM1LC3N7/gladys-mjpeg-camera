// -----------------------------------------------------------------------------
// One capture against the fake camera on 127.0.0.1: snapshot, MJPEG stream
// (the connection closed after the first frame), Basic, Digest (MD5,
// SHA-256, a cached nonce, a stale one), redirects, timeout, size, the
// lenient parser, and errors that never quote the address.
// -----------------------------------------------------------------------------

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { captureFrame, createSession, FetchError } from '../src/http.js';
import { parseCameraEntry } from '../src/config.js';
import { USER_AGENT } from '../src/constants.js';
import {
  basic,
  digest,
  hang,
  redirect,
  snapshot,
  startFakeCamera,
  startRawCamera,
  status,
  stream,
} from './helpers/fakeCamera.js';
import { tinyJpeg } from './helpers/jpegs.js';

const A = tinyJpeg({ seed: 1 });
const B = tinyJpeg({ seed: 2 });

let cam;
before(async () => {
  cam = await startFakeCamera();
});
after(() => cam.close());

const entry = (path, auth) => parseCameraEntry(cam.url(path, auth));
const capture = (path, auth, options) => captureFrame(entry(path, auth), options);
const waitFor = async (check) => {
  for (let i = 0; i < 100 && !check(); i += 1) await delay(10);
  assert.ok(check());
};

test('a snapshot: the JPEG, identified, without credentials sent unasked', async () => {
  cam.route('/capture', snapshot(A));
  const result = await capture('/capture');
  assert.deepEqual(result.jpeg, A);
  assert.equal(result.kind, 'snapshot');
  const request = cam.requests.at(-1);
  assert.equal(request.headers['user-agent'], USER_AGENT);
  assert.equal(request.headers.authorization, undefined);
});

test('an MJPEG stream: the first frame, then the connection is closed', async () => {
  const withLength = stream([A, B]);
  const withoutLength = stream([B, A], { contentLength: false, chunkSize: 97 });
  cam.route('/stream', withLength);
  cam.route('/esp32', withoutLength);
  const first = await capture('/stream');
  assert.equal(first.kind, 'stream');
  assert.deepEqual(first.jpeg, A);
  assert.deepEqual((await capture('/esp32')).jpeg, B);
  await waitFor(() => withLength.stats.closed === 1 && withoutLength.stats.closed === 1);
  assert.ok(withLength.stats.sent < 10, 'the stream was not read on');
});

test('Digest MD5 and SHA-256: the challenge answered, then reused without a 401', async () => {
  const md5 = digest(snapshot(A), { user: 'admin', pass: 'pa:ss word' });
  const sha = digest(snapshot(B), {
    user: 'admin',
    pass: 'secret',
    // Two headers, the strongest second: the camera of the RFC example.
    challenges: (nonce) => [
      `Digest realm="IP Camera", qop="auth", algorithm=MD5, nonce="${nonce}", opaque="o"`,
      `Digest realm="IP Camera", qop="auth", algorithm=SHA-256, nonce="${nonce}", opaque="o"`,
    ],
  });
  cam.route('/cgi-bin/snapshot.cgi', md5);
  cam.route('/sha', sha);
  const session = createSession();
  const auth = { user: 'admin', pass: 'pa:ss word' };
  assert.deepEqual((await capture('/cgi-bin/snapshot.cgi?channel=1', auth, { session })).jpeg, A);
  const before = cam.requests.length;
  await capture('/cgi-bin/snapshot.cgi?channel=1', auth, { session });
  assert.equal(cam.requests.length - before, 1, 'the cached challenge, nonce count 2');
  assert.match(cam.requests.at(-1).headers.authorization, /nc=00000002/);
  assert.doesNotMatch(cam.requests.at(-1).headers.authorization, /pa:ss/);
  assert.deepEqual((await capture('/sha', { user: 'admin', pass: 'secret' })).jpeg, B);
  assert.match(cam.requests.at(-1).headers.authorization, /algorithm=SHA-256/);
});

test('Digest: a stale nonce is renewed; a wrong password is an auth error', async () => {
  const handler = digest(snapshot(A), { user: 'admin', pass: 'pw', nonceUses: 1 });
  cam.route('/stale', handler);
  const session = createSession();
  await capture('/stale', { user: 'admin', pass: 'pw' }, { session });
  await capture('/stale', { user: 'admin', pass: 'pw' }, { session });
  assert.equal(handler.state.accepted, 2);
  const err = await capture('/stale', { user: 'admin', pass: 'wrong' }).catch((e) => e);
  assert.ok(err instanceof FetchError);
  assert.equal(err.code, 'auth');
  assert.match(err.message, /refused/);
  const none = await capture('/stale').catch((e) => e);
  assert.match(none.message, /asks for a user name and password/);
});

test('Basic after the challenge, and a shared password for a URL with a user only', async () => {
  cam.route('/basic', basic(snapshot(A), { user: 'viewer', pass: 'shared-secret' }));
  const camera = parseCameraEntry(
    `${cam.url('/basic', { user: 'viewer' })} Porch`,
    'shared-secret',
  );
  assert.equal(camera.password, 'shared-secret');
  assert.deepEqual((await captureFrame(camera)).jpeg, A);
});

test('redirects: followed up to 3, credentials only for the same origin', async () => {
  cam.route('/r1', redirect('/r2', 301));
  cam.route('/r2', redirect('/r3', 307));
  cam.route('/r3', redirect('/capture', 302));
  cam.route('/r0', redirect('/r1'));
  cam.route('/away', redirect(`http://localhost:${cam.port}/protected`));
  cam.route('/protected', basic(snapshot(A), { user: 'u', pass: 'p' }));
  cam.route('/to-file', redirect('file:///etc/passwd'));
  assert.deepEqual((await capture('/r1')).jpeg, A);
  const tooMany = await capture('/r0').catch((e) => e);
  assert.equal(tooMany.code, 'redirects');
  const away = await capture('/away', { user: 'u', pass: 'p' }).catch((e) => e);
  assert.equal(away.code, 'auth', 'localhost is another origin: no password sent there');
  assert.equal(cam.requests.at(-1).headers.authorization, undefined);
  assert.equal((await capture('/to-file').catch((e) => e)).code, 'protocol');
});

test('errors: timeout, HTTP status, not a JPEG, too large; never the address', async () => {
  cam.route('/hang', hang());
  cam.route('/missing', status(404, 'nope'));
  cam.route('/login', status(200, '<html>login</html>'));
  cam.route('/huge', snapshot(Buffer.concat([A, Buffer.alloc(5000)])));
  cam.route('/huge-stream', stream([A], { contentLength: false }));
  const cases = [
    ['/hang', 'timeout', { timeout: 200 }],
    ['/missing', 'http'],
    ['/login', 'not_jpeg'],
    ['/huge', 'too_large', { maxBytes: 1000 }],
    ['/huge-stream', 'too_large', { maxBytes: 200 }],
  ];
  for (const [path, code, options] of cases) {
    const err = await capture(
      `${path}?token=t0k3n`,
      { user: 'admin', pass: 's3cret' },
      options,
    ).catch((e) => e);
    assert.equal(err.code, code, path);
    assert.doesNotMatch(err.message, /127\.0\.0\.1|t0k3n|s3cret|admin/, path);
  }
  const refused = await captureFrame({ url: 'http://127.0.0.1:1/x' }).catch((e) => e);
  assert.equal(refused.code, 'network');
  assert.match(refused.message, /ECONNREFUSED/);
});

test('an old camera with LF-only headers is read by the lenient parser', async () => {
  const raw = await startRawCamera(
    Buffer.concat([Buffer.from('HTTP/1.0 200 OK\nContent-Type: image/jpeg\n\n', 'latin1'), A]),
  );
  try {
    const session = createSession();
    const result = await captureFrame({ url: raw.url('/snapshot.jpg') }, { session });
    assert.deepEqual(result.jpeg, A);
    assert.equal(session.lenient, true, 'remembered for the next captures');
  } finally {
    await raw.close();
  }
});

/** A throwaway self-signed certificate (openssl, in a temporary directory), or undefined. */
function selfSigned() {
  const dir = mkdtempSync(join(tmpdir(), 'mjpeg-tls-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
      ].concat(
        ['-subj', '/CN=127.0.0.1', '-days', '1'],
        ['-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')],
      ),
      { stdio: 'ignore' },
    );
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tls = selfSigned();

test(
  'https: a self-signed camera is refused, unless the user accepts it',
  { skip: !tls },
  async () => {
    const server = https.createServer(tls, snapshot(A));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const camera = { url: `https://127.0.0.1:${server.address().port}/snapshot.jpg` };
      const refused = await captureFrame(camera).catch((e) => e);
      assert.equal(refused.code, 'tls');
      assert.match(refused.message, /Accept self-signed certificates/);
      assert.deepEqual((await captureFrame(camera, { allowSelfSigned: true })).jpeg, A);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
