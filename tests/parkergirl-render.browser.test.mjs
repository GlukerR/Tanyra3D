// tests/parkergirl-render.browser.test.mjs — рендер parkergirl после
// ['safe','quantize'] в реальном WebGL (браузерный тест).
//
// Вопрос 2026-08-01: квантование (KHR_mesh_quantization) переписывает позиции
// 16-битными числами. У parkergirl скин-деформация (1 скин) и 456 морф-таргетов
// на восьми примитивах — единственное, что оптимизация может испортить НЕЗАМЕТНО:
// метрики сойдутся, валидатор промолчит, а персонаж в движении сложится пополам
// (см. комментарий «Анимация» в ui/viewer/viewer.js). Статический анализ уже
// подтвердил цифры (27854 треугольника, скины/морфы/анимации не изменились,
// файл 8.48 → 3.60 МБ). Здесь проверяется то, что анализ не видит: РЕНДЕР —
// не деформируется ли квантованная сетка иначе, чем оригинал.
//
// Механика:
//   Оригинал и результат грузятся в ОДНУ камеру (как DualViewport.loadOptimized —
//   камера с оригинала, потому что авто-кадрирование результата ненадёжно:
//   getBounds() не читает inverseBindMatrices, см. TESTBUG-007). Анимация ставится
//   в АБСОЛЮТНОЕ время через setAnimationTime — оба вьюпорта показывают ровно одну
//   позу (см. контракт движка просмотра в ui/viewer/index.js).
//
//   ОСОБЕННОСТЬ parkergirl (замерено 2026-08-01): клип MorphBake — это мимика,
//   запечённая в 456 морф-таргетов с дельтами ~0.02 ед. при габарите ~2.6 ед.
//   На кадре 400×300 с камеры на 2.6 ед. такое изменение СУБПИКСЕЛЬНО: кадры
//   в разных позах совпадают побайтово (контроль: chibi_zenitsu со скелетной
//   анимацией даёт 20.45% изменённых пикселей — методика накачки рабочая, дело
//   в характере морфов). Поэтому «анимация реально работает» проверяется
//   СТРУКТУРНО: морф-инлюенсы обязаны различаться между позами. Если клип ничего
//   не анимирует — инлюенсы во всех позах одинаковы, и сравнение поз ничего не
//   доказывает (тест обязан покраснеть).
//
// Оптимизированный файл собирает node-контекст globalSetup
// (tests/parkergirl-build.setup.mjs) в tests/__optimized__/, откуда его раздаёт
// Vite-мидлварь /optimized/ (vitest.config.mjs, optimizedArtifactsPlugin).
// Оригинал приходит из publicDir (fixtures/models) как /parkergirl.glb.

import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest'
import {
  createViewer,
  disposeViewer,
  snapshotPixels,
  diffStats,
} from './helpers/viewer-test-utils.mjs'

// Артефакт parkergirl-sq.glb собирает node-контекст globalSetup
// (tests/parkergirl-build.setup.mjs). Модель — ЛОКАЛЬНАЯ (в git её нет, см.
// REPO_MODELS в tests/helpers/model-files.mjs), поэтому на чистом клоне сборка
// пропускается, и globalSetup сообщает об этом через provide/inject.
//
// Условие читается ЗДЕСЬ, на этапе сбора файла: при отсутствии артефакта весь
// блок становится describe.skip с причиной в имени — не упавшим тестом.
// isPresent() из model-files.mjs тут не работает: файл исполняется в Chromium,
// node:fs ему недоступен — для этого и нужен канал из node-контекста.
const PARKERGIRL_AVAILABLE = inject('parkergirl-artifact-available') === true

const ORIG_URL = '/parkergirl.glb'
const OPT_URL = '/optimized/parkergirl-sq.glb'

// Инварианты исходника (из metric-отчёта, см. parkergirl-build.setup.mjs).
const ORIG_TRIANGLES = 27854

// Моменты времени (доли длительности клипа), в которые сравниваем позы.
// Разбросанные по всему клипу: морфы и скин ведут себя по-разному в разных фазах.
const POSE_FRACTIONS = [0, 0.15, 0.35, 0.55, 0.75, 0.92]

// Инлюенсы морфов всех мешей (дайджест для структурного контроля «анимация
// реально анимирует морфы»).
function morphInfluencesDigest(viewer) {
  const digests = []
  viewer.model?.traverse((o) => {
    if (o.isMesh && o.morphTargetInfluences?.length) {
      digests.push(
        o.morphTargetInfluences.map((v) => +v.toFixed(3)).join(','),
      )
    }
  })
  return digests
}

const parkergirlDescribe = PARKERGIRL_AVAILABLE ? describe : describe.skip

