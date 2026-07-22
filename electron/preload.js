const { contextBridge, ipcRenderer } = require('electron')

// The only surface the renderers (overlay + studio) get to the main process.
contextBridge.exposeInMainWorld('gestureAPI', {
  // Window actions + permissions (overlay).
  runAction: (action) => ipcRenderer.invoke('gesture:action', action),
  checkPermission: () => ipcRenderer.invoke('helper:trusted'),
  requestPermission: () => ipcRenderer.invoke('helper:request-access'),
  ping: () => ipcRenderer.invoke('helper:ping'),

  // Transient control (menu bar → overlay).
  onSetPaused: (cb) => ipcRenderer.on('control:set-paused', (_e, v) => cb(v)),

  // Settings (persisted; shared by overlay + studio).
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (_e, s) => cb(s)),

  // Loop diagnostics (fps / inference ms / duty cycle) → main writes a logfile.
  reportDiag: (data) => ipcRenderer.send('diag:report', data),

  // Gesture Studio.
  openStudio: () => ipcRenderer.invoke('studio:open'),
  saveRecording: (payload) => ipcRenderer.invoke('recording:save', payload),
})
