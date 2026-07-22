// Feature model + gesture matcher + trigger state machine. Shared by the overlay
// (actuator) and the studio (editor). Geometry is computed from MediaPipe's
// worldLandmarks (metric 3D) so it's projection-invariant, and normalized
// against a per-user calibration so 0 = your fist and 1 = your open hand.
//
// MediaPipe Hands returns 21 landmarks per hand:
//   0 wrist
//   thumb  1 CMC  2 MCP  3 IP   4 TIP
//   index  5 MCP  6 PIP  7 DIP  8 TIP
//   middle 9 MCP 10 PIP 11 DIP 12 TIP
//   ring  13 MCP 14 PIP 15 DIP 16 TIP
//   pinky 17 MCP 18 PIP 19 DIP 20 TIP

const WRIST = 0
const THUMB_TIP = 4
const INDEX_TIP = 8
const MIDDLE_MCP = 9

export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky']

// [MCP, PIP, DIP, TIP] per finger — used for the reach-ratio curl metric.
// Kinematic chains for curl: consecutive points whose bends we sum. Fingers
// start at the wrist so the MCP (knuckle) bend is included; the thumb uses its
// own joints. Curl = sum of the turn angles between consecutive bones, which is
// rotation-invariant (angles between vectors don't depend on the camera frame).
const CHAIN = {
  index: [0, 5, 6, 7, 8],
  middle: [0, 9, 10, 11, 12],
  ring: [0, 13, 14, 15, 16],
  pinky: [0, 17, 18, 19, 20],
}
const CURL_FINGERS = ['index', 'middle', 'ring', 'pinky']

const clamp01 = (v) => Math.min(1, Math.max(0, v))
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) })
const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
const norm3 = (a) => { const m = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / m, y: a.y / m, z: a.z / m } }

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0))
}

// Turn angle (degrees) between segment a→b and b→c. 0 = straight, up to 180 = folded.
function turn(geo, a, b, c) {
  const u = sub(geo[b], geo[a]), v = sub(geo[c], geo[b])
  const m = Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z) || 1
  return (Math.acos(Math.min(1, Math.max(-1, dot3(u, v) / m))) * 180) / Math.PI
}

// Total flexion of a finger = sum of the bends at each joint along its chain.
function fingerFlexion(geo, chain) {
  let sum = 0
  for (let i = 0; i + 2 < chain.length; i++) sum += turn(geo, chain[i], chain[i + 1], chain[i + 2])
  return sum
}

// A canonical coordinate frame attached to the palm, so features can be measured
// independent of how the hand is rotated in space. y = up the palm (wrist →
// middle knuckle), z = palm normal, x = across the palm; scaled by palm length.
function palmFrame(geo) {
  const origin = geo[0]
  const y = norm3(sub(geo[9], geo[0]))
  const z = norm3(cross(sub(geo[17], geo[5]), y)) // palm normal from the across-vector
  const x = cross(y, z)
  const scale = dist(geo[9], geo[0]) || 1
  return { origin, x, y, z, scale }
}

// Which way the palm faces, computed ONLY from well-observed landmarks (wrist +
// index/middle/pinky knuckles) — never from the thumb, since using a possibly-
// fabricated thumb to decide whether the thumb is fabricated would be circular.
// Returns the palm normal's component along the camera axis; handedness flips the
// sign because index→pinky reverses between hands. Sign convention is unverified
// — this is exposed as a diagnostic to be measured, not assumed.
export function palmFacing(geo, handLabel) {
  const y = norm3(sub(geo[9], geo[0]))
  const n = norm3(cross(sub(geo[17], geo[5]), y))
  return n.z * (handLabel === 'Left' ? -1 : 1)
}

function toLocal(p, F) {
  const d = sub(p, F.origin)
  return { x: dot3(d, F.x) / F.scale, y: dot3(d, F.y) / F.scale, z: dot3(d, F.z) / F.scale }
}

// A finger's proximal direction (MCP → PIP) projected onto the palm plane, so
// splay ignores tilt toward/away from the camera (the noisy depth axis).
function inPlaneDir(geo, F, mcp, pip) {
  const a = toLocal(geo[mcp], F), b = toLocal(geo[pip], F)
  return { x: b.x - a.x, y: b.y - a.y } // drop z (palm normal)
}

function angle2(u, v) {
  const m = Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y) || 1
  return (Math.acos(Math.min(1, Math.max(-1, (u.x * v.x + u.y * v.y) / m))) * 180) / Math.PI
}

// The thumb doesn't FOLD when you tuck it — it swings across the palm at the CMC
// (saddle) joint, so its MCP/IP flexion barely changes between open and fist
// (~2°). Measure its travel instead: how far the tip sits from the pinky knuckle.
//
// Critically, normalize by PALM WIDTH (index knuckle → pinky knuckle), not palm
// length. Both the numerator and this denominator are ACROSS-palm spans, so when
// the hand rotates about its long axis and that axis swings into the camera's
// depth direction (where MediaPipe's estimate is weakest), both distort together
// and the error largely cancels in the ratio. Normalizing by an along-palm span
// instead leaves the numerator corrupted and the denominator clean — which made
// the same fist read 64 face-on and 181 rotated.
function thumbTravel(geo) {
  const palmWidth = dist(geo[5], geo[17]) || 1
  return (dist(geo[4], geo[17]) / palmWidth) * 100
}

