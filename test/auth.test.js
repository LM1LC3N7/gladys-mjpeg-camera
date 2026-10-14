// -----------------------------------------------------------------------------
// Basic and Digest: the RFC 7616 example (section 3.9.1), the challenge
// parser, the choice between several challenges.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  basicAuthorization,
  digestAuthorization,
  parseChallenges,
  pickChallenge,
} from '../src/auth.js';

const RFC = {
  realm: 'http-auth@example.org',
  nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
  opaque: 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS',
  cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ',
};

const response = (header) => /response="([0-9a-f]+)"/.exec(header)[1];

test('the RFC 7616 example, MD5 and SHA-256', () => {
  const challenges = parseChallenges([
    `Digest realm="${RFC.realm}", qop="auth, auth-int", algorithm=SHA-256, nonce="${RFC.nonce}", opaque="${RFC.opaque}"`,
    `Digest realm="${RFC.realm}", qop="auth, auth-int", algorithm=MD5, nonce="${RFC.nonce}", opaque="${RFC.opaque}"`,
  ]);
  assert.equal(challenges.length, 2);
  const chosen = pickChallenge(challenges);
  assert.equal(chosen.params.algorithm, 'SHA-256', 'the strongest one');
  const answer = (challenge) =>
    digestAuthorization({
      challenge,
      username: 'Mufasa',
      password: 'Circle of Life',
      uri: '/dir/index.html',
      nc: 1,
      cnonce: RFC.cnonce,
    });
  const sha = answer(chosen);
  assert.equal(response(sha), '753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1');
  assert.match(sha, /qop=auth, nc=00000001, cnonce="f2\/wE4/);
  assert.match(sha, /opaque="FQhe/);
  assert.match(sha, /algorithm=SHA-256/);
  assert.equal(response(answer(challenges[1])), '8ca523f5e9506fed4657c9700eebdbec');
});

test('the old RFC 2069 form (no qop) and the -sess variants', () => {
  const [legacy] = parseChallenges('Digest realm="cam", nonce="abc"');
  const header = digestAuthorization({
    challenge: legacy,
    username: 'admin',
    password: 'pw',
    uri: '/snapshot.jpg',
  });
  assert.doesNotMatch(header, /qop|nc=|cnonce/);
  assert.doesNotMatch(header, /algorithm/, 'not sent when the camera did not name one');
  const [sess] = parseChallenges('Digest realm="cam", nonce="abc", qop=auth, algorithm=MD5-sess');
  const a = digestAuthorization({
    challenge: sess,
    username: 'u',
    password: 'p',
    uri: '/',
    cnonce: 'x',
  });
  const b = digestAuthorization({
    challenge: sess,
    username: 'u',
    password: 'p',
    uri: '/',
    cnonce: 'y',
  });
  assert.notEqual(response(a), response(b), 'the session key depends on the cnonce');
});

test('challenges: several per header, Basic as a fallback, auth-int only refused', () => {
  const both = parseChallenges('Basic realm="cam", Digest realm="cam", nonce="n1", qop="auth"');
  assert.deepEqual(
    both.map((c) => c.scheme),
    ['basic', 'digest'],
  );
  assert.equal(pickChallenge(both).scheme, 'digest', 'Digest keeps the password off the wire');
  assert.equal(pickChallenge(parseChallenges('Basic realm="x"')).scheme, 'basic');
  assert.equal(
    pickChallenge(parseChallenges('Digest realm="x", nonce="n", qop="auth-int"')),
    undefined,
  );
  assert.equal(pickChallenge(parseChallenges('NTLM')), undefined);
  const [escaped] = parseChallenges('Digest realm="a \\"quoted\\" realm", nonce="n"');
  assert.equal(escaped.params.realm, 'a "quoted" realm');
  assert.equal(
    basicAuthorization('admin', 'pâss'),
    `Basic ${Buffer.from('admin:pâss').toString('base64')}`,
  );
});
