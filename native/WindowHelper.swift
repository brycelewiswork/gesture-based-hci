// WindowHelper — a tiny long-lived process that performs macOS window actions
// via the Accessibility API. It reads one command per line on stdin and writes
// one result line per command on stdout. Electron's main process keeps this
// running and pipes commands to it, so there is NO per-gesture process spawn.
//
// Commands:
//   ping            -> pong
//   trusted         -> yes | no          (is this process Accessibility-trusted?)
//   request-access  -> yes | no          (same, but prompts the user if not)
//   maximize        -> ok:<app> | err:*  (fill the focused window to the screen)
//   minimize        -> ok:<app> | err:*
//   tileLeft        -> ok:<app> | err:*  (left half of the screen)
//   tileRight       -> ok:<app> | err:*  (right half)
//   center          -> ok:<app> | err:*  (centered, 60% of the screen)
//
// Build: see native/build.sh

import Cocoa
import ApplicationServices

setvbuf(stdout, nil, _IOLBF, 0)

func axTrusted(prompt: Bool) -> Bool {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    let options = [key: prompt] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

func axElement(_ v: AnyObject?) -> AXUIElement? {
    guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

// The frontmost application, as an AX element + display name. NSWorkspace's
// frontmostApplication is notification-backed and this helper never pumps a run
// loop (it blocks on readLine), so it goes STALE and sticks to whichever app it
// first saw (the "always Figma" bug). Draining the run loop once refreshes it;
// if that still yields nothing, fall back to the AX system-wide focused element's
// owning process (a live query).
func frontmostApp() -> (AXUIElement, String)? {
    CFRunLoopRunInMode(CFRunLoopMode.defaultMode, 0, false) // deliver pending activation notifications
    if let app = NSWorkspace.shared.frontmostApplication {
        return (AXUIElementCreateApplication(app.processIdentifier), app.localizedName ?? "app")
    }
    let sys = AXUIElementCreateSystemWide()
    var el: AnyObject?
    if AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &el) == .success,
       let focusedEl = axElement(el) {
        var pid: pid_t = 0
        if AXUIElementGetPid(focusedEl, &pid) == .success, pid > 0 {
            let name = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "app"
            return (AXUIElementCreateApplication(pid), name)
        }
    }
    return nil
}

// The window to act on for an app: keyboard-focused window, else the main window,
// else its first window (some apps expose main/first but not a "focused" window).
func windowOf(_ axApp: AXUIElement) -> AXUIElement? {
    var v: AnyObject?
    if AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &v) == .success, let w = axElement(v) { return w }
    if AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &v) == .success, let w = axElement(v) { return w }
    if AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &v) == .success,
       let wins = v as? [AXUIElement], let first = wins.first { return first }
    return nil
}

func focusedWindow() -> (AXUIElement, String)? {
    guard let (axApp, name) = frontmostApp() else { return nil }
    guard let win = windowOf(axApp) else { return nil }
    return (win, name)
}

func screenForWindow(_ axWin: AXUIElement) -> NSScreen? {
    guard let primary = NSScreen.screens.first else { return nil }
    var posRef: AnyObject?
    var sizeRef: AnyObject?
    guard AXUIElementCopyAttributeValue(axWin, kAXPositionAttribute as CFString, &posRef) == .success,
          AXUIElementCopyAttributeValue(axWin, kAXSizeAttribute as CFString, &sizeRef) == .success
    else { return nil }
    var p = CGPoint.zero
    var s = CGSize.zero
    AXValueGetValue(posRef as! AXValue, .cgPoint, &p)
    AXValueGetValue(sizeRef as! AXValue, .cgSize, &s)
    let cocoaY = primary.frame.height - (p.y + s.height)
    let center = CGPoint(x: p.x + s.width / 2, y: cocoaY + s.height / 2)
    return NSScreen.screens.first(where: { $0.frame.contains(center) })
}

func axAttrString(_ el: AXUIElement, _ attr: String) -> String {
    var v: AnyObject?
    if AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, let s = v as? String { return s }
    return "?"
}

func axSettable(_ el: AXUIElement, _ attr: String) -> Bool {
    var b: DarwinBoolean = false
    AXUIElementIsAttributeSettable(el, attr as CFString, &b)
    return b.boolValue
}

// Read the window's current AX position (top-left origin) + size.
func readAXPosSize(_ axWin: AXUIElement) -> (CGPoint, CGSize)? {
    var pr: AnyObject?
    var sr: AnyObject?
    guard AXUIElementCopyAttributeValue(axWin, kAXPositionAttribute as CFString, &pr) == .success,
          AXUIElementCopyAttributeValue(axWin, kAXSizeAttribute as CFString, &sr) == .success else { return nil }
    var p = CGPoint.zero
    var s = CGSize.zero
    AXValueGetValue(pr as! AXValue, .cgPoint, &p)
    AXValueGetValue(sr as! AXValue, .cgSize, &s)
    return (p, s)
}