// Angle (degrees) between segment (a1→a2) and (b1→b2), in 3D.
function vecAngle(geo, a1, a2, b1, b2) {
  const u = sub(geo[a2], geo[a1]), v = sub(geo[b2], geo[b1])
  const m = Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z) || 1
  return (Math.acos(Math.min(1, Math.max(-1, dot3(u, v) / m))) * 180) / Math.PI
}

// Thumb measured from its BASE instead of its tip: the angle between the thumb's
// metacarpal (CMC→MCP, 1→2) and the index metacarpal (wrist→index MCP, 0→5).
// Both vectors live on the rigid palm plate, which stays observable when the
// thumb's TIP disappears behind a fist — and abduction physically happens at the
// CMC anyway, so this is where the signal actually originates. Angle between two
// 3D vectors → rotation-invariant. Small = adducted/tucked, large = abducted.
function thumbAbduction(geo) {
  return vecAngle(geo, 1, 2, 0, 5)
}

// How far the thumb tip sits in front of / behind the palm, in palm-widths.
// This is the observability check: when the thumb is behind the hand the camera
// physically cannot see it, and MediaPipe reports a fabricated position rather
// than admitting it doesn't know. Sign follows MediaPipe's z convention.
function thumbDepth(geo) {
  const palmZ = ((geo[0].z || 0) + (geo[5].z || 0) + (geo[9].z || 0) + (geo[17].z || 0)) / 4
  const palmWidth = dist(geo[5], geo[17]) || 1
  return ((geo[4].z || 0) - palmZ) / palmWidth
}

// Raw, un-normalized features (for calibration capture). rawCurl = total flexion
// per finger (degrees, higher = more curled) — except the thumb, which is its
// travel metric. rawSpread = mean splay (degrees).
export function rawFeatures(geo) {
  const F = palmFrame(geo)
  // Thumb now measured from its base (abduction at the CMC). The old tip-based
  // travel metric is kept alongside purely as a diagnostic, so the two can be
  // compared under rotation rather than argued about.
  const rawCurl = { thumb: thumbAbduction(geo) }
  const rawThumbTravel = thumbTravel(geo)
  const rawThumbDepth = thumbDepth(geo)
  for (const f of CURL_FINGERS) rawCurl[f] = fingerFlexion(geo, CHAIN[f])
  const di = inPlaneDir(geo, F, 5, 6)
  const dm = inPlaneDir(geo, F, 9, 10)
  const dr = inPlaneDir(geo, F, 13, 14)
  const dp = inPlaneDir(geo, F, 17, 18)
  const rawSpread = (angle2(di, dm) + angle2(dm, dr) + angle2(dr, dp)) / 3
  return { rawCurl, rawSpread, rawThumbDepth, rawThumbTravel }
}

// Turn (already-smoothed) raw features into normalized signals, using the user's
// calibration so 0 = fist and 1 = open. Pinch stays in image space (its own tuning).
export function normalizeSignals(raw, img, settings, pinchActive) {
  const t = settings.tuning
  const cal = settings.calibration

  const ext = {}
  for (const f of FINGERS) {
    // curlOpen = flexion when straight (small), curlClosed = when fisted (large).
    const lo = cal.curlOpen[f], hi = cal.curlClosed[f]
    ext[f] = hi === lo ? 0.5 : clamp01((hi - raw.rawCurl[f]) / (hi - lo))
  }
  const spread =
    cal.splaySpread === cal.splayTogether
      ? 0.5
      : clamp01((raw.rawSpread - cal.splayTogether) / (cal.splaySpread - cal.splayTogether))

  const scale = dist(img[WRIST], img[MIDDLE_MCP]) || 1
  const pinchDist = dist(img[THUMB_TIP], img[INDEX_TIP]) / scale
  const pinch = pinchActive ? pinchDist < t.pinchRelease : pinchDist < t.pinchRatio

  return {
    ext,
    rawCurl: raw.rawCurl,
    spread,
    rawSpread: raw.rawSpread,
    rawThumbDepth: raw.rawThumbDepth,
    rawThumbTravel: raw.rawThumbTravel,
    pinchDist,
    pinch,
  }
}

// --- Recorded gestures (learned templates) ---------------------------------
// Hand-crafted scalars provably cannot separate poses that differ only by the
// thumb: across 3191 recorded frames, the best of 18 candidate features scored
// 0.87 separation on fist↔thumbs-up (≈ chance; ~2.0 is usable). The signal isn't
// in any one number — it's in the joint configuration of all 21 points. Matching
// the whole canonicalized hand against recorded examples gets 97%+ precision on
// that same pair. So: rules for simple finger poses, templates for the rest.

// Express every landmark in the palm's own frame, scaled by palm length: strips
// global rotation/translation/scale, leaving pose. 60 dims (wrist is the origin).
export function canonicalize(world) {
  const y = norm3(sub(world[9], world[0]))
  const z = norm3(cross(sub(world[17], world[5]), y))
  const x = cross(y, z)
  const s = dist(world[9], world[0]) || 1
  const out = []
  for (let i = 1; i < 21; i++) {
    const d = sub(world[i], world[0])
    out.push(dot3(d, x) / s, dot3(d, y) / s, dot3(d, z) / s)
  }
  return out
}

