// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. Every handler is registered BEFORE connect(),
// and delegates to the MjpegCameraApp (src/app.js).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { MjpegCameraApp } from './src/app.js';
import { ACTIONS } from './src/constants.js';

const gladys = new GladysIntegration();
const app = new MjpegCameraApp({ gladys });

// --- Discovery -------------------------------------------------------------------
gladys.onScanRequest(() => app.publishDevices());
gladys.onDeviceCreated((device) => app.deviceCreated(device));
gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

// --- Camera images: a fresh one when Gladys asks (live view, "show me") ----------
gladys.onGetImage((device) => app.getImage(device));

// --- Configuration screen button -----------------------------------------------
gladys.onAction(ACTIONS.TEST, () => app.testCameras());

// --- Configuration changed by the user ----------------------------------------
gladys.onConfigUpdated((config) => {
  logger.info('Configuration updated: restarting');
  return app.start(config);
});

// --- Connection lifecycle ------------------------------------------------------
gladys.on('connected', async () => {
  try {
    await app.start(await gladys.getConfig());
  } catch (err) {
    logger.error('Start failed', err);
  }
});
gladys.on('disconnected', () => app.stop());
gladys.handleShutdown(() => app.stop());

logger.info('Starting the MJPEG camera integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
