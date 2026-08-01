// tests/instance-grid-render.browser.test.mjs — рендер Instance Grid 01 после
// ['safe','quantize','join'] в реальном WebGL (браузерный тест).
//
// Вопрос 2026-08-01: join разворачивает общую геометрию сетки в копии (625 мешей
// с общей геометрией → 1 меш с запечёнными трансформами), а квантование
// (KHR_mesh_quantization) переписывает позиции 16-битными числами. Статический
// анализ (tests/quantize.test.mjs, раздел 7) уже подтвердил цифры: треугольники
// те же, файл легче, расширение в required. Здесь проверяется то, что анализ
// не видит: РЕНДЕР — не разъехалась ли развёрнутая и квантованная сетка
// относительно оригинала (позиции) и не появились ли артефакты (дыры, вырожденные
// треугольники, вспухшие примитивы).
//
// Механика проверки «позиции те же»:
//   viewer.frame() выводит камеру из мирового bounding box. Если сетка после
//   join+quantize стоит на тех же местах, авто-кадрирование оригинала и результата
//   даёт ОДНУ камеру (в допуске квантования). Плюс — рендер обеих моделей ОДНОЙ
//   камерой: при совпавших позициях картинки совпадают пиксель в пиксель (допуск —
//   округление квантования, ~1 шаг 16-битной сетки). Массовое расхождение пикселей
//   означало бы, что геометрия уехала или сломалась.
//
// Оптимизированный файл собирает node-контекст globalSetup
// (tests/instance-grid-build.setup.mjs) в tests/__optimized__/, откуда его раздаёт
// Vite-мидлварь /optimized/ (vitest.config.mjs, optimizedArtifactsPlugin).
// Оригинал приходит из publicDir (fixtures/models) как /Instance%20Grid%2001.glb.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  createViewer,
  disposeViewer,
  snapshotPixels,
  diffStats,
} from './helpers/viewer-test-utils.mjs'

const ORIG_URL = '/Instance%20Grid%2001.glb'
const OPT_URL = '/optimized/instance-grid-sqj.glb'

// Инварианты исходника (из metric-отчёта, см. instance-grid-build.setup.mjs).
const ORIG_TRIANGLES = 7500
const ORIG_DRAW_CALLS = 625

describe('Instance Grid 01 — safe+quantize+join: рендер без артефактов, позиции те же (browser)', () => {
  /** @type {HTMLCanvasElement} */
  let canvas
  /** @type {import('../ui/viewer/viewer.js').Viewer} */
  let viewer

  beforeAll(async () => {
    const result = await createViewer()
    canvas = result.canvas
    viewer = result.viewer
  })

  afterAll(() => {
    disposeViewer(viewer, canvas)
  })

  it('обе модели грузятся; треугольники не изменились, drawCalls 625 → 1', async () => {
    await viewer.load(ORIG_URL)
    const orig = viewer.getStats()
    expect(orig).not.toBeNull()
    expect(orig.triangles).toBe(ORIG_TRIANGLES)
    expect(orig.drawCalls).toBe(ORIG_DRAW_CALLS)

    await viewer.load(OPT_URL)
    const opt = viewer.getStats()
    expect(opt).not.toBeNull()
    // join и квантование не трогают полигоны — треугольников ровно столько же
    expect(opt.triangles).toBe(ORIG_TRIANGLES)
    // join схлопнул 625 копий с общей геометрией в один меш
    expect(opt.drawCalls).toBe(1)
  })

  it('позиции те же: авто-кадрирование оригинала и результата даёт одну камеру', async () => {
    await viewer.load(ORIG_URL)
    const camOrig = viewer.getCameraState()
    await viewer.load(OPT_URL)
    const camOpt = viewer.getCameraState()

    // Камера выводится из мирового bbox; квантование двигает вершины на ~1 шаг
    // 16-битной сетки (модель ~268 ед. → шаг ~0.004), т.е. bbox меняется на доли
    // процента. Позиция и цель должны совпасть в относительном допуске 0.5%.
    const rel = (a, b) => (Math.abs(a - b) / Math.max(Math.abs(b), 1e-9)) * 100
    for (const k of ['x', 'y', 'z']) {
      expect(rel(camOpt.position[k], camOrig.position[k])).toBeLessThan(0.5)
      expect(rel(camOpt.target[k], camOrig.target[k])).toBeLessThan(0.5)
    }
    // near/far — производные от bbox; допуск чуть шире, т.к. near = dist/100.
    expect(rel(camOpt.near, camOrig.near)).toBeLessThan(1)
    expect(rel(camOpt.far, camOrig.far)).toBeLessThan(1)
  })

  it('рендер без артефактов: пиксели совпадают в допуске квантования', async () => {
    // Оригинал — со своей авто-камерой.
    await viewer.load(ORIG_URL)
    const camOrig = viewer.getCameraState()
    viewer.renderFrame()
    const a = snapshotPixels(viewer)

    // Результат — С ТОЙ ЖЕ камерой: единственная допустимая разница пикселей —
    // округление позиций квантованием, а не другой ракурс.
    await viewer.load(OPT_URL, { camera: camOrig })
    viewer.renderFrame()
    const b = snapshotPixels(viewer)

    // Модель действительно видна (не пустой кадр с обеих сторон).
    const base = diffStats(a, b)
    // Измерение для ручной сверки (в отчёте): на 2026-08-01 ~0.06% экстремальных
    // пикселей (≈70 из 120 000) — это кромки силуэтов, см. комментарий ниже.
    console.log(
      `[instance-grid-render] overPct=${base.overPct.toFixed(3)}% ` +
        `meanDiff=${base.meanDiff.toFixed(3)} maxDiff=${base.maxDiff} ` +
        `extremePct=${base.extremePct.toFixed(4)}% litPct=${base.litPct.toFixed(2)}%`,
    )
    expect(base.litPct).toBeGreaterThan(0.5)

    // Массовое расхождение пикселей = геометрия уехала или сломалась.
    // Допуск: не более 0.5% пикселей с расхождением > 12 суммарно по каналам,
    // среднее расхождение < 2, «экстремальных» (d > 60) — не более 0.1%.
    // Квантование двигает вершины на шаг 16-битной сетки (~0.004 ед. при габарите
    // ~268 ед.), и на кромках силуэта это даёт единичные субпиксельные сдвиги
    // заливки (один пиксель может сменить цвет целиком — это нормально).
    // Массовое расхождение или проценты экстремальных пикселей — уже артефакт.
    expect(base.overPct).toBeLessThan(0.5)
    expect(base.meanDiff).toBeLessThan(2)
    expect(base.extremePct).toBeLessThan(0.1)
  })
})