function sqdist(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2
  return s
}

// k-NN over every recorded gesture's templates, pooled. Returns the winner only
// if the neighbour vote is decisive — an indecisive vote means "don't know", and
// for a trigger, declining to fire is always the right answer when unsure.
// (A distance threshold does NOT work as a reject: thumbs-up sits inside the
// fist's distance cloud. Rejection comes from recording a 'none' class instead.)
export function matchRecorded(vec, settings) {
  const k = settings.tuning.knnK ?? 15
  const minConf = settings.tuning.knnMinConfidence ?? 0.9
  const pool = []
  const classes = new Set()
  for (const g of settings.gestures) {
    if (g.type !== 'recorded' || g.enabled === false || !g.templates) continue
    classes.add(g.id)
    for (const t of g.templates) pool.push({ t, id: g.id })
  }
  // A single pose class wins every vote (its own templates are always the nearest
  // neighbours), so it would fire on ANY hand. k-NN needs something to lose to —
  // at minimum a recorded 'rest' class. With <2 classes, decline rather than
  // false-fire constantly.
  if (!pool.length || classes.size < 2) return null

  const scored = pool.map((p) => ({ d: sqdist(vec, p.t), id: p.id })).sort((a, b) => a.d - b.d)
  const top = scored.slice(0, Math.min(k, scored.length))
  const tally = {}
  for (const s of top) tally[s.id] = (tally[s.id] || 0) + 1
  let bestId = null, bestN = 0
  for (const [id, n] of Object.entries(tally)) if (n > bestN) { bestN = n; bestId = id }
  const conf = bestN / top.length
  return conf < minConf ? null : { id: bestId, conf }
}

// Does this hand satisfy a gesture definition? Extension is 0 (fully curled) …
// 1 (fully straight), calibrated to the user. `tolerance` = how far from the
// ideal pose is allowed (lower = stricter): a 'down' finger must read
// <= tolerance, an 'up' finger >= 1 - tolerance; 'any' is ignored. Spread is
// evaluated for gestures that require it.
export function gestureMatches(g, signals) {
  const tol = g.tolerance ?? 0.4
  for (const f of FINGERS) {
    const want = g.fingers[f]
    if (!want || want === 'any') continue
    const e = signals.ext[f]
    if (want === 'up' && e < 1 - tol) return false
    if (want === 'down' && e > tol) return false
  }
  const spread = g.spread || 'any'
  if (spread === 'spread' && signals.spread < 0.5) return false
  if (spread === 'together' && signals.spread > 0.5) return false
  if (g.pinch === 'required' && !signals.pinch) return false
  if (g.pinch === 'forbidden' && signals.pinch) return false
  return true
}

function specificity(g) {
  let n = 0
  for (const f of FINGERS) if (g.fingers[f] && g.fingers[f] !== 'any') n++
  if (g.spread && g.spread !== 'any') n++
  if (g.pinch === 'required' || g.pinch === 'forbidden') n++
  return n
}

// Best-matching enabled gesture id for the current frame, or 'none'. Ties break
// toward the most specific (fewest 'any') gesture.
export function bestMatch(signals, settings) {
  let best = null
  for (const g of settings.gestures) {
    if (g.enabled === false) continue
    if (g.type === 'recorded') continue // handled by matchRecorded, not finger rules
    if (!g.fingers) continue
    if (!gestureMatches(g, signals)) continue
    if (!best || specificity(g) > specificity(best)) best = g
  }
  return best ? best.id : 'none'
}

// --- Primary-hand arbitration --------------------------------------------
// Given all detected hands (image landmarks), return the INDEX of the hand that
// should drive gestures: the one closest to the camera (largest bounding box),
// with continuity + hysteresis so control doesn't jitter. Returns -1 if none.

function handSize(lm) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0
  for (const p of lm) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return Math.hypot(maxX - minX, maxY - minY)
}

function centroid(lm) {
  let x = 0, y = 0
  for (const p of lm) { x += p.x; y += p.y }
  return { x: x / lm.length, y: y / lm.length }
}

function centroidDist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function createHandSelector(settings) {
  const { takeoverRatio, maxCentroidJump } = settings.handSelect
  let lastCentroid = null

  return function select(hands) {
    if (!hands || hands.length === 0) {
      lastCentroid = null
      return -1
    }
    const metrics = hands.map((lm, i) => ({ i, size: handSize(lm), c: centroid(lm) }))
    const largest = metrics.reduce((a, b) => (b.size > a.size ? b : a))

    let primary
    if (!lastCentroid) {
      primary = largest
    } else {
      const cont = metrics.reduce((a, b) =>
        centroidDist(b.c, lastCentroid) < centroidDist(a.c, lastCentroid) ? b : a,
      )
      if (centroidDist(cont.c, lastCentroid) > maxCentroidJump) {
        primary = largest
      } else if (largest !== cont && largest.size > cont.size * takeoverRatio) {
        primary = largest
      } else {
        primary = cont
      }
    }
    lastCentroid = primary.c
    return primary.i
  }
}

