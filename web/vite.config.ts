import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      lru_map: fileURLToPath(new URL('./src/vendor/lru-map.ts', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['@pierre/diffs/react', '@pierre/trees/react'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:7070',
      '/term': { target: 'ws://localhost:7070', ws: true },
    },
  },
})
