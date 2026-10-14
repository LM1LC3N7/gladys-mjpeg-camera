// -----------------------------------------------------------------------------
// Constants of the MJPEG / snapshot camera integration.
// -----------------------------------------------------------------------------

/** Every request says who reads the camera (visible in the camera's logs). */
export const USER_AGENT =
  'gladys-mjpeg-camera/0.1 (+https://github.com/LM1LC3N7/gladys-mjpeg-camera)';
export const ACCEPT = 'image/jpeg, multipart/x-mixed-replace, */*;q=0.5';

/** One capture: connection, redirects, authentication and the first frame. */
export const HTTP_TIMEOUT = 10_000;
export const MAX_REDIRECTS = 3;
/** A frame (or a snapshot) bigger than this is abandoned while streaming. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** Bytes a stream may send before its first frame (boundary, part headers). */
export const MAX_PREAMBLE_BYTES = 64 * 1024;

/**
 * The core refuses a camera image longer than 150 * 1024 characters, measured
 * on the whole `image/jpg;base64,...` string (SDK MAX_CAMERA_IMAGE_SIZE), so a
 * JPEG of about 112 KB at most.
 */
export const IMAGE_PREFIX = 'image/jpg;base64,';
export const MAX_IMAGE_LENGTH = 150 * 1024;

/** Re-encoding of a frame too big for Gladys (jpeg-js, pure JS). */
export const RESIZE = {
  QUALITY: 75,
  /** A frame is never shrunk below this width: past it, the capture fails. */
  MIN_WIDTH: 160,
  /**
   * jpeg-js guards, sized for a 256 MB container: the decoder accounts about
   * 15 bytes per pixel for a 4:2:0 frame (most cameras) and 22 for 4:4:4
   * (measured), so a 5 MP camera needs 75 to 110 MB; only one frame is
   * decoded at a time (app.js `resizeChain`).
   */
  MAX_RESOLUTION_MP: 6,
  MAX_MEMORY_MB: 112,
  /**
   * A camera whose frames must be downscaled (0.5 to 4 s of CPU each on the
   * container's half core) is refreshed at most this often.
   */
  MIN_INTERVAL: 30_000,
};

/** Refresh: 10 s by default; 5 s is the core's 12 images a minute per camera. */
export const MIN_REFRESH_SECONDS = 5;
/** Two images of one camera are never published closer than this. */
export const MIN_PUBLISH_SPACING = 5_000;
/** A frame younger than this answers a new request (a live view, the test). */
export const REUSE_WINDOW = 1_000;
/** Consecutive failed captures before a camera is "offline". */
export const OFFLINE_AFTER = 3;
/** An offline camera is tried again at this pace (or the refresh, if slower). */
export const OFFLINE_RETRY = 60_000;
export const MAX_CAMERAS = 16;
export const NAME_LIMIT = 60;

/** Manifest keys (forever: stored in user scenes and dashboards). */
export const ACTIONS = { TEST: 'test_cameras' };
export const SCENE_TRIGGERS = { OFFLINE: 'camera_offline', ONLINE: 'camera_online' };
