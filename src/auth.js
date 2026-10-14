// -----------------------------------------------------------------------------
// HTTP authentication of the cameras: Basic and Digest (RFC 7616: MD5,
// SHA-256 and SHA-512-256, their "-sess" variants, qop=auth, and the RFC 2069
// form without qop that old IP cameras still use). Pure: http.js sends.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';

const HASHES = { md5: 'md5', 'sha-256': 'sha256', 'sha-512-256': 'sha512-256' };
/** Strongest first: the one picked when a camera offers several. */
const STRENGTH = ['sha-512-256', 'sha-256', 'md5'];

/**
 * The challenges of WWW-Authenticate header values (RFC 7235: several
 * challenges per header, comma separated, quoted strings with escapes):
 *   ['Digest realm="cam", qop="auth", nonce="abc"', 'Basic realm="cam"']
 *   -> [{ scheme: 'digest', params: { realm: 'cam', qop: 'auth', nonce: 'abc' } },
 *       { scheme: 'basic', params: { realm: 'cam' } }]
 */
export function parseChallenges(values) {
  const challenges = [];
  for (const value of [values].flat()) {
    const text = String(value ?? '');
    let i = 0;
    let current;
    while (i < text.length) {
      while (i < text.length && /[\s,]/.test(text[i])) i += 1;
      const start = i;
      while (i < text.length && !/[\s,=]/.test(text[i])) i += 1;
      const token = text.slice(start, i);
      if (!token) {
        i += 1;
        continue;
      }
      let j = i;
      while (j < text.length && text[j] === ' ') j += 1;
      if (text[j] === '=' && current) {
        // name=value: a parameter of the current challenge.
        i = j + 1;
        while (i < text.length && text[i] === ' ') i += 1;
        let value = '';
        if (text[i] === '"') {
          i += 1;
          while (i < text.length && text[i] !== '"') {
            if (text[i] === '\\' && i + 1 < text.length) i += 1;
            value += text[i];
            i += 1;
          }
          i += 1;
        } else {
          const begin = i;
          while (i < text.length && text[i] !== ',') i += 1;
          value = text.slice(begin, i).trim();
        }
        current.params[token.toLowerCase()] = value;
      } else if (text[j] === '=') {
        i = j + 1; // a token68 without a scheme: ignored
      } else {
        current = { scheme: token.toLowerCase(), params: Object.create(null) };
        challenges.push(current);
      }
    }
  }
  return challenges;
}

const algorithmOf = (challenge) => {
  const name = String(challenge.params.algorithm ?? 'MD5').toLowerCase();
  const sess = name.endsWith('-sess');
  const base = sess ? name.slice(0, -5) : name;
  return HASHES[base] ? { base, sess, hash: HASHES[base] } : undefined;
};

const qopsOf = (challenge) =>
  String(challenge.params.qop ?? '')
    .split(',')
    .map((q) => q.trim().toLowerCase())
    .filter(Boolean);

/** Can we answer this Digest challenge (known algorithm, qop "auth" or none)? */
const digestUsable = (challenge) =>
  challenge.scheme === 'digest' &&
  Boolean(challenge.params.nonce) &&
  Boolean(algorithmOf(challenge)) &&
  (qopsOf(challenge).length === 0 || qopsOf(challenge).includes('auth'));

/**
 * The challenge to answer: the strongest usable Digest, else Basic, else
 * undefined (an unsupported scheme, or a Digest with qop=auth-int only).
 */
export function pickChallenge(challenges) {
  const digests = challenges
    .filter(digestUsable)
    .sort((a, b) => STRENGTH.indexOf(algorithmOf(a).base) - STRENGTH.indexOf(algorithmOf(b).base));
  return digests[0] ?? challenges.find((c) => c.scheme === 'basic');
}

export function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

const quote = (value) => `"${String(value).replace(/["\\]/g, '\\$&')}"`;

/**
 * The Authorization header answering a Digest challenge for one request.
 * `nc` is the number of requests already sent with this nonce plus one.
 */
export function digestAuthorization({
  challenge,
  username,
  password,
  method = 'GET',
  uri,
  nc = 1,
  cnonce = randomBytes(16).toString('hex'),
}) {
  const algorithm = algorithmOf(challenge);
  if (!algorithm) {
    throw new Error(`unsupported Digest algorithm ${challenge.params.algorithm}`);
  }
  const H = (text) => createHash(algorithm.hash).update(text, 'utf8').digest('hex');
  const { realm = '', nonce, opaque } = challenge.params;
  const qop = qopsOf(challenge).length > 0 ? 'auth' : undefined;
  const count = nc.toString(16).padStart(8, '0');
  let ha1 = H(`${username}:${realm}:${password}`);
  if (algorithm.sess) {
    ha1 = H(`${ha1}:${nonce}:${cnonce}`);
  }
  const ha2 = H(`${method}:${uri}`);
  const response = qop
    ? H(`${ha1}:${nonce}:${count}:${cnonce}:${qop}:${ha2}`)
    : H(`${ha1}:${nonce}:${ha2}`);
  const userhash = String(challenge.params.userhash).toLowerCase() === 'true';
  const parts = [
    `username=${quote(userhash ? H(`${username}:${realm}`) : username)}`,
    `realm=${quote(realm)}`,
    `nonce=${quote(nonce)}`,
    `uri=${quote(uri)}`,
    `response=${quote(response)}`,
  ];
  if (challenge.params.algorithm) {
    parts.push(`algorithm=${challenge.params.algorithm}`);
  }
  if (opaque !== undefined) {
    parts.push(`opaque=${quote(opaque)}`);
  }
  if (qop) {
    parts.push(`qop=${qop}`, `nc=${count}`, `cnonce=${quote(cnonce)}`);
  }
  if (userhash) {
    parts.push('userhash=true');
  }
  return `Digest ${parts.join(', ')}`;
}
