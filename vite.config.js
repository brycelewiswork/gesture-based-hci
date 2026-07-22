import { defineConfig } from 'vite'

// Two renderer entry points: the always-on overlay (index.html) and the
// interactive Gesture Studio (studio.html). Electron main/preload live in
// electron/ and are loaded directly by Node (not bundled here).
export default defineConfig({
  root: '.',
  base: './', // relative paths so built HTML loads under file://
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome128', // Electron controls the Chromium version
    rollupOptions: {
      input: {
        main: 'index.html',
        studio: 'studio.html',
      },
    },
  },
})
