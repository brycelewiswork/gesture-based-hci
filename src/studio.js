import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import {
  FINGERS,
  createRecognizer,
  createHandSelector,
  createGestureEngine,
  createSegmenter,
  createSpotter,
  buildDescriptor,
  consistency,
  separations,
  channelBreakdown,
  motionProfile,
  suggestThreshold,
  trajDist,
  computeWeights,
  motionFrame,
  canonicalize,
  DESCRIPTOR_DIMS,
  DESC_VERSION,
} from './gestures.js'

const TASKS_VISION_VERSION = '0.10.35'
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

// All window actions (mirrors Raycast's Window Management, minus the ones that need
// private Spaces APIs). Kept as {value,label} so the long dropdown reads nicely.
const ACTIONS = [
  'none', 'maximize', 'almostMaximize', 'reasonableSize', 'center', 'minimize', 'toggleFullscreen', 'restore',
  'tileLeft', 'tileRight', 'topHalf', 'bottomHalf',
  'topLeftQuarter', 'topRightQuarter', 'bottomLeftQuarter', 'bottomRightQuarter',
  'firstThird', 'centerThird', 'lastThird', 'firstTwoThirds', 'lastTwoThirds',
  'topLeftSixth', 'topCenterSixth', 'topRightSixth', 'bottomLeftSixth', 'bottomCenterSixth', 'bottomRightSixth',
  'maximizeHeight', 'maximizeWidth', 'moveLeft', 'moveRight', 'moveUp', 'moveDown',
  'nextDisplay', 'previousDisplay',
]
const ACTION_LABELS = {
  none: 'None', maximize: 'Maximize', almostMaximize: 'Almost Maximize (90%, centered)',
  reasonableSize: 'Reasonable Size (60%)', center: 'Center (keep size)', minimize: 'Minimize',
  toggleFullscreen: 'Toggle Fullscreen', restore: 'Restore previous',
  tileLeft: 'Left Half', tileRight: 'Right Half', topHalf: 'Top Half', bottomHalf: 'Bottom Half',
  topLeftQuarter: 'Top-Left Quarter', topRightQuarter: 'Top-Right Quarter',
  bottomLeftQuarter: 'Bottom-Left Quarter', bottomRightQuarter: 'Bottom-Right Quarter',
  firstThird: 'First Third', centerThird: 'Center Third', lastThird: 'Last Third',
  firstTwoThirds: 'First Two-Thirds', lastTwoThirds: 'Last Two-Thirds',
  topLeftSixth: 'Top-Left Sixth', topCenterSixth: 'Top-Center Sixth', topRightSixth: 'Top-Right Sixth',
  bottomLeftSixth: 'Bottom-Left Sixth', bottomCenterSixth: 'Bottom-Center Sixth', bottomRightSixth: 'Bottom-Right Sixth',
  maximizeHeight: 'Maximize Height', maximizeWidth: 'Maximize Width',
  moveLeft: 'Move to Left Edge', moveRight: 'Move to Right Edge', moveUp: 'Move to Top Edge', moveDown: 'Move to Bottom Edge',
  nextDisplay: 'Next Display', previousDisplay: 'Previous Display',
}
const actionOptions = () => ACTIONS.map((a) => ({ value: a, label: ACTION_LABELS[a] || a }))
const MOTIONS = ['swipe', 'spread', 'pinch', 'rotate']
const DIRECTIONS = { swipe: ['left', 'right', 'up', 'down'], rotate: ['cw', 'ccw'], spread: [], pinch: [] }
const FINGER_LABELS = { thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Pinky' }

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]

let settings = null
let selectPrimary = null
let landmarker = null
let makeLandmarker = null
let rebuildTimer = null

function scheduleRebuild() {
  clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(async () => {
    if (!makeLandmarker) return
    try {
      await makeLandmarker()
      status('Detector rebuilt with new strictness.')
    } catch (e) {
      status('Rebuild failed: ' + e.message, true)
    }
  }, 400)
}
const recognize = createRecognizer()
let latestSignals = null // most recent frame's signals (ext + raw features, for record/calibrate)

const $ = (id) => document.getElementById(id)
const status = (msg, isErr = false) => {
  const el = $('status')
  el.textContent = msg
  el.classList.toggle('err', isErr)
}

// --- persistence ---------------------------------------------------------
let persistTimer = null
function persistNow() {
  window.gestureAPI.updateSettings(settings)
}
function persistDebounced() {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(persistNow, 250)
}

function newId() {
  return 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)
}

// --- tuning controls -----------------------------------------------------
const TUNING = [
  { group: 'tuning', key: 'dwellMs', label: 'Dwell (ms)', min: 150, max: 1500, step: 10 },
  { group: 'tuning', key: 'cooldownMs', label: 'Cooldown (ms)', min: 200, max: 3000, step: 50 },
  { group: 'tuning', key: 'pinchRatio', label: 'Pinch enter', min: 0.1, max: 0.8, step: 0.01 },
  { group: 'tuning', key: 'pinchRelease', label: 'Pinch release', min: 0.1, max: 1.0, step: 0.01 },
  { group: 'tuning', key: 'voteWindow', label: 'Smoothing (frames)', min: 1, max: 12, step: 1 },
  { group: 'tuning', key: 'featureSmoothing', label: 'Steadiness (jitter filter)', min: 0, max: 0.9, step: 0.05 },
  { group: 'tuning', key: 'knnMinConfidence', label: 'Recorded-gesture certainty', min: 0.5, max: 1, step: 0.05 },
  { group: 'tuning', key: 'segReadyMs', label: 'Ready delay (ms) — hand must settle', min: 100, max: 2000, step: 50 },
  { group: 'tuning', key: 'commitDelayMs', label: 'Settle hold (ms) — wait for the hand to stop', min: 0, max: 400, step: 20 },
  { group: 'tuning', key: 'activeFps', label: 'Active FPS (while a hand is present)', min: 15, max: 60, step: 5 },
  { group: 'tuning', key: 'idleFps', label: 'Idle FPS (no hand — saves battery)', min: 2, max: 30, step: 1 },
  // Raising these rejects hand-shaped things that aren't hands (lamps, faces,
  // patterned fabric). Changing them rebuilds the detector.
  { group: 'detection', key: 'minHandDetectionConfidence', label: 'Hand detection strictness', min: 0.3, max: 0.95, step: 0.05, rebuild: true },
  { group: 'detection', key: 'minHandPresenceConfidence', label: 'Hand presence strictness', min: 0.3, max: 0.95, step: 0.05, rebuild: true },
  { group: 'handSelect', key: 'takeoverRatio', label: 'Hand takeover', min: 1.0, max: 2.0, step: 0.05 },
  { group: 'handSelect', key: 'maxCentroidJump', label: 'Hand re-acquire', min: 0.05, max: 0.6, step: 0.01 },
]

