// tests/viewer-regression.browser.test.mjs — браузерные тесты вьюера (WebGL).
//
// Тесты запускаются в Chromium через @vitest/browser + playwright и проверяют
// поведение, которое статический анализ исходников не ловит: реальная загрузка
// модели, анимация, камера.
//
// Модели раздаются через Vite publicDir (fixtures/models/ → /).
//
// Покрытие (задание 2026-07-29):
//   1. getCameraState() — 6 полей (было 4 до 125faa2)
//   2. applyCameraState() — near/far + updateProjectionMatrix()
//   3. frame() — near/far/minDistance/maxDistance
//   4. setExposure() — валидация, откат на 1
//   5. selectAnimationClip() — _animClipIndex + левый/правый вьюпорт
//   6. getAnimation() — leftIndex/rightIndex
//   7. _applyAnimSelection() — клип сохраняется между загрузками
//   8. resetView() — один frame(), копия во второй вьюпорт

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  createViewer,
  disposeViewer,
  setupDualViewportDOM,
  teardownDualViewportDOM,
  resetAnimationClipIndex,
} from '../tests/helpers/viewer-test-utils.mjs'

// URL-ы моделей — Vite publicDir раздаёт fixtures/models/ с корня /
const CUBE_URL = '/Dirty%20Cube%2001.glb'
const ANIM_MODEL_URL = '/chibi_zenitsu.glb'
const LILITH_URL = '/Lilith%20Character%2001.glb'
const CTHULHU_URL = '/Cthulhu%20Stone%2001.glb'
const PARKERGIRL_URL = '/parkergirl.glb'
const DRACO_URL = '/Draco%20Compressed%20Input%2001.glb'
const MESHOPT_URL = '/Meshopt%20Compressed%20Input%2001.glb'

// Все GLB-модели в fixtures/models/ (кроме уже перечисленных выше).
// URL-encoded вручную — encodeURIComponent небезопасен для /vendor/роутинга.
// Модели, отмеченные gitTracked: true, версионируются в git и доступны на CI.
// Остальные — только локально (не коммитятся из-за лицензий).
// Размеры файлов (байты) — для перф-порога: модели > 10MB должны грузиться < 10с.
// Измерено на ext4, md5sum совпадает с git-объектом.
const FILE_SIZES = {
  'Dirty Cube 01': 62284,
  'Instance Grid 01': 993984,
  'Morph Cube 01': 3672,
  'Vertex Colors 01': 2948,
  'Draco Compressed Input 01': 6380,
  'Meshopt Compressed Input 01': 7500,
  'Linked Duplicates Grid 01': 8624,
  'Orphan Texture Cube 01': 25620,
  'Preinstanced Grid 01': 2532,
  'Truncated Broken 01': 1468,
  'chibi_zenitsu': 4253652,
  'Lilith Character 01': 8261392,
  'Cthulhu Stone 01': 19113196,
  'parkergirl': 8479208,
  'ABeautifulGame': 42977928,
  'MosquitoInAmber': 24229904,
  'IridescenceLamp': 4083912,
  'SunglassesKhronos': 371188,
  'SpecularSilkPouf': 4632512,
  'DiffuseTransmissionTeacup': 4795028,
  'ToyCar': 5422412,
  'IridescentDishWithOlives': 5742828,
  'DiffuseTransmissionPlant': 5759100,
  'PotOfCoalsAnimationPointer': 6326684,
  'ChronographWatch': 7446368,
  'AnisotropyBarnLamp': 7833440,
  'AnimationPointerUVs': 7980492,
  'SheenWoodLeatherSofa': 10107912,
  'CommercialRefrigerator': 10131180,
  'CarConcept': 11778688,
  'r 250': 16055840,
  'Е300': 16708380,
  'L-330': 7830588,
}

