import p5 from 'p5'

// MediaPipe hand skeleton edges (pairs of landmark indices).
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], // thumb
  [0, 5], [5, 6], [6, 7], [7, 8], // index
  [5, 9], [9, 10], [10, 11], [11, 12], // middle
  [9, 13], [13, 14], [14, 15], [15, 16], // ring
  [13, 17], [17, 18], [18, 19], [19, 20], // pinky
  [0, 17], // palm base
]

const W = 480
const H = 360

// Debug overlay: mirrored camera feed, hand skeleton, gesture label,
// dwell-progress ring, and a flash when an action fires. `getState` returns the
// latest shared render state each frame; `video` is the live <video> element.
export function createOverlay(container, getState, video) {
  const sketch = (p) => {
    p.setup = () => {
      const c = p.createCanvas(W, H)
      c.parent(container)
      p.textFont('-apple-system, system-ui, sans-serif')
    }

    p.draw = () => {
      const s = getState()
      p.background(11, 14, 20)

      // Mirrored camera + landmarks (selfie view feels natural).
      p.push()
      p.translate(W, 0)
      p.scale(-1, 1)
      if (video && video.readyState >= 2) {
        p.drawingContext.drawImage(video, 0, 0, W, H)
      }
      // Draw every detected hand; the primary (gesture-driving) one is bright,
      // the others are dimmed so you can see which hand has control.
      const hands = s.hands && s.hands.length ? s.hands : s.landmarks ? [s.landmarks] : []
      for (const h of hands) drawHand(p, h, h === s.landmarks)
      p.pop()

      drawHud(p, s)
    }
  }

  return new p5(sketch)
}

function drawHand(p, lm, isPrimary = true) {
  const lineAlpha = isPrimary ? 220 : 70
  const dotAlpha = isPrimary ? 255 : 90
  p.stroke(90, 200, 255, lineAlpha)
  p.strokeWeight(isPrimary ? 2 : 1.5)
  for (const [a, b] of HAND_CONNECTIONS) {
    p.line(lm[a].x * W, lm[a].y * H, lm[b].x * W, lm[b].y * H)
  }
  p.noStroke()
  p.fill(255, 255, 255, dotAlpha)
  for (const pt of lm) {
    p.circle(pt.x * W, pt.y * H, isPrimary ? 6 : 4)
  }
}

function drawHud(p, s) {
  // Gesture label + live signals (drawn un-mirrored) — your tuning readout.
  p.noStroke()
  p.textAlign(p.LEFT, p.TOP)

  p.fill(203, 213, 225)
  p.textSize(13)
  const rawSuffix = s.rawName && s.rawName !== s.gestureLabel ? `  (raw: ${s.rawName})` : ''
  p.text(`gesture: ${s.gestureLabel}${rawSuffix}`, 10, 10)

  p.textSize(10)
  p.fill(120, 140, 160)
  p.text(`${s.fps} fps · perm: ${s.permission}`, 10, 28)

  if (s.signals && s.signals.ext) {
    const e = s.signals.ext
    const f = (v) => v.toFixed(1)
    p.fill(150, 170, 190)
    p.text(
      `T:${f(e.thumb)} I:${f(e.index)} M:${f(e.middle)} R:${f(e.ring)} P:${f(e.pinky)}  pinch:${s.signals.pinchDist.toFixed(2)}${s.signals.pinch ? ' ●' : ''}`,
      10,
      42,
    )
  }

  // DRY-RUN badge.
  if (s.dryRun) {
    p.fill(230, 180, 60)
    p.textAlign(p.RIGHT, p.TOP)
    p.text('DRY-RUN', W - 10, 10)
    p.textAlign(p.LEFT, p.TOP)
  }

  // Rolling (would-)fire log, stacked up from the bottom-right.
  if (s.fireLog && s.fireLog.length) {
    p.textSize(10)
    p.textAlign(p.RIGHT, p.BOTTOM)
    for (let i = 0; i < s.fireLog.length; i++) {
      const line = s.fireLog[s.fireLog.length - 1 - i]
      p.fill(150, 170, 190, 255 - i * 40)
      p.text(line, W - 10, H - 12 - i * 13)
    }
    p.textAlign(p.LEFT, p.TOP)
  }

  // Dwell-progress ring, bottom-left.
  const cx = 34, cy = H - 34, r = 20
  p.noFill()
  p.stroke(60, 70, 85)
  p.strokeWeight(4)
  p.circle(cx, cy, r * 2)
  if (s.progress > 0) {
    p.stroke(90, 200, 255)
    p.strokeWeight(4)
    p.arc(cx, cy, r * 2, r * 2, -p.HALF_PI, -p.HALF_PI + s.progress * p.TWO_PI)
  }

  // Fire flash — a fading green border for ~350ms after an action fires.
  const since = p.millis() - s.fireFlash
  if (s.fireFlash > 0 && since < 350) {
    const a = p.map(since, 0, 350, 220, 0)
    p.noFill()
    p.stroke(80, 220, 120, a)
    p.strokeWeight(6)
    p.rect(3, 3, W - 6, H - 6)
  }
}