function renderTuning() {
  const host = $('tuning')
  host.innerHTML = ''
  for (const spec of TUNING) {
    const row = document.createElement('div')
    row.className = 'row'
    const label = document.createElement('label')
    label.textContent = spec.label
    const range = document.createElement('input')
    range.type = 'range'
    range.min = spec.min
    range.max = spec.max
    range.step = spec.step
    range.value = settings[spec.group][spec.key]
    const num = document.createElement('input')
    num.type = 'number'
    num.step = spec.step
    num.value = settings[spec.group][spec.key]

    const apply = (v) => {
      const val = spec.step >= 1 ? Math.round(v) : v
      settings[spec.group][spec.key] = val
      range.value = val
      num.value = val
      if (spec.group === 'handSelect') selectPrimary = createHandSelector(settings)
      if (spec.rebuild) scheduleRebuild()
      persistDebounced()
    }
    range.addEventListener('input', () => apply(parseFloat(range.value)))
    num.addEventListener('change', () => apply(parseFloat(num.value)))

    row.append(label, range, num)
    host.appendChild(row)
  }
}

// --- gesture editor ------------------------------------------------------
function renderGestures() {
  const host = $('gestures')
  host.innerHTML = ''
  settings.gestures.forEach((g, i) => host.appendChild(gestureCard(g, i)))
  refreshTestGestures() // keep the test dropdown in sync with adds/deletes
}

function gestureCard(g, index) {
  const card = document.createElement('div')
  card.className = 'gesture' + (g.enabled === false ? ' disabled' : '')

  // header: enabled + name + delete
  const head = document.createElement('div')
  head.className = 'ghead'
  const en = document.createElement('input')
  en.type = 'checkbox'
  en.checked = g.enabled !== false
  en.title = 'Enabled'
  en.addEventListener('change', () => { g.enabled = en.checked; card.classList.toggle('disabled', !en.checked); persistNow() })
  const name = document.createElement('input')
  name.type = 'text'
  name.value = g.name
  name.addEventListener('input', () => {
    g.name = name.value
    persistDebounced()
    refreshTestGestures() // a rename must show up in the test list too
  })
  const del = document.createElement('button')
  del.className = 'danger'
  del.textContent = '✕'
  del.title = 'Delete gesture'
  del.addEventListener('click', () => { settings.gestures.splice(index, 1); persistNow(); renderGestures() })
  head.append(en, name)
  if (g.type === 'enrolled' || g.type === 'recorded') {
    const rerec = document.createElement('button')
    rerec.textContent = '⟳ Re-record'
    rerec.title = 'Record fresh data, keeping this gesture’s name and action'
    rerec.addEventListener('click', () => (g.type === 'recorded' ? startPoseReRecord(g) : startReRecord(g)))
    head.append(rerec)
  }
  head.append(del)

  // An enrolled motion is learned from your reps. The only real dial is how
  // close a live movement must be — everything else came from the recording.
  if (g.type === 'enrolled') {
    const grid = document.createElement('div')
    grid.className = 'grid2'
    grid.appendChild(selectField('Action', actionOptions(), g.action, (v) => { g.action = v; persistNow() }))
    grid.appendChild(numField('Cooldown (ms)', g.cooldownMs ?? 900, 200, 3000, 50, (v) => { g.cooldownMs = v; persistDebounced() }))
    grid.appendChild(
      numField('Sensitivity (lower = stricter)', Math.round((g.threshold ?? 6) * 100) / 100, 0.5, 30, 0.25, (v) => {
        g.threshold = v
        persistDebounced()
      }),
    )
    card.append(head, grid, enrolledViz(g))
    return card
  }

  // A motion gesture is a trajectory, not a shape — it fires on completion, so
  // dwell/tolerance/finger controls don't apply. Its dials are about the move.
  if (g.type === 'motion') {
    const grid = document.createElement('div')
    grid.className = 'grid2'
    grid.appendChild(
      selectField('Motion', MOTIONS, g.motion, (v) => {
        g.motion = v
        g.direction = (DIRECTIONS[v] || [])[0] || null
        persistNow()
        renderGestures()
      }),
    )
    const dirs = DIRECTIONS[g.motion] || []
    if (dirs.length) {
      grid.appendChild(selectField('Direction', dirs, g.direction || dirs[0], (v) => { g.direction = v; persistNow() }))
    }
    grid.appendChild(selectField('Action', actionOptions(), g.action, (v) => { g.action = v; persistNow() }))

    const poses = settings.gestures.filter((x) => x.type !== 'motion')
    grid.appendChild(
      selectField('Only while pose', ['(any)', ...poses.map((p) => p.name)], g.poseGate ? (poses.find((p) => p.id === g.poseGate)?.name ?? '(any)') : '(any)', (v) => {
        const p = poses.find((x) => x.name === v)
        g.poseGate = p ? p.id : null
        persistNow()
      }),
    )

    const grid2 = document.createElement('div')
    grid2.className = 'grid2'
    grid2.appendChild(numField('Time window (ms)', g.windowMs ?? 600, 150, 2000, 50, (v) => { g.windowMs = v; persistDebounced() }))
    grid2.appendChild(numField('Cooldown (ms)', g.cooldownMs ?? 800, 200, 3000, 50, (v) => { g.cooldownMs = v; persistDebounced() }))
    if (g.motion === 'swipe') {
      grid2.appendChild(numField('Min travel (hand-widths)', g.minDistance ?? 1.2, 0.3, 4, 0.1, (v) => { g.minDistance = v; persistDebounced() }))
    } else if (g.motion === 'rotate') {
      grid2.appendChild(numField('Min rotation (0–2)', g.minRotation ?? 1.0, 0.2, 2, 0.1, (v) => { g.minRotation = v; persistDebounced() }))
    } else {
      grid2.appendChild(numField('Pinch low', g.pinchLow ?? 0.35, 0.1, 1, 0.05, (v) => { g.pinchLow = v; persistDebounced() }))
      grid2.appendChild(numField('Pinch high', g.pinchHigh ?? 0.7, 0.2, 2, 0.05, (v) => { g.pinchHigh = v; persistDebounced() }))
    }

    const info = document.createElement('p')
    info.className = 'note'
    info.textContent = 'Motion gesture · fires when the movement completes (no holding). Travel is measured in hand-widths, so it works at any distance from the camera.'
    card.append(head, grid, grid2, info)
    return card
  }

  // What the motion actually captured, gesture-agnostic (works for a pinch, a
  // zoom, a rotate — not just translations):
  //   • channels — where the motion lives (pose / orientation / position / scale)
  //   • profile — motion amount per phase (one hump = clean; flat tail = a hold)
  //   • quality — rep consistency vs the barriers (rest / other gestures) it must
  //     stay clear of; this predicts reliability for ANY gesture type.
  function enrolledViz(gesture) {
    const wrap = document.createElement('div')
    if (
      !gesture.templates ||
      !gesture.templates.length ||
      gesture.templates[0].length !== DESCRIPTOR_DIMS ||
      gesture.descVersion !== DESC_VERSION
    ) {
      wrap.innerHTML = `<p class="note" style="color:var(--warn)">Enrolled under an older recognition model — delete it and re-enroll to use the new amplitude-tolerant matching.</p>`
      return wrap
    }
    const prof = motionProfile(gesture.templates)
    const ch = channelBreakdown(gesture.templates)
    const c = consistency(gesture.templates, gesture.weights)
    const sep = separations(gesture, settings)
    const thr = gesture.threshold ?? 8

    const W = 200, H = 54
    const bp = Math.max(1e-3, Math.max(...prof))
    const barW = W / prof.length
    const bars = prof
      .map((v, i) => {
        const h = (v / bp) * (H - 8)
        return `<rect x="${(i * barW).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(barW - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="#5ac8ff" opacity="0.8"/>`
      })
      .join('')

    const CH = [['pose', ch.pose], ['orientation', ch.orient], ['position', ch.pos], ['scale', ch.scale]]
    const chanBar = CH.map(([n, f]) => `<span style="opacity:.85">${n} <b>${Math.round(f * 100)}%</b></span>`).join(' · ')

    const barrier = (label, v) => {
      if (v == null) return ''
      const bad = v <= thr
      return `<div class="note">↔ ${label}: <b style="color:${bad ? 'var(--danger)' : 'var(--good)'}">${v.toFixed(1)}</b>${bad ? ' (below threshold!)' : ''}</div>`
    }

    wrap.innerHTML =
      `<div class="note">Motion by channel: ${chanBar}</div>
       <svg width="${W}" height="${H}" style="background:var(--bg);border:1px solid var(--line);border-radius:6px;margin:6px 0">${bars}</svg>
       <p class="note">Motion per phase (a single hump = a clean burst; a long flat tail = your hand held still — trim it by relaxing right after the motion).</p>
       <div class="note">Reps agree within <b>${c.loose.toFixed(1)}</b> · threshold <b>${thr.toFixed(1)}</b></div>
       ${barrier('a still hand', sep.rest)}
       ${barrier('nearest other gesture', sep.others)}
       <p class="note">${(gesture.templates || []).length} reps · ~${gesture.durationMs}ms · matched continuously at several speeds. Good = tight rep agreement AND both barriers comfortably above the threshold.</p>`
    return wrap
  }

  // A recorded gesture matches by learned example, so the finger-rule controls
  // don't apply to it — show what it learned from instead.
  if (g.type === 'recorded') {
    const grid = document.createElement('div')
    grid.className = 'grid2'
    grid.appendChild(selectField('Action', actionOptions(), g.action, (v) => { g.action = v; persistNow() }))
    grid.appendChild(
      numField('Dwell override (ms, blank = global)', g.dwellMs ?? '', 0, 3000, 10, (v) => {
        g.dwellMs = Number.isFinite(v) ? v : null
        persistDebounced()
      }, true),
    )
    const info = document.createElement('p')
    info.className = 'note'
    const otherPoses = settings.gestures.filter((x) => x.type === 'recorded' && x.enabled !== false && x !== g).length
    if (!otherPoses) {
      info.style.color = 'var(--warn)'
      info.innerHTML = `⚠ Only pose recorded — it can't fire yet. With one pose, k-NN matches <b>any</b> hand, so it's disabled until you record a second pose to compare against (e.g. a “rest” pose with Action = None).`
    } else {
      info.textContent = `Recorded pose · ${(g.templates || []).length} frames captured · matched by whole-hand similarity, not finger rules.`
    }
    card.append(head, grid, info)
    return card
  }

  // action + pinch
  const grid = document.createElement('div')
  grid.className = 'grid2'
  grid.appendChild(selectField('Action', actionOptions(), g.action, (v) => { g.action = v; persistNow() }))
  grid.appendChild(selectField('Pinch', ['any', 'required', 'forbidden'], g.pinch || 'any', (v) => { g.pinch = v; persistNow() }))
  grid.appendChild(selectField('Spread (extended fingers)', ['any', 'spread', 'together'], g.spread || 'any', (v) => { g.spread = v; persistNow() }))

  // tolerance + dwell override
  const grid2 = document.createElement('div')
  grid2.className = 'grid2'
  grid2.appendChild(numField('Tolerance (lower = stricter pose)', g.tolerance ?? 0.4, 0.1, 0.7, 0.05, (v) => { g.tolerance = v; persistDebounced() }))
  grid2.appendChild(
    numField('Dwell override (ms, blank = global)', g.dwellMs ?? '', 0, 3000, 10, (v) => {
      g.dwellMs = Number.isFinite(v) ? v : null
      persistDebounced()
    }, true),
  )

  // finger pattern
  const fset = document.createElement('div')
  fset.className = 'fingerset'
  for (const f of FINGERS) fset.appendChild(fingerControl(g, f))

  // actions: record pose
  const acts = document.createElement('div')
  acts.className = 'gactions'
  const rec = document.createElement('button')
  rec.textContent = '⦿ Record current pose'
  rec.addEventListener('click', () => {
    if (!latestSignals) return status('No hand detected to record.', true)
    g.fingers = poseToFingers(latestSignals.ext)
    persistNow()
    renderGestures()
  })
  acts.appendChild(rec)

  card.append(head, grid, grid2, fset, acts)
  return card
}

