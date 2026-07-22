const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const DEFAULTS = require('../shared/default-settings.json')

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

// Section-wise merge: scalar sections fall back to defaults key-by-key; the
// gestures array is taken wholesale from saved settings when present.
function withDefaults(saved) {
  const s = saved || {}
  return {
    version: DEFAULTS.version,
    camera: { ...DEFAULTS.camera, ...s.camera },
    detection: { ...DEFAULTS.detection, ...s.detection },
    handSelect: { ...DEFAULTS.handSelect, ...s.handSelect },
    tuning: { ...DEFAULTS.tuning, ...s.tuning },
    gestures: Array.isArray(s.gestures) ? s.gestures : DEFAULTS.gestures,
    // Reset a saved calibration whose feature model differs from the current one
    // (the stored numbers mean something different across model versions).
    calibration: (() => {
      const cal = s.calibration && s.calibration.model === DEFAULTS.calibration.model ? s.calibration : {}
      return {
        model: DEFAULTS.calibration.model,
        captured: cal.captured || false,
        curlOpen: { ...DEFAULTS.calibration.curlOpen, ...cal.curlOpen },
        curlClosed: { ...DEFAULTS.calibration.curlClosed, ...cal.curlClosed },
        splaySpread: cal.splaySpread ?? DEFAULTS.calibration.splaySpread,
        splayTogether: cal.splayTogether ?? DEFAULTS.calibration.splayTogether,
      }
    })(),
    debug: { ...DEFAULTS.debug, ...s.debug },
  }
}

function load() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    return withDefaults(JSON.parse(raw))
  } catch {
    return withDefaults(null)
  }
}

function save(settings) {
  const resolved = withDefaults(settings)
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
    fs.writeFileSync(settingsPath(), JSON.stringify(resolved, null, 2))
  } catch (e) {
    console.error('[settings] save failed:', e.message)
  }
  return resolved
}

module.exports = { load, save, withDefaults, DEFAULTS, settingsPath }
