import { createRecognizer, createGestureEngine, createHandSelector, createSpotter, motionFrame } from './gestures.js'
import { createOverlay } from './overlay.js'
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'

const TASKS_VISION_VERSION = '0.10.35'
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

// Live settings (from the main process; updated when the studio saves).
let settings = null

// Shared render state, mutated each frame and read by the p5 overlay.
const state = {
  landmarks: null,
  hands: [],
  gestureLabel: 'none', // human name of the matched gesture
  rawName: 'none',
  signals: null, // { ext: {thumb..pinky}, pinchDist, pinch }
  progress: 0,
  fireFlash: 0,
  fireLog: [],
  dryRun: false,
  permission: 'unknown',
  fps: 0,
}

function logFire(text) {
  state.fireLog.push(text)
  while (state.fireLog.length > 5) state.fireLog.shift()
}

function banner(msg) {
  const el = document.getElementById('banner')
  el.textContent = msg
  el.classList.toggle('show', Boolean(msg))
}

async function ensureAccessibility() {
  try {
    let perm = await window.gestureAPI.checkPermission()
    if (perm !== 'yes') {
      await window.gestureAPI.requestPermission()
      perm = await window.gestureAPI.checkPermission()
    }
    state.permission = perm
    if (perm !== 'yes') {
      banner('Grant Accessibility to the helper in System Settings › Privacy & Security › Accessibility, then relaunch.')
    }
  } catch (e) {
    state.permission = 'error'
    console.error('[accessibility]', e)
  }
}

// One persistent <video>; releasing the stream turns the camera hardware off.
const video = document.createElement('video')
video.autoplay = true
video.playsInline = true
video.muted = true
let currentStream = null

async function startCamera() {
  if (currentStream) return
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: settings.camera.width,
      height: settings.camera.height,
      facingMode: settings.camera.facingMode,
    },
    audio: false,
  })
  currentStream = stream
  video.srcObject = stream
  await video.play()
}

function stopCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop())
    currentStream = null
  }
  video.srcObject = null
}

async function createLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(WASM_URL)
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: settings.detection.numHands,
    minHandDetectionConfidence: settings.detection.minHandDetectionConfidence,
    minHandPresenceConfidence: settings.detection.minHandPresenceConfidence,
    minTrackingConfidence: settings.detection.minTrackingConfidence,
  })
}

let paused = false

