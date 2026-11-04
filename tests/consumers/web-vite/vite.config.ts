import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  build: {
    target: 'es2022',
    // AudioWorklet modules must remain same-origin assets under the lab CSP.
    assetsInlineLimit: 0,
    rollupOptions: { input: Object.fromEntries(['index', 'speech', 'speech-check'].map(name =>
      [name, fileURLToPath(new URL(`./${name}.html`, import.meta.url))])) },
  },
})