function fingerControl(g, finger) {
  const col = document.createElement('div')
  col.className = 'fcol'
  const nm = document.createElement('div')
  nm.className = 'fname'
  nm.textContent = FINGER_LABELS[finger]
  const seg = document.createElement('div')
  seg.className = 'seg'
  const states = [['up', '▲'], ['any', '–'], ['down', '▼']]
  const buttons = {}
  for (const [state, glyph] of states) {
    const b = document.createElement('button')
    b.textContent = glyph
    b.title = state
    b.classList.toggle('on', (g.fingers[finger] || 'any') === state)
    b.addEventListener('click', () => {
      g.fingers[finger] = state
      for (const s of Object.keys(buttons)) buttons[s].classList.toggle('on', s === state)
      persistNow()
    })
    buttons[state] = b
    seg.appendChild(b)
  }
  col.append(nm, seg)
  return col
}

function poseToFingers(ext) {
  const out = {}
  for (const f of FINGERS) {
    const e = ext[f]
    out[f] = e >= 0.6 ? 'up' : e <= 0.4 ? 'down' : 'any'
  }
  return out
}

function selectField(label, options, value, onChange) {
  const wrap = document.createElement('label')
  wrap.className = 'field'
  const span = document.createElement('span')
  span.textContent = label
  const sel = document.createElement('select')
  for (const o of options) {
    const val = typeof o === 'string' ? o : o.value
    const lbl = typeof o === 'string' ? o : o.label
    const opt = document.createElement('option')
    opt.value = val
    opt.textContent = lbl
    if (val === value) opt.selected = true
    sel.appendChild(opt)
  }
  sel.addEventListener('change', () => onChange(sel.value))
  wrap.append(span, sel)
  return wrap
}