// Write size then position for ONE intermediate frame.
func setAXFrame(_ axWin: AXUIElement, _ p: CGPoint, _ s: CGSize) {
    var pp = p
    var ss = s
    if let sv = AXValueCreate(.cgSize, &ss) { AXUIElementSetAttributeValue(axWin, kAXSizeAttribute as CFString, sv) }
    if let pv = AXValueCreate(.cgPoint, &pp) { AXUIElementSetAttributeValue(axWin, kAXPositionAttribute as CFString, pv) }
}

// Apply a target rect (Cocoa coords) to a window, converting to AX top-left space.
// ANIMATED: we interpolate the whole frame (position AND size together) from the
// current frame to the target over ~180ms with ease-out, setting each intermediate
// frame ourselves. Two reasons this beats a single set: (1) native apps like Finder
// don't animate AX moves at all — driving it makes them glide; (2) writing pos and
// size as one coherent frame per step moves all four corners SYNCHRONOUSLY, instead
// of the app resizing then repositioning (or vice-versa) as separate steps.
func applyCocoaFrame(_ axWin: AXUIElement, _ rect: CGRect) -> String {
    guard let primary = NSScreen.screens.first else { return "err:no-screen" }
    if !axSettable(axWin, kAXPositionAttribute as String) {
        return "err:pos-locked(subrole:\(axAttrString(axWin, kAXSubroleAttribute as String)))"
    }
    let targetPos = CGPoint(x: rect.origin.x, y: primary.frame.height - (rect.origin.y + rect.size.height))
    let targetSize = CGSize(width: rect.size.width, height: rect.size.height)

    if let (p0, s0) = readAXPosSize(axWin) {
        let steps = 14
        for i in 1 ..< steps {
            let raw = Double(i) / Double(steps)
            let t = 1 - pow(1 - raw, 4) // ease-out quart — gentler, slower tail into the landing
            let p = CGPoint(x: p0.x + (targetPos.x - p0.x) * t, y: p0.y + (targetPos.y - p0.y) * t)
            let s = CGSize(width: s0.width + (targetSize.width - s0.width) * t, height: s0.height + (targetSize.height - s0.height) * t)
            setAXFrame(axWin, p, s)
            usleep(12_000) // ~12ms/step → ~170ms total
        }
    }
    // Final exact frame — size FIRST, POSITION LAST, so an app that re-asserts its
    // own position when resized (Figma does) can't override our position afterward.
    var fp = targetPos
    var fs = targetSize
    guard let posVal = AXValueCreate(.cgPoint, &fp), let sizeVal = AXValueCreate(.cgSize, &fs) else { return "err:axvalue" }
    let rs = AXUIElementSetAttributeValue(axWin, kAXSizeAttribute as CFString, sizeVal)
    let rp = AXUIElementSetAttributeValue(axWin, kAXPositionAttribute as CFString, posVal)
    if rp != .success { return "err:setpos:ax\(rp.rawValue)" }
    if rs != .success { return "err:setsize:ax\(rs.rawValue)" }

    // After it settles, read back and fix the two app-specific cases:
    //   (a) size-capped app (Claude ~855 wide) clamped smaller → our position was
    //       for the bigger size, so re-center the ACTUAL size in the target rect;
    //   (b) app snapped its position back on resize (Figma) → re-assert the target
    //       position now that its resize reaction is finished.
    // Apps that honored the frame read back on-target → no correction.
    usleep(140_000)
    if let actual = currentCocoaFrame(axWin) {
        if actual.width < rect.width - 8 || actual.height < rect.height - 8 {
            let cx = rect.origin.x + (rect.width - actual.width) / 2
            let cy = rect.origin.y + (rect.height - actual.height) / 2
            var p = CGPoint(x: cx, y: primary.frame.height - (cy + actual.height))
            if let pv = AXValueCreate(.cgPoint, &p) { AXUIElementSetAttributeValue(axWin, kAXPositionAttribute as CFString, pv) }
        } else if abs(actual.origin.x - rect.origin.x) > 4 || abs(actual.origin.y - rect.origin.y) > 4 {
            var p = targetPos
            if let pv = AXValueCreate(.cgPoint, &p) { AXUIElementSetAttributeValue(axWin, kAXPositionAttribute as CFString, pv) }
        }
    }
    return "ok"
}

