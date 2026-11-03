import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  build: {
    target: 'es2022',
    rollupOptions: { input: Object.fromEntries(['index', 'speech', 'speech-check'].map(name =>
      [name, fileURLToPath(new URL(`./${name}.html`, import.meta.url))])) },
  },
})
