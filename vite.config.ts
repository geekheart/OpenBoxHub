import { readFile } from 'node:fs/promises'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react(), {
    name: 'include-project-license',
    apply: 'build',
    async generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'LICENSE',
        source: await readFile(new URL('./LICENSE', import.meta.url), 'utf8'),
      })
    },
  }],
  worker: { format: 'es' },
  server: { host: '127.0.0.1' },
})