// The focused window's current frame in Cocoa coords (bottom-left origin).
func currentCocoaFrame(_ axWin: AXUIElement) -> CGRect? {
    guard let primary = NSScreen.screens.first else { return nil }
    var posRef: AnyObject?
    var sizeRef: AnyObject?
    guard AXUIElementCopyAttributeValue(axWin, kAXPositionAttribute as CFString, &posRef) == .success,
          AXUIElementCopyAttributeValue(axWin, kAXSizeAttribute as CFString, &sizeRef) == .success else { return nil }
    var p = CGPoint.zero
    var s = CGSize.zero
    AXValueGetValue(posRef as! AXValue, .cgPoint, &p)
    AXValueGetValue(sizeRef as! AXValue, .cgSize, &s)
    return CGRect(x: p.x, y: primary.frame.height - (p.y + s.height), width: s.width, height: s.height)
}

// Compute a target rect (Cocoa coords: bottom-left origin, higher y = up) from the
// screen's visibleFrame `vf`. `cur` (the window's current frame) is needed for the
// size-preserving actions (center / move-to-edge / maximize one axis). Mirrors the
// Raycast Window Management layouts.
func targetFrame(_ action: String, _ vf: CGRect, _ cur: CGRect?) -> CGRect? {
    let x = vf.origin.x, y = vf.origin.y, w = vf.width, h = vf.height
    let w2 = w / 2, w3 = w / 3, h2 = h / 2
    switch action {
    // sizing
    case "maximize": return vf
    case "almostMaximize": return CGRect(x: x + w * 0.05, y: y + h * 0.05, width: w * 0.9, height: h * 0.9)
    case "reasonableSize":
        let rw = min(w * 0.6, 1025), rh = min(h * 0.6, 900)
        return CGRect(x: x + (w - rw) / 2, y: y + (h - rh) / 2, width: rw, height: rh)
    // halves (tileLeft/tileRight kept as the left/right-half aliases)
    case "tileLeft", "leftHalf": return CGRect(x: x, y: y, width: w2, height: h)
    case "tileRight", "rightHalf": return CGRect(x: x + w2, y: y, width: w2, height: h)
    case "topHalf": return CGRect(x: x, y: y + h2, width: w, height: h2)
    case "bottomHalf": return CGRect(x: x, y: y, width: w, height: h2)
    // quarters
    case "topLeftQuarter": return CGRect(x: x, y: y + h2, width: w2, height: h2)
    case "topRightQuarter": return CGRect(x: x + w2, y: y + h2, width: w2, height: h2)
    case "bottomLeftQuarter": return CGRect(x: x, y: y, width: w2, height: h2)
    case "bottomRightQuarter": return CGRect(x: x + w2, y: y, width: w2, height: h2)
    // thirds (vertical columns, full height)
    case "firstThird": return CGRect(x: x, y: y, width: w3, height: h)
    case "centerThird": return CGRect(x: x + w3, y: y, width: w3, height: h)
    case "lastThird": return CGRect(x: x + 2 * w3, y: y, width: w3, height: h)
    case "firstTwoThirds": return CGRect(x: x, y: y, width: 2 * w3, height: h)
    case "lastTwoThirds": return CGRect(x: x + w3, y: y, width: 2 * w3, height: h)
    // sixths (3 columns × 2 rows)
    case "topLeftSixth": return CGRect(x: x, y: y + h2, width: w3, height: h2)
    case "topCenterSixth": return CGRect(x: x + w3, y: y + h2, width: w3, height: h2)
    case "topRightSixth": return CGRect(x: x + 2 * w3, y: y + h2, width: w3, height: h2)
    case "bottomLeftSixth": return CGRect(x: x, y: y, width: w3, height: h2)
    case "bottomCenterSixth": return CGRect(x: x + w3, y: y, width: w3, height: h2)
    case "bottomRightSixth": return CGRect(x: x + 2 * w3, y: y, width: w3, height: h2)
    // size-preserving (need the current frame)
    case "center":
        guard let c = cur else { return nil }
        return CGRect(x: x + (w - c.width) / 2, y: y + (h - c.height) / 2, width: c.width, height: c.height)
    case "maximizeHeight":
        guard let c = cur else { return nil }
        return CGRect(x: c.origin.x, y: y, width: c.width, height: h)
    case "maximizeWidth":
        guard let c = cur else { return nil }
        return CGRect(x: x, y: c.origin.y, width: w, height: c.height)
    case "moveLeft":
        guard let c = cur else { return nil }
        return CGRect(x: x, y: c.origin.y, width: c.width, height: c.height)
    case "moveRight":
        guard let c = cur else { return nil }
        return CGRect(x: x + w - c.width, y: c.origin.y, width: c.width, height: c.height)
    case "moveUp":
        guard let c = cur else { return nil }
        return CGRect(x: c.origin.x, y: y + h - c.height, width: c.width, height: c.height)
    case "moveDown":
        guard let c = cur else { return nil }
        return CGRect(x: c.origin.x, y: y, width: c.width, height: c.height)
    default:
        return nil
    }
}