function majority(votes) {
  const counts = {}
  let best = votes[votes.length - 1]
  let bestN = 0
  for (const v of votes) {
    counts[v] = (counts[v] || 0) + 1
    if (counts[v] > bestN) { bestN = counts[v]; best = v }
  }
  return best
}

// Stateful recognizer: holds pinch hysteresis + the vote window so one flickery
// frame doesn't reset a hold. recognize(img, world, settings) returns
// { matched, name, raw, signals }.
export function createRecognizer() {
  const votes = []
  let pinchActive = false
  let smooth = null // exponentially-smoothed raw features
  let thumbBelief = null // tracked thumb state (coasts through occlusion)

  return function recognize(img, world, settings, handLabel) {
    if (!img || img.length < 21) {
      votes.length = 0
      pinchActive = false
      smooth = null
      thumbBelief = null
      return { matched: null, name: 'none', raw: 'none', signals: null }
    }

    const usedWorld = Boolean(world && world.length >= 21)
    const geo = usedWorld ? world : img
    const fresh = rawFeatures(geo)
    const cal = settings.calibration
    const s = Math.min(0.95, Math.max(0, settings.tuning.featureSmoothing ?? 0.5))

    // Fingers + spread: straight smoothing of the raw features.
    if (!smooth) {
      smooth = {
        rawCurl: { ...fresh.rawCurl },
        rawSpread: fresh.rawSpread,
        rawThumbDepth: fresh.rawThumbDepth,
        rawThumbTravel: fresh.rawThumbTravel,
      }
    } else {
      for (const f of CURL_FINGERS) smooth.rawCurl[f] = smooth.rawCurl[f] * s + fresh.rawCurl[f] * (1 - s)
      smooth.rawSpread = smooth.rawSpread * s + fresh.rawSpread * (1 - s)
      smooth.rawThumbDepth = smooth.rawThumbDepth * s + fresh.rawThumbDepth * (1 - s)
      smooth.rawThumbTravel = smooth.rawThumbTravel * s + fresh.rawThumbTravel * (1 - s)
    }

    // How many fingers are confidently curled? This is well-observed data, and it
    // constrains what the thumb is physically allowed to be doing.
    let curled = 0
    for (const f of CURL_FINGERS) {
      const lo = cal.curlOpen[f], hi = cal.curlClosed[f]
      const e = hi === lo ? 0.5 : clamp01((hi - smooth.rawCurl[f]) / (hi - lo))
      if (e < 0.35) curled++
    }
    const fistLike = curled === CURL_FINGERS.length

    // --- Thumb: belief tracking ----------------------------------------------
    // The belief scaffold is here, but there is deliberately NO plausibility gate
    // on the thumb's value: with the fist closed the thumb can still be tucked,
    // thumbs-up, OR abducted laterally, which spans nearly the whole range. A
    // scalar band therefore cannot separate a hallucinated thumb from a real
    // pose, and would reject genuine configurations. The sound discriminator is
    // OBSERVABILITY (is the thumb behind the hand right now?) plus continuity —
    // pending an empirical check of the thumb-depth sign. Until then: track.
    const obs = fresh.rawCurl.thumb
    if (thumbBelief === null) thumbBelief = obs
    else thumbBelief = thumbBelief * s + obs * (1 - s)
    smooth.rawCurl.thumb = thumbBelief

    const signals = normalizeSignals(smooth, img, settings, pinchActive)
    signals.geoSrc = usedWorld ? 'world' : 'image' // diagnostic: which landmark set fed the features
    signals.fistLike = fistLike
    signals.thumbObs = obs
    signals.palmFacing = palmFacing(geo, handLabel)
    pinchActive = signals.pinch

    // Recorded (learned) gestures take precedence when the match is decisive;
    // fall back to the finger rules otherwise.
    let raw = 'none'
    const rec = matchRecorded(canonicalize(geo), settings)
    signals.knnConf = rec ? rec.conf : 0
    if (rec) raw = rec.id
    else raw = bestMatch(signals, settings)

    votes.push(raw)
    while (votes.length > settings.tuning.voteWindow) votes.shift()
    const name = majority(votes)

    const matched = name === 'none' ? null : settings.gestures.find((g) => g.id === name) || null
    return { matched, name, raw, signals }
  }
}

