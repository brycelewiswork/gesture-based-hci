const { app, BrowserWindow, ipcMain, session, systemPreferences, Tray, Menu, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { WindowHelper } = require('./windowHelper')
const settingsStore = require('./settingsStore')

const isDev = process.env.VITE_DEV === '1'
const DEV_URL = 'http://127.0.0.1:5173'

// The overlay is a background utility that gets covered by other apps' windows.
// macOS native window-occlusion detection would mark it "hidden" and Chromium
// would pause its requestAnimationFrame loop — freezing gesture detection whenever
// a full-screen app (Figma, a browser) is in front. These switches keep the
// renderer running even while occluded/backgrounded. Must be set before app ready.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

const ALLOWED_ACTIONS = new Set([
  'maximize', 'minimize', 'center', 'almostMaximize', 'reasonableSize', 'toggleFullscreen', 'restore',
  'tileLeft', 'tileRight', 'topHalf', 'bottomHalf',
  'topLeftQuarter', 'topRightQuarter', 'bottomLeftQuarter', 'bottomRightQuarter',
  'firstThird', 'centerThird', 'lastThird', 'firstTwoThirds', 'lastTwoThirds',
  'topLeftSixth', 'topCenterSixth', 'topRightSixth', 'bottomLeftSixth', 'bottomCenterSixth', 'bottomRightSixth',
  'maximizeHeight', 'maximizeWidth', 'moveLeft', 'moveRight', 'moveUp', 'moveDown',
  'nextDisplay', 'previousDisplay',
])

const helperBin = app.isPackaged
  ? path.join(process.resourcesPath, 'window-helper')
  : path.join(__dirname, '..', 'native', 'bin', 'window-helper')

const helper = new WindowHelper(helperBin)

let settings = null
let win = null // overlay
let overlayVisible = false // the camera preview is hidden by default; detection still runs headless
let studioWin = null
let tray = null
let paused = false

// --- Settings ------------------------------------------------------------
function broadcast(channel, payload, exceptSender) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    if (exceptSender && w.webContents === exceptSender) continue
    w.webContents.send(channel, payload)
  }
}

function applySettings(next, { persist = true, exceptSender = null } = {}) {
  settings = persist ? settingsStore.save(next) : settingsStore.withDefaults(next)
  broadcast('settings:changed', settings, exceptSender)
  return settings
}

// --- Windows -------------------------------------------------------------
function createOverlay() {
  win = new BrowserWindow({
    width: 480,
    height: 360,
    resizable: false,
    alwaysOnTop: true,
    focusable: false, // never frontmost, so gestures target the app behind it
    skipTaskbar: true,
    show: false, // headless by default — the preview is only for debugging (toggle from the tray)
    title: 'Gesture HCI',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep detection running when the overlay is covered
    },
  })

  const { workArea } = require('electron').screen.getPrimaryDisplay()
  win.setPosition(workArea.x + workArea.width - 480 - 16, workArea.y + workArea.height - 360 - 16)

  if (isDev) {
    win.loadURL(DEV_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

function openStudio() {
  if (studioWin && !studioWin.isDestroyed()) {
    studioWin.show()
    studioWin.focus()
    return
  }
  // Studio needs real keyboard/mouse focus, so temporarily become a regular app.
  app.setActivationPolicy('regular')
  if (app.dock) app.dock.show()

  studioWin = new BrowserWindow({
    width: 980,
    height: 780,
    minWidth: 760,
    minHeight: 560,
    title: 'Gesture Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (isDev) {
    studioWin.loadURL(`${DEV_URL}/studio.html`)
    studioWin.webContents.openDevTools({ mode: 'detach' })
  } else {
    studioWin.loadFile(path.join(__dirname, '..', 'dist', 'studio.html'))
  }

  studioWin.on('closed', () => {
    studioWin = null
    // Back to a background overlay utility.
    app.setActivationPolicy('accessory')
    if (app.dock) app.dock.hide()
  })
}

// --- Permissions + IPC ---------------------------------------------------
function wireMediaPermissions() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })
}

const DIAG_LOG = path.join(app.getPath('userData'), 'diag.log')