parkergirlDescribe(
  'parkergirl — safe+quantize: скин-анимация и морфы рендерятся без артефактов (browser)' +
    (PARKERGIRL_AVAILABLE ? '' : ' [skipped: parkergirl.glb отсутствует локально — артефакт не собран]'),
  () => {
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

  it('обе модели грузятся; треугольники и анимация на месте', async () => {
    await viewer.load(ORIG_URL)
    const orig = viewer.getStats()
    expect(orig).not.toBeNull()
    expect(orig.triangles).toBe(ORIG_TRIANGLES)
    const origAnim = viewer.getAnimationInfo()
    expect(origAnim.count).toBe(1)

    await viewer.load(OPT_URL)
    const opt = viewer.getStats()
    expect(opt).not.toBeNull()
    // квантование не трогает полигоны — треугольников ровно столько же
    expect(opt.triangles).toBe(ORIG_TRIANGLES)
    const optAnim = viewer.getAnimationInfo()
    // анимация сохранилась и имеет ту же длительность
    expect(optAnim.count).toBe(1)
    expect(optAnim.duration).toBeCloseTo(origAnim.duration, 3)
  })

  it('сторож: анимация реально анимирует морфы (инлюенсы различаются между позами)', async () => {
    await viewer.load(ORIG_URL)
    const anim = viewer.getAnimationInfo()
    const dur = anim.duration
    expect(dur).toBeGreaterThan(0)

    // Инлюенсы в каждой позе. НЕ перезагружаем модель между позами и не дёргаем
    // playClip: поза ставится абсолютным временем setAnimationTime, как это делает
    // DualViewport._advanceAnimation (одно время на оба вьюпорта).
    const states = new Set()
    for (const frac of POSE_FRACTIONS) {
      viewer.setAnimationTime(dur * frac)
      states.add(morphInfluencesDigest(viewer).join('|'))
    }

    // Морф-инлюенсы обязаны различаться хотя бы между двумя позами: иначе клип
    // ничего не анимирует, и пиксельное сравнение поз в следующем тесте не
    // доказывает ничего.
    console.log(
      `[parkergirl-render] guard: уникальных состояний инлюенсов ` +
        `среди ${POSE_FRACTIONS.length} поз = ${states.size} (из ${8} мешей × 57 морфов)`,
    )
    expect(states.size).toBeGreaterThan(1)

    // Модель действительно видна в кадре (не пустая сцена с обеих сторон).
    viewer.setAnimationTime(0)
    viewer.renderFrame()
    const base = diffStats(snapshotPixels(viewer), snapshotPixels(viewer))
    expect(base.litPct).toBeGreaterThan(0.5)
  })

  it('рендер без артефактов: кадры оригинала и результата совпадают в каждой позе', async () => {
    // Оригинал — со своей авто-камерой (frame() по мировому bbox).
    await viewer.load(ORIG_URL)
    const camOrig = viewer.getCameraState()
    const anim = viewer.getAnimationInfo()
    const dur = anim.duration
    expect(dur).toBeGreaterThan(0)

    // Кадры оригинала во всех позах.
    const origShots = []
    for (const frac of POSE_FRACTIONS) {
      viewer.setAnimationTime(dur * frac)
      viewer.renderFrame()
      origShots.push(snapshotPixels(viewer))
    }

    // Результат — С ТОЙ ЖЕ камерой и в ТОЙ ЖЕ позе: единственная допустимая
    // разница пикселей — округление позиций квантованием, не другой ракурс
    // и не рассинхрон анимации.
    await viewer.load(OPT_URL, { camera: camOrig })
    for (let i = 0; i < POSE_FRACTIONS.length; i++) {
      const frac = POSE_FRACTIONS[i]
      viewer.setAnimationTime(dur * frac)
      viewer.renderFrame()
      const b = snapshotPixels(viewer)

      const stats = diffStats(origShots[i], b)
      console.log(
        `[parkergirl-render] pose ${frac}: overPct=${stats.overPct.toFixed(3)}% ` +
          `meanDiff=${stats.meanDiff.toFixed(3)} maxDiff=${stats.maxDiff} ` +
          `extremePct=${stats.extremePct.toFixed(4)}% litPct=${stats.litPct.toFixed(2)}%`,
      )
      expect(stats.litPct).toBeGreaterThan(0.5)

      // Допуски те же, что у Instance Grid (и по той же причине): квантование
      // двигает вершины на шаг 16-битной сетки, и на кромках силуэтов это даёт
      // единичные субпиксельные сдвиги заливки. Массовое расхождение или
      // проценты экстремальных пикселей — уже артефакт (поехавший скин/морф).
      expect(stats.overPct).toBeLessThan(0.5)
      expect(stats.meanDiff).toBeLessThan(2)
      expect(stats.extremePct).toBeLessThan(0.1)
    }
  })
  },
)
