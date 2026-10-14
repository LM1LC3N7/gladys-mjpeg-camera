// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, button result, badges).
// -----------------------------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;
const ko = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} Ko`;
const dims = (d) => (d?.width && d?.height ? `${d.width}×${d.height}` : '?');

export const T = {
  ok: (cameras, seconds) => ({
    en:
      seconds > 0
        ? `${plural(cameras, 'camera')}, an image every ${seconds} s.`
        : `${plural(cameras, 'camera')}, images on demand only.`,
    fr:
      seconds > 0
        ? `${cameras} caméra${cameras > 1 ? 's' : ''}, une image toutes les ${seconds} s.`
        : `${cameras} caméra${cameras > 1 ? 's' : ''}, images à la demande uniquement.`,
  }),
  noCamera: {
    en: 'No camera yet: type the address of a camera in the configuration.',
    fr: "Aucune caméra : saisissez l'adresse d'une caméra dans la configuration.",
  },
  notCreated: (n) => ({
    en: `${plural(n, 'camera')} waiting in Discovery: add ${n === 1 ? 'it' : 'them'} to get the images.`,
    fr: `${n} caméra${n > 1 ? 's' : ''} en attente dans Découverte : ajoutez-${n > 1 ? 'les' : 'la'} pour recevoir les images.`,
  }),
  failing: (failing, total, details, retrySeconds) => ({
    en: `${failing} of ${plural(total, 'camera')} unreachable: ${details.en}.${retrySeconds ? ` Retrying every ${retrySeconds} s.` : ''}`,
    fr: `${failing} caméra${failing > 1 ? 's' : ''} sur ${total} injoignable${failing > 1 ? 's' : ''} : ${details.fr}.${retrySeconds ? ` Nouvel essai toutes les ${retrySeconds} s.` : ''}`,
  }),
  resized: (names) => ({
    en: ` Frames over 150 KB are downscaled (${names}): set a lower resolution on the camera (VGA or SVGA on an ESP32-CAM) to spare the CPU and get the configured pace.`,
    fr: ` Images de plus de 150 Ko réduites (${names}) : choisissez une résolution plus basse sur la caméra (VGA ou SVGA sur un ESP32-CAM) pour économiser le processeur et retrouver le rythme configuré.`,
  }),
  invalid: (positions) => ({
    en: ` Ignored (not an http or https address): entry ${positions.join(', ')}.`,
    fr: ` Ignorée${positions.length > 1 ? 's' : ''} (pas une adresse http ou https) : entrée ${positions.join(', ')}.`,
  }),
  badgeResized: (resized) => ({
    en: `Frames of ${dims(resized.original)} downscaled to ${dims(resized)}: lower the camera resolution.`,
    fr: `Images ${dims(resized.original)} réduites en ${dims(resized)} : baissez la résolution de la caméra.`,
  }),
  notConfigured: 'this camera is no longer in the configuration of the integration',
  test: {
    ok: (camera, r) => {
      const resized = r.factor > 1;
      return {
        en:
          `OK ${camera.name} (${camera.host}): ${r.kind === 'stream' ? 'MJPEG stream' : 'snapshot'}, ` +
          `${dims(r.original)}, ${kb(r.original.bytes)}, ${r.ms} ms` +
          (resized ? ` → downscaled to ${dims(r)} (${kb(r.bytes)})` : ''),
        fr:
          `OK ${camera.name} (${camera.host}) : ${r.kind === 'stream' ? 'flux MJPEG' : 'image fixe'}, ` +
          `${dims(r.original)}, ${ko(r.original.bytes)}, ${r.ms} ms` +
          (resized ? ` → réduite en ${dims(r)} (${ko(r.bytes)})` : ''),
      };
    },
    failed: (camera, error) => ({
      en: `FAILED ${camera.name} (${camera.host}): ${error}`,
      fr: `ÉCHEC ${camera.name} (${camera.host}) : ${error}`,
    }),
    advice: {
      en: 'Frames over 150 KB are downscaled for Gladys: a lower resolution on the camera spares the CPU.',
      fr: 'Les images de plus de 150 Ko sont réduites pour Gladys : une résolution plus basse sur la caméra économise le processeur.',
    },
  },
};
