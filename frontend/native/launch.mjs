import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'

if (process.platform !== 'darwin') {
  console.error('Mode native memerlukan macOS. Jalankan npm run dev untuk membuka SmartHarvest di browser.')
  process.exit(1)
}

let server
try {
  let address = process.env.SMARTHARVEST_URL
  if (!address) {
    server = await createServer({ server: { host: '127.0.0.1', open: false } })
    await server.listen()
    address = server.resolvedUrls?.local[0]
    if (!address) throw new Error('Alamat Vite tidak tersedia.')
    console.log(`Vite siap di ${address}`)
  }

  const app = spawn('swift', ['-module-cache-path', join(tmpdir(), 'smartharvest-swift-modules'), 'native/SmartHarvest.swift'], {
    env: { ...process.env, SMARTHARVEST_URL: address },
    stdio: 'inherit',
  })
  const stopApp = signal => app.kill(signal)
  process.on('SIGINT', stopApp)
  process.on('SIGTERM', stopApp)
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      app.once('error', reject)
      app.once('exit', code => resolve(code ?? 1))
    })
  } finally {
    process.off('SIGINT', stopApp)
    process.off('SIGTERM', stopApp)
  }
} catch (error) {
  console.error('Gagal membuka SmartHarvest:', error.message)
  process.exitCode = 1
} finally {
  await server?.close()
}
