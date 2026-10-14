// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized, and
// the grammar of the `cameras` field.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { MAX_CAMERAS, MIN_REFRESH_SECONDS, NAME_LIMIT } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = {
  cameras: '',
  refresh_seconds: 10,
  allow_self_signed: false,
};
export const BOUNDS = { refresh_seconds: [0, 3600] };

/**
 * Query parameters that carry a credential on old cameras (Foscam
 * `user`/`pwd`, ZoneMinder `user`/`pass`/`auth`/`token`…): left out of the
 * camera id, so changing a password keeps the same Gladys device.
 */
const SECRET_PARAM =
  /^(user|username|usr|login|pass|passwd|password|pwd|psw|token|auth|key|apikey|api_key|access_token|sid|session)$/i;

const decode = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/**
 * The stable id of a camera (the `camera:<id>` external id, forever): the
 * first 12 hex digits of the SHA-256 of its URL without credentials, fragment
 * or credential parameters. A hash, so the external id never shows a path or
 * a token. NEVER change this function: it would duplicate every camera.
 */
export function cameraId(url) {
  const clean = new URL(url);
  clean.username = '';
  clean.password = '';
  clean.hash = '';
  for (const name of [...clean.searchParams.keys()]) {
    if (SECRET_PARAM.test(name)) {
      clean.searchParams.delete(name);
    }
  }
  return createHash('sha256').update(clean.href).digest('hex').slice(0, 12);
}

/**
 * One entry of the `cameras` field: a URL, then an optional name after a
 * space or a `|`:
 *   "http://192.168.1.50:81/stream Garden"
 *   "http://admin:secret@192.168.1.20/cgi-bin/snapshot.cgi|Front door"
 * Only http: and https: URLs. A user name without a password takes the
 * password of the `camera_password` field.
 *   -> { id, url (without credentials), host, name, username, password } or { invalid: true }
 */
export function parseCameraEntry(entry, sharedPassword = '') {
  const text = String(entry ?? '').trim();
  if (!text) {
    return undefined;
  }
  const cut = text.search(/[\s|]/);
  const address = cut === -1 ? text : text.slice(0, cut);
  const name =
    cut === -1
      ? ''
      : text
          .slice(cut + 1)
          .replace(/^[\s|]+/, '')
          .trim();
  let url;
  try {
    url = new URL(address);
  } catch {
    return { invalid: true };
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    return { invalid: true };
  }
  const username = decode(url.username);
  const password = url.password ? decode(url.password) : username ? sharedPassword : '';
  url.username = '';
  url.password = '';
  url.hash = '';
  return {
    id: cameraId(url.href),
    url: url.href,
    host: url.host,
    name: name.slice(0, NAME_LIMIT) || `Camera ${url.host}`,
    username,
    password,
  };
}

/** The `cameras` field: entries separated by commas or new lines. */
export function parseCameras(text, sharedPassword = '') {
  const cameras = [];
  const invalid = [];
  const seen = new Set();
  String(text ?? '')
    .split(/[,\n\r]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry, index) => {
      const parsed = parseCameraEntry(entry, sharedPassword);
      if (parsed.invalid) {
        // The position only: the entry itself may carry a password.
        invalid.push(index + 1);
      } else if (!seen.has(parsed.id) && cameras.length < MAX_CAMERAS) {
        seen.add(parsed.id);
        cameras.push(parsed);
      }
    });
  return { cameras, invalid };
}

/** Seconds between two published images: 0 (on demand only) or 5 to 3600. */
export function refreshSeconds(value) {
  const n = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(n)) {
    return DEFAULTS.refresh_seconds;
  }
  const [min, max] = BOUNDS.refresh_seconds;
  const seconds = Math.min(max, Math.max(min, Math.round(n)));
  return seconds === 0 ? 0 : Math.max(MIN_REFRESH_SECONDS, seconds);
}

export function normalizeConfig(raw = {}) {
  const { cameras, invalid } = parseCameras(raw.cameras, String(raw.camera_password ?? ''));
  return {
    cameras,
    /** Positions (1-based) of the entries that are not http(s) URLs. */
    invalid,
    refreshSeconds: refreshSeconds(raw.refresh_seconds),
    allowSelfSigned: raw.allow_self_signed === true || raw.allow_self_signed === 'true',
  };
}
