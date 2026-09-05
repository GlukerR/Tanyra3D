import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const threeRoot = path.resolve(__dirname, 'node_modules/three')

const CORES = os.cpus().length || 4
const asked = Number(process.env.TANYRA_TEST_WORKERS)
const maxWorkers = Number.isFinite(asked) && asked > 0
  ? asked
  : process.env.CI
    ? undefined
    : Math.max(2, Math.floor(CORES / 3))

const optimizedArtifactsPlugin = {
  name: 'optimized-artifacts',
  configureServer(viteServer) {
    viteServer.middlewares.use('/optimized/', (req, res, next) => {
      const relPath = (req.url || '').replace(/^\/+/, '')
      if (!relPath || relPath.includes('..')) return next()
      const filePath = path.resolve(__dirname, 'tests', '__optimized__', relPath)
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return next()
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary' })
      res.end(fs.readFileSync(filePath))
    })
  },
}

const threeVendorPlugin = {
  name: 'three-vendor',
  configureServer(viteServer) {
    viteServer.middlewares.use('/vendor/three/', (req, res, next) => {
      const relPath = (req.url || '').replace(/^\//, '')
      if (!relPath || relPath.includes('..')) return next()
      const filePath = path.join(threeRoot, relPath)
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return next()
      const ext = path.extname(filePath).toLowerCase()
      const mime = {
        '.wasm': 'application/wasm',
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.drc': 'application/octet-stream',
      }[ext] || 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': mime })
      res.end(fs.readFileSync(filePath))
    })
  },
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/**/*.test.mjs'],
          exclude: ['tests/**/*.browser.test.mjs'],
          globalSetup: ['tests/analyse-baseline.setup.mjs'],
          setupFiles: ['tests/isolate-profiles.setup.mjs'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          ...(maxWorkers ? { maxWorkers } : {}),
        },
      },
      {
        publicDir: 'fixtures/models',
        plugins: [threeVendorPlugin, optimizedArtifactsPlugin],
        test: {
          name: 'browser',
          include: ['tests/**/*.browser.test.mjs'],
          setupFiles: ['tests/browser-setup.mjs'],
          globalSetup: [
            'tests/browser-baseline.setup.mjs',
            'tests/instance-grid-build.setup.mjs',
            'tests/parkergirl-build.setup.mjs',
            'tests/diffuse-transmission-models.setup.mjs',
          ],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          ...(maxWorkers ? { maxWorkers } : {}),
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            api: { host: '127.0.0.1' },
            screenshotDirectory: 'tests/__screenshots__',
            screenshotFailures: true,
            instances: [
              { browser: 'chromium' },
            ],
          },
        },
      },
    ],
  },
})