function numField(label, value, min, max, step, onChange, allowBlank = false) {
  const wrap = document.createElement('label')
  wrap.className = 'field'
  const span = document.createElement('span')
  span.textContent = label
  const inp = document.createElement('input')
  inp.type = 'number'
  inp.min = min
  inp.max = max
  inp.step = step
  inp.value = value
  inp.addEventListener('change', () => {
    if (allowBlank && inp.value === '') return onChange(NaN)
    onChange(parseFloat(inp.value))
  })
  wrap.append(span, inp)
  return wrap
}

function addGesture(g) {
  settings.gestures.push({ id: newId(), enabled: true, ...g })
  persistNow()
  renderGestures()
  refreshTestGestures()
}

// --- data capture --------------------------------------------------------
// Logs the raw hand + derived features per frame so a model can be fitted to the
// real pose manifold offline, instead of hand-picking a feature and probing a
// few points. Landmarks are the payload: any candidate feature can be recomputed
// from them later without needing another recording.
const MAX_FRAMES = 4000 // ~2 min at 30fps; guards against unbounded memory
let recording = null

const r4 = (v) => Math.round(v * 10000) / 10000

function recordFrame(world, img, handLabel, signals) {
  if (!recording || !world || recording.frames.length >= MAX_FRAMES) return
  recording.frames.push({
    t: Math.round(performance.now() - recording.t0),
    hand: handLabel,
    world: world.map((p) => [r4(p.x), r4(p.y), r4(p.z || 0)]),
    img: img.map((p) => [r4(p.x), r4(p.y), r4(p.z || 0)]),
    feats: {
      curl: Object.fromEntries(FINGERS.map((f) => [f, r4(signals.rawCurl[f])])),
      spread: r4(signals.rawSpread),
      thumbTravel: r4(signals.rawThumbTravel),
      thumbDepth: r4(signals.rawThumbDepth),
      palmFacing: r4(signals.palmFacing),
    },
  })
}

async function toggleRecord() {
  const btn = $('recBtn')
  if (recording) {
    const payload = recording
    recording = null
    btn.textContent = '● Record'
    btn.classList.remove('on')
    if (!payload.frames.length) {
      $('recStatus').textContent = 'Nothing captured — no hand was detected.'
      return
    }
    $('recStatus').textContent = `Saving ${payload.frames.length} frames…`
    try {
      const file = await window.gestureAPI.saveRecording(payload)
      $('recStatus').innerHTML =
        `Saved ${payload.frames.length} frames · <span class="path">${file}</span>`
    } catch (e) {
      $('recStatus').textContent = 'Save failed: ' + e.message
    }
  } else {
    const label = ($('recLabel').value || 'session').trim()
    recording = { label, t0: performance.now(), frames: [], calibration: settings.calibration }
    btn.textContent = '■ Stop'
    btn.classList.add('on')
    $('recStatus').textContent = `Recording “${label}” — move your hand through every orientation…`
  }
}

function wireRecorder() {
  $('recBtn').addEventListener('click', toggleRecord)
  setInterval(() => {
    if (recording) {
      $('recStatus').textContent =
        `Recording “${recording.label}” — ${recording.frames.length} frames. Keep moving through orientations…`
    }
  }, 500)
}

// --- recognition test harness --------------------------------------------
// The motion stream cannot tell us how many times you MEANT to do the gesture —
// a burst is not an intent, and returns / adjustments / strays are all bursts.
// Auto-counting attempts is therefore either circular (using the recognizer to
// define what it's being tested against) or a shape hack that fits one gesture
// family and lies about the rest. So the attempt count comes from YOU; the test
// only counts what FIRES. Two runs, both free of any gesture-shape assumption:
//   detect — you perform it N times at your pace: misses = N−fires, extras = fires−N
//   quiet  — you don't perform it at all: every fire is a false positive
let testState = null

// The spotter calls this on every recognition (actuation is separate — the overlay
// would dispatch g.action; here we only tally). We record whatever fires; scoring
// interprets it against the count you provided, never against segmented bursts.
function onGestureFired(g) {
  if (!testState) return
  testState.fires.push({ t: performance.now(), id: g.id, name: g.name })
  updateTestUI()
}

function renderDiagnosis(g, st, r) {
  const out = []
  if (g.type !== 'enrolled') {
    out.push(`<div class="note">Held-pose gesture — fires on dwell; no motion diagnosis.</div>`)
    return out.join('')
  }
  const thr = g.threshold ?? 8
  const c = consistency(g.templates, g.weights)
  const sep = separations(g, settings)
  out.push(`<div class="note">Fire threshold: <b>${thr.toFixed(1)}</b> · reps agree within <b>${c.loose.toFixed(1)}</b> (tighter = better enrollment).</div>`)
  const barrier = (label, v) => {
    if (v == null) return
    const bad = v <= thr
    out.push(`<div class="note">Distance to ${label}: <b>${v.toFixed(1)}</b> ${bad ? '<span style="color:var(--danger)">— below threshold, will confuse/false-fire</span>' : '<span style="color:var(--good)">— clear</span>'}</div>`)
  }
  barrier('a still hand', sep.rest)
  barrier('nearest other gesture', sep.others)

  // Closest the spotter came to the target across the whole run (telemetry = the
  // per-frame distance). Without pairing we can't name WHICH attempt, but the
  // closest approach says whether the misses were even matchable.
  const tel = (st.telemetry || []).map((s) => s.d).filter(Number.isFinite)
  if (tel.length && r && r.miss) {
    const closest = Math.min(...tel)
    if (closest > thr) {
      const ceil = Math.min(...[sep.rest, sep.others].filter((v) => v != null).concat(Infinity))
      const suggestion = Math.min(closest * 1.05, ceil * 0.9)
      out.push(`<div class="note" style="color:var(--warn)">Its closest approach all run was <b>${closest.toFixed(1)}</b> — never under the <b>${thr.toFixed(1)}</b> threshold. The missed reps didn't resemble your enrollment (weaker/faster/different shape). Re-enroll including the gentler flicks you actually make, or raise sensitivity toward <b>${suggestion.toFixed(1)}</b>${Number.isFinite(ceil) ? ` (under the ${ceil.toFixed(1)} barrier)` : ''}.</div>`)
    } else {
      out.push(`<div class="note" style="opacity:.8">It did dip to <b>${closest.toFixed(1)}</b> (under threshold) during the run, so the gesture matches — the misses are most likely back-to-back reps landing inside the <b>${g.cooldownMs ?? 700}ms</b> cooldown. Space them slightly, or lower the cooldown.</div>`)
    }
  }
  return out.join('')
}

