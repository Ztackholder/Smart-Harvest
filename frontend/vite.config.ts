import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const { API_PROXY_TARGET } = loadEnv(mode, process.cwd(), '')
  const proxy = API_PROXY_TARGET
    ? { '/api/v1': { target: API_PROXY_TARGET, changeOrigin: true } }
    : undefined

  return {
    plugins: [react(), tailwindcss()],
    build: { license: { fileName: 'third-party-licenses.md' } },
    server: { host: '127.0.0.1', proxy },
    preview: { host: '127.0.0.1', proxy },
  }
})