async function main() {
  settings = await window.gestureAPI.getSettings()
  state.dryRun = settings.debug.dryRun

  let selectPrimary = createHandSelector(settings)
  const recognize = createRecognizer()

  window.gestureAPI.onSettingsChanged((next) => {
    settings = next
    state.dryRun = next.debug.dryRun
    selectPrimary = createHandSelector(next) // handSelect params may have changed
    console.log('[settings] updated')
  })

  window.gestureAPI.onSetPaused(async (v) => {
    if (v) {
      paused = true
      stopCamera()
    } else {
      await startCamera()
      paused = false
    }
  })

  await ensureAccessibility()
  await startCamera()
  const landmarker = await createLandmarker()

  // Shared by the pose engine (held gestures) and the motion spotter (movements):
  // recognition is separate from actuation, so both funnel their fire here.
  async function fireAction(matched) {
    state.fireFlash = performance.now()
    const t = (performance.now() / 1000).toFixed(1)
    // A recognized gesture with no bound action (e.g. a freshly enrolled motion, or
    // a 'reject' class) is logged but does nothing.
    if (!matched.action || matched.action === 'none') {
      logFire(`${t}s  ${matched.name}  (recognized, no action)`)
      return
    }
    const label = `${matched.name}→${matched.action}`
    if (state.dryRun) {
      logFire(`${t}s  ${label}  (dry-run)`)
      console.log('[gesture] would fire', label, '(dry-run)')
      return
    }
    try {
      const res = await window.gestureAPI.runAction(matched.action)
      logFire(`${t}s  ${label}  → ${res}`) // surface ok:<app> / err:<why> in the HUD
      console.log('[action]', label, '→', res)
    } catch (e) {
      logFire(`${t}s  ${label}  → error`)
      console.error('[action] failed:', e)
    }
  }

  const engine = createGestureEngine(fireAction)
  const spotter = createSpotter(fireAction) // continuous motion recognition (settle-gated inside)
  let motionEMA = null // smoothed motion-feature state; reset when the hand leaves

  createOverlay(document.getElementById('app'), () => state, video)

  let lastTs = 0
  let lastFrame = performance.now()
  let loopErrors = 0
  // Loop diagnostics: how many frames/sec we actually run, how long GPU inference
  // takes, what fraction of wall-time is spent in inference (the battery driver),
  // and how often a hand is even present. Emitted every 2s to a logfile via main.
  let diag = { t0: performance.now(), frames: 0, infMs: 0, hands: 0 }
  function emitDiag(nowP) {
    const el = nowP - diag.t0
    if (el < 2000) return
    try {
      window.gestureAPI.reportDiag({
        fps: +(diag.frames / (el / 1000)).toFixed(1),
        infMs: diag.frames ? +(diag.infMs / diag.frames).toFixed(2) : 0,
        dutyPct: +((diag.infMs / el) * 100).toFixed(1),
        handPct: diag.frames ? +((diag.hands / diag.frames) * 100).toFixed(0) : 0,
        paused,
        hidden: document.hidden,
      })
    } catch {}
    diag = { t0: nowP, frames: 0, infMs: 0, hands: 0 }
  }
  let lastHandSeen = -Infinity
  function loop() {
    // Self-paced (setTimeout) rather than requestAnimationFrame: the detection rate
    // is decoupled from the display so we run inference only as often as needed —
    // fast while a hand is around, and a slow idle-watch when it isn't (most of the
    // day). This is the battery fix: idle GPU duty drops ~8×. Always reschedules,
    // even if a frame throws, so one bad frame can't stop detection.
    const t0 = performance.now()
    try {
      frame()
    } catch (e) {
      if (loopErrors++ < 3) console.error('[loop] frame error:', e)
    }
    const idle = performance.now() - lastHandSeen > (settings.tuning.idleAfterMs ?? 1200)
    const fps = idle ? settings.tuning.idleFps ?? 8 : settings.tuning.activeFps ?? 30
    const gap = 1000 / Math.max(1, fps) - (performance.now() - t0)
    setTimeout(loop, Math.max(4, gap))
  }

  function frame() {
    emitDiag(performance.now())
    diag.frames++
    if (paused) {
      state.landmarks = null
      state.hands = []
      state.gestureLabel = 'paused'
      state.rawName = 'paused'
      state.signals = null
      state.progress = 0
      motionEMA = null
      return
    }

    let now = performance.now()
    if (now <= lastTs) now = lastTs + 1
    lastTs = now

    const tInf = performance.now()
    const results = landmarker.detectForVideo(video, now)
    diag.infMs += performance.now() - tInf
    const hands = results.landmarks || []
    const worldHands = results.worldLandmarks || []
    const idx = selectPrimary(hands)
    const primary = idx >= 0 ? hands[idx] : null
    const worldPrimary = idx >= 0 ? worldHands[idx] || null : null
    if (primary) { diag.hands++; lastHandSeen = now } // keep the loop at full rate while a hand is present
    state.hands = hands
    state.landmarks = primary

    const rec = recognize(primary, worldPrimary, settings)
    state.signals = rec.signals
    state.rawName = idToName(rec.raw)
    const st = engine(rec.matched, now, settings)
    state.gestureLabel = rec.matched ? rec.matched.name : 'none'
    state.progress = st.progress

    // Motion (enrolled) gestures: build the smoothed per-frame hand state and run
    // the continuous spotter, which fires enrolled movements via fireAction. Built
    // through the SAME motionFrame() + EMA the studio enrolled with, so live frames
    // match the templates.
    if (worldPrimary) {
      const raw = motionFrame(primary, worldPrimary)
      const s = Math.min(0.95, Math.max(0, settings.tuning.featureSmoothing ?? 0.5))
      if (!motionEMA || s === 0) {
        motionEMA = { canon: [...raw.canon], n: [...raw.n], cx: raw.cx, cy: raw.cy, size: raw.size }
      } else {
        for (let i = 0; i < raw.canon.length; i++) motionEMA.canon[i] = motionEMA.canon[i] * s + raw.canon[i] * (1 - s)
        for (let i = 0; i < 3; i++) motionEMA.n[i] = motionEMA.n[i] * s + raw.n[i] * (1 - s)
        motionEMA.cx = motionEMA.cx * s + raw.cx * (1 - s)
        motionEMA.cy = motionEMA.cy * s + raw.cy * (1 - s)
        motionEMA.size = motionEMA.size * s + raw.size * (1 - s)
      }
      spotter(now, { canon: [...motionEMA.canon], n: [...motionEMA.n], cx: motionEMA.cx, cy: motionEMA.cy, size: motionEMA.size }, settings)
    } else {
      motionEMA = null // don't smear smoothing across a hand disappearing
    }

    state.fps = Math.round(1000 / Math.max(1, now - lastFrame))
    lastFrame = now
  }

  loop() // self-scheduling via setTimeout
}

function idToName(id) {
  if (id === 'none' || id === 'paused') return id
  const g = settings.gestures.find((x) => x.id === id)
  return g ? g.name : id
}

main().catch((e) => {
  console.error(e)
  banner('Startup error: ' + e.message)
})
