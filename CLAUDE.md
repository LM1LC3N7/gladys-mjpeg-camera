# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15). It
reads **HTTP cameras of the local network** (JPEG snapshot URLs and MJPEG
streams: ESP32-CAM, older IP cameras, motion, motionEye, mjpg-streamer) and
turns each into a Gladys camera device: periodic images
(`publishCameraImage`), a fresh image on demand (`onGetImage`), offline /
online scene triggers, a transport badge and a "Test cameras" button. No
ffmpeg, no RTSP (Gladys ships its own RTSP camera integration). Not
affiliated with any camera maker.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/http.test.js             # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` and `audit` before every commit.

## Architecture

```
index.js            SDK wiring only (handlers registered before connect())
src/app.js          MjpegCameraApp: cameras, discovery, periodic images,
                    onGetImage, health, badges, status, test button
src/http.js         the only network access: one capture over node:http(s)
                    (redirects, deadline, auth retry, lenient parser)
src/auth.js         Basic, Digest RFC 7616: challenges, Authorization (pure)
src/mjpeg.js        content type, the first JPEG of an answer (pure)
src/jpeg.js         JPEG markers: SOI, size, structural end (pure)
src/image.js        the camera image: as is, or downscaled with jpeg-js
src/devices.js      camera devices, external ids, transport badges (pure)
src/triggers.js     capture outcomes -> health -> scene events (pure)
src/config.js       config_schema normalized, the `cameras` grammar, ids
src/constants.js    timeouts, limits, pacing, manifest keys
src/i18n.js         runtime texts (en/fr)
test/helpers/       fake camera (HTTP on 127.0.0.1 + a raw TCP one), JPEG
                    generators, fake timers; Gladys is the SDK's fake
```

## The `cameras` grammar

Entries separated by commas or new lines (the store has no textarea type:
the field is a `string`). Each entry is a URL, then an optional name after
the first space or `|`:

```
http://192.168.1.50:81/stream Garden, http://admin@192.168.1.20/cgi-bin/snapshot.cgi|Front door
```

Only `http:` and `https:`; an invalid entry is reported by its position,
never echoed (it may carry a password). Duplicates (same id) are dropped, at
most `MAX_CAMERAS` (16). A user name without a password takes the
`camera_password` secret field.

## Rules

- **Not affiliated** with any camera maker: the intro, the docs and the
  README say so; no maker logo anywhere (the cover is a drawn pictogram).
  The docs send RTSP cameras to the RTSP integration built into Gladys.
- **Keys are forever**: the manifest keys (`src/constants.js`:
  `test_cameras`, `camera_offline`, `camera_online`), the config keys
  (`cameras`, `camera_password`, `refresh_seconds`, `allow_self_signed`),
  the event data keys (`camera`, `name`, `error`, `failures`,
  `offline_minutes`), the feature key `image` and the external id shape
  `camera:<id>` are stored in user scenes and dashboards. Never rename them.
- **The camera id is forever too** (`cameraId` in `src/config.js`): the
  first 12 hex digits of the SHA-256 of the URL without credentials,
  fragment or credential-looking query parameters. A test pins one value;
  changing the function would duplicate every camera of every user.
- **The camera image** is `image/jpg;base64,...`, at most 150 × 1024
  characters **prefix included** (the SDK and the core measure the whole
  string): a JPEG of 115,185 bytes at most (`MAX_JPEG_BYTES`). Bigger frames
  are halved (box filter) and re-encoded at quality 75 until they fit,
  starting at the factor the previous frame needed.
- **jpeg-js is the one extra dependency** (pure JS, no dependency of its
  own, BSD-3-Clause), allowed by the module spec for the downscale. Its
  guards: `maxResolutionInMP` 6 and `maxMemoryUsageInMB` 112 (measured: about
  15 bytes per pixel for a 4:2:0 frame, 22 for 4:4:4); one downscale at a
  time (`resizeChain`) in a 256 MB container.
- **The HTTP client** (`src/http.js`, the only network access) is built on
  `node:http`/`node:https`, not `fetch`: a streamed body that can be
  dropped after the first frame, `insecureHTTPParser` as a fallback for old
  firmwares (LF-only headers: `HPE_*` errors, remembered per camera), and
  `rejectUnauthorized: false` only when the user ticked
  `allow_self_signed`. http/https only at every hop, at most 3 redirects,
  one 10 s deadline for the whole capture, a frame bounded to 4 MB, 64 KB of
  preamble before the first frame.
- **Credentials**: never sent before the camera answers 401 (then the
  challenge is cached per camera: the next captures authenticate at once,
  Digest with the next nonce count, a stale nonce renewed once); Digest
  preferred over Basic (SHA-512-256 > SHA-256 > MD5, `-sess`, `qop=auth`,
  the RFC 2069 form without qop); never answered with Basic when the camera
  offers only an unsupported scheme; sent to the camera's own origin only
  (or its host upgraded to https). No URL in a log, a status or an error:
  name + host only; the device params hold the host only.
- **Be polite with the cameras** (an ESP32-CAM serves ONE client at a time):
  one capture at a time per camera, shared by every caller (periodic image,
  `onGetImage`, test button) and reused for 1 s (`REUSE_WINDOW`); a stream
  is closed right after its first frame; `refresh_seconds` 10 by default, 5
  at least (the core takes 12 images a minute per camera: also
  `MIN_PUBLISH_SPACING`), 0 for on demand only; an offline camera every
  minute (`OFFLINE_RETRY`); a camera whose frames must be downscaled every
  30 s at most (`RESIZE.MIN_INTERVAL`); only the created devices are read.
- **One event per transition** (`src/triggers.js`): the first reading fires
  nothing; offline after `OFFLINE_AFTER` (3) consecutive failed captures;
  `camera_online` only after an announced `camera_offline` (pairs). Only a
  created camera has a health (the test button on a camera not added fires
  nothing).
- **Built without a real camera**: the formats (multipart, Digest) follow
  the RFCs and the behaviour of common firmwares, tested against the fake
  camera; `TODO.md` lists what to confirm.
- **Read-only rootfs**: write nothing on disk.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag.
- **Changelog**: every user-visible change adds a line under
  `## [Unreleased]` in `CHANGELOG.md`.
- **Manifest texts** are `{ en, fr }` objects; the catalog description holds
  10 to 100 characters per language; `test/manifest.test.js` ties the
  manifest to the code (keys, defaults, bounds, trigger variables against
  the events the code fires).
- **User-facing text** is bilingual, `docs/en.md` and `docs/fr.md` kept in
  sync. Comments explain why, in English.
- **Tests never touch the network**: the fake camera listens on 127.0.0.1
  (`test/helpers/fakeCamera.js`); the JPEG fixtures are generated.

## CI and pushes

- Group the commits and push **at most once a day**, unless the maintainer
  explicitly asks otherwise: the GitHub Actions quota is limited.
- If every CI job fails in under 2 seconds, the quota is exhausted: it is
  not a bug in the code.
- The Docker image cannot be built in the Claude Code cloud container (no
  network for `apk` inside `docker build`): the CI builds it.
