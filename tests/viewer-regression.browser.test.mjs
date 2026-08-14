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

// Все GLB-модели в fixtures/models/. Часть коммитится в репозиторий, часть лежит
// только у автора (лицензии сторонних моделей не позволяют их публиковать) — здесь
// это НЕ перечисляется: наличие проверяется HEAD-запросом к тому же серверу, который
// раздаёт модели тесту. Причины две.
//
// Первая: список версионируемых моделей уже есть — REPO_MODELS в
// tests/helpers/model-files.mjs. Второй такой список расходится с первым молча.
// Импортировать сам helper сюда нельзя: он читает `node:fs`, а этот файл исполняется
// в браузере.
//
// Вторая: размеры файлов приходят из Content-Length, а не из таблицы констант.
// Таблица устаревала бы при каждой пересборке фикстуры.
const MODEL_FILES = [
  'Dirty Cube 01.glb',
  'Instance Grid 01.glb',
  'Morph Cube 01.glb',
  'Vertex Colors 01.glb',
  'Draco Compressed Input 01.glb',
  'Meshopt Compressed Input 01.glb',
  'Linked Duplicates Grid 01.glb',
  'Orphan Texture Cube 01.glb',
  'Preinstanced Grid 01.glb',
  // Truncated Broken — намеренно обрезанный GLB. Парсинг three.js кидает RangeError:
  // это ожидаемо и дефектом вьюера не является. Проверяем, что ошибка ПРИХОДИТ, а не
  // что загрузка висит.
  'Truncated Broken 01.glb',
  'chibi_zenitsu.glb',
  'Lilith Character 01.glb',
  'Cthulhu Stone 01.glb',
  'parkergirl.glb',
  'ABeautifulGame.glb',
  'MosquitoInAmber.glb',
  'IridescenceLamp.glb',
  'SunglassesKhronos.glb',
  'SpecularSilkPouf.glb',
  'DiffuseTransmissionTeacup.glb',
  'ToyCar.glb',
  'IridescentDishWithOlives.glb',
  'DiffuseTransmissionPlant.glb',
  'PotOfCoalsAnimationPointer.glb',
  'ChronographWatch.glb',
  'AnisotropyBarnLamp.glb',
  'AnimationPointerUVs.glb',
  'SheenWoodLeatherSofa.glb',
  'CommercialRefrigerator.glb',
  'CarConcept.glb',
  'Production Draco Webp 01.glb',
  'Production Multi UV 01.glb',
  'Production Many Materials 01.glb',
]

const EXPECT_FAIL = new Set(['Truncated Broken 01.glb'])

// Наличие и размер — с сервера, один HEAD на модель, до объявления тестов.
// Top-level await: vitest собирает файл асинхронно, и к моменту описания `it`
// результат уже известен — отсутствующая модель становится честным it.skip с
// причиной в отчёте, а не тестом, который «прошёл», ничего не проверив.
const MODEL_PROBES = await Promise.all(
  MODEL_FILES.map(async (file) => {
    const url = '/' + encodeURIComponent(file)
    try {
      const res = await fetch(url, { method: 'HEAD' })
      const len = Number(res.headers.get('content-length'))
      return { file, url, present: res.ok, size: Number.isFinite(len) ? len : 0 }
    } catch (e) {
      return { file, url, present: false, size: 0 }
    }
  }),
)

// Одиночному тесту наличие модели сообщает та же HEAD-проба, что и
// параметризованному блоку внизу. Второго списка имён здесь нет намеренно —
// см. рассуждение над MODEL_FILES: два списка расходятся молча.
const modelPresent = (file) => MODEL_PROBES.some((p) => p.file === file && p.present)
const missingOf = (files) => files.filter((f) => !modelPresent(f))
const skipNote = (missing) => `[пропущено: нет локально — ${missing.join(', ')}]`