function scoreDetect(st) {
  const fired = st.fires.filter((f) => f.id === st.gestureId).length
  const other = st.fires.filter((f) => f.id !== st.gestureId)
  const otherNames = {}
  for (const f of other) otherNames[f.name] = (otherNames[f.name] || 0) + 1
  return {
    n: st.target,
    fired,
    hits: Math.min(fired, st.target),
    miss: Math.max(0, st.target - fired),
    extra: Math.max(0, fired - st.target),
    other: other.length,
    otherNames,
  }
}

function renderDetect(r, g, st) {
  const rate = r.n ? Math.round((r.hits / r.n) * 100) : 0
  const bits = [`<div style="font-size:15px;margin-bottom:6px"><b>${r.hits}/${r.n}</b> intended reps fired (${rate}%)</div>`]
  if (r.miss) bits.push(`<div class="note">✗ <b>${r.miss}</b> missed — you performed it, nothing fired</div>`)
  if (r.extra) bits.push(`<div class="note" style="color:var(--warn)">⚠ <b>${r.extra}</b> more fires than the ${r.n} you intended — a return or stray motion is also matching. Run a Quiet check to isolate it.</div>`)
  if (r.other) bits.push(`<div class="note">✗ a different gesture fired <b>${r.other}</b>× — ${Object.entries(r.otherNames).map(([n, c]) => `${n}×${c}`).join(', ')}</div>`)
  if (!r.miss && !r.extra && !r.other) bits.push(`<div class="note" style="color:var(--good)">Clean — every intended rep fired, nothing else did.</div>`)
  bits.push(`<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--line)"><b>Why:</b></div>`)
  bits.push(renderDiagnosis(g, st, r))
  $('testResults').innerHTML = `<div class="assist-result">${bits.join('')}</div>`
}

function renderQuiet(st) {
  const secs = Math.max(1, (st.stopT - st.startT) / 1000)
  const n = st.fires.length
  const names = {}
  for (const f of st.fires) names[f.name] = (names[f.name] || 0) + 1
  const bits = [`<div style="font-size:15px;margin-bottom:6px"><b>${n}</b> false fire${n === 1 ? '' : 's'} in ${secs.toFixed(0)}s${n ? ` (${((n / secs) * 60).toFixed(1)}/min)` : ''}</div>`]
  if (!n) bits.push(`<div class="note" style="color:var(--good)">Nothing fired while you weren't gesturing — returns and idle motion are being rejected.</div>`)
  else bits.push(`<div class="note">Fired without intent: ${Object.entries(names).map(([nm, c]) => `${nm}×${c}`).join(', ')}. Each is a false positive — raise the threshold or tighten enrollment until this is zero.</div>`)
  $('testResults').innerHTML = `<div class="assist-result">${bits.join('')}</div>`
}

function updateTestUI() {
  if (!testState) return
  const cue = $('testCue')
  if (testState.mode === 'quiet') {
    const f = testState.fires.length
    cue.className = f ? 'cue' : 'cue go'
    cue.textContent = `quiet run — ${f} false fire${f === 1 ? '' : 's'} so far · press Stop when done`
  } else {
    const fired = testState.fires.filter((x) => x.id === testState.gestureId).length
    cue.className = 'cue go'
    cue.textContent = `${fired} fired — perform "${testState.gName}" ${testState.target}× then press Stop`
  }
}

function stopTest() {
  const st = testState
  st.stopT = performance.now()
  testState = null
  $('testBtn').textContent = '▶ Detection run'
  $('testBtn').classList.remove('on')
  $('testQuietBtn').textContent = 'Quiet check'
  $('testQuietBtn').classList.remove('on')
  $('testCue').className = 'cue'
  $('testCue').textContent = 'done'
  const g = settings.gestures.find((x) => x.id === st.gestureId)
  if (st.mode === 'quiet') renderQuiet(st)
  else renderDetect(scoreDetect(st), g, st)
}

function startTest(mode) {
  const g = settings.gestures.find((x) => x.id === $('testGesture').value)
  if (!g) return status('No gesture selected.', true)
  if (g.type === 'enrolled' && g.descVersion !== DESC_VERSION)
    return status('This gesture was enrolled under the old recognition model — delete it and re-enroll before testing.', true)
  const target = Math.max(1, Math.min(60, parseInt($('testReps').value, 10) || 10))
  testState = { gestureId: g.id, gName: g.name, mode, target, fires: [], telemetry: [], startT: performance.now() }
  const btn = mode === 'detect' ? $('testBtn') : $('testQuietBtn')
  btn.textContent = '■ Stop'
  btn.classList.add('on')
  $('testResults').innerHTML = ''
  $('testCue').className = 'cue ready'
  $('testCue').textContent = mode === 'detect'
    ? `perform "${g.name}" ${target}× at your own pace — then Stop`
    : `move normally but do NOT perform "${g.name}" — then Stop`
  updateTestUI()
}

function toggleTest(mode) {
  if (testState) return stopTest() // either button stops an in-progress run
  startTest(mode)
}

function refreshTestGestures() {
  const sel = $('testGesture')
  const prev = sel.value
  sel.innerHTML = ''
  for (const g of settings.gestures) {
    const o = document.createElement('option')
    o.value = g.id
    o.textContent = `${g.name} (${g.type || 'rule'})`
    sel.appendChild(o)
  }
  if (prev) sel.value = prev
}

function wireTest() {
  $('testBtn').addEventListener('click', () => toggleTest('detect'))
  $('testQuietBtn').addEventListener('click', () => toggleTest('quiet'))
  refreshTestGestures()
}

// --- enrolled motions ----------------------------------------------------
// Rolling per-frame motion history (pose + palm normal + centroid + size), so an
// enrollment rep can be sliced out around each detected motion burst.
const motionBuf = []
let motionEMA = null // smoothed motion-feature state; reset when the hand leaves
const SEG_PAD = 80 // ms of context either side of the detected burst

// Visible arming state: green READY means a gesture would be accepted right now.
// Amber means the hand hasn't settled yet, so anything you do is treated as a
// transition rather than intent — which is the point: knowing why it ignored you.
let readyState = null
function setReadyPill(state) {
  if (state === readyState) return
  readyState = state
  const el = $('readyPill')
  el.className = 'readypill' + (state === 'ready' ? ' ready' : state === 'wait' ? ' busy' : '')
  el.textContent = state === 'ready' ? 'READY' : state === 'wait' ? 'settling…' : 'no hand'
}

function sliceMotion(from, to) {
  return motionBuf.filter((f) => f.t >= from && f.t <= to)
}