function wireIpc() {
  try { fs.writeFileSync(DIAG_LOG, '') } catch {} // fresh log each launch
  ipcMain.on('diag:report', (_e, d) => {
    const line = `${new Date().toISOString()} fps=${d.fps} inferMs=${d.infMs} duty=${d.dutyPct}% hand=${d.handPct}% paused=${d.paused} hidden=${d.hidden}\n`
    try { fs.appendFileSync(DIAG_LOG, line) } catch {}
  })

  ipcMain.handle('gesture:action', async (_e, action) => {
    if (!ALLOWED_ACTIONS.has(action)) return `err:unmapped:${action}`
    return helper.send(action)
  })
  ipcMain.handle('helper:trusted', () => helper.send('trusted'))
  ipcMain.handle('helper:request-access', () => helper.send('request-access'))
  ipcMain.handle('helper:ping', () => helper.send('ping'))

  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:update', (e, next) => applySettings(next, { exceptSender: e.sender }))

  ipcMain.handle('studio:open', () => {
    openStudio()
    return true
  })

  // Dump a captured session (raw landmarks + derived features per frame) to disk
  // for offline analysis. Landmarks are the payload — they let any candidate
  // feature be recomputed later without re-recording.
  ipcMain.handle('recording:save', (_e, payload) => {
    const dir = path.join(app.getPath('userData'), 'recordings')
    fs.mkdirSync(dir, { recursive: true })
    const safe = String(payload.label || 'session').replace(/[^a-z0-9_-]/gi, '_')
    const file = path.join(dir, `${safe}-${Date.now()}.json`)
    fs.writeFileSync(file, JSON.stringify(payload))
    return file
  })
}

// --- Menu bar ------------------------------------------------------------
function setPaused(next) {
  paused = next
  if (win && !win.isDestroyed()) win.webContents.send('control:set-paused', paused)
  if (tray) tray.setTitle(paused ? ' ⏸' : ' ✋')
}

function setDryRun(next) {
  applySettings({ ...settings, debug: { ...settings.debug, dryRun: next } })
}

async function buildTrayMenu() {
  let ax = 'unknown'
  try {
    ax = await helper.send('trusted')
  } catch { /* helper may be down */ }

  return Menu.buildFromTemplate([
    { label: 'Gesture HCI', enabled: false },
    { label: `Accessibility: ${ax === 'yes' ? '✓ granted' : '✗ not granted'}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Gesture Studio…', click: () => openStudio() },
    {
      label: overlayVisible ? 'Hide camera preview' : 'Show camera preview',
      click: () => {
        overlayVisible = !overlayVisible
        if (!win || win.isDestroyed()) return
        overlayVisible ? win.showInactive() : win.hide() // showInactive: never steals focus
      },
    },
    {
      label: paused ? 'Resume tracking' : 'Pause tracking',
      click: () => setPaused(!paused),
    },
    {
      label: 'Dry-run (log, don’t move windows)',
      type: 'checkbox',
      checked: Boolean(settings.debug.dryRun),
      click: () => setDryRun(!settings.debug.dryRun),
    },
    ...(ax === 'yes'
      ? []
      : [{ label: 'Request Accessibility…', click: () => helper.send('request-access') }]),
    { type: 'separator' },
    { label: 'Quit Gesture HCI', accelerator: 'Command+Q', click: () => app.quit() },
  ])
}

function setupTray() {
  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle(' ✋')
  tray.setToolTip('Gesture HCI')
  tray.on('click', async () => tray.popUpContextMenu(await buildTrayMenu()))
  tray.on('right-click', async () => tray.popUpContextMenu(await buildTrayMenu()))
}

// --- Lifecycle -----------------------------------------------------------
app.whenReady().then(async () => {
  settings = settingsStore.load()

  if (app.dock) app.dock.hide()
  app.setActivationPolicy('accessory')

  try {
    const status = systemPreferences.getMediaAccessStatus('camera')
    if (status !== 'granted') await systemPreferences.askForMediaAccess('camera')
  } catch (e) {
    console.error('[camera] permission request failed:', e.message)
  }

  helper.start()
  wireMediaPermissions()
  wireIpc()
  createOverlay()
  setupTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlay()
  })
})

app.on('window-all-closed', () => {
  helper.stop()
  app.quit()
})

app.on('before-quit', () => helper.stop())
