# TODO

## Before announcing

- [ ] Test on a real Gladys 5.1+ with an ESP32-CAM (CameraWebServer sketch):
      `/capture` and `:81/stream`, the dashboard camera widget, the live
      view, the "send a camera image" scene action.
- [ ] Test an IP camera with Digest (a Dahua or Hikvision snapshot URL) and
      one with Basic, plus motionEye and mjpg-streamer.
- [ ] Check the CPU of the container while a UXGA (1600×1200) ESP32-CAM is
      downscaled every 30 s (0.5 CPU).
- [ ] Reply on the forum thread that asked for ESP32-CAM / old IP cameras,
      then add the `gladys-assistant-integration` topic to publish in the
      store.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).

## To confirm (built without a real camera)

- [ ] The camera addresses of the docs table (Hikvision ISAPI picture,
      motionEye snapshot, Axis, IP Webcam) on real devices.
- [ ] An empty `camera` filter of the two triggers matches any camera (the
      core treats an empty field as a wildcard).
- [ ] The transport badge (`publishTransports`) of a camera device renders
      on the device card.
- [ ] Real multipart quirks: a boundary declared with or without its
      dashes, a `Content-Length` that counts the trailing CRLF, a missing
      EOI. All are handled from the descriptions of the formats; collect
      real captures (anonymized) if a camera fails.
- [ ] The lenient HTTP parser covers the old firmwares met in the field
      (LF-only line endings are covered by a test).

## Decisions taken without the maintainer

- The `cameras` field is a `string` (the store has no textarea type):
  entries separated by commas or new lines, like `gladys-rss`.
- A `camera_password` secret field serves the addresses that carry a user
  name without a password, so a password need not sit in a plain field.
- Credentials are sent only after a 401 (challenge first, then cached), not
  preemptively: a camera offering Digest never sees the password in clear.
- No "online" feature (the constants have none for a camera): the
  `camera_offline` / `camera_online` triggers and the transport badge.
- No widget and no scene action: the core's camera widget and "send a
  camera image" action already cover them.
- A camera whose frames must be downscaled is refreshed every 30 s at most
  (CPU of the container), whatever `refresh_seconds`.
- The catalog description does not say "Unofficial connector": no third
  party service is involved (the user's own cameras, a standard protocol),
  as for `gladys-rss`; the intro and the docs say "not affiliated with any
  camera maker".

## Ideas

- Downscale in a worker thread, so a big frame never blocks the event loop.
- Per-camera options in the entry (a refresh, a rotation).
- A "motion" trigger comparing two consecutive frames (would need a decode
  of every frame: CPU).