// A deliberate movement just completed (a motion-energy burst). During
// enrollment it becomes a template; during a test it counts as one attempt.
// Recognition is NOT done here anymore — the continuous spotter handles that,
// so a gesture no longer has to be cleanly segmented to be recognized.
function onSegment(seg) {
  const desc = buildDescriptor(sliceMotion(seg.start - SEG_PAD, seg.end + SEG_PAD))
  if (!desc) return
  const dur = Math.round(seg.end - seg.start)

  if (enrolling) {
    enrolling.bursts.push(desc)
    enrolling.durations.push(dur)
    updateEnrollUI()
    return
  }
  // The test no longer counts bursts as attempts — a burst isn't an intent.
}

let enrolling = null

const ENROLL_MIN = 6 // fewest good reps before we'll call it done
const ENROLL_MAX = 30 // stop collecting no matter what
const ENROLL_STRONG = 12 // this many good reps = definitely strong

// Separate the gesture from its return (and stray catches) by SELF-SIMILARITY.
// You start from rest and perform the gesture first, so burst 0 anchors "the
// gesture". Distances from the anchor to later bursts are bimodal — a tight
// cluster (real reps) and a far cluster (returns / strays). Cut at the largest
// gap between them: everything nearer than the gap is kept, the rest rejected.
// No fixed count, no "hold the end just right" — the returns are filtered out.
function clusterReps(bursts) {
  if (bursts.length <= 1) return { kept: bursts.map((_, i) => i), strays: [] }
  const anchor = bursts[0]
  const rest = bursts.map((b, i) => ({ i, d: i === 0 ? 0 : trajDist(anchor, b) })).filter((x) => x.i !== 0)
  rest.sort((a, b) => a.d - b.d)
  const spread = rest[rest.length - 1].d - rest[0].d
  let cut = Infinity
  let gap = 0
  for (let k = 1; k < rest.length; k++) {
    const g = rest[k].d - rest[k - 1].d
    if (g > gap) { gap = g; cut = g > spread * 0.35 && g > 0.5 ? rest[k].d : Infinity }
  }
  const kept = [0], strays = []
  for (const x of rest) (x.d < cut ? kept : strays).push(x.i)
  return { kept, strays }
}

function enrollStrength(reps) {
  if (reps.length < ENROLL_MIN) return { signal: 'forming', strong: false, loose: Infinity }
  const loose = consistency(reps).loose
  // Converged when the recent additions haven't loosened the cluster.
  enrolling.looseHist.push(loose)
  const h = enrolling.looseHist
  const stable = h.length >= 3 && Math.abs(h[h.length - 1] - h[h.length - 3]) < 0.1 * (h[h.length - 3] || 1)
  const strong = reps.length >= ENROLL_STRONG || (reps.length >= ENROLL_MIN && stable)
  return { signal: strong ? 'strong' : 'building', strong, loose }
}

function updateEnrollUI() {
  const cue = $('enrollCue')
  if (!enrolling) return
  const { kept, strays } = clusterReps(enrolling.bursts)
  const reps = kept.map((i) => enrolling.bursts[i])
  const { signal, strong, loose } = enrollStrength(reps)
  cue.className = reps.length >= ENROLL_MIN ? 'cue go' : 'cue ready'
  cue.textContent =
    `${reps.length} reps${strays.length ? ` · ${strays.length} strays dropped` : ''}` +
    ` · ${signal}${Number.isFinite(loose) ? ` (tightness ${loose.toFixed(1)})` : ''}`
  if (strong || enrolling.bursts.length >= ENROLL_MAX) finishEnroll()
}

function finishEnroll() {
  const { name, targetId } = enrolling
  const { kept } = clusterReps(enrolling.bursts)
  const reps = kept.map((i) => enrolling.bursts[i])
  const durs = kept.map((i) => enrolling.durations[i])
  enrolling = null
  $('enrollBtn').textContent = '● Enroll motion'
  $('enrollBtn').classList.remove('on')
  $('enrollCue').style.display = 'none'

  if (reps.length < 4) return status('Not enough consistent reps — perform the SAME motion a few more times.', true)
  const medDur = [...durs].sort((a, b) => a - b)[Math.floor(durs.length / 2)]
  const rounded = reps.map((t) => t.map((v) => Math.round(v * 1000) / 1000))
  const weights = computeWeights(rounded) // learn the per-dimension metric from these reps
  const threshold = suggestThreshold(rounded, settings, null, weights)

  if (targetId) {
    const g = settings.gestures.find((x) => x.id === targetId)
    if (!g) return status('That gesture no longer exists.', true)
    // Replace ONLY the learned parts; keep name, action, cooldown, enabled, id.
    Object.assign(g, { templates: rounded, weights, durationMs: medDur, descVersion: DESC_VERSION, threshold })
    persistNow()
    renderGestures()
    status(`Re-recorded “${g.name}” — ${reps.length} reps, ~${medDur}ms. Action “${g.action}” kept.`)
    return
  }

  addGesture({
    name,
    type: 'enrolled',
    descVersion: DESC_VERSION,
    templates: rounded,
    weights,
    durationMs: medDur,
    threshold,
    cooldownMs: 700,
    action: 'none',
  })
  $('enrollName').value = ''
  status(`Enrolled “${name}” — ${reps.length} consistent reps, ~${medDur}ms each. Test it next.`)
}

function enrollMotion() {
  const btn = $('enrollBtn')
  const cue = $('enrollCue')
  if (enrolling) {
    // Manual stop → finalize with whatever's converged so far (if enough).
    if (clusterReps(enrolling.bursts).kept.length >= 4) finishEnroll()
    else {
      enrolling = null
      btn.textContent = '● Enroll motion'
      btn.classList.remove('on')
      cue.style.display = 'none'
    }
    return
  }
  const name = ($('enrollName').value || '').trim()
  if (!name) return status('Name the motion first.', true)
  beginEnroll(name, null)
}

// Shared start for a NEW motion and for a re-record. targetId set → finishEnroll
// updates that gesture in place (name / action / cooldown / id preserved) instead
// of creating a new one.
function beginEnroll(name, targetId) {
  enrolling = { name, targetId: targetId || null, bursts: [], durations: [], looseHist: [] }
  $('enrollBtn').textContent = '■ Done'
  $('enrollBtn').classList.add('on')
  const cue = $('enrollCue')
  cue.style.display = ''
  cue.className = 'cue ready'
  cue.textContent = targetId
    ? `Re-recording “${name}” — repeat until it says “strong”`
    : 'Perform the gesture — repeat until it says “strong”'
}

function startReRecord(gesture) {
  if (enrolling) return status('Finish the current recording first.', true)
  beginEnroll(gesture.name, gesture.id)
  status(`Re-recording “${gesture.name}” — perform it again; its name and action are kept.`)
}

function wireEnroll() {
  $('enrollBtn').addEventListener('click', enrollMotion)
}

// --- recorded gestures ---------------------------------------------------
// Store ~120 prototypes per gesture: measured on 3191 real frames, 100/gesture
// scores 89.9% vs 90.5% for keeping all 744 — the rest is redundant bulk.
const MAX_POSE_FRAMES = 600 // only thins if a recording is enormous; a normal hold keeps every frame
let gestureRec = null // { name, targetId?, frames: [canon vectors] }