// Тест или блок, которым нужны конкретные модели. Нет хоть одной — честный
// skip с причиной в имени, а не падение.
//
// Падение здесь выглядит обманчиво (история 2026-08-09, 12 красных тестов на
// чистом клоне): сервер на отсутствующий файл отдаёт не пустоту, а страницу
// 404, three.js честно пытается разобрать её как GLB и умирает на
// «RangeError: Invalid typed array length: 4». По этому сообщению нипочём не
// догадаться, что дело всего лишь в некоммитимой модели.
//
// Условие вычисляется на этапе СБОРА файла: MODEL_PROBES заполнен top-level
// await выше, поэтому к моменту объявления it результат уже известен.
const itWithModels = (files, name, fn, timeout) => {
  const missing = missingOf(files)
  return missing.length
    ? it.skip(`${name} ${skipNote(missing)}`, () => {}, timeout)
    : it(name, fn, timeout)
}

// Когда на модели держится весь блок, включая beforeAll: пропускать по одному
// тесту бессмысленно — подготовка всё равно не отработает.
const describeWithModels = (files, name, fn) => {
  const missing = missingOf(files)
  return missing.length ? describe.skip(`${name} ${skipNote(missing)}`, fn) : describe(name, fn)
}

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
    // Позиция/цель — три числа
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
      position: { ...original.position },
      target: { ...original.target },
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

  // Снимок камеры уезжает в СОСЕДНИЙ вьюпорт. Пока движок один, форма этих данных ни
  // на что не влияет; со вторым движком она решает всё: `THREE.Vector3` в снимке
  // заставил бы реализацию на другом движке тянуть три.js ради трёх чисел, а
  // структурная подмена (передать {x,y,z} туда, где ждут Vector3) сломалась бы на
  // первом же вызове метода — ровно так этот тест и падал до правки контракта.
  // Разбор — ui/viewer/contract.ts, ROADMAP.md §5g.
  it('снимок камеры — простые числа, а не объекты движка', () => {
    const state = viewer.getCameraState()
    for (const key of ['position', 'target']) {
      const v = state[key]
      expect(Object.getPrototypeOf(v), `${key} несёт объект движка, а не данные`)
        .toBe(Object.prototype)
      expect(Object.keys(v).sort()).toEqual(['x', 'y', 'z'])
      // Снимок обязан пережить перенос через границу, где живых объектов не бывает.
      expect(() => structuredClone(v)).not.toThrow()
    }
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

  itWithModels(['chibi_zenitsu.glb'], 'loads an animated model and getAnimationInfo() returns clip info', async () => {
    await viewer.load(ANIM_MODEL_URL)
    const info = viewer.getAnimationInfo()
    expect(info.count).toBeGreaterThanOrEqual(1)
    expect(info.names.length).toBe(info.count)
    expect(info.index).toBe(0) // playClip(0) при загрузке
    expect(info.duration).toBeGreaterThan(0)
  })

  // Два теста ниже разбирают модель, загруженную предыдущим тестом. Без неё они
  // не падают, а проходят впустую (клипов нет — переключать нечего, время
  // двигать не на чем), поэтому их наличие модели касается наравне с ним.
  itWithModels(['chibi_zenitsu.glb'], 'playClip() switches to a different clip and getAnimationInfo().index matches', () => {
    const info = viewer.getAnimationInfo()
    if (info.count < 2) return // всего 1 клип — нечего переключать

    viewer.playClip(1)
    const after = viewer.getAnimationInfo()
    expect(after.index).toBe(1)

    // Возвращаем на первый
    viewer.playClip(0)
    expect(viewer.getAnimationInfo().index).toBe(0)
  })

  itWithModels(['chibi_zenitsu.glb'], 'setAnimationTime() advances animation without throwing', () => {
    viewer.setAnimationTime(0.5)
    // Не падает — достаточно
    expect(true).toBe(true)
  })

  itWithModels(['Cthulhu Stone 01.glb'], 'loads Cthulhu Stone (morph targets) — getAnimationInfo shows 1 clip named Scene', async () => {
    await viewer.load(CTHULHU_URL)
    const info = viewer.getAnimationInfo()
    expect(info.count).toBe(1)
    expect(info.names.length).toBe(1)
    // Название может быть чистым 'Scene' или с префиксом 'root|Scene'
    expect(info.names[0]).toMatch(/Scene/)
    expect(info.index).toBe(0)
    expect(info.duration).toBeGreaterThan(0)
  })

  itWithModels(['Cthulhu Stone 01.glb'], 'playClip(0) does not throw on single-clip Cthulhu', () => {
    expect(() => viewer.playClip(0)).not.toThrow()
    const info = viewer.getAnimationInfo()
    expect(info.count).toBe(1)
    expect(info.index).toBe(0)
  })

  itWithModels(['parkergirl.glb'], 'loads parkergirl (skinning) — getAnimationInfo shows 1 clip named MorphBake', async () => {
    await viewer.load(PARKERGIRL_URL)
    const info = viewer.getAnimationInfo()
    expect(info.count).toBe(1)
    expect(info.names.length).toBe(1)
    expect(info.names[0]).toMatch(/MorphBake/)
    expect(info.index).toBe(0)
    expect(info.duration).toBeGreaterThan(0)
  })

  itWithModels(['parkergirl.glb'], 'playClip(0) does not throw on single-clip parkergirl', () => {
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

  itWithModels(['chibi_zenitsu.glb'], 'loadOriginal() loads a model and getAnimation() returns leftIndex/rightIndex', async () => {
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

  // Продолжение предыдущего теста: работает с моделью, которую он загрузил.
  itWithModels(['chibi_zenitsu.glb'], 'selectAnimationClip() updates both leftIndex and rightIndex', () => {
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

  itWithModels(['Lilith Character 01.glb'], 'selectAnimationClip() persists non-zero index across reloads (same animated model)', async () => {
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
// Animation panel DOM — anim-controls visibility, clip list, single-clip hiding
// ---------------------------------------------------------------------------
//
// Проверяет поведение панели управления анимацией (#anim-controls).
// Панель должна:
//   - быть скрыта (class=hidden) для моделей без анимации
//   - быть видна для моделей с анимацией
//   - показывать список клипов (<select> с <option>) для моделей с ≥2 клипами
//   - скрывать селектор клипа (#anim-clip) если клип ровно один
//   - скрываться после reset() (модель снята)
//
// Логика управляется refreshAnimUI() (см. ui/app.js tail), которая вызывается
// из _notifyLoaded() через window.onOptiViewerModelLoaded.
// ---------------------------------------------------------------------------

describe('Animation panel (DOM) — anim-controls visibility and clip list', () => {
  let animControls
  let animClipSel

  beforeAll(async () => {
    await setupDualViewportDOM()
    resetAnimationClipIndex()

    // Создаём DOM панели анимации — те же ID и классы, что в index.html
    animControls = document.createElement('div')
    animControls.id = 'anim-controls'
    animControls.className = 'vp-anim hidden'
    animControls.style.display = '' // display управляется через class hidden

    animClipSel = document.createElement('select')
    animClipSel.id = 'anim-clip'
    animClipSel.className = 'vp-anim-clip'

    animControls.appendChild(animClipSel)

    // play-btn, seek, time — тоже создаём, но в тестах не проверяем
    const playBtn = document.createElement('button')
    playBtn.id = 'anim-play-btn'
    playBtn.className = 'vp-tool is-on'
    animControls.appendChild(playBtn)

    const seek = document.createElement('input')
    seek.id = 'anim-seek'
    seek.className = 'vp-slider'
    seek.type = 'range'
    animControls.appendChild(seek)

    const timeEl = document.createElement('span')
    timeEl.id = 'anim-time'
    timeEl.className = 'vp-ctl-value'
    timeEl.textContent = '0.0s'
    animControls.appendChild(timeEl)

    document.body.appendChild(animControls)

    // Регистрируем refreshAnimUI() — копия логики из app.js
    window.onOptiViewerModelLoaded = () => {
      if (!window.OptiViewer || !window.OptiViewer.getAnimation) return
      const info = window.OptiViewer.getAnimation()
      const has = info.count > 0
      animControls.classList.toggle('hidden', !has)
      if (!has) {
        animClipSel.innerHTML = ''
        return
      }

      // Пересобираем список, если модель сменилась
      const signature = info.names.join('\u0000')
      if (animClipSel.dataset.signature !== signature) {
        animClipSel.dataset.signature = signature
        animClipSel.innerHTML = ''
        info.names.forEach((name, i) => {
          const opt = document.createElement('option')
          opt.value = String(i)
          opt.textContent = name
          animClipSel.appendChild(opt)
        })
        // Один клип — выбирать не из чего
        animClipSel.classList.toggle('hidden', info.count < 2)
      }
      if (Number(animClipSel.value) !== info.index) {
        animClipSel.value = String(info.index)
      }
    }

    // Стартовое состояние: моделей нет — панели нет
    window.onOptiViewerModelLoaded()
  })

  afterAll(() => {
    animControls?.remove()
    teardownDualViewportDOM()
    delete window.onOptiViewerModelLoaded
  })

  it('starts hidden — no model loaded', () => {
    expect(animControls.classList.contains('hidden')).toBe(true)
    expect(animClipSel.children.length).toBe(0)
  })

  it('non-animated model (Dirty Cube) — panel stays hidden, clip list empty', async () => {
    const resp = await fetch(CUBE_URL)
    const file = new File([await resp.blob()], 'Dirty Cube 01.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file)

    // onOptiViewerModelLoaded вызывается _notifyLoaded() после загрузки
    expect(animControls.classList.contains('hidden')).toBe(true)
    expect(animClipSel.children.length).toBe(0)
  })

  itWithModels(['chibi_zenitsu.glb'], 'animated model with 1 clip (chibi_zenitsu) — panel visible, clip selector hidden', async () => {
    const resp = await fetch(ANIM_MODEL_URL)
    const file = new File([await resp.blob()], 'chibi_zenitsu.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file)

    expect(animControls.classList.contains('hidden')).toBe(false)
    expect(animClipSel.children.length).toBe(1)
    // Один клип → селектор скрыт
    expect(animClipSel.classList.contains('hidden')).toBe(true)
  })

  itWithModels(['Lilith Character 01.glb'], 'model with 3 clips (Lilith) — panel visible, clip selector has 3 options', async () => {
    const resp = await fetch(LILITH_URL)
    const file = new File([await resp.blob()], 'Lilith Character 01.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file)

    expect(animControls.classList.contains('hidden')).toBe(false)
    expect(animClipSel.children.length).toBe(3)
    // Три клипа → селектор виден
    expect(animClipSel.classList.contains('hidden')).toBe(false)

    // Имена клипов содержат ожидаемые подстроки
    const names = [...animClipSel.options].map((o) => o.textContent)
    expect(names.some((n) => n.includes('Idle'))).toBe(true)
    expect(names.some((n) => n.includes('Lilith_Walk_Loop'))).toBe(true)
    expect(names.some((n) => n.includes('0-T-Pose'))).toBe(true)
  })

  itWithModels(['Cthulhu Stone 01.glb'], 'single-clip model (Cthulhu Stone) — panel visible, clip selector hidden', async () => {
    const resp = await fetch(CTHULHU_URL)
    const file = new File([await resp.blob()], 'Cthulhu Stone 01.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file)

    expect(animControls.classList.contains('hidden')).toBe(false)
    expect(animClipSel.children.length).toBe(1)
    expect(animClipSel.classList.contains('hidden')).toBe(true)
    expect(animClipSel.options[0].textContent).toMatch(/Scene/)
  })

  it('after reset() — panel hides again', () => {
    window.OptiViewer.reset()
    // reset() вызывает _notifyLoaded(), который зовёт onOptiViewerModelLoaded
    expect(animControls.classList.contains('hidden')).toBe(true)
    expect(animClipSel.children.length).toBe(0)
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

// Весь блок держится на Lilith — включая beforeAll, который готовит DOM под
// уже загруженную модель. Пропускать по одному тесту тут нечего.
describeWithModels(['Lilith Character 01.glb'], 'DualViewport — both viewports loaded with Lilith (3 clips)', () => {
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

  it('camera state matches between left and right — all 6 fields', () => {
    // После loadOriginal() + loadOptimized() с одной и той же моделью состояния
    // камер обоих вьюпортов должны совпадать ПОЛНОСТЬЮ, включая near, far,
    // minDistance, maxDistance. Загрузка второй модели копирует камеру из левой
    // (см. DualViewport.loadOptimized — camera = left.getCameraState()).
    //
    // Раньше getCameraState() не передавал near/far, и правый вьюпорт оставался
    // со значениями из конструктора (0.01 / 1000), а левый получал вычисленные
    // по габариту — плоскости отсечения различались.
    const states = window.OptiViewer.cameraStates()
    expect(states.left).not.toBeNull()
    expect(states.right).not.toBeNull()
    if (!states.left || !states.right) return

    // position — Vector3, сравниваем покомпонентно
    expect(states.left.position.x).toBeCloseTo(states.right.position.x, 4)
    expect(states.left.position.y).toBeCloseTo(states.right.position.y, 4)
    expect(states.left.position.z).toBeCloseTo(states.right.position.z, 4)

    // target — Vector3
    expect(states.left.target.x).toBeCloseTo(states.right.target.x, 4)
    expect(states.left.target.y).toBeCloseTo(states.right.target.y, 4)
    expect(states.left.target.z).toBeCloseTo(states.right.target.z, 4)

    // near/far — скаляры, должны совпадать точно
    expect(states.left.near).toBe(states.right.near)
    expect(states.left.far).toBe(states.right.far)

    // minDistance/maxDistance — скаляры
    expect(states.left.minDistance).toBe(states.right.minDistance)
    expect(states.left.maxDistance).toBe(states.right.maxDistance)
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
// Модель, которой нет на диске (сторонние не коммитятся из-за лицензий), даёт
// it.skip с причиной в имени — см. MODEL_PROBES выше.
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

  // ВНИМАНИЕ: собственного таймаута у этих тестов больше нет — действует общий
  // testTimeout из vitest.config.mjs (120 с).
  //
  // Была лесенка «по размеру файла»: <100K → 5 с, <1MB → 10 с и так далее. Она
  // покраснела на `Dirty Cube 01` — 62 КБ, лимит 5 с. Модель тут ни при чём: она
  // идёт в блоке первой и платит за прогрев WebGL. В спокойном прогоне это 2.6 с
  // (сама же и возглавляла топ-5 медленных при 0.1 МБ), под нагрузкой — больше пяти.
  //
  // Вывод тот же, что записан в шапке vitest.config.mjs: таймаут — страховка от
  // зависания, а не утверждение о скорости. Цифра, выведенная из размера файла,
  // измеряет загрузку машины, а не тест. Замер как наблюдение остался — тайминги
  // печатаются в afterAll.
  //
  // Историческая лесенка (для справки, если кто-то захочет её вернуть):
  //   < 100K   → 5s  (крошечные модели)
  //   < 1MB    → 10s
  //   < 10MB   → 15s
  //   < 50MB   → 30s  (ABeautifulGame 41MB)
  //   >= 50MB  → 60s  (запас)

  for (const { file, url, present, size } of MODEL_PROBES) {
    const name = file.replace(/\.glb$/i, '')
    const expectFail = EXPECT_FAIL.has(file)

    // Модели нет на диске — тест пропускается ЯВНО, с причиной в имени. Раньше здесь
    // был перехват 404 внутри теста и `return`: тест числился пройденным, не проверив
    // ничего. На CI, где из 34 моделей лежат 10, это давало два десятка зелёных строк
    // ни о чём — и настоящий сбой сети выглядел точно так же.
    if (!present) {
      it.skip(`${name} — loads, has stats, detectSource valid [нет локально — пропущено]`, () => {})
      continue
    }

    it(`${name} — loads, has stats, detectSource valid`, async () => {
      const startTime = performance.now()
      let gltf

      try {
        gltf = await viewer.load(url)
      } catch (err) {
        // Намеренно битая модель — ошибка ожидаема
        if (expectFail) {
          timings.push({ name, time: performance.now() - startTime, size })
          return
        }
        throw err
      }

      // Намеренно битая загрузилась успешно — странно
      if (expectFail) {
        throw new Error(`${name} marked as expectFail but loaded successfully`)
      }

      timings.push({ name, time: performance.now() - startTime, size })

      // Порога «столько-то мегабайт за столько-то секунд» здесь СОЗНАТЕЛЬНО нет.
      // Время загрузки плавает вместе с загрузкой машины — тем же соображением
      // обоснован общий testTimeout в vitest.config.mjs. Тайминги печатаются в
      // afterAll: замер как наблюдение полезен, замер как приговор — источник
      // случайного красного.

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
    })
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
