// tests/instance-grid-build.setup.mjs — globalSetup browser-проекта.
//
// Собирает Instance Grid 01 под ['safe','quantize','join'] и кладёт результат в
// tests/__optimized__/instance-grid-sqj.glb. Файл раздаёт браузерному тесту
// Vite-мидлварь /optimized/* (см. vitest.config.mjs, optimizedArtifactsPlugin).
//
// Зачем это здесь, а не в самом тесте: браузерные тесты исполняются в Chromium,
// node:fs им недоступен, а оптимизатор — движок на node. Глобальный setup
// исполняется в node-контексте ДО браузерных тестов и умеет и собирать, и
// писать на диск.
//
// Дублирование с tests/quantize.test.mjs (раздел 7) намеренное: там цифры,
// здесь — артефакт, который браузерный тест реально открывает во вьюере.
// Инварианты (треугольники не изменились) проверяются и здесь — артефакт не
// должен вводить viewer-тест в заблуждение.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { optimizeFile } from '../optimize2.mjs'
import { modelPath } from './helpers/model-files.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OPT_DIR = path.resolve(__dirname, '__optimized__')
const DST_GLB = path.join(OPT_DIR, 'instance-grid-sqj.glb')
const DST_META = path.join(OPT_DIR, 'instance-grid-sqj.meta.json')

export async function setup() {
  fs.mkdirSync(OPT_DIR, { recursive: true })

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqj-browser-'))
  const result = await optimizeFile(modelPath('Instance Grid 01.glb'), {
    advancedFeatures: ['safe', 'quantize', 'join'],
    dryRun: false,
    outDir,
  })

  if (result.status !== 'ok') {
    throw new Error(
      `instance-grid-build.setup: optimizeFile status='${result.status}' — viewer-тест рендера не сможет работать`,
    )
  }

  // Инвариант: квантование и join не трогают полигоны. Если когда-нибудь тронут —
  // артефакт не должен молча уехать в браузерный тест.
  const { before, after } = result.metrics
  if (after.triangles !== before.triangles) {
    throw new Error(
      `instance-grid-build.setup: triangles изменились ${before.triangles} → ${after.triangles}`,
    )
  }

  // Сам артефакт + рядом мета (для отчёта и ручной сверки).
  fs.writeFileSync(DST_GLB, fs.readFileSync(result.file.dst))
  fs.writeFileSync(
    DST_META,
    JSON.stringify(
      {
        model: 'Instance Grid 01.glb',
        features: ['safe', 'quantize', 'join'],
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