function subsample(frames, n) {
  if (frames.length <= n) return frames
  const step = frames.length / n
  const out = []
  for (let i = 0; i < n; i++) out.push(frames[Math.floor(i * step)])
  return out
}

const round4 = (v) => Math.round(v * 10000) / 10000

function toggleGestureRecord() {
  const btn = $('gRecBtn')
  if (gestureRec) {
    const { name, frames, targetId } = gestureRec
    gestureRec = null
    btn.textContent = '● Record pose'
    btn.classList.remove('on')
    if (frames.length < 30) {
      status(`Only ${frames.length} frames — hold the pose longer.`, true)
      return
    }
    const templates = subsample(frames, MAX_POSE_FRAMES).map((v) => v.map(round4))
    if (targetId) {
      const g = settings.gestures.find((x) => x.id === targetId)
      if (!g) return status('That pose no longer exists.', true)
      g.templates = templates // replace; keep name / action / dwell / id
      persistNow()
      renderGestures()
      status(`Re-recorded “${g.name}” — ${templates.length} frames. Action “${g.action}” kept.`)
      return
    }
    addGesture({
      name,
      type: 'recorded',
      templates,
      dwellMs: null,
      action: 'none',
    })
    $('gRecName').value = ''
    status(`Recorded “${name}” — ${templates.length} frames. Use it as a motion's pose gate, or give it an action.`)
  } else {
    const name = ($('gRecName').value || '').trim()
    if (!name) return status('Name the gesture first.', true)
    gestureRec = { name, frames: [] }
    btn.textContent = '■ Stop'
    btn.classList.add('on')
    status(`Recording “${name}” — sweep through every orientation…`)
  }
}

function startPoseReRecord(gesture) {
  if (gestureRec || enrolling) return status('Finish the current recording first.', true)
  gestureRec = { name: gesture.name, targetId: gesture.id, frames: [] }
  const btn = $('gRecBtn')
  btn.textContent = '■ Stop'
  btn.classList.add('on')
  status(`Re-recording pose “${gesture.name}” — hold it and sweep orientations, then Stop. Name & action are kept.`)
}

function wireGestureRecorder() {
  $('gRecBtn').addEventListener('click', toggleGestureRecord)
}

// --- calibration ---------------------------------------------------------
function median(arr) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function refreshCalUI() {
  $('calStatus').textContent = settings.calibration.captured
    ? 'Calibrated to your hand. Re-capture any pose to refine.'
    : 'Not calibrated — using defaults. Capture open + fist for accurate finger bars.'
}

// Sample the raw features for ~0.7s and store the median as a calibration point.
async function capture(kind) {
  if (!latestSignals) return status('No hand detected — show your hand first.', true)
  status(`Capturing “${kind}” — hold the pose steady…`)
  const curl = { thumb: [], index: [], middle: [], ring: [], pinky: [] }
  const spread = []
  const start = performance.now()
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      if (latestSignals) {
        for (const f of FINGERS) curl[f].push(latestSignals.rawCurl[f])
        spread.push(latestSignals.rawSpread)
      }
      if (performance.now() - start >= 700) { clearInterval(iv); resolve() }
    }, 20)
  })

  const cal = settings.calibration
  if (kind === 'open') for (const f of FINGERS) cal.curlOpen[f] = median(curl[f])
  else if (kind === 'fist') for (const f of FINGERS) cal.curlClosed[f] = median(curl[f])
  else if (kind === 'spread') cal.splaySpread = median(spread)
  else if (kind === 'together') cal.splayTogether = median(spread)
  cal.captured = true
  persistNow()
  refreshCalUI()
  status(`Captured “${kind}”.`)
}

function wireCalibration() {
  document.querySelectorAll('[data-cal]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await capture(btn.dataset.cal)
      btn.classList.add('captured')
    })
  })
  refreshCalUI()
}

// --- live preview --------------------------------------------------------
function buildFingerBars() {
  const host = $('fingerBars')
  host.innerHTML = ''
  const els = {}
  for (const f of FINGERS) {
    const col = document.createElement('div')
    col.className = 'finger'
    const track = document.createElement('div')
    track.className = 'track'
    const fill = document.createElement('div')
    fill.className = 'fill'
    const mid = document.createElement('div')
    mid.className = 'mid'
    track.append(fill, mid)
    const lbl = document.createElement('div')
    lbl.className = 'lbl'
    lbl.textContent = FINGER_LABELS[f]
    const val = document.createElement('div')
    val.className = 'val'
    const raw = document.createElement('div')
    raw.className = 'raw'
    col.append(track, lbl, val, raw)
    host.appendChild(col)
    els[f] = { fill, val, raw }
  }
  return els
}

