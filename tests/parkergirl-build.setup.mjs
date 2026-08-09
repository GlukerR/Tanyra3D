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

export async function setup(project) {
  if (!fs.existsSync(modelPath('parkergirl.glb'))) {
    // parkergirl.glb — ЛОКАЛЬНАЯ модель: в git её нет (см. REPO_MODELS в
    // tests/helpers/model-files.mjs), на чистом клоне она отсутствует законно.
    // Раньше здесь был throw — и globalSetup валил весь browser-проект ДО сбора
    // тестов (история 2026-08-09: 13 красных прогонов подряд, «No test files
    // found»). Теперь: сборку пропускаем, о пропуске пишем в лог, а браузерные
    // тесты узнают о пропуске через provide/inject и graceful-пропускаются
    // на этапе сбора. Настоящие поломки (status !== 'ok', нарушенные инварианты
    // ниже) по-прежнему бросают.
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
