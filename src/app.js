// -----------------------------------------------------------------------------
// The integration itself: the cameras of the configuration offered in
// Discovery, the periodic images of the created ones, the fresh image Gladys
// asks for (onGetImage), the online/offline triggers, the transport badges
// and the "Test cameras" button. index.js only wires the SDK handlers to it.
//
// Pace (see CLAUDE.md): one capture at a time per camera (an ESP32-CAM
// serves one client), shared by every caller and reused for a second; an
// image published every `refresh_seconds` (5 s at least: the core takes 12 a
// minute), an offline camera tried every minute, a camera whose frames must
// be downscaled every 30 s at most; one downscale at a time (CPU, memory).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { MIN_PUBLISH_SPACING, OFFLINE_RETRY, RESIZE, REUSE_WINDOW } from './constants.js';
import { buildCameraDevice, ids, parseExternalId, transportOf } from './devices.js';
import { captureFrame, createSession } from './http.js';
import { T } from './i18n.js';
import { MAX_JPEG_BYTES, cameraImage } from './image.js';
import { INITIAL_HEALTH, nextHealth } from './triggers.js';

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };
/** A tick a few milliseconds early still counts as on time. */
const TICK_SLACK = 1_000;

const sameAccess = (a, b) =>
  a.url === b.url && a.username === b.username && a.password === b.password;