// --- Enrolled motions (learned from repetitions) ---------------------------
// Same lesson as poses: don't specify, demonstrate. You perform the motion ~10
// times, each rep becomes a template, and live movement is matched against them.
// Hand-parameterized primitives can't express "flick two fingers left" — that
// motion lives in the fingers moving relative to the palm, and measured on real
// data the hand centroid barely moves directionally at all (0.41 left vs 0.37
// right / 0.45 up — isotropic wobble, no directional signal).
//
// Each frame contributes: canonical pose (fingers relative to palm — catches the
// flick), palm normal (catches wrist rotation, which canonical pose removes by
// design), and centroid drift (catches whole-hand travel). Low-dimensional
// blocks are up-weighted so 60 dims of pose don't drown out 3 dims of rotation.
// ===========================================================================
// MOTION GESTURES — a gesture is a trajectory through the full space of what a
// hand can do. That space has four channels, and different gestures live in
// different ones (measured on real data: a "flick" is 42% orientation / 32%
// position / 26% pose; a pinch is ~all pose; a push toward camera is ~all scale):
//
//   pose         fingers relative to the palm  (canonical landmarks, absolute)
//   orientation  palm direction                (Δ from the motion's start)
//   position     centroid in frame             (Δ from start, hand-width units)
//   scale        hand size ≈ depth             (Δ from start, log ratio)
//
// Pose is kept ABSOLUTE so the held shape (two-finger vs fist) constrains the
// match; the other three are relative-to-start so a gesture is about the
// MOVEMENT, not where/how the hand happened to be. Each channel is weighted by
// ~1/√dims so 60 pose dims don't drown out 1 scale dim, with the low-dim motion
// channels boosted since that's where most gesture signal lives. These weights
// are principled starting points — the consistency/distinctness readout is how
// we tell whether a channel is over- or under-counted, not guesswork.
// ===========================================================================
const N = 14 // resample every trajectory to this many points
// dims per resampled frame: 60 pose-shape (absolute) + 60 pose-VELOCITY (fingers
// moving relative to the palm — e.g. bent→straight) + 3 orient + 2 pos + 1 scale.
const PER = 126
export const DESCRIPTOR_DIMS = N * PER // 1764 — templates from older builds differ and must be re-enrolled
export const DESC_VERSION = 7 // bump when descriptor MEANING or the metric changes; stale templates re-enroll
const DUR_REF = 300 // ms — reference cadence; motion channels are SPEED relative to this
const W_POSE = 0.13 // ≈ 1/√60 — absolute hand shape (a weak gate)
const W_POSE_VEL = 0.5 // finger motion relative to the palm — a primary signal for finger gestures
const W_ORIENT = 1.2
const W_POS = 1.4
const W_SCALE = 2.0

export function palmNormalOf(geo) {
  const y = norm3(sub(geo[9], geo[0]))
  return norm3(cross(sub(geo[17], geo[5]), y))
}

// Bounding-box centroid + diagonal size in image space.
function centroidSize(lm) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0, sx = 0, sy = 0
  for (const p of lm) {
    sx += p.x; sy += p.y
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { cx: sx / lm.length, cy: sy / lm.length, size: Math.hypot(maxX - minX, maxY - minY) || 0.001 }
}

// One raw (pre-smoothing) motion frame: pose (canon), palm normal, mirror-
// corrected centroid (so "left" = the user's left), hand size. The SINGLE source
// of truth for both enrollment (studio) and live recognition (overlay) — if these
// two built frames differently, live frames would never match the templates.
export function motionFrame(primary, worldPrimary) {
  const { cx, cy, size } = centroidSize(primary)
  const n = palmNormalOf(worldPrimary)
  return { canon: canonicalize(worldPrimary), n: [n.x, n.y, n.z], cx: 1 - cx, cy, size }
}