func pidOf(_ el: AXUIElement) -> pid_t { var p: pid_t = 0; AXUIElementGetPid(el, &p); return p }

// Remembers each window's frame before a move, so "restore" can undo it.
var savedFrames: [pid_t: CGRect] = [:]

func toggleFullscreen(_ axWin: AXUIElement) -> Bool {
    let attr = "AXFullScreen" as CFString
    var v: AnyObject?
    let cur = AXUIElementCopyAttributeValue(axWin, attr, &v) == .success ? ((v as? Bool) ?? false) : false
    return AXUIElementSetAttributeValue(axWin, attr, (cur ? kCFBooleanFalse : kCFBooleanTrue) as CFTypeRef) == .success
}

// Move the window to the next/previous screen (dir ±1), preserving its relative
// position and clamping its size to the destination's visible area.
func moveToDisplay(_ axWin: AXUIElement, _ dir: Int) -> String {
    guard let cur = currentCocoaFrame(axWin), let screen = screenForWindow(axWin) else { return "err:no-frame" }
    let screens = NSScreen.screens
    guard screens.count > 1, let idx = screens.firstIndex(of: screen) else { return "err:single-display" }
    let from = screen.visibleFrame
    let to = screens[(idx + dir + screens.count) % screens.count].visibleFrame
    let relX = from.width > 0 ? (cur.origin.x - from.origin.x) / from.width : 0
    let relY = from.height > 0 ? (cur.origin.y - from.origin.y) / from.height : 0
    let nw = min(cur.width, to.width), nh = min(cur.height, to.height)
    return applyCocoaFrame(axWin, CGRect(x: to.origin.x + relX * to.width, y: to.origin.y + relY * to.height, width: nw, height: nh))
}

func runAction(_ action: String) -> String {
    guard let (axWin, name) = focusedWindow() else { return "err:no-focused-window" }
    let pid = pidOf(axWin)
    func tagged(_ r: String) -> String { r == "ok" ? "ok:\(name)" : "\(r)|target:\(name)" }

    switch action {
    case "minimize":
        AXUIElementSetAttributeValue(axWin, kAXMinimizedAttribute as CFString, kCFBooleanTrue as CFTypeRef)
        return "ok:\(name)"
    case "toggleFullscreen":
        return toggleFullscreen(axWin) ? "ok:\(name)" : "err:fullscreen-failed|target:\(name)"
    case "nextDisplay": return tagged(moveToDisplay(axWin, 1))
    case "previousDisplay": return tagged(moveToDisplay(axWin, -1))
    case "restore":
        guard let saved = savedFrames[pid] else { return "err:nothing-to-restore|target:\(name)" }
        return tagged(applyCocoaFrame(axWin, saved))
    default:
        break
    }

    guard let screen = screenForWindow(axWin) ?? NSScreen.main else { return "err:no-screen" }
    let cur = currentCocoaFrame(axWin)
    guard let rect = targetFrame(action, screen.visibleFrame, cur) else { return "err:unknown-action:\(action)" }
    if let c = cur { savedFrames[pid] = c } // remember pre-move frame for "restore"
    return tagged(applyCocoaFrame(axWin, rect))
}

// Main command loop. Anything that isn't a control command is a window action.
while let line = readLine(strippingNewline: true) {
    let cmd = line.trimmingCharacters(in: .whitespacesAndNewlines)
    switch cmd {
    case "":
        continue
    case "ping":
        print("pong")
    case "trusted":
        print(axTrusted(prompt: false) ? "yes" : "no")
    case "request-access":
        print(axTrusted(prompt: true) ? "yes" : "no")
    case "frame": // diagnostic: focused window frame + its screen's visibleFrame (Cocoa coords)
        if let (axWin, name) = focusedWindow(), let f = currentCocoaFrame(axWin) {
            let vf = (screenForWindow(axWin) ?? NSScreen.main)?.visibleFrame ?? .zero
            print("win:\(Int(f.minX)),\(Int(f.minY)),\(Int(f.width)),\(Int(f.height))|vf:\(Int(vf.minX)),\(Int(vf.minY)),\(Int(vf.width)),\(Int(vf.height))|primaryH:\(Int(NSScreen.screens.first?.frame.height ?? 0))|\(name)")
        } else { print("err:no-window") }
    default:
        print(runAction(cmd))
    }
}
