# Gesture HCI — webcam hand gestures for macOS window management

Control your Mac's windows with hand gestures seen through the webcam. Flick a
window to the left half, throw a shaka to almost-maximize, whatever you teach it —
the **focused** window responds. Gestures are **learned from your own repetitions**
(like training a wake word), not hard-coded, and everything is tuned live in a
built-in **Gesture Studio**.

Runs as a quiet background menu-bar app: the camera preview is hidden by default,
detection sips GPU when your hands are down and only spins up while you're
gesturing, and there is **no cloud** — all recognition is on-device.

> macOS only. Uses the webcam continuously while running (a small green camera
> light stays on); Pause from the menu bar turns it off.

---

## Download

**[⬇︎ Download the latest build](https://github.com/brycelewiswork/gesture-based-hci/releases/latest)** — Apple Silicon (M-series) only.

1. Unzip and move **Gesture HCI.app** to `/Applications`.
2. It's **self-signed, not notarized**, so Gatekeeper will block it on first launch. Clear the quarantine flag once:
   ```bash
   xattr -dr com.apple.quarantine "/Applications/Gesture HCI.app"
   ```
   then open it normally.
3. Grant **Accessibility** when prompted (needed to move windows).

The app runs in the **menu bar (✋)**, not the Dock — open the Gesture Studio from there. Intel Macs and anyone who'd rather not bypass Gatekeeper can [build from source](#install--run) instead.

---

## Requirements

- **macOS** (Apple Silicon or Intel)
- A **webcam**
- **Node 18+**
- **Xcode Command Line Tools** — needed to compile the tiny Swift window helper
  (`xcode-select --install`)

## Install & run

```bash
npm install

# Dev (Vite + Electron with hot reload)
npm run dev
```

To build a clickable, signed `.app` that keeps its Accessibility permission across
rebuilds:

```bash
npm run setup:signing   # once — creates a stable self-signed cert in your login keychain
npm run build:app       # builds + signs → release/mac*/Gesture HCI.app
```

Launch the `.app`. It lives in the **menu bar** (✋), not the Dock.

### Grant Accessibility

Window management uses the macOS Accessibility API, so the bundled helper needs
permission. On first run the app points you to **System Settings → Privacy &
Security → Accessibility** — enable the helper there. Thanks to the stable signing
cert, you only grant this **once** (it survives rebuilds).

---

## How to use it

Open the menu-bar **✋ → Open Gesture Studio**. There are two kinds of gesture:

### Motion gestures (a movement)
A flick, a wrist rotation, a push toward the camera — anything that's a *motion*.

1. Type a name, hit **Enroll motion**.
2. Perform the movement a handful of times **at your own pace**. It keeps going
   until the signal is *strong*, then stops itself. Return-to-start and stray moves
   are dropped automatically, so you don't have to control your timing.
3. On the new gesture's card, pick an **Action** (e.g. *Left Half*).

Recognition is amplitude- and hold-tolerant: a short casual flick and a big
deliberate one both match, and it fires when your hand *settles* after the motion —
so a "windup" in the opposite direction won't trigger the opposite gesture.

### Pose gestures (a held shape)
A shape you hold still (peace sign, shaka, fist). Fires on **dwell** (hold it
briefly).

1. Hit **Record pose**, hold the shape and slowly rotate through a few angles, Stop.
2. **Record a second "rest" pose** — your relaxed / open / typing hands — with
   **Action = None**. This is required: with only one pose the recognizer matches
   *any* hand. Rest gives the match something to lose to.
3. Set the real pose's **Action** and, if you like, a per-gesture **Dwell**.

### Make gestures that fire reliably
A few things separate a gesture that "just works" from a frustrating one:

- **Make it distinct** from your idle hands and from your other gestures. The
  recognizer needs something to tell them apart — a clear direction, a specific
  finger shape, a decisive motion. Opposite pairs (flick left / flick right) are
  fine; vague wiggles are not.
- **Be crisp and consistent.** Perform every enrollment rep the same, decisive way.
  Fast, committed motions enroll far better than slow, drifty ones — the recognizer
  keys on **speed**, and sloppy reps make a fuzzy template.
- **Don't fuss over size or timing.** A small casual version and a big deliberate
  one both match, and you can pause before/after — each rep is trimmed to its active
  burst. Perform it how you *actually* will in daily use.
- **Read the enrollment card.** "Reps agree within" should sit comfortably *below*
  "distance to a still hand" — that gap is your reliability margin. If they're close,
  re-enroll more consistently (or make the gesture more distinct).

### Train both hands
The recognizer is **hand-specific**. The same "flick left" done with your left vs
right hand is genuinely a different movement — different biomechanics, mirrored
geometry — so a gesture enrolled with one hand **won't reliably fire with the
other**. If you want a gesture to work either-handed, **enroll it twice** (once per
hand) and point both at the same Action.

Your non-dominant hand is usually less consistent, so be extra crisp and deliberate
when enrolling it — a fast, repeatable rep matters more there. Re-record if the
enrollment card shows loose rep agreement.

### Validate before you trust it
The **Recognition test** panel:
- **Detection run** — say how many times you'll do it, perform them, Stop. It
  counts what fires (fewer = misses, more = something stray is also matching).
- **Quiet check** — move around *without* doing the gesture; anything that fires is
  a false positive.

### Tune (Tuning panel)
- **Sensitivity** (per gesture) — lower = stricter.
- **Settle hold** — how long the hand must slow before a motion fires (lower =
  snappier, higher = more windup-proof).
- **Active / Idle FPS** — detection rate while gesturing vs idle (idle is the
  battery saver).
- **Steadiness** — jitter smoothing.

---

## Window actions

Mirrors Raycast's window management (single-display geometry): **halves, quarters,
thirds, sixths**, maximize, **almost-maximize (90%, centered)**, reasonable size
(60%), center, maximize height/width, move-to-edge, toggle fullscreen, next/previous
display, and restore. Moves are animated; apps that cap their size (e.g. Claude) are
re-centered, and apps that snap their own position (e.g. Figma) are re-asserted.

## Menu-bar controls (✋)

- **Show / Hide camera preview** — the debug overlay is hidden by default
- **Pause tracking** — turns the camera off
- **Dry-run** — log what *would* fire without moving windows
- **Open Gesture Studio**
- **Quit**

---

## Troubleshooting

Most problems fall into a handful of buckets. Use the **Recognition test** panel to
see what's actually happening before changing anything.

**A gesture never fires, or misses a lot.** Run a **Detection run**. If the card
says it "dipped under threshold" but didn't fire, your reps are too close together
(the cooldown ate them — space them out) or **Settle hold** is too high. If it never
got near the threshold, your live motion doesn't match what you enrolled — re-record
performing it the way you actually do, or nudge **Sensitivity** up (less strict).

**A pose fires on *any* hand, or constantly.** You only recorded one pose. The
matcher (k-NN) always picks the nearest recorded pose, and with one class that's
*always* it. **Record a second "rest" pose** — relaxed / open / typing hands — with
**Action = None**. That gives the vote somewhere to go when you're not signing.

**A windup fires the opposite gesture** (you cock left before flicking right, and
"left" triggers). Raise **Settle hold**. Firing waits for your hand to actually
*stop*; a brief windup that reverses into the real motion won't clear that bar.

**Too many false fires during normal use.** Run a **Quiet check** (move around
*without* gesturing) to see what's matching. Lower **Sensitivity**, raise **Settle
hold**, and for poses make sure your rest class covers the hands you really make —
an **open hand** especially, since it's close to many poses.

**Works with one hand but not the other.** Enroll the other hand as its own gesture
(see [Train both hands](#train-both-hands)).

**Recognized, but the window doesn't move.** In order: (1) grant **Accessibility**
to the helper (System Settings → Privacy & Security → Accessibility); (2) turn off
**Dry-run** in the menu bar; (3) some apps manage their own window — a native
**full-screen** window can't be moved at all, and a few apps cap their size or
re-assert their position (the helper compensates by re-centering / re-asserting, but
a hard full-screen is off-limits).

**It feels laggy.** In Tuning: lower **Settle hold**, raise **Active FPS**, lower
**Steadiness**. Each is a trade-off (snappier vs. more windup-prone / more GPU / more
jitter) — see the Tune section.

**Nothing detects at all.** Check the camera isn't **Paused** (menu bar) and that
another app hasn't grabbed the webcam. Show the camera preview (menu bar) to confirm
the hand skeleton is tracking.

---

## Architecture

```
┌─ Overlay renderer (headless by default) ─┐
│  webcam → MediaPipe HandLandmarker       │──┐  IPC   ┌─ Electron main (Node) ─┐  stdio  ┌─ Swift helper ─┐
│  → pose recognizer (k-NN)                │  ├───────▶│ settings store (JSON)  │────────▶│ Accessibility  │
│  → motion spotter (learned metric)       │  │        │ ipcMain: actions       │         │ window layouts │
│  → fires window actions                  │  │        └────────────────────────┘         └────────────────┘
└──────────────────────────────────────────┘  │
┌─ Studio renderer (editor) ───────────────┐  │      settings.json in ~/Library/Application Support/
│  preview · enroll/record · test · tune   │──┘
└──────────────────────────────────────────┘
```

- **CV runs in each renderer** — it *is* Chromium, so MediaPipe (GPU) performs like
  a browser. The detection loop is a self-paced timer, decoupled from the display,
  so it runs fast while a hand is present and idles otherwise.
- **The Swift helper is long-lived** — the main process pipes one command per line
  to a persistent process (no per-gesture spawn) and animates window frames.
- **Settings are the source of truth**, persisted to `userData` and live-applied to
  the overlay whenever the Studio saves.

| File | Role |
|---|---|
| `electron/main.js` | lifecycle, windows, camera permission, IPC, settings owner, tray |
| `electron/settingsStore.js` | load/merge/save settings in `userData` |
| `electron/windowHelper.js` | persistent stdio bridge to the Swift binary |
| `electron/preload.js` | the only OS surface exposed to renderers (`window.gestureAPI`) |
| `native/WindowHelper.swift` | Accessibility API — animated window layouts on the focused window |
| `shared/default-settings.json` | default tuning + seed gesture |
| `src/renderer.js` | overlay orchestrator: camera → detection → recognizers → action |
| `src/gestures.js` | the recognizers: k-NN poses, motion descriptor + learned per-dim metric + settle-gated spotter |
| `src/studio.js` + `studio.html` | Gesture Studio: preview, enroll/record, recognition test, tuning |
| `src/overlay.js` | p5 debug overlay (only drawn when the preview is shown) |

### How motion recognition works (short version)
A motion is a trajectory through the whole hand state — finger shape, palm
orientation, position, and depth — expressed as **speed** (not raw displacement), so
casual and deliberate versions match. Each rep is trimmed to its active burst and
resampled; the match **metric is learned per-dimension from your reps** (a diagonal
Fisher weighting), so the recognizer automatically trusts the parts of *your* gesture
that are consistent and ignores the noisy ones. Firing waits for the hand to settle,
which rejects preparatory "windup" motions.

## License

MIT