// Per-frame speed: magnitude of change across the whole hand state between two
// frames (unweighted — this is only used to locate the motion, not to match).
function stepSpeed(a, b) {
  let s = 0
  for (let k = 0; k < a.canon.length; k++) s += (a.canon[k] - b.canon[k]) ** 2
  for (let k = 0; k < 3; k++) s += (a.n[k] - b.n[k]) ** 2
  s += (a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2 + Math.log((a.size || 1) / (b.size || 1)) ** 2
  return Math.sqrt(s)
}

// Trim leading/trailing frames whose speed is a small fraction of the peak — the
// still "approach" and the held tail after a flick. This ALIGNS reps on their
// actual motion instead of on where the segmenter happened to cut: a fast flick
// followed by a long hold becomes the same descriptor as a fast flick with no
// hold. Measured cause of failure: a ~150ms burst inside a ~500ms padded segment
// landed at a different phase each rep, so every channel read as noise (uniform
// SNR≈0.7). Trimming also makes the SPEED honest — measured over the burst, not
// diluted by stillness.
function activeSpan(frames) {
  if (frames.length < 4) return frames
  const e = [0]
  for (let i = 1; i < frames.length; i++) e.push(stepSpeed(frames[i], frames[i - 1]))
  const peak = Math.max(...e) || 1
  const thr = 0.15 * peak
  let lo = 1, hi = frames.length - 1
  while (lo < hi && e[lo] < thr) lo++ // first frame where real motion starts
  while (hi > lo && e[hi] < thr) hi-- // last frame with real motion
  lo = Math.max(0, lo - 2); hi = Math.min(frames.length - 1, hi + 1) // a little context
  return hi - lo >= 2 ? frames.slice(lo, hi + 1) : frames
}

// Per-frame hand state → one fixed-length descriptor. First trims to the active
// motion (so reps align on the movement, not the segment). Resamples the (variable-
// length, variable-speed) frame list to N points over its OWN timeline (so a fast
// and a slow rep align by phase), carrying each sample's real timestamp so the
// motion channels can be expressed as SPEED, not displacement.
//
// Motion = per-step velocity × (DUR_REF / step_duration): change per real second,
// scaled to a reference cadence. Why speed and not Δ-from-start:
//   • A short QUICK flick and a long flick have the SAME speed (displacement ÷
//     duration), so casually-sized reps match — the amplitude falls out.
//   • A still or drifting hand has ~zero speed, so a small deliberate flick is far
//     from rest instead of sitting halfway to it (which Δ-from-start could never fix).
// Pose stays ABSOLUTE so the held shape (two-finger vs fist) still constrains it.
// frames: [{ t, canon:[60], n:[3], cx, cy, size }]
export function buildDescriptor(rawFrames) {
  if (!rawFrames || rawFrames.length < 2) return null
  const frames = activeSpan(rawFrames)
  const R = [], T = []
  for (let i = 0; i < N; i++) {
    const pos = (i * (frames.length - 1)) / (N - 1)
    const lo = Math.floor(pos)
    const hi = Math.min(frames.length - 1, lo + 1)
    const t = pos - lo
    const a = frames[lo], b = frames[hi]
    R.push({
      canon: a.canon.map((v, k) => v * (1 - t) + b.canon[k] * t),
      n: a.n.map((v, k) => v * (1 - t) + b.n[k] * t),
      cx: a.cx * (1 - t) + b.cx * t,
      cy: a.cy * (1 - t) + b.cy * t,
      size: a.size * (1 - t) + b.size * t,
    })
    T.push((a.t ?? 0) * (1 - t) + (b.t ?? 0) * t)
  }
  const s0 = R[0].size || 0.001
  // Velocity over a ~40ms CENTRAL baseline, not frame-to-frame: palm-normal is the
  // jitteriest signal and a per-frame derivative amplifies that jitter (measured:
  // orientation carried the most rep noise, SNR 1.7). Averaging the derivative over
  // a few samples cancels sensor jitter while keeping the real motion. The half-
  // window adapts to cadence so a long gesture isn't over-smoothed.
  const stepMs = Math.max(1, (T[N - 1] - T[0]) / (N - 1))
  const w = Math.max(1, Math.min(3, Math.round(40 / stepMs)))
  const out = []
  for (let i = 0; i < N; i++) {
    const f = R[i]
    const ai = Math.max(0, i - w), bi = Math.min(N - 1, i + w)
    const a = R[ai], b = R[bi]
    const gain = DUR_REF / Math.max(1, T[bi] - T[ai]) // change per reference-cadence step = speed
    for (const v of f.canon) out.push(v * W_POSE) // pose absolute — held shape (weak gate)
    for (let k = 0; k < 60; k++) out.push((b.canon[k] - a.canon[k]) * gain * W_POSE_VEL) // finger motion vs palm
    for (let k = 0; k < 3; k++) out.push((b.n[k] - a.n[k]) * gain * W_ORIENT)
    out.push(((b.cx - a.cx) / s0) * gain * W_POS)
    out.push(((b.cy - a.cy) / s0) * gain * W_POS)
    out.push(Math.log((b.size || s0) / (a.size || s0)) * gain * W_SCALE)
  }
  return out
}

export function trajDist(a, b, w) {
  let s = 0
  if (w) for (let i = 0; i < a.length; i++) s += w[i] * (a[i] - b[i]) ** 2
  else for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2
  return Math.sqrt(s)
}

// Learn a per-DIMENSION weight from the reps instead of hand-setting per-channel
// weights. A dimension that moves the same way every rep is signal; one that
// scatters is noise. weight = signal² / (rep-variance + reg) — a diagonal Fisher
// metric. "signal" = how far the dim sits from a still hand: velocity dims
// (d%PER≥60) rest at 0 so signal=|mean|; absolute-pose dims are held at rest, so
// they can't help separate from it → signal 0 → weight 0 (auto-dropped). Net: the
// matcher trusts the fingertips and the decisive parts of the motion, and ignores
// palm jitter and shape wobble, with nothing hand-tuned. reg is a high-ish typical
// variance so consistent-but-tiny dims can't blow up, and it makes the metric fall
// back toward plain Euclidean when the reps don't say much (few-rep robustness).
export function computeWeights(templates) {
  const D = templates[0].length, m = templates.length
  const mean = new Array(D).fill(0)
  for (const t of templates) for (let d = 0; d < D; d++) mean[d] += t[d] / m
  const varr = new Array(D).fill(0)
  for (const t of templates) for (let d = 0; d < D; d++) varr[d] += (t[d] - mean[d]) ** 2
  for (let d = 0; d < D; d++) varr[d] /= Math.max(1, m - 1)
  const sorted = varr.slice().sort((a, b) => a - b)
  const reg = Math.max(1e-9, sorted[Math.floor(0.6 * D)])
  const w = new Array(D)
  for (let d = 0; d < D; d++) {
    const sig = d % PER >= 60 ? Math.abs(mean[d]) : 0
    w[d] = (sig * sig) / (varr[d] + reg)
  }
  let s = 0
  for (let d = 0; d < D; d++) s += w[d]
  const k = s > 0 ? D / s : 1 // normalize to mean 1 so thresholds stay in a familiar range
  for (let d = 0; d < D; d++) w[d] = +(w[d] * k).toFixed(4)
  return w
}

// --- Enrollment quality (gesture-agnostic) ---------------------------------
// consistency: how tightly the reps agree. The single best predictor of
// reliability, and it works identically for a pinch, a zoom, or a flick.
export function consistency(templates, w) {
  const ds = []
  for (let i = 0; i < templates.length; i++)
    for (let j = i + 1; j < templates.length; j++) ds.push(trajDist(templates[i], templates[j], w))
  if (!ds.length) return { median: 0, loose: 0 }
  ds.sort((a, b) => a - b)
  return { median: ds[ds.length >> 1], loose: ds[Math.floor(0.9 * (ds.length - 1))] }
}

// Distance from a gesture's templates to "rest" — the same hand holding still
// (motion channels zeroed). This ≈ the gesture's motion magnitude, and it must
// exceed the fire threshold or a motionless hand will false-fire. Computed from
// the templates alone, so it's available even before the gesture is saved.
export function restDistance(templates, w) {
  let restD = Infinity
  for (const t of templates) {
    const rest = t.map((v, i) => (i % PER < 60 ? v : 0)) // keep pose, zero motion Δ
    const d = trajDist(t, rest, w)
    if (d < restD) restD = d
  }
  return restD
}

// distinctness: nearest OTHER enrolled gesture, plus the rest distance above.
// Both must exceed the fire threshold or the gesture confuses / false-fires.
// Uses this gesture's learned metric (g.weights) throughout.
export function separations(g, settings) {
  const w = g.weights
  let others = Infinity
  for (const o of settings.gestures) {
    if (o === g || o.type !== 'enrolled' || !o.templates) continue
    for (const a of g.templates) for (const b of o.templates) { const d = trajDist(a, b, w); if (d < others) others = d }
  }
  return { others: Number.isFinite(others) ? others : null, rest: restDistance(g.templates, w) }
}

// Fraction of the gesture's motion in each channel — the honest replacement for
// "straightness". The motion channels are velocities, so a channel's motion IS
// the magnitude of its values (absolute pose [0,60) is a shape gate, not motion,
// and is excluded). "pose" here = finger velocity relative to the palm.
const CH = { pose: [60, 120], orient: [120, 123], pos: [123, 125], scale: [125, 126] }
export function channelBreakdown(templates) {
  const avg = templates[0].map((_, d) => templates.reduce((s, t) => s + t[d], 0) / templates.length)
  const acc = { pose: 0, orient: 0, pos: 0, scale: 0 }
  for (let f = 0; f < N; f++) {
    for (const ch of Object.keys(CH)) {
      const [lo, hi] = CH[ch]
      for (let k = lo; k < hi; k++) { const v = avg[f * PER + k]; acc[ch] += v * v }
    }
  }
  const tot = acc.pose + acc.orient + acc.pos + acc.scale || 1
  return { pose: acc.pose / tot, orient: acc.orient / tot, pos: acc.pos / tot, scale: acc.scale / tot }
}

// Per-phase motion magnitude (the velocity channels only) — shows where the
// movement happens vs where the hand coasts. A single hump = a clean burst.
export function motionProfile(templates) {
  const avg = templates[0].map((_, d) => templates.reduce((s, t) => s + t[d], 0) / templates.length)
  const prof = []
  for (let f = 0; f < N; f++) {
    let s = 0
    for (let k = 60; k < PER; k++) s += avg[f * PER + k] ** 2 // velocity dims only
    prof.push(Math.sqrt(s))
  }
  return prof
}

// Place the threshold in the safe window: ABOVE the loosest rep pair (so all your
// reps fire) and BELOW every barrier (rest, other gestures — so nothing else
// does). The rest barrier is always available from the templates, so the
// threshold can never accidentally land above a still hand. If the window has
// collapsed (a subtle gesture whose motion barely exceeds its rep noise), we
// return a best-effort value just above the reps and rely on the UI to warn.
export function suggestThreshold(templates, settings, gesture, w) {
  const c = consistency(templates, w)
  let barrier = restDistance(templates, w)
  if (gesture && settings) {
    const s = separations(gesture, settings)
    if (s.others != null) barrier = Math.min(barrier, s.others)
  }
  if (barrier > c.loose) {
    // Sit JUST above the reps, taking only a small slice of the gap. With learned
    // per-dim weights the window is usually wide (rest ≫ reps), and the old midpoint
    // rule left the top of that gap open to near-misses (reaching/relaxing that
    // resembles the gesture). A quarter-gap placement, capped short of the barrier,
    // matched the empirically-clean threshold; the sensitivity slider fine-tunes.
    return Math.min(c.loose + 0.25 * (barrier - c.loose), barrier * 0.8)
  }
  return c.loose * 1.1 // no safe window — gesture too subtle; UI flags it
}

// --- Segmenter: burst detection only ---------------------------------------
// Used for ENROLLMENT (cut each rep) and for the test's attempt-counting. It no
// longer gates recognition — the old "settle 600ms before a gesture" ready-gate
// was a band-aid for segment-based recognition, and it broke consecutive reps.
// Recognition now rejects transitions structurally (see createSpotter): a
// return-to-neutral doesn't match a gesture's trajectory, so no timer is needed.
export function createSegmenter() {
  let startedAt = null
  let quietSince = null
  return function feed(now, energy, t, handPresent) {
    const startE = t.segStartEnergy ?? 0.15
    const endE = t.segEndEnergy ?? 0.09
    const settle = t.segSettleMs ?? 140
    if (!handPresent) { startedAt = null; quietSince = null; return { seg: null, ready: false } }

    let seg = null
    if (startedAt === null) {
      if (energy > startE) startedAt = now
    } else if (energy < endE) {
      if (quietSince === null) quietSince = now
      else if (now - quietSince >= settle) {
        const cand = { start: startedAt, end: quietSince }
        startedAt = null; quietSince = null
        const dur = cand.end - cand.start
        if (dur >= (t.segMinMs ?? 120) && dur <= (t.segMaxMs ?? 1600)) seg = cand
      }
    } else {
      quietSince = null
    }
    return { seg, ready: startedAt === null && handPresent }
  }
}

// --- Continuous spotter (the recognition path) -----------------------------
// At every frame, match the recent buffer (at a few time-scales, for speed
// variation) against every enrolled template. Fire when the best match dips
// below threshold AND then starts rising — i.e. the gesture just PASSED its
// closest point (completed) — with a refractory after. This is standard gesture
// spotting: no explicit segmentation, no ready-gate. Rest and return-to-neutral
// never match a motion template's shape, so they're rejected by construction.
const SCALES = [0.7, 1.0, 1.4]

export function createSpotter(onFire) {
  const buf = []
  const st = {} // per gesture: { below, minD }
  let cand = null // most-recent completion candidate {g, d}, dispatched only at settle
  let peak = 0 // decaying peak speed of the current motion episode
  let slowSince = null // when the hand first dropped below the settle threshold
  let lastFire = -Infinity
  return function update(now, frame, settings) {
    buf.push({ t: now, ...frame })
    while (buf.length && now - buf[0].t > 2500) buf.shift()

    const scores = {}
    for (const g of settings.gestures) {
      if (g.type !== 'enrolled' || g.enabled === false || !g.templates || !g.templates.length) continue
      if (g.descVersion !== DESC_VERSION) continue // enrolled under an older descriptor — needs re-enroll
      let best = Infinity
      for (const sc of SCALES) {
        const w = buf.filter((s) => s.t >= now - g.durationMs * sc)
        if (w.length < 5) continue
        const desc = buildDescriptor(w)
        if (!desc) continue
        for (const t of g.templates) {
          if (t.length !== desc.length) continue // stale-format template — ignore
          const d = trajDist(desc, t, g.weights)
          if (d < best) best = d
        }
      }
      scores[g.id] = best
      const s = st[g.id] || (st[g.id] = { below: false, minD: Infinity })
      const thr = g.threshold ?? 8
      if (best <= thr) {
        s.below = true
        if (best < s.minD) s.minD = best
      }
      if (s.below && (best > s.minD * 1.15 || best > thr)) {
        // This gesture just passed its closest point. Don't fire yet — record it as
        // the current candidate (MOST RECENT wins). A windup fires this for the
        // OPPOSITE gesture mid-motion, but it's immediately overwritten by the real
        // stroke that follows, so only the committed motion survives to dispatch.
        cand = { g, d: s.minD, at: now }
        s.below = false
        s.minD = Infinity
      }
    }

    // Dispatch the candidate only once the hand SETTLES — the one thing that
    // separates the intended stroke (hand stops after it) from a windup or a
    // return (always followed by more motion). Settle = speed stays below a
    // fraction of the episode's peak for `commitDelayMs`.
    const speed = buf.length >= 2 ? stepSpeed(buf[buf.length - 1], buf[buf.length - 2]) : 0
    peak = Math.max(speed, peak * 0.9)
    // Settle = the hand DECELERATED after the stroke, not a dead stop — fire at 28%
    // of the episode's peak so natural movement commits without a deliberate hold.
    // The brief `holdMs` (not a low threshold) is what rejects a windup's momentary
    // turn-around: an apex dip rises again fast, a landed flick stays slow.
    const settleThr = Math.max(0.02, 0.28 * peak)
    const holdMs = settings.tuning.commitDelayMs ?? 80
    if (cand && now - cand.at > 500) cand = null // stale (e.g. a return held off by cooldown) — drop it
    if (speed <= settleThr) {
      if (slowSince == null) slowSince = now
      if (cand && now - slowSince >= holdMs && now - lastFire > (cand.g.cooldownMs ?? 700)) {
        const c = cand
        cand = null
        lastFire = now
        peak = speed
        onFire(c.g, c.d)
      }
    } else {
      slowSince = null
    }
    return scores
  }
}

// --- Trigger state machine -------------------------------------------------
// A matched gesture must be held for its dwell before firing; after firing it
// won't fire again until (a) cooldown passes AND (b) the hand re-arms (no match).
export function createGestureEngine(onAction) {
  let heldName = null
  let heldSince = 0
  let lastFire = -Infinity
  let armed = true

  return function update(matched, now, settings) {
    const name = matched ? matched.id : 'none'
    if (name === 'none') armed = true

    if (name !== heldName) {
      heldName = name
      heldSince = now
    }

    if (!matched || !armed) {
      return { name, progress: 0, armed, fired: false }
    }

    const dwellMs = matched.dwellMs || settings.tuning.dwellMs
    const held = now - heldSince
    const progress = Math.min(1, held / dwellMs)

    if (held >= dwellMs && now - lastFire >= settings.tuning.cooldownMs) {
      lastFire = now
      armed = false
      onAction(matched)
      return { name, progress: 1, armed, fired: true }
    }

    return { name, progress, armed, fired: false }
  }
}
