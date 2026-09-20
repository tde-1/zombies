import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The dev server proxies everything the Express app owns, so `npm run client` (5173) and
// `npm run dev` (3200) together behave exactly like the built site served from 3200 — same
// origin, same session cookie, same socket. No CORS anywhere, ever.
const API = process.env.ZM_API || 'http://127.0.0.1:3200'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/auth': { target: API, changeOrigin: false },
      '/socket.io': { target: API, ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
})
