import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { optimizeFile } from '../optimize2.mjs'
import { modelPath } from './helpers/model-files.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OPT_DIR = path.resolve(__dirname, '__optimized__')
const DST_GLB = path.join(OPT_DIR, 'parkergirl-sq.glb')
const DST_META = path.join(OPT_DIR, 'parkergirl-sq.meta.json')

export async function setup(project) {
  if (!fs.existsSync(modelPath('parkergirl.glb'))) {
    console.warn(
      '[parkergirl-build.setup] parkergirl.glb отсутствует локально — сборка артефакта пропущена; ' +
        'тесты рендера parkergirl будут пропущены (норма на чистом клоне)',
    )
    project.provide('parkergirl-artifact-available', false)
    return
  }

  project.provide('parkergirl-artifact-available', true)

  fs.mkdirSync(OPT_DIR, { recursive: true })

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sq-browser-'))
  const result = await optimizeFile(modelPath('parkergirl.glb'), {
    advancedFeatures: ['safe', 'quantize'],
    dryRun: false,
    outDir,
  })

  if (result.status !== 'ok') {
    throw new Error(
      `parkergirl-build.setup: optimizeFile status='${result.status}' — viewer-тест рендера не сможет работать`,
    )
  }

  const { before, after } = result.metrics
  const invariant = (key) => {
    if (after[key] !== before[key]) {
      throw new Error(
        `parkergirl-build.setup: ${key} изменились ${before[key]} → ${after[key]}`,
      )
    }
  }
  invariant('triangles')
  invariant('skins')
  invariant('morphTargets')
  invariant('animations')

  fs.writeFileSync(DST_GLB, fs.readFileSync(result.file.dst))
  fs.writeFileSync(
    DST_META,
    JSON.stringify(
      {
        model: 'parkergirl.glb',
        features: ['safe', 'quantize'],
        before,
        after,
        applied: result.applied.map((a) => a.ruleId),
      },
      null,
      2,
    ),
  )
}

export function teardown() {}
