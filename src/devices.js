// -----------------------------------------------------------------------------
// The Gladys devices and their transport badges. Pure.
//
// External ids (forever):
//   camera:<id>          a camera; <id> is the 12-hex hash of its URL
//                        (config.js `cameraId`)
//   camera:<id>:image    its image feature
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_TRANSPORTS,
} from '@gladysassistant/integration-sdk';
import { T as TEXT } from './i18n.js';

export const FEATURE = { IMAGE: 'image' };

export const ids = {
  camera: (gladys, cameraId) => gladys.externalId(`camera:${cameraId}`),
  feature: (deviceId, key) => `${deviceId}:${key}`,
};

/** The camera id of a device external id, or undefined. */
export function parseExternalId(externalId) {
  const match = /:camera:([0-9a-f]{12})$/.exec(String(externalId ?? ''));
  return match ? match[1] : undefined;
}

/**
 * A camera device: one `camera`/`image` feature. Its params hold the host
 * only: a path or a query may carry a token, and the params are readable by
 * every user of Gladys. The poll path reads the URL from the configuration.
 */
export function buildCameraDevice(gladys, camera) {
  const id = ids.camera(gladys, camera.id);
  return {
    name: camera.name,
    external_id: id,
    features: [
      {
        name: 'Image',
        external_id: ids.feature(id, FEATURE.IMAGE),
        category: C.CAMERA,
        type: T.CAMERA.IMAGE,
        min: 0,
        max: 1,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      },
    ],
    params: [{ name: 'host', value: camera.host }],
  };
}

const clip = (text, max = 200) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The transport badge of a camera, or undefined while its state is unknown:
 * local, local + degraded when its frames must be downscaled, unreachable
 * once offline.
 */
export function transportOf(deviceId, { state, resized }) {
  if (state === 'offline') {
    return { external_id: deviceId, transport: DEVICE_TRANSPORTS.UNREACHABLE };
  }
  if (state !== 'online') {
    return undefined;
  }
  if (resized) {
    const message = TEXT.badgeResized(resized);
    return {
      external_id: deviceId,
      transport: DEVICE_TRANSPORTS.LOCAL,
      degraded: true,
      message: { en: clip(message.en), fr: clip(message.fr) },
    };
  }
  return { external_id: deviceId, transport: DEVICE_TRANSPORTS.LOCAL };
}