export class MjpegCameraApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'mjpeg-camera' }),
    now = Date.now,
    timers = defaultTimers,
    capture = captureFrame,
    captureOptions = {},
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.captureImpl = capture;
    this.captureOptions = captureOptions;
    this.config = normalizeConfig();
    /** camera id -> what we know of that camera (kept across restarts). */
    this.cameras = new Map();
    this.timer = undefined;
    this.generation = 0;
    this.lastStatus = undefined;
    this.resizeChain = Promise.resolve();
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    const generation = ++this.generation;
    this.config = normalizeConfig(raw);
    this.syncCameras();
    await this.publishDevices().catch((err) =>
      this.logger.warn(`Publishing the cameras failed: ${err.message}`),
    );
    if (this.config.refreshSeconds > 0) {
      await this.tick();
      if (generation !== this.generation) {
        return;
      }
      this.timer = this.timers.setInterval(
        () => this.tick().catch((err) => this.logger.warn(`Refresh failed: ${err.message}`)),
        this.config.refreshSeconds * 1000,
      );
    }
    await this.reportStatus();
  }

  stop() {
    this.generation += 1;
    this.timers.clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Keep what we know of the cameras still configured, add the new ones. */
  syncCameras() {
    const previous = this.cameras;
    this.cameras = new Map();
    for (const camera of this.config.cameras) {
      const old = previous.get(camera.id);
      const state = old ?? {
        deviceId: ids.camera(this.gladys, camera.id),
        health: INITIAL_HEALTH,
        badge: undefined,
        nextAt: 0,
        publishedAt: Number.NEGATIVE_INFINITY,
        factor: 2,
        resized: undefined,
      };
      if (!old || !sameAccess(old.camera, camera)) {
        // New credentials: a new connection memory (challenge, parser).
        state.session = createSession();
        state.last = undefined;
      }
      state.camera = camera;
      this.cameras.set(camera.id, state);
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  withInvalid(message) {
    if (this.config.invalid.length === 0) {
      return message;
    }
    const suffix = T.invalid(this.config.invalid);
    return { en: message.en + suffix.en, fr: message.fr + suffix.fr };
  }

  async reportStatus() {
    const all = [...this.cameras.values()];
    if (all.length === 0) {
      await this.setStatus(true, this.withInvalid(T.noCamera));
      return;
    }
    const created = all.filter((s) => this.isCreated(s));
    if (created.length === 0) {
      await this.setStatus(true, this.withInvalid(T.notCreated(all.length)));
      return;
    }
    // Offline, or never seen working: a single lost frame of a working camera
    // is not worth a red status.
    const failing = created.filter(
      (s) =>
        s.health.state === 'offline' || (s.health.state === 'unknown' && s.health.failures > 0),
    );
    const refresh = this.config.refreshSeconds;
    let message;
    if (failing.length > 0) {
      const list = (separator) =>
        failing
          .slice(0, 3)
          .map((s) => `${s.camera.name}${separator}${s.health.error}`)
          .concat(failing.length > 3 ? ['…'] : [])
          .join(', ');
      const details = { en: list(': '), fr: list(' : ') };
      const retry = refresh > 0 ? Math.max(refresh, OFFLINE_RETRY / 1000) : 0;
      message = T.failing(failing.length, created.length, details, retry);
    } else {
      message = T.ok(created.length, refresh);
    }
    const resized = created.filter((s) => s.resized).map((s) => s.camera.name);
    if (resized.length > 0) {
      const suffix = T.resized(resized.join(', '));
      message = { en: message.en + suffix.en, fr: message.fr + suffix.fr };
    }
    await this.setStatus(failing.length < created.length, this.withInvalid(message));
  }

  // --- Devices -------------------------------------------------------------------

  async publishDevices() {
    await this.gladys.publishDiscoveredDevices(
      this.config.cameras.map((camera) => buildCameraDevice(this.gladys, camera)),
    );
  }

  isCreated(state) {
    return (this.gladys.devices ?? []).some((d) => d.external_id === state.deviceId);
  }

  stateOf(device) {
    const id = parseExternalId(device?.external_id);
    return id ? this.cameras.get(id) : undefined;
  }

  /** A camera was just added: show an image at once, even in on-demand mode. */
  async deviceCreated(device) {
    const state = this.stateOf(device);
    if (state) {
      await this.refreshCamera(state);
    }
    await this.reportStatus();
  }

  async deviceDeleted(device) {
    const state = this.stateOf(device);
    if (state) {
      state.health = INITIAL_HEALTH;
      state.badge = undefined;
    }
    await this.reportStatus();
  }

  // --- Capturing -----------------------------------------------------------------

  /** Capture the created cameras that are due, all at once (one per camera). */
  async tick() {
    const now = this.now();
    const due = [...this.cameras.values()].filter(
      (s) => this.isCreated(s) && !s.inflight && now + TICK_SLACK >= s.nextAt,
    );
    await Promise.all(due.map((s) => this.refreshCamera(s)));
    await this.reportStatus();
  }

  /** Milliseconds until the next periodic capture of a camera. */
  intervalOf(state) {
    let interval = this.config.refreshSeconds * 1000;
    if (state.health.state === 'offline') {
      interval = Math.max(interval, OFFLINE_RETRY);
    } else if (state.resized) {
      interval = Math.max(interval, RESIZE.MIN_INTERVAL);
    }
    return interval;
  }

  /** The periodic path: capture, then publish the image. */
  async refreshCamera(state) {
    const started = this.now();
    const generation = this.generation;
    let result;
    try {
      result = await this.capture(state);
    } catch {
      return; // recorded in the health of the camera
    } finally {
      state.nextAt = started + this.intervalOf(state);
    }
    if (generation !== this.generation) {
      return; // stopped or restarted meanwhile (disconnected, new configuration)
    }
    if (this.now() - state.publishedAt < MIN_PUBLISH_SPACING) {
      return; // the core takes 12 images a minute per camera
    }
    state.publishedAt = this.now();
    await this.gladys
      .publishCameraImage(state.deviceId, result.image)
      .catch((err) =>
        this.logger.warn(`Publishing the image of ${state.camera.name} failed: ${err.message}`),
      );
  }

  /**
   * A fresh image of a camera. One capture at a time per camera: concurrent
   * callers share it, and a frame younger than REUSE_WINDOW is reused.
   */
  capture(state) {
    if (state.last && this.now() - state.last.at < REUSE_WINDOW) {
      return Promise.resolve(state.last);
    }
    if (!state.inflight) {
      state.inflight = this.doCapture(state).finally(() => {
        state.inflight = undefined;
      });
    }
    return state.inflight;
  }

  async doCapture(state) {
    const started = this.now();
    const { camera } = state;
    try {
      const frame = await this.captureImpl(camera, {
        session: state.session,
        allowSelfSigned: this.config.allowSelfSigned,
        ...this.captureOptions,
      });
      const image = await this.resize(frame.jpeg, state.factor);
      const result = { ...image, kind: frame.kind, ms: this.now() - started, at: this.now() };
      state.last = result;
      state.factor = Math.max(2, image.factor);
      state.resized = image.factor > 1 ? image : undefined;
      await this.recordOutcome(state, { ok: true });
      return result;
    } catch (err) {
      // Logged once per outage: an offline camera retried every minute stays quiet.
      const level = state.health.state === 'offline' ? 'debug' : 'warn';
      this.logger[level](`Capture of ${camera.name} (${camera.host}) failed: ${err.message}`);
      await this.recordOutcome(state, { ok: false, error: err.message });
      throw err;
    }
  }

  /** Downscale a frame too big for Gladys, one frame at a time. */
  resize(jpeg, factorHint) {
    if (jpeg.length <= MAX_JPEG_BYTES) {
      return Promise.resolve(cameraImage(jpeg));
    }
    const run = this.resizeChain.then(() => cameraImage(jpeg, { factorHint }));
    this.resizeChain = run.catch(() => {});
    return run;
  }

  /** Health, scene events and badge of a created camera after a capture. */
  async recordOutcome(state, outcome) {
    if (!this.isCreated(state)) {
      return; // the test button on a camera not added yet: no device, no event
    }
    const { health, events } = nextHealth(state.health, outcome, {
      now: this.now(),
      deviceId: state.deviceId,
      name: state.camera.name,
    });
    state.health = health;
    for (const event of events) {
      this.logger.info(`${state.camera.name}: ${event.key}`);
      await this.gladys
        .publishSceneEvent(event.key, event.data)
        .catch((err) => this.logger.warn(`Scene event ${event.key} failed: ${err.message}`));
    }
    const entry = transportOf(state.deviceId, { state: health.state, resized: state.resized });
    const key = entry && JSON.stringify(entry);
    if (entry && key !== state.badge) {
      state.badge = key;
      await this.gladys.publishTransports([entry]).catch((err) => {
        state.badge = undefined;
        this.logger.warn(`publishTransports failed: ${err.message}`);
      });
    }
  }

  // --- Gladys asks -----------------------------------------------------------------

  /** onGetImage: a fresh image for the live view or the "show me" intent. */
  async getImage(device) {
    const state = this.stateOf(device);
    if (!state) {
      throw new Error(T.notConfigured);
    }
    const result = await this.capture(state);
    await this.reportStatus();
    return result.image;
  }

  /** The "Test cameras" button: one capture of every configured camera. */
  async testCameras() {
    const states = [...this.cameras.values()];
    if (states.length === 0) {
      return this.withInvalid(T.noCamera);
    }
    let resized = false;
    const lines = await Promise.all(
      states.map(async (state) => {
        try {
          const result = await this.capture(state);
          resized ||= result.factor > 1;
          return T.test.ok(state.camera, result);
        } catch (err) {
          return T.test.failed(state.camera, err.message);
        }
      }),
    );
    await this.reportStatus();
    if (resized) {
      lines.push(T.test.advice);
    }
    return this.withInvalid({
      en: lines.map((l) => l.en).join('\n'),
      fr: lines.map((l) => l.fr).join('\n'),
    });
  }
}