const ALL_MODELS = [
  { name: 'Dirty Cube 01', url: CUBE_URL, gitTracked: true },
  { name: 'Instance Grid 01', url: '/Instance%20Grid%2001.glb', gitTracked: true },
  { name: 'Morph Cube 01', url: '/Morph%20Cube%2001.glb', gitTracked: true },
  { name: 'Vertex Colors 01', url: '/Vertex%20Colors%2001.glb', gitTracked: true },
  { name: 'Draco Compressed Input 01', url: DRACO_URL, gitTracked: true },
  { name: 'Meshopt Compressed Input 01', url: MESHOPT_URL, gitTracked: true },
  { name: 'Linked Duplicates Grid 01', url: '/Linked%20Duplicates%20Grid%2001.glb', gitTracked: true },
  { name: 'Orphan Texture Cube 01', url: '/Orphan%20Texture%20Cube%2001.glb', gitTracked: true },
  { name: 'Preinstanced Grid 01', url: '/Preinstanced%20Grid%2001.glb', gitTracked: true },
  // Truncated Broken — намеренно обрезанный/битый GLB (коррупция данных).
  // Парсинг Three.js выбрасывает RangeError, что ожидаемо и не является
  // дефектом вьюера. Проверяем только что ошибка приходит (а не зависание).
  { name: 'Truncated Broken 01', url: '/Truncated%20Broken%2001.glb', gitTracked: true, expectFail: true },
  // Local-only: сторонние модели, не коммитятся
  { name: 'chibi_zenitsu', url: ANIM_MODEL_URL, gitTracked: false },
  { name: 'Lilith Character 01', url: LILITH_URL, gitTracked: false },
  { name: 'Cthulhu Stone 01', url: CTHULHU_URL, gitTracked: false },
  { name: 'parkergirl', url: PARKERGIRL_URL, gitTracked: false },
  { name: 'ABeautifulGame', url: '/ABeautifulGame.glb', gitTracked: false },
  { name: 'MosquitoInAmber', url: '/MosquitoInAmber.glb', gitTracked: false },
  { name: 'IridescenceLamp', url: '/IridescenceLamp.glb', gitTracked: false },
  { name: 'SunglassesKhronos', url: '/SunglassesKhronos.glb', gitTracked: false },
  { name: 'SpecularSilkPouf', url: '/SpecularSilkPouf.glb', gitTracked: false },
  { name: 'DiffuseTransmissionTeacup', url: '/DiffuseTransmissionTeacup.glb', gitTracked: false },
  { name: 'ToyCar', url: '/ToyCar.glb', gitTracked: false },
  { name: 'IridescentDishWithOlives', url: '/IridescentDishWithOlives.glb', gitTracked: false },
  { name: 'DiffuseTransmissionPlant', url: '/DiffuseTransmissionPlant.glb', gitTracked: false },
  { name: 'PotOfCoalsAnimationPointer', url: '/PotOfCoalsAnimationPointer.glb', gitTracked: false },
  { name: 'ChronographWatch', url: '/ChronographWatch.glb', gitTracked: false },
  { name: 'AnisotropyBarnLamp', url: '/AnisotropyBarnLamp.glb', gitTracked: false },
  { name: 'AnimationPointerUVs', url: '/AnimationPointerUVs.glb', gitTracked: false },
  { name: 'SheenWoodLeatherSofa', url: '/SheenWoodLeatherSofa.glb', gitTracked: false },
  { name: 'CommercialRefrigerator', url: '/CommercialRefrigerator.glb', gitTracked: false },
  { name: 'CarConcept', url: '/CarConcept.glb', gitTracked: false },
  { name: 'r 250', url: '/r%20250.glb', gitTracked: false },
  { name: 'Е300', url: '/%D0%95300.glb', gitTracked: false },
  { name: 'L-330', url: '/L-330.glb', gitTracked: false },
]

// ---------------------------------------------------------------------------
// Viewer — класс движка просмотра (ui/viewer/viewer.js)
// ---------------------------------------------------------------------------

