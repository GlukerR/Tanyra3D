// tests/parkergirl-build.setup.mjs — globalSetup browser-проекта.
//
// Собирает parkergirl.glb под ['safe','quantize'] и кладёт результат в
// tests/__optimized__/parkergirl-sq.glb. Файл раздаёт браузерному тесту
// Vite-мидлварь /optimized/* (см. vitest.config.mjs, optimizedArtifactsPlugin).
//
// Зачем это здесь, а не в самом тесте: браузерные тесты исполняются в Chromium,
// node:fs им недоступен, а оптимизатор — движок на node. Глобальный setup
// исполняется в node-контексте ДО браузерных тестов и умеет и собирать, и
// писать на диск.
//
// Дублирование с tests/quantize.test.mjs (раздел про parkergirl) намеренное:
// там цифры, здесь — артефакт, который браузерный тест реально открывает во
// вьюере. Инварианты (треугольники/скины/морфы не изменились) проверяются и
// здесь — артефакт не должен вводить viewer-тест в заблуждение.

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

export async function setup() {
  if (!fs.existsSync(modelPath('parkergirl.glb'))) {
    throw new Error(
      'parkergirl-build.setup: parkergirl.glb отсутствует локально — браузерный тест рендера скин-анимации не сможет работать',
    )
  }

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

  // Инварианты: квантование не трогает полигоны, скины, морфы и анимации.
  // Если когда-нибудь тронет — артефакт не должен молча уехать в браузерный тест.
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

  // Сам артефакт + рядом мета (для отчёта и ручной сверки).
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
