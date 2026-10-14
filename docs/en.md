# MJPEG & snapshot cameras

Brings the cameras that speak **plain HTTP** into Gladys: an ESP32-CAM, an
older IP camera, a webcam served by motion, motionEye or mjpg-streamer. Two
kinds of address work: a **JPEG snapshot** URL and an **MJPEG stream**
(`multipart/x-mixed-replace`). No ffmpeg, no RTSP, nothing in the cloud:
everything stays on your local network.

**For an RTSP camera, use the RTSP camera integration built into Gladys
instead**: this one is the light path for the cameras that only offer HTTP.
Not affiliated with any camera maker; the brand names below only identify
compatible products.

## What you get

| Surface         | Content                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| Device          | One camera device per address, with its image on the dashboard camera widget                                    |
| Live view       | A fresh image each time Gladys asks for one (live view, "show me the camera", the "send a camera image" action) |
| Scene triggers  | **Camera offline** (3 failed captures in a row) and **Camera back online**                                      |
| Settings button | **Test cameras**: one image of each camera, with its kind, resolution, size and time, or the error              |
| Device badge    | "Local" while the camera answers, "Unreachable" once offline, an orange dot when its images must be downscaled  |

## Setup

Type the addresses in **Cameras**, separated by commas. Each address may be
followed by a **name**, after a space or a `|`:

```
http://192.168.1.50:81/stream Garden, http://192.168.1.20/cgi-bin/snapshot.cgi|Front door
```

Then open **Discovery** and add the cameras. Only the cameras you add are
read. Press **Test cameras** to check each address.

Common addresses (check the documentation of your camera; `<ip>` is its
address on your network):

| Camera                               | Snapshot                                           | Stream                                |
| ------------------------------------ | -------------------------------------------------- | ------------------------------------- |
| ESP32-CAM ("CameraWebServer" sketch) | `http://<ip>/capture`                              | `http://<ip>:81/stream`               |
| mjpg-streamer                        | `http://<ip>:8080/?action=snapshot`                | `http://<ip>:8080/?action=stream`     |
| motionEye                            | `http://<ip>:8765/picture/1/current/`              | `http://<ip>:8081/`                   |
| motion                               | -                                                  | `http://<ip>:8081/`                   |
| Many IP cameras (Dahua, Amcrest…)    | `http://<ip>/cgi-bin/snapshot.cgi`                 | -                                     |
| Hikvision                            | `http://<ip>/ISAPI/Streaming/channels/101/picture` | -                                     |
| Axis                                 | `http://<ip>/axis-cgi/jpg/image.cgi`               | `http://<ip>/axis-cgi/mjpg/video.cgi` |
| "IP Webcam" Android app              | `http://<ip>:8080/shot.jpg`                        | `http://<ip>:8080/video`              |

A snapshot address is the lightest choice when the camera offers one. An
**ESP32-CAM serves its stream to one client at a time**: while a browser
watches `:81/stream`, Gladys waits; `/capture` avoids that.

## Passwords

- Type them in the address: `http://user:password@192.168.1.20/…`. A special
  character of the password is written in percent-encoding (`@` is `%40`, a
  comma `%2C`).
- Or type only the user name in the address (`http://admin@192.168.1.20/…`)
  and the password in **Camera password**: it stays hidden in the
  configuration screen, unlike a password typed in the address.
- Basic and **Digest** (MD5, SHA-256) authentication are supported. The
  password is never sent before the camera asks for it, it is never sent in
  clear text to a camera that offers Digest, and it goes to that camera only
  (never to another address it redirects to, except the same camera over
  https).
- An address carrying a token in its query (`?user=…&pwd=…`) works too: the
  logs and the statuses never show an address, only the camera name and host.
- An https camera with a self-signed certificate needs **Accept self-signed
  certificates**.

## Images and pace

- Every camera added sends an image to Gladys every **10 seconds** by
  default (**Image refresh**, 5 seconds at least: Gladys takes 12 images a
  minute per camera; 0 for on demand only). The live view and the scenes get
  a fresh image whatever this setting.
- Gladys takes images of **150 KB** at most. A bigger image is downscaled
  (halved until it fits) inside the integration, which costs CPU: such a
  camera is then refreshed every 30 seconds at most, and the status and the
  device badge say so. **Set a lower resolution on the camera** instead: VGA
  (640×480) or SVGA (800×600) with a JPEG quality around 12 on an ESP32-CAM.
- An image is read once per camera at a time, whoever asks: the periodic
  image, the live view and the test button share it.
- An MJPEG stream is never watched continuously: the integration takes its
  first image, then closes the connection.

## Scenes

- **Camera offline**: a camera that was sending images failed 3 captures in
  a row. Variables: `name`, `error`, `failures`.
- **Camera back online**: the same camera sends images again. Variables:
  `name`, `offline_minutes`.

Both have an optional **Camera** filter (empty: any camera). They come in
pairs: a camera that is already down when the integration starts announces
nothing, and its return is not announced either. An offline camera is tried
again every minute.

To send an image in a message, use the "send a camera image" action of
Gladys with one of these cameras.

## Status messages and errors

| Message                                          | Meaning                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `no image within 10 s`                           | The camera does not answer (address, power, an ESP32-CAM busy with a browser)     |
| `the camera asks for a user name and password`   | Add them to the address (see Passwords)                                           |
| `user name or password refused`                  | Wrong credentials                                                                 |
| `not a JPEG image (text/html)`                   | The address shows a web page (a login page, the camera's home page): fix the path |
| `certificate not trusted`                        | An https camera with a self-signed certificate: see Passwords                     |
| `TLS handshake failed`                           | An old https camera (TLS 1.0 or 1.1): use its http address                        |
| `frame over 4 MB` or `too big to downscale here` | Lower the camera resolution                                                       |

## Privacy

Nothing leaves your network and nothing is written on disk: the images go to
your Gladys only. The configuration keeps the addresses; the camera devices
only show the host of each camera.