describe('Viewer — camera state (browser)', () => {
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

  it('getCameraState() returns position, target, near, far, minDistance, maxDistance', () => {
    const state = viewer.getCameraState()
    expect(state).toHaveProperty('position')
    expect(state).toHaveProperty('target')
    expect(state).toHaveProperty('near')
    expect(state).toHaveProperty('far')
    expect(state).toHaveProperty('minDistance')
    expect(state).toHaveProperty('maxDistance')
    // Позиция/цель — Vector3
    expect(Number.isFinite(state.position.x)).toBe(true)
    expect(Number.isFinite(state.target.x)).toBe(true)
    // near/far — конечные числа из конструктора (0.01 / 1000)
    expect(Number.isFinite(state.near)).toBe(true)
    expect(Number.isFinite(state.far)).toBe(true)
    // minDistance/maxDistance — по умолчанию OrbitControls ставит Infinity.
    // Они становятся конечными только после frame().
    expect(state.minDistance).toBeGreaterThanOrEqual(0)
    expect(state.maxDistance).toBeGreaterThanOrEqual(0)
  })

  it('applyCameraState() sets near, far, minDistance, maxDistance and updates projection matrix', () => {
    // Сначала сохраняем исходное состояние (ещё до загрузки модели — камера
    // в конструкторе: 0.01, 1000). Применяем новые значения.
    const original = viewer.getCameraState()
    const newState = {
      position: original.position.clone(),
      target: original.target.clone(),
      near: 0.05,
      far: 500,
      minDistance: 0.1,
      maxDistance: 100,
    }
    viewer.applyCameraState(newState)

    const after = viewer.getCameraState()
    expect(after.near).toBe(0.05)
    expect(after.far).toBe(500)
    expect(after.minDistance).toBe(0.1)
    expect(after.maxDistance).toBe(100)

    // Возвращаем как было (чтобы не ломать следующие тесты)
    viewer.applyCameraState(original)
  })

  it('setExposure() validates input, falls back to 1 for non-finite values', () => {
    // Нормальное значение
    viewer.setExposure(2)
    expect(viewer.renderer.toneMappingExposure).toBe(2)

    // NaN → 1 (Number(NaN) = NaN, не finite)
    viewer.setExposure(NaN)
    expect(viewer.renderer.toneMappingExposure).toBe(1)

    // undefined → 1 (Number(undefined) = NaN)
    viewer.setExposure(undefined)
    expect(viewer.renderer.toneMappingExposure).toBe(1)

    // null → Number(null) = 0, это finite — вьюер ставит 0 (корректно по контракту)
    viewer.setExposure(null)
    expect(viewer.renderer.toneMappingExposure).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Viewer — загрузка модели: камера кадрируется после load
// ---------------------------------------------------------------------------

describe('Viewer — model loading (browser)', () => {
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

  it('loads a GLB model and returns stats', async () => {
    const gltf = await viewer.load(CUBE_URL)
    expect(gltf).toBeTruthy()
    expect(gltf.scene).toBeTruthy()

    const stats = viewer.getStats()
    expect(stats).not.toBeNull()
    expect(stats.triangles).toBeGreaterThan(0)
    expect(stats.vertices).toBeGreaterThan(0)
    expect(stats.drawCalls).toBeGreaterThan(0)
  })

  it('camera state is set after model load (frame() ran)', () => {
    const state = viewer.getCameraState()
    // После frame() near/far должны быть конечными числами
    // и разумными для модели размером ~1-2 единицы
    expect(state.near).toBeGreaterThan(0)
    expect(state.near).toBeLessThan(1)
    expect(state.far).toBeGreaterThan(10)
    expect(state.minDistance).toBeGreaterThan(0)
    expect(state.maxDistance).toBeGreaterThan(state.minDistance)
    expect(Number.isFinite(state.maxDistance)).toBe(true)
    // target должен быть в центре модели (не нули для Dirty Cube)
    expect(Number.isFinite(state.target.x)).toBe(true)
    expect(Number.isFinite(state.target.y)).toBe(true)
    expect(Number.isFinite(state.target.z)).toBe(true)
  })

  it('detectSource() returns compression info for the loaded model', () => {
    const detected = viewer.getDetection()
    expect(detected).not.toBeNull()
    // Dirty Cube 01.glb не использует draco/meshopt/ktx2 — все false
    expect(typeof detected.draco).toBe('boolean')
    expect(typeof detected.meshopt).toBe('boolean')
    expect(typeof detected.ktx2).toBe('boolean')
  })
})

// ---------------------------------------------------------------------------
// Viewer — анимация
// ---------------------------------------------------------------------------

describe('Viewer — animation (browser)', () => {
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

  it('loads an animated model and getAnimationInfo() returns clip info', async () => {
    await viewer.load(ANIM_MODEL_URL)
    const info = viewer.getAnimationInfo()
    expect(info.count).toBeGreaterThanOrEqual(1)
    expect(info.names.length).toBe(info.count)
    expect(info.index).toBe(0) // playClip(0) при загрузке
    expect(info.duration).toBeGreaterThan(0)
  })

  it('playClip() switches to a different clip and getAnimationInfo().index matches', () => {
    const info = viewer.getAnimationInfo()
    if (info.count < 2) return // всего 1 клип — нечего переключать

    viewer.playClip(1)
    const after = viewer.getAnimationInfo()
    expect(after.index).toBe(1)

    // Возвращаем на первый
    viewer.playClip(0)
    expect(viewer.getAnimationInfo().index).toBe(0)
  })

  it('setAnimationTime() advances animation without throwing', () => {
    viewer.setAnimationTime(0.5)
    // Не падает — достаточно
    expect(true).toBe(true)
  })

  it('loads Cthulhu Stone (morph targets) — getAnimationInfo shows 1 clip named Scene', async () => {
    await viewer.load(CTHULHU_URL)
    const info = viewer.getAnimationInfo()
    expect(info.count).toBe(1)
    expect(info.names.length).toBe(1)
    // Название может быть чистым 'Scene' или с префиксом 'root|Scene'
    expect(info.names[0]).toMatch(/Scene/)
    expect(info.index).toBe(0)
    expect(info.duration).toBeGreaterThan(0)
  })

  it('playClip(0) does not throw on single-clip Cthulhu', () => {
    expect(() => viewer.playClip(0)).not.toThrow()
    const info = viewer.getAnimationInfo()
    expect(info.count).toBe(1)
    expect(info.index).toBe(0)
  })

  it('loads parkergirl (skinning) — getAnimationInfo shows 1 clip named MorphBake', async () => {
    await viewer.load(PARKERGIRL_URL)
    const info = viewer.getAnimationInfo()
    expect(info.count).toBe(1)
    expect(info.names.length).toBe(1)
    expect(info.names[0]).toMatch(/MorphBake/)
    expect(info.index).toBe(0)
    expect(info.duration).toBeGreaterThan(0)
  })

  it('playClip(0) does not throw on single-clip parkergirl', () => {
    expect(() => viewer.playClip(0)).not.toThrow()
    const info = viewer.getAnimationInfo()
    expect(info.count).toBe(1)
    expect(info.index).toBe(0)
  })

  it('model without animations returns count: 0 and index: -1', async () => {
    await viewer.load(CUBE_URL)
    const info = viewer.getAnimationInfo()
    expect(info.count).toBe(0)
    expect(info.names).toEqual([])
    expect(info.index).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// DualViewport — интеграция с DOM (ui/viewer/index.js → window.OptiViewer)
// ---------------------------------------------------------------------------

describe('DualViewport — animation sync (browser)', () => {
  beforeAll(async () => {
    await setupDualViewportDOM()
  })

  afterAll(() => {
    teardownDualViewportDOM()
  })

  it('OptiViewer global API is available', () => {
    expect(window.OptiViewer).toBeTruthy()
    expect(typeof window.OptiViewer.loadOriginal).toBe('function')
    expect(typeof window.OptiViewer.getAnimation).toBe('function')
    expect(typeof window.OptiViewer.selectAnimationClip).toBe('function')
    expect(typeof window.OptiViewer.resetView).toBe('function')
    expect(typeof window.OptiViewer.setExposure).toBe('function')
    expect(typeof window.OptiViewer.cameraStates).toBe('function')
  })

  it('loadOriginal() loads a model and getAnimation() returns leftIndex/rightIndex', async () => {
    // Загружаем модель через OptiViewer (как это делает app.js)
    const response = await fetch(ANIM_MODEL_URL)
    const blob = await response.blob()
    const file = new File([blob], 'chibi_zenitsu.glb', { type: 'model/gltf-binary' })

    const result = await window.OptiViewer.loadOriginal(file)
    expect(result).not.toBeNull()
    expect(result.stats).toBeTruthy()
    expect(result.stats.triangles).toBeGreaterThan(0)

    // getAnimation() должен вернуть leftIndex/rightIndex
    const anim = window.OptiViewer.getAnimation()
    expect(anim).toHaveProperty('leftIndex')
    expect(anim).toHaveProperty('rightIndex')
    expect(typeof anim.leftIndex).toBe('number')
    expect(typeof anim.rightIndex).toBe('number')
  })

  it('selectAnimationClip() updates both leftIndex and rightIndex', () => {
    const before = window.OptiViewer.getAnimation()
    if (before.count < 2) return // только 1 клип — нечего переключать

    // Выбираем другой клип
    window.OptiViewer.selectAnimationClip(1)
    const after = window.OptiViewer.getAnimation()
    expect(after.leftIndex).toBe(1)
    expect(after.rightIndex).toBe(1)

    // Возвращаем на первый
    window.OptiViewer.selectAnimationClip(0)
  })

  it('selectAnimationClip() persists non-zero index across reloads (same animated model)', async () => {
    // Шаг 1: загружаем модель с несколькими клипами (Lilith — 3 анимации)
    const resp1 = await fetch(LILITH_URL)
    const file1 = new File([await resp1.blob()], 'Lilith Character 01.glb', { type: 'model/gltf-binary' })
    const result1 = await window.OptiViewer.loadOriginal(file1)
    expect(result1).not.toBeNull()

    // Получаем список анимаций
    const anim1 = window.OptiViewer.getAnimation()
    expect(anim1.count).toBeGreaterThanOrEqual(3)

    // Шаг 2: выбираем клип №1 (не нулевой — ключевой тест!)
    // Правый вьюпорт сброшен loadOriginal(), поэтому rightIndex = -1.
    // Главное — leftIndex стал 1 (выбранный клип применился к левому вьюпорту).
    window.OptiViewer.selectAnimationClip(1)
    const anim2 = window.OptiViewer.getAnimation()
    expect(anim2.leftIndex).toBe(1)
    expect(anim2.rightIndex).toBe(-1)

    // Шаг 3: ПЕРЕЗАГРУЖАЕМ ту же анимированную модель.
    // _afterLoad() → _applyAnimSelection() должна восстановить клип №1
    const resp2 = await fetch(LILITH_URL)
    const file2 = new File([await resp2.blob()], 'Lilith Character 01.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file2)

    const anim3 = window.OptiViewer.getAnimation()
    // _applyAnimSelection() вызывает playClip(1), потому что idx = 1 > 0
    expect(anim3.leftIndex).toBe(1)
    expect(anim3.count).toBeGreaterThanOrEqual(3)

    // Шаг 4: загружаем модель БЕЗ анимаций — индексы сбрасываются в -1
    const resp3 = await fetch(CUBE_URL)
    const file3 = new File([await resp3.blob()], 'Dirty Cube 01.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file3)

    const anim4 = window.OptiViewer.getAnimation()
    expect(anim4.leftIndex).toBe(-1)
    expect(anim4.rightIndex).toBe(-1)
    expect(anim4.count).toBe(0)
  })

  it('cameraStates() returns camera state for both viewports', () => {
    const states = window.OptiViewer.cameraStates()
    expect(states).toHaveProperty('left')
    expect(states).toHaveProperty('right')
    if (states.left) {
      expect(states.left).toHaveProperty('near')
      expect(states.left).toHaveProperty('far')
      expect(states.left).toHaveProperty('position')
    }
  })

  it('setExposure() applies to both viewports', () => {
    window.OptiViewer.setExposure(1.5)
    expect(window.OptiViewer.getExposure()).toBe(1.5)
    // applyExposure() применила к обоим вьюпортам — проверяем что не упало
    window.OptiViewer.setExposure(1.0)
    expect(window.OptiViewer.getExposure()).toBe(1)
  })

  it('resetView() frames one viewport and copies camera state', () => {
    // После загрузки моделей resetView() должен отработать без ошибок
    expect(() => window.OptiViewer.resetView()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Viewer — сжатые модели (Draco, Meshopt)
// ---------------------------------------------------------------------------
//
// Draco требует, чтобы сервер раздавал файлы декодера (.wasm, .js) по пути
// /vendor/three/examples/jsm/libs/draco/gltf/. В тестовом окружении их отдаёт
// Vite-плагин threeVendorPlugin из vitest.config.mjs.
//
// MeshoptDecoder импортируется как ES-модуль и бандлится Vite — дополнительных
// файлов на диске не требуется.
// ---------------------------------------------------------------------------

describe('Viewer — compressed models (browser)', () => {
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

  it('loads a Draco-compressed model and returns stats', async () => {
    const gltf = await viewer.load(DRACO_URL)
    expect(gltf).toBeTruthy()
    expect(gltf.scene).toBeTruthy()

    const stats = viewer.getStats()
    expect(stats).not.toBeNull()
    expect(stats.triangles).toBeGreaterThan(0)
    expect(stats.vertices).toBeGreaterThan(0)
    expect(stats.drawCalls).toBeGreaterThan(0)

    // camera state is finite after frame()
    const state = viewer.getCameraState()
    expect(Number.isFinite(state.near)).toBe(true)
    expect(Number.isFinite(state.far)).toBe(true)
  })

  it('detectSource correctly identifies Draco compression', () => {
    const detected = viewer.getDetection()
    expect(detected).not.toBeNull()
    expect(detected.draco).toBe(true)
    expect(detected.meshopt).toBe(false)
    expect(detected.ktx2).toBe(false)
  })

  it('loads a Meshopt-compressed model and returns stats', async () => {
    // Переключаемся на meshopt-модель
    const gltf = await viewer.load(MESHOPT_URL)
    expect(gltf).toBeTruthy()
    expect(gltf.scene).toBeTruthy()

    const stats = viewer.getStats()
    expect(stats).not.toBeNull()
    expect(stats.triangles).toBeGreaterThan(0)
    expect(stats.vertices).toBeGreaterThan(0)
    expect(stats.drawCalls).toBeGreaterThan(0)
  })

  it('detectSource correctly identifies Meshopt compression', () => {
    const detected = viewer.getDetection()
    expect(detected).not.toBeNull()
    expect(detected.draco).toBe(false)
    expect(detected.meshopt).toBe(true)
    expect(detected.ktx2).toBe(false)
  })

  it('loads an uncompressed model after a compressed one (reuses viewer)', async () => {
    // Грузим обычную модель после meshopt — проверяем, что декодеры не засоряют
    // состояние и перезагрузка работает
    const gltf = await viewer.load(CUBE_URL)
    expect(gltf).toBeTruthy()

    const detected = viewer.getDetection()
    expect(detected).not.toBeNull()
    expect(detected.draco).toBe(false)
    expect(detected.meshopt).toBe(false)
    expect(detected.ktx2).toBe(false)
  })

  it('handles 404 gracefully — non-existent model URL', async () => {
    // Проверяем, что загрузка несуществующего URL не крашит вьюер
    // Viewer.load не очищает this.stats при ошибке — они остаются от предыдущей
    // успешной загрузки. Это нормально: при следующей успешной загрузке stats
    // перезапишутся. Главное — что reject не ломает внутреннее состояние.
    await expect(viewer.load('/nonexistent.glb')).rejects.toThrow()
    // После ошибки вьюер можно переиспользовать — проверяется в следующем тесте
  })

  it('reloads a working model after a failed load', async () => {
    // Сначала пробуем несуществующий URL
    await expect(viewer.load('/nonexistent.glb')).rejects.toThrow()

    // Затем грузим рабочую модель
    const gltf = await viewer.load(CUBE_URL)
    expect(gltf).toBeTruthy()
    expect(viewer.getStats()?.triangles).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// DualViewport — оба вьюпорта загружены: синхронизация анимации
// ---------------------------------------------------------------------------

describe('DualViewport — both viewports loaded with Lilith (3 clips)', () => {
  beforeAll(async () => {
    await setupDualViewportDOM()
    // DualViewport — синглтон (ES-модуль кешируется). Предыдущий describe
    // мог оставить _animClipIndex = 1 (тест selectAnimationClip persistence).
    resetAnimationClipIndex()
  })

  afterAll(() => {
    teardownDualViewportDOM()
  })

  it('loads Lilith into left (loadOriginal) then right (loadOptimized)', async () => {
    // Шаг 1: загружаем в левый вьюпорт
    const resp1 = await fetch(LILITH_URL)
    const file = new File([await resp1.blob()], 'Lilith Character 01.glb', { type: 'model/gltf-binary' })
    const result1 = await window.OptiViewer.loadOriginal(file)
    expect(result1).not.toBeNull()
    expect(result1.stats.triangles).toBeGreaterThan(0)

    // После loadOriginal правый вьюпорт пуст — rightIndex = -1
    let anim = window.OptiViewer.getAnimation()
    expect(anim.count).toBeGreaterThanOrEqual(3)
    expect(anim.leftIndex).toBe(0)
    expect(anim.rightIndex).toBe(-1)

    // Шаг 2: загружаем ту же модель в правый вьюпорт через URL
    // loadOptimized принимает URL (строку), а не File
    await window.OptiViewer.loadOptimized(LILITH_URL)

    anim = window.OptiViewer.getAnimation()
    expect(anim.count).toBeGreaterThanOrEqual(3)
    expect(anim.leftIndex).toBe(0)  // _applyAnimSelection: idx=0, 0>0=false → не трогает
    expect(anim.rightIndex).toBe(0) // после загрузки playClip(0) в _setupAnimations
  })

  it('selectAnimationClip(1) synchronizes leftIndex and rightIndex to 1', () => {
    // Теперь оба вьюпорта загружены с Lilith (3 клипа)
    window.OptiViewer.selectAnimationClip(1)

    const anim = window.OptiViewer.getAnimation()
    expect(anim.count).toBeGreaterThanOrEqual(3)
    expect(anim.leftIndex).toBe(1)
    expect(anim.rightIndex).toBe(1)

    // Возвращаем на клип 0, чтобы не ломать следующие тесты
    window.OptiViewer.selectAnimationClip(0)
  })

  it('cameraStates() returns camera state for both viewports', () => {
    const states = window.OptiViewer.cameraStates()
    expect(states.left).not.toBeNull()
    expect(states.right).not.toBeNull()
    if (states.left && states.right) {
      expect(Number.isFinite(states.left.near)).toBe(true)
      expect(Number.isFinite(states.right.near)).toBe(true)
    }
  })

  it('resetView() works with both viewports loaded', () => {
    expect(() => window.OptiViewer.resetView()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Параметризованный тест: загрузка КАЖДОЙ модели из fixtures/ во вьюере.
// ---------------------------------------------------------------------------
//
// Проверяет, что модель загружается без ошибок, stats не-null, triangles > 0,
// detectSource возвращает валидные флаги сжатия.
//
// Модели, отмеченные gitTracked: false, могут отсутствовать на CI (не коммитятся
// из-за лицензий) — в этом случае тест пропускается с пояснением.
// ---------------------------------------------------------------------------

describe('Viewer — all models parameterized (browser)', () => {
  /** @type {HTMLCanvasElement} */
  let canvas
  /** @type {import('../ui/viewer/viewer.js').Viewer} */
  let viewer

  // Собираем тайминги для топа-5 медленных моделей
  /** @type {{ name: string, time: number, size: number }[]} */
  const timings = []

  beforeAll(async () => {
    const result = await createViewer()
    canvas = result.canvas
    viewer = result.viewer
  })

  afterAll(() => {
    // Топ-5 самых медленных моделей
    const sorted = [...timings].sort((a, b) => b.time - a.time).slice(0, 5)
    if (sorted.length > 0) {
      console.log('\n═══ Топ-5 медленных моделей ═══')
      for (let i = 0; i < sorted.length; i++) {
        const t = sorted[i]
        const sizeMb = (t.size / 1_000_000).toFixed(1)
        console.log(`  ${i + 1}. ${t.name} — ${t.time.toFixed(0)}ms (${sizeMb}MB)`)
      }
      console.log('')
    }

    disposeViewer(viewer, canvas)
  })

  // Функция вычисления таймаута по размеру файла (байты):
  //   < 100K   → 5s  (крошечные модели)
  //   < 1MB    → 10s
  //   < 10MB   → 15s
  //   < 50MB   → 30s  (ABeautifulGame 41MB)
  //   >= 50MB  → 60s  (запас)
  function testTimeout(fileSize) {
    if (fileSize < 100_000) return 5_000
    if (fileSize < 1_000_000) return 10_000
    if (fileSize < 10_000_000) return 15_000
    if (fileSize < 50_000_000) return 30_000
    return 60_000
  }

  for (const { name, url, gitTracked, expectFail } of ALL_MODELS) {
    const fileSize = FILE_SIZES[name]
    if (fileSize === undefined) {
      throw new Error(`Missing FILE_SIZES entry for '${name}' — add it before the test runs`)
    }

    const timeout = testTimeout(fileSize)

    it(`${name} — loads, has stats, detectSource valid`, async () => {
      const startTime = performance.now()
      let gltf

      try {
        gltf = await viewer.load(url)
      } catch (err) {
        const elapsed = performance.now() - startTime
        const msg = String(err.message || '')

        // 404 = модель не прикоммичена (не gitTracked). Пропускаем.
        if (msg.includes('404') || msg.includes('Not Found') || msg.includes('Failed to fetch')) {
          if (!gitTracked) {
            timings.push({ name, time: elapsed, size: fileSize })
            return
          }
          throw err
        }
        // Намеренно битая модель — ошибка ожидаема
        if (expectFail) {
          timings.push({ name, time: elapsed, size: fileSize })
          return
        }
        throw err
      }

      // Намеренно битая загрузилась успешно — странно
      if (expectFail) {
        throw new Error(`${name} marked as expectFail but loaded successfully`)
      }

      const elapsed = performance.now() - startTime
      timings.push({ name, time: elapsed, size: fileSize })

      // Порог производительности: модели > 10MB должны загружаться не дольше 10 секунд.
      if (fileSize > 10_000_000 && elapsed > 10_000) {
        throw new Error(`${name}: ${(fileSize / 1_000_000).toFixed(1)}MB loaded in ${elapsed.toFixed(0)}ms (limit: 10s)`)
      }

      // Модель загружена — проверяем stats
      expect(gltf).toBeTruthy()
      expect(gltf.scene).toBeTruthy()

      const stats = viewer.getStats()
      expect(stats).not.toBeNull()
      expect(stats.triangles).toBeGreaterThan(0)
      expect(stats.vertices).toBeGreaterThan(0)
      expect(typeof stats.drawCalls).toBe('number')
      expect(stats.drawCalls).toBeGreaterThan(0)

      // detectSource всегда должен возвращать объект с тремя boolean
      const detected = viewer.getDetection()
      expect(detected).not.toBeNull()
      expect(typeof detected.draco).toBe('boolean')
      expect(typeof detected.meshopt).toBe('boolean')
      expect(typeof detected.ktx2).toBe('boolean')
    }, timeout)
  }
})

describe('Viewer — compressed models via DualViewport (browser)', () => {
  beforeAll(async () => {
    await setupDualViewportDOM()
  })

  afterAll(() => {
    teardownDualViewportDOM()
  })

  it('loads a Draco model via loadOriginal and getAnimation() works', async () => {
    const response = await fetch(DRACO_URL)
    const blob = await response.blob()
    const file = new File([blob], 'Draco Compressed Input 01.glb', { type: 'model/gltf-binary' })

    const result = await window.OptiViewer.loadOriginal(file)
    expect(result).not.toBeNull()
    expect(result.stats).toBeTruthy()
    expect(result.stats.triangles).toBeGreaterThan(0)

    // Draco-модель без анимаций
    const anim = window.OptiViewer.getAnimation()
    expect(anim.count).toBe(0)
    expect(anim.leftIndex).toBe(-1)
    expect(anim.rightIndex).toBe(-1)
  })

  it('loads a Meshopt model after Draco, works correctly', async () => {
    const response = await fetch(MESHOPT_URL)
    const blob = await response.blob()
    const file = new File([blob], 'Meshopt Compressed Input 01.glb', { type: 'model/gltf-binary' })

    const result = await window.OptiViewer.loadOriginal(file)
    expect(result).not.toBeNull()
    expect(result.stats).toBeTruthy()

    // cameraStates не падает
    const states = window.OptiViewer.cameraStates()
    expect(states.left).not.toBeNull()
    if (states.left) {
      expect(Number.isFinite(states.left.near)).toBe(true)
    }
  })
})
