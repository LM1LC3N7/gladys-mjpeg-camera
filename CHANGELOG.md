# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-14

### Added

- One camera device per address of the "Cameras" field (a URL and an
  optional name), for JPEG snapshot URLs and MJPEG streams
  (`multipart/x-mixed-replace`, with or without a `Content-Length` per part):
  ESP32-CAM, older IP cameras, motion, motionEye, mjpg-streamer.
- The camera image published every 10 seconds by default (5 at least, 0 for
  on demand only), and a fresh capture whenever Gladys asks (live view).
- Basic and Digest authentication (MD5, SHA-256), credentials in the address
  or a shared hidden password, never sent before the camera asks.
- Images over 150 KB downscaled to fit, with a hint to lower the camera
  resolution in the status and the device badge.
- Scene triggers "camera offline" (3 failed captures in a row) and "camera
  back online"; a local / unreachable badge per camera.
- "Test cameras" button: kind, resolution, size and time of one capture per
  camera, or the error.
- Optional acceptance of self-signed certificates for https cameras.

[Unreleased]: https://github.com/LM1LC3N7/gladys-mjpeg-camera/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-mjpeg-camera/releases/tag/v0.1.1