// Hand centroid + size in image space. Motion needs POSITION — which the
// canonicalized pose vector deliberately throws away.
async function startPreview() {
  const canvas = $('cam')
  const ctx = canvas.getContext('2d')
  const W = canvas.width
  const H = canvas.height
  const bars = buildFingerBars()

  const video = document.createElement('video')
  video.autoplay = true
  video.playsInline = true
  video.muted = true
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: settings.camera.width, height: settings.camera.height, facingMode: settings.camera.facingMode },
    audio: false,
  })
  video.srcObject = stream
  await video.play()

  const vision = await FilesetResolver.forVisionTasks(WASM_URL)
  // Detection thresholds are constructor options, so changing them means
  // rebuilding the detector rather than just setting a variable.
  makeLandmarker = async () => {
    const next = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: settings.detection.numHands,
      minHandDetectionConfidence: settings.detection.minHandDetectionConfidence,
      minHandPresenceConfidence: settings.detection.minHandPresenceConfidence,
      minTrackingConfidence: settings.detection.minTrackingConfidence,
    })
    const old = landmarker
    landmarker = next
    if (old) old.close()
  }
  await makeLandmarker()
  status('Live — show your hand.')

  // Both engines run here so the test harness can score pose AND motion
  // gestures. The studio never performs window actions — it only reports what
  // fired, which is the thing under test.
  const poseEngine = createGestureEngine(onGestureFired)
  const segmenter = createSegmenter() // enrollment rep-cutting + test attempt counting
  const spotter = createSpotter(onGestureFired) // settle-gated inside; test measures real behavior

  let lastTs = 0
  let loopErrors = 0
  function loop() {
    // Always reschedule, even if this frame throws — otherwise a single bad frame
    // kills requestAnimationFrame and the preview freezes on the last image.
    try {
      frame()
    } catch (e) {
      if (loopErrors++ < 3) {
        console.error('[loop] frame error:', e)
        status('Frame error: ' + e.message, true)
      }
    }
    requestAnimationFrame(loop)
  }

  function frame() {
    let now = performance.now()
    if (now <= lastTs) now = lastTs + 1
    lastTs = now

    if (!landmarker) return // mid-rebuild
    const results = landmarker.detectForVideo(video, now)
    const hands = results.landmarks || []
    const worldHands = results.worldLandmarks || []
    const handed = results.handednesses || results.handedness || []
    const idx = selectPrimary(hands)
    const primary = idx >= 0 ? hands[idx] : null
    const worldPrimary = idx >= 0 ? worldHands[idx] || null : null
    const handCat = idx >= 0 && handed[idx] && handed[idx][0] ? handed[idx][0] : null
    const handLabel = handCat ? handCat.categoryName : null
    // Handedness confidence is the one per-detection score MediaPipe exposes.
    // A real hand scores high; a lamp it mistook for a hand should score low —
    // which makes it measurable rather than a matter of opinion.
    const handScore = handCat ? handCat.score : 0

    // draw mirrored camera + all hands (primary bright)
    ctx.save()
    ctx.clearRect(0, 0, W, H)
    ctx.translate(W, 0)
    ctx.scale(-1, 1)
    if (video.readyState >= 2) ctx.drawImage(video, 0, 0, W, H)
    for (const h of hands) drawHand(ctx, h, h === primary, W, H)
    ctx.restore()

    const rec = recognize(primary, worldPrimary, settings, handLabel)
    latestSignals = rec.signals
    if (!primary) {
      // No hand in frame at all. The segmenter must know, or the movement of a
      // hand ENTERING the frame reads as a gesture starting from rest.
      segmenter(now, 0, settings.tuning, false)
      setReadyPill('none')
      motionEMA = null // don't smear smoothing across a disappearance
    }
    if (rec.signals && primary) {
      recordFrame(worldPrimary, primary, handLabel, rec.signals)

      // Pose gestures (held): dwell/hold via the pose recognizer.
      poseEngine(rec.matched, now, settings)

      // Motion gestures: build the per-frame hand state and run BOTH the spotter
      // (continuous recognition — fires) and the segmenter (burst detection —
      // counts deliberate movements for enrollment and the test).
      if (worldPrimary) {
        // Smooth the motion features (EMA) before they enter the pipeline — the
        // palm-normal estimate especially is jittery frame-to-frame, and that
        // jitter was flowing straight into every descriptor (measured: it's the
        // dominant noise in the orientation channel). This was previously only
        // applied to pose recognition, never to motion.
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
        const mf = { canon: [...motionEMA.canon], n: [...motionEMA.n], cx: motionEMA.cx, cy: motionEMA.cy, size: motionEMA.size }

        // Motion energy = per-frame change of the whole hand state. Drives the
        // segmenter and reveals how long a gesture actually takes.
        const prev = motionBuf[motionBuf.length - 1]
        let energy = 0
        if (prev) {
          let s = 0
          for (let i = 0; i < mf.canon.length; i++) s += (mf.canon[i] - prev.canon[i]) ** 2
          energy = Math.sqrt(s)
        }
        motionBuf.push({ t: now, ...mf })
        while (motionBuf.length && now - motionBuf[0].t > 6000) motionBuf.shift()

        const scores = spotter(now, mf, settings) // recognition (may call onGestureFired)
        if (testState && Number.isFinite(scores[testState.gestureId])) {
          testState.telemetry.push({ t: now, d: scores[testState.gestureId] })
        }

        const { seg, ready } = segmenter(now, energy, settings.tuning, true)
        setReadyPill(ready ? 'ready' : 'wait')
        if (seg) onSegment(seg)
      } else {
        segmenter(now, 0, settings.tuning, false)
        setReadyPill('none')
      }
    }
    if (gestureRec && worldPrimary) {
      gestureRec.frames.push(canonicalize(worldPrimary))
      $('status').textContent = `Recording “${gestureRec.name}” — ${gestureRec.frames.length} frames. Keep sweeping orientations…`
    }
    if (rec.signals) {
      for (const f of FINGERS) {
        const e = rec.signals.ext[f]
        bars[f].fill.style.height = `${Math.round(e * 100)}%`
        bars[f].val.textContent = e.toFixed(2)
        bars[f].raw.textContent = rec.signals.rawCurl[f].toFixed(0)
      }
      $('spreadVal').textContent =
        `spread ${rec.signals.spread.toFixed(2)} · palm facing ${rec.signals.palmFacing.toFixed(2)}` +
        ` · hands seen: ${hands.length} · confidence ${(handScore * 100).toFixed(0)}%`
      $('matchName').textContent = rec.matched ? rec.matched.name : '—'
      $('matchRaw').textContent = rec.matched ? '' : rec.raw !== 'none' ? `(raw ${idName(rec.raw)})` : ''
    } else {
      $('matchName').textContent = '—'
      $('matchRaw').textContent = ''
      $('spreadVal').textContent = '—'
      for (const f of FINGERS) {
        bars[f].fill.style.height = '0%'
        bars[f].val.textContent = ''
        bars[f].raw.textContent = ''
      }
    }
  }

  requestAnimationFrame(loop)
}

function idName(id) {
  const g = settings.gestures.find((x) => x.id === id)
  return g ? g.name : id
}

function drawHand(ctx, lm, primary, W, H) {
  ctx.lineWidth = primary ? 2 : 1.5
  ctx.strokeStyle = primary ? 'rgba(90,200,255,0.9)' : 'rgba(90,200,255,0.28)'
  ctx.beginPath()
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.moveTo(lm[a].x * W, lm[a].y * H)
    ctx.lineTo(lm[b].x * W, lm[b].y * H)
  }
  ctx.stroke()
  ctx.fillStyle = primary ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,0.35)'
  for (const p of lm) {
    ctx.beginPath()
    ctx.arc(p.x * W, p.y * H, primary ? 3 : 2, 0, Math.PI * 2)
    ctx.fill()
  }
}

// --- boot ----------------------------------------------------------------
async function main() {
  settings = await window.gestureAPI.getSettings()
  selectPrimary = createHandSelector(settings)

  window.gestureAPI.onSettingsChanged((next) => {
    // External change (e.g. menu-bar dry-run). Keep our working copy in sync for
    // fields we don't actively edit; don't clobber the editor mid-interaction.
    settings.debug = next.debug
  })

  renderTuning()
  renderGestures()
  wireCalibration()
  wireRecorder()
  wireGestureRecorder()
  wireEnroll()
  wireTest()

  // Rule gestures and primitive motions are no longer offered — your own data
  // killed both (finger flags: 0.87 separation; swipe-on-centroid: isotropic
  // 0.41 left / 0.37 right). Their matchers stay so any existing gesture keeps
  // working, but there are now exactly two ways to make one: enroll a motion,
  // or record a pose.

  try {
    await startPreview()
  } catch (e) {
    status('Camera error: ' + e.message, true)
    console.error(e)
  }
}

main().catch((e) => {
  status('Startup error: ' + e.message, true)
  console.error(e)
})
