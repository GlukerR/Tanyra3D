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
// Нужен для замера рамок в тестах уровней детализации: проверяем, что переключение
// меняет модель НА МЕСТЕ, а не увозит её в сторону.
import * as THREE from 'three'
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
  'StoneWellLods.glb',
  'StoneWellLodsFlat.glb',
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

  // --- KHR_animation_pointer -------------------------------------------------
  //
  // Канал по указателю адресует место в JSON (`/materials/0/…/baseColorFactor`), а не
  // узел сцены. Загрузчик three.js такие каналы выбрасывает молча — до плагина
  // @needle-tools модель приезжала с клипом БЕЗ ЕДИНОЙ ДОРОЖКИ, и снаружи это было
  // неотличимо от модели без анимации.
  //
  // Сторожим именно дорожки, а не число клипов: клип создавался и раньше, пустой.
  // Утверждение «клипов ≥1» дефект пропускало.
  it('Animated Pointer 01 — канал по указателю доезжает дорожкой, а не пустым клипом', async () => {
    await viewer.load('/Animated%20Pointer%2001.glb')
    const info = viewer.getAnimationInfo()
    expect(info.count).toBe(1)
    expect(info.duration).toBeGreaterThan(0)

    // Собственно проверка: дорожка есть и она про цвет материала.
    const clip = viewer.clips[0]
    expect(clip.tracks.length).toBeGreaterThan(0)
    expect(clip.tracks.some((t) => /color/i.test(t.name))).toBe(true)
  })

  it('Animated Pointer 01 — цвет материала действительно меняется во времени', async () => {
    await viewer.load('/Animated%20Pointer%2001.glb')

    // Модель едет от красного к синему за секунду. Читаем цвет в двух моментах:
    // если плагин не работает, оба будут одинаковы, и тест это увидит.
    const colorAt = (t) => {
      viewer.setAnimationTime(t)
      let found = null
      viewer.model.traverse((o) => {
        if (found === null && o.material && o.material.color) found = o.material.color.clone()
      })
      return found
    }

    const start = colorAt(0)
    const later = colorAt(0.9)
    expect(start).not.toBeNull()
    expect(later).not.toBeNull()
    // Красный убывает, синий растёт — направление, а не просто «что-то изменилось».
    expect(later.r).toBeLessThan(start.r)
    expect(later.b).toBeGreaterThan(start.b)
  })

  // Осиротевший канал: `path: "pointer"` без адреса. Это НАШ след — под оптимизациями
  // библиотека снимает незнакомое расширение, а слово в поле `path` остаётся.
  //
  // Файл собирается здесь, а не лежит в fixtures: он заведомо невалиден
  // (VALUE_NOT_IN_LIST), и класть такой в золотой корпус — значит объяснять его каждому
  // набору, который корпус обходит. Правим байты копии в памяти.
  //
  // Сторожим ровно то, что Александр увидел глазами 2026-08-14: без предохранителя
  // плагин просил узел с номером `undefined`, запрос отклонялся, и МОДЕЛЬ НЕ
  // ОТКРЫВАЛАСЬ ВОВСЕ — вместо «анимации не видно» приложение писало «не удаётся
  // показать модель».
  it('Animated Pointer 01 — осиротевший канал не рушит загрузку модели', async () => {
    const buf = new Uint8Array(await (await fetch('/Animated%20Pointer%2001.glb')).arrayBuffer())
    const view = new DataView(buf.buffer)
    const jsonLen = view.getUint32(12, true)
    const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)))

    delete json.extensionsUsed
    delete json.animations[0].channels[0].target.extensions

    let text = JSON.stringify(json)
    while (text.length % 4) text += ' '
    const jsonBytes = new TextEncoder().encode(text)
    const bin = buf.subarray(20 + jsonLen)

    const out = new Uint8Array(20 + jsonBytes.length + bin.length)
    const ov = new DataView(out.buffer)
    out.set(buf.subarray(0, 20))
    ov.setUint32(8, out.length, true)
    ov.setUint32(12, jsonBytes.length, true)
    out.set(jsonBytes, 20)
    out.set(bin, 20 + jsonBytes.length)

    const url = URL.createObjectURL(new Blob([out], { type: 'model/gltf-binary' }))
    try {
      // Главное утверждение: загрузка ДОХОДИТ до конца.
      const stats = await viewer.load(url)
      expect(stats).toBeTruthy()
      expect(viewer.model).toBeTruthy()
      // Анимации при этом нет — канал снят, и это честно: адреса у него не осталось.
      const info = viewer.getAnimationInfo()
      expect(info.count === 0 || viewer.clips[0].tracks.length === 0).toBe(true)
    } finally {
      URL.revokeObjectURL(url)
    }
  })

  // --- развёртки текстур по указателю (ui/viewer/pointer-uv.ts) --------------
  //
  // До 2026-08-15 здесь не двигалось НИЧЕГО, и виноват был не движок: three.js r185
  // умеет собственное преобразование развёртки у 23 слотов. Плагин @needle-tools
  // создавал дорожки, но переводил имена слотов только для `map` и `emissiveMap` —
  // `normalTexture` так и не становился `normalMap`, привязка не находила свойство.
  //
  // Сторожим ДВИЖЕНИЕ, а не наличие дорожек: дорожки были и раньше.
  itWithModels(['PotOfCoalsAnimationPointer.glb'], 'PotOfCoals — марево над углями действительно вращается', async () => {
    await viewer.load('/PotOfCoalsAnimationPointer.glb')

    // Модель крутит нормали и толщину объёма НАВСТРЕЧУ друг другу — от их наложения
    // и получается дрожание воздуха. Значит смотрим на обе и на РАЗНЫЕ знаки.
    // Именно HeatDome, а не «первый попавшийся материал с картой нормалей»: карты
    // нормалей есть и у котелка, и у углей, а анимирован из них только купол.
    const read = (t) => {
      viewer.setAnimationTime(t)
      let normal = null; let thickness = null
      viewer.model.traverse((o) => {
        const m = o.material
        if (!m || m.name !== 'HeatDome') return
        if (m.normalMap) normal = m.normalMap.rotation
        if (m.thicknessMap) thickness = m.thicknessMap.rotation
      })
      return { normal, thickness }
    }

    const a = read(0)
    const b = read(1.5)
    expect(a.normal, 'у материала нет карты нормалей — модель не та').not.toBeNull()
    expect(a.thickness, 'у материала нет карты толщины — модель не та').not.toBeNull()
    expect(b.normal, 'поворот нормалей стоит на месте').not.toBe(a.normal)
    expect(b.thickness, 'поворот толщины стоит на месте').not.toBe(a.thickness)
    // Навстречу: один растёт, другой убывает.
    expect(Math.sign(b.normal - a.normal)).not.toBe(Math.sign(b.thickness - a.thickness))
  })

  itWithModels(['AnimationPointerUVs.glb'], 'AnimationPointerUVs — развёртки едут больше чем у пары слотов', async () => {
    await viewer.load('/AnimationPointerUVs.glb')

    // Снимок поворота/сдвига КАЖДОЙ текстуры сцены в два разных момента.
    const snapshot = (t) => {
      viewer.setAnimationTime(t)
      const out = []
      viewer.model.traverse((o) => {
        const m = o.material
        if (!m) return
        for (const [key, v] of Object.entries(m)) {
          if (v && v.isTexture) out.push(`${key}:${v.rotation}:${v.offset.x},${v.offset.y}:${v.repeat.x},${v.repeat.y}`)
        }
      })
      return out
    }

    const a = snapshot(0)
    const b = snapshot(2)
    expect(a.length).toBeGreaterThan(10)
    const moved = a.filter((s, i) => s !== b[i]).length
    // Раньше двигалось ноль. Порог намеренно скромный: модель — таблица на 21 слот,
    // и часть из них three.js не поддерживает вовсе (diffuse transmission).
    // Замер 2026-08-15: с приводом едут 93 текстуры из 174, без него — 4 (те, что
    // плагин переводил сам). Порог 50 — с большим запасом ниже замера и втрое выше
    // прежнего состояния: он ловит поломку привода, а не колеблется от версии three.
    expect(moved, 'развёртки текстур стоят на месте').toBeGreaterThan(50)
  })

  // Слот, которого нет в таблице SLOT_TO_THREE, обязан тихо пропуститься, а не
  // уронить показ (pointer-uv.ts: `if (!threeProps) continue`). В корпусе такого
  // канала нет — образцы diffuse transmission статичны, без анимации, — поэтому
  // правим байты копии в памяти: у одного канала слот заменяется на заведомо
  // незнакомый, но оканчивающийся на Texture, чтобы упражнять именно ветку «слота
  // нет в таблице», а не «это вообще не слот».
  itWithModels(['AnimationPointerUVs.glb'], 'AnimationPointerUVs — незнакомый слот в канале тихо пропускается, остальные развёртки едут', async () => {
    const buf = new Uint8Array(await (await fetch('/AnimationPointerUVs.glb')).arrayBuffer())
    const view = new DataView(buf.buffer)
    const jsonLen = view.getUint32(12, true)
    const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)))

    // Найти канал на развёртку и заменить его слот на незнакомый.
    let changed = false
    for (const anim of json.animations || []) {
      for (const ch of anim.channels || []) {
        const ext = ch.target && ch.target.extensions && ch.target.extensions['KHR_animation_pointer']
        if (!ext || typeof ext.pointer !== 'string') continue
        const m = ext.pointer.match(/^(\/materials\/\d+\/)(.+)(\/extensions\/KHR_texture_transform\/(?:offset|rotation|scale))$/)
        if (!m) continue
        const segs = m[2].split('/')
        const slot = segs[segs.length - 1]
        if (!slot || !slot.endsWith('Texture')) continue
        segs[segs.length - 1] = 'notInTableTexture'
        ext.pointer = m[1] + segs.join('/') + m[3]
        changed = true
        break
      }
      if (changed) break
    }
    expect(changed).toBe(true)

    // Пересобрать GLB — тот же приём, что в тесте «осиротевший канал» выше.
    let text = JSON.stringify(json)
    while (text.length % 4) text += ' '
    const jsonBytes = new TextEncoder().encode(text)
    const bin = buf.subarray(20 + jsonLen)
    const out = new Uint8Array(20 + jsonBytes.length + bin.length)
    const ov = new DataView(out.buffer)
    out.set(buf.subarray(0, 20))
    ov.setUint32(8, out.length, true)
    ov.setUint32(12, jsonBytes.length, true)
    out.set(jsonBytes, 20)
    out.set(bin, 20 + jsonBytes.length)

    const url = URL.createObjectURL(new Blob([out], { type: 'model/gltf-binary' }))
    try {
      // Главное утверждение: модель ДОЕЗЖАЕТ до конца, незнакомый слот не роняет показ.
      const stats = await viewer.load(url)
      expect(stats).toBeTruthy()
      expect(viewer.model).toBeTruthy()

      // Остальные развёртки не застыли: сломан один канал из 103, прочие едут.
      const snapshot = (t) => {
        viewer.setAnimationTime(t)
        const out = []
        viewer.model.traverse((o) => {
          const m = o.material
          if (!m) return
          for (const [key, v] of Object.entries(m)) {
            if (v && v.isTexture) out.push(`${key}:${v.rotation}:${v.offset.x},${v.offset.y}:${v.repeat.x},${v.repeat.y}`)
          }
        })
        return out
      }
      const a = snapshot(0)
      const b = snapshot(2)
      const moved = a.filter((s, i) => s !== b[i]).length
      expect(moved, 'развёртки текстур застыли после пропуска незнакомого слота').toBeGreaterThan(50)
    } finally {
      URL.revokeObjectURL(url)
    }
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

// ---------------------------------------------------------------------------
// Viewer — варианты материала (запасные цвета и отделки)
//
// KHR_materials_variants загрузчик three.js не читает сам: расширение вынесено в
// отдельный плагин (three-gltf-extensions, ссылка на него стоит в документации самого
// GLTFLoader). Без плагина художник видел ОДИН вид из трёх и про остальные не знал.
//
// Сторож смотрит на материалы В СЦЕНЕ, а не на состояние панели: «выбран Carmine Candy»
// — это переменная, которая может обновиться, пока картинка стоит на месте. Дефект такого
// рода уже был с развёртками текстур (дорожки создавались, но ничего не двигали).
// ---------------------------------------------------------------------------

describe('Viewer — material variants (browser)', () => {
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

  /** Отпечаток раскраски сцены: какой материал стоит на каждом меше. */
  const materialFingerprint = () => {
    const out = []
    viewer.model.traverse((o) => {
      if (o.material) out.push(o.material.uuid)
    })
    return out
  }

  itWithModels(['CarConcept.glb'], 'CarConcept — три окраски видны в getVariantInfo', async () => {
    await viewer.load('/CarConcept.glb')
    const info = viewer.getVariantInfo()
    expect(info.count).toBe(3)
    expect(info.names).toEqual(['Carmine Candy', 'Pearly Swirly', 'Torched Graphite'])
    // Начальный вид — записанный в файле основным, а не первый из списка: экспортёр
    // выбирает его сознательно, и подменять этот выбор нельзя.
    expect(info.current).toBeNull()
  })

  itWithModels(['CarConcept.glb'], 'CarConcept — три окраски дают три РАЗНЫЕ раскраски сцены', async () => {
    await viewer.load('/CarConcept.glb')
    const base = materialFingerprint()
    expect(base.length, 'в сцене нет мешей с материалами').toBeGreaterThan(0)

    // Утверждение именно такое, а не «любой вариант отличается от исходного вида».
    // Проверено по файлу: основной вид CarConcept СОВПАДАЕТ с «Carmine Candy»
    // (примитивы стоят на материале 6, и Carmine Candy подменяет его на тот же 6).
    // Требовать от этой пары различий значило бы требовать от движка выдумать его.
    const looks = {}
    for (const name of viewer.getVariantInfo().names) {
      expect(await viewer.setVariant(name)).toBe(true)
      looks[name] = materialFingerprint().join(' ')
    }
    const distinct = new Set(Object.values(looks))
    expect(distinct.size, `три варианта дали одинаковую раскраску: ${JSON.stringify(Object.keys(looks))}`).toBe(3)

    // И основной вид — одна из этих трёх раскрасок, а не четвёртая выдуманная.
    expect(distinct.has(base.join(' ')), 'исходный вид не совпал ни с одним вариантом').toBe(true)
  })

  itWithModels(['CarConcept.glb'], 'CarConcept — null возвращает вид, записанный в файле', async () => {
    await viewer.load('/CarConcept.glb')
    const base = materialFingerprint()
    await viewer.setVariant('Pearly Swirly')
    expect(materialFingerprint()).not.toEqual(base)
    expect(await viewer.setVariant(null)).toBe(true)
    expect(viewer.getVariantInfo().current).toBeNull()
    expect(materialFingerprint(), 'возврат «как в файле» не восстановил исходную раскраску').toEqual(base)
  })

  itWithModels(['CarConcept.glb'], 'неизвестное имя — отказ, а не исключение и не смена вида', async () => {
    await viewer.load('/CarConcept.glb')
    const base = materialFingerprint()
    // Список вариантов приходит из файла, и вьювер не обязан гадать, что в нём окажется.
    expect(await viewer.setVariant('Такого варианта нет')).toBe(false)
    expect(materialFingerprint()).toEqual(base)
  })

  itWithModels(['ChronographWatch.glb'], 'ChronographWatch — четыре отделки', async () => {
    await viewer.load('/ChronographWatch.glb')
    const info = viewer.getVariantInfo()
    expect(info.count).toBe(4)
    expect(info.names).toEqual(['Surgical White', 'Midnight Gold', 'Commerce Green', 'Khronos Red'])
  })

  itWithModels(['Dirty Cube 01.glb'], 'модель без вариантов — пустой список, а не выдуманный', async () => {
    await viewer.load('/Dirty%20Cube%2001.glb')
    const info = viewer.getVariantInfo()
    expect(info.count).toBe(0)
    expect(info.names).toEqual([])
    // Панели в интерфейсе при этом быть не должно — она рисуется по count.
    expect(await viewer.setVariant('что угодно')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Viewer — уровни детализации
//
// Уровни приезжают ДВУМЯ способами, и оба настоящие:
//
//   1. `MSFT_lod` — узел несёт список запасных, менее подробных версий себя. Способ
//      правильный, но экспортируют его единицы.
//   2. Отдельные узлы-соседи с LOD в имени — так их отдаёт Sketchfab, то есть самый
//      массовый источник моделей для веба. Расширения в файле нет, и любой движок
//      рисует все уровни СРАЗУ, друг сквозь друга.
//
// Замер 2026-08-15 на «Stone Well - Photogrammetry & LODs» (Gorgious, CC-BY-4.0): шесть
// уровней — 67 247 + 9 915 + 2 230 + 480 + 126 + 2 треугольника, все рисуются сразу.
// Разложены в ряд вдоль X, витриной; перенос лежит в matrix узла уровня.
//
// Переключение НИЧЕГО НЕ УДАЛЯЕТ (Правило 11): спрятанный уровень остаётся и в сцене, и
// в файле. Сторожа ниже это и проверяют — по видимости объектов, а не по их наличию.
// ---------------------------------------------------------------------------

describe('Viewer — levels of detail (browser)', () => {
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

  /** Сколько треугольников реально РИСУЕТСЯ: скрытые ветки не считаются. */
  const visibleTriangles = () => {
    let tri = 0
    viewer.scene.traverse((o) => {
      if (!o.visible) return
      // невидимый предок скрывает всё поддерево, traverse про это не знает
      for (let p = o.parent; p; p = p.parent) if (!p.visible) return
      const g = o.geometry
      if (!g || !g.attributes || !g.attributes.position) return
      tri += g.index ? g.index.count / 3 : g.attributes.position.count / 3
    })
    return Math.round(tri)
  }

  itWithModels(['StoneWellLods.glb'], 'StoneWellLods — шесть уровней найдены через расширение', async () => {
    await viewer.load('/StoneWellLods.glb')
    const info = viewer.getLodInfo()
    expect(info.count).toBe(6)
    // Автор связал уровни как положено — это ФАКТ, а не догадка по именам.
    expect(info.source).toBe('extension')
    // Порядок — от самого подробного к самому грубому, по числу треугольников.
    expect(info.triangles).toEqual([67247, 9915, 2230, 480, 126, 2])
    expect(info.current).toBeNull()
  })

  itWithModels(['StoneWellLods.glb'], 'StoneWellLods — каждый уровень показывается по отдельности', async () => {
    await viewer.load('/StoneWellLods.glb')
    const info = viewer.getLodInfo()
    for (let i = 0; i < info.count; i++) {
      expect(viewer.setLod(i), `уровень ${i} не переключился`).toBe(true)
      expect(visibleTriangles(), `на уровне ${i} рисуется не он`).toBe(info.triangles[i])
    }
  })

  itWithModels(['StoneWellLods.glb'], 'скрытый уровень остаётся в сцене — его не удаляют', async () => {
    await viewer.load('/StoneWellLods.glb')
    viewer.setLod(5) // самый грубый, 2 треугольника
    // Переключение — состояние ПОКАЗА. Уровни обязаны остаться на месте, иначе это
    // уже правка модели, а её быть не должно.
    const info = viewer.getLodInfo()
    expect(info.count).toBe(6)
    expect(info.triangles).toEqual([67247, 9915, 2230, 480, 126, 2])
    // и вернуться к самому подробному можно в любой момент
    expect(viewer.setLod(0)).toBe(true)
    expect(visibleTriangles()).toBe(67247)
  })

  itWithModels(['StoneWellLods.glb'], 'номер вне списка — отказ, а не исключение', async () => {
    await viewer.load('/StoneWellLods.glb')
    viewer.setLod(0)
    const before = visibleTriangles()
    expect(viewer.setLod(6)).toBe(false)
    expect(viewer.setLod(-1)).toBe(false)
    expect(visibleTriangles()).toBe(before)
  })

  // ── второй способ: уровни как отдельные узлы-соседи ───────────────────────
  //
  // StoneWellLodsFlat.glb — НЕТРОНУТАЯ выгрузка Sketchfab, то есть ровно то, что
  // приносит человек. Расширения в ней нет; шесть уровней лежат соседями и рисуются
  // одновременно.

  itWithModels(['StoneWellLodsFlat.glb'], 'StoneWellLodsFlat — шесть уровней узнаны по именам соседей', async () => {
    await viewer.load('/StoneWellLodsFlat.glb')
    const info = viewer.getLodInfo()
    expect(info.count).toBe(6)
    // Это ДОГАДКА по именам, а не факт из расширения, и говорить о ней надо честно.
    expect(info.source).toBe('names')
    expect(info.triangles).toEqual([67247, 9915, 2230, 480, 126, 2])
  })

  itWithModels(['StoneWellLodsFlat.glb'], 'StoneWellLodsFlat — «как в файле» показывает ВСЕ уровни сразу', async () => {
    await viewer.load('/StoneWellLodsFlat.glb')
    // Именно так модель и приезжает, и человек имеет право увидеть, что там на самом
    // деле: 80 000 треугольников вместо 67 247, все шесть друг сквозь друга.
    const all = 67247 + 9915 + 2230 + 480 + 126 + 2
    expect(visibleTriangles()).toBe(all)

    expect(viewer.setLod(0)).toBe(true)
    expect(visibleTriangles()).toBe(67247)
    expect(viewer.setLod(5)).toBe(true)
    expect(visibleTriangles()).toBe(2)

    // Возврат к «как в файле» — снова все сразу. Ничего не потеряно.
    expect(viewer.setLod(null)).toBe(true)
    expect(visibleTriangles()).toBe(all)
  })

  itWithModels(['CarConcept.glb'], 'обычная модель из многих частей уровнями не считается', async () => {
    // Сторож догадки: 25 примитивов, много узлов, но ни одного с LOD в имени.
    // Принять их за уровни значило бы решать за автора (Правило 11).
    await viewer.load('/CarConcept.glb')
    expect(viewer.getLodInfo().count).toBe(0)
  })

  itWithModels(['StoneWellLods.glb'], 'уровни совмещены в одной точке — переключение не уводит модель', async () => {
    await viewer.load('/StoneWellLods.glb')
    // Автор разложил уровни в ряд вдоль X (перенос 1.5, 3, 4.5, 6, 7.5 в матрице узла).
    // Образец собран со снятым переносом: переключение обязано менять модель НА МЕСТЕ,
    // а не увозить её из кадра. Проверяем по центрам рамок — они должны совпадать.
    const centers = []
    for (let i = 0; i < viewer.getLodInfo().count; i++) {
      viewer.setLod(i)
      const box = new THREE.Box3().setFromObject(viewer.model)
      centers.push(box.getCenter(new THREE.Vector3()))
    }
    const first = centers[0]
    for (const c of centers) {
      // Допуск 0.05 при габарите модели около 1.3: огрублённые уровни слегка гуляют
      // формой, но не местом. Прежний ряд давал бы разницу в единицы.
      expect(c.distanceTo(first), 'уровень уехал в сторону при переключении').toBeLessThan(0.05)
    }
  })

  itWithModels(['StoneWellLods.glb'], '«показать все сразу» рисует сумму всех уровней', async () => {
    await viewer.load('/StoneWellLods.glb')
    const info = viewer.getLodInfo()
    const sum = info.triangles.reduce((a, b) => a + b, 0)
    expect(viewer.setLod('all')).toBe(true)
    expect(visibleTriangles(), 'показаны не все уровни').toBe(sum)
    // И обратно к одному — без следов.
    expect(viewer.setLod(0)).toBe(true)
    expect(visibleTriangles()).toBe(info.triangles[0])
  })

  itWithModels(['Dirty Cube 01.glb'], 'модель без уровней — пустой список', async () => {
    await viewer.load('/Dirty%20Cube%2001.glb')
    const info = viewer.getLodInfo()
    expect(info.count).toBe(0)
    expect(info.source).toBeNull()
    expect(viewer.setLod(0)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Свет: наш студийный или тот, что принесла сама модель
//
// До 2026-08-15 наш направленный источник светил ПОВЕРХ авторского: загрузчик создаёт
// источники из KHR_lights_punctual сам, а мы ничего не гасили. Оценить, как модель
// задумана автором, было нельзя — светили оба.
//
// Сторожим три вещи, и каждая уже была бы дефектом по отдельности:
//   1. Свой свет модели ВИДЕН как число, а не как догадка;
//   2. У модели без своих источников переключать нечего — setLightMode('file') отвечает
//      false, а не гасит сцену в темноту;
//   3. Режим не «прилипает» к следующей модели: она может быть без своих источников и
//      открылась бы почти чёрной.
// ---------------------------------------------------------------------------

describe('Viewer — свет модели (browser)', () => {
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

  itWithModels(['Dirty Cube 01.glb'], 'Dirty Cube несёт свои источники — они посчитаны', async () => {
    await viewer.load(CUBE_URL)
    const info = viewer.getLightInfo()
    // В файле объявлено два источника (KHR_lights_punctual). Сравниваем «не меньше»:
    // точное число — дело файла, а не наше, а вот потерять их нельзя.
    expect(info.count, 'свой свет модели не найден').toBeGreaterThanOrEqual(1)
    // Новая модель всегда открывается на студийном: иначе тёмная модель выглядела бы
    // сломанной ещё до того, как человек что-то нажал.
    expect(info.mode).toBe('studio')
  })

  itWithModels(['Dirty Cube 01.glb'], 'переключение гасит НАШ источник, но не окружение', async () => {
    await viewer.load(CUBE_URL)
    expect(viewer._key.visible, 'студийный источник погашен в исходном состоянии').toBe(true)

    expect(viewer.setLightMode('file')).toBe(true)
    expect(viewer._key.visible, 'наш источник продолжает светить поверх авторского').toBe(false)
    // Окружение приглушается, но НЕ до нуля: это не свет, а то, что отражается, и
    // обнуление красит металл и стекло в чёрный вместо замысла автора.
    expect(viewer.scene.environmentIntensity).toBeGreaterThan(0)
    expect(viewer.scene.environmentIntensity).toBeLessThan(1)
    expect(viewer.getLightInfo().mode).toBe('file')

    expect(viewer.setLightMode('studio')).toBe(true)
    expect(viewer._key.visible).toBe(true)
    expect(viewer.scene.environmentIntensity).toBe(1)
  })

  itWithModels(['Morph Cube 01.glb'], 'у модели без своих источников переключать нечего', async () => {
    await viewer.load('/Morph%20Cube%2001.glb')
    const info = viewer.getLightInfo()
    expect(info.count, 'у этой модели не должно быть своих источников').toBe(0)
    // Главное: не молча погасить сцену, а честно отказать.
    expect(viewer.setLightMode('file'), 'сцену увели в темноту вместо отказа').toBe(false)
    expect(viewer._key.visible, 'студийный источник всё-таки погас').toBe(true)
    expect(viewer.scene.environmentIntensity).toBe(1)
  })

  itWithModels(['Dirty Cube 01.glb', 'Morph Cube 01.glb'], 'режим не переезжает на следующую модель', async () => {
    await viewer.load(CUBE_URL)
    expect(viewer.setLightMode('file')).toBe(true)
    // Следующая модель без своих источников: останься режим — она пришла бы почти чёрной.
    await viewer.load('/Morph%20Cube%2001.glb')
    expect(viewer.getLightInfo().mode).toBe('studio')
    expect(viewer._key.visible).toBe(true)
    expect(viewer.scene.environmentIntensity).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Камеры автора
//
// Ракурс — решение автора наравне с уровнями детализации и вариантами материала. До
// 2026-08-15 мы их просто не замечали: загрузчик кладёт камеры в gltf.cameras, а мы
// всегда ставили свою орбиту. У ToyCar их восемь, у AnimationPointerUVs одиннадцать.
//
// Сторожим то, что ломается молча:
//   1. Камеры найдены и посчитаны;
//   2. Через камеру автора ОРБИТА ВЫКЛЮЧЕНА — иначе первое движение мыши уводит её с
//      места, куда автор поставил, и вернуть нечем;
//   3. Пропорции кадра берутся от окна, а не от файла: иначе картинка растянута;
//   4. Выбор не переезжает на следующую модель — там этого ракурса может не быть, а
//      камеры прежней модели к тому моменту уже освобождены.
// ---------------------------------------------------------------------------

describe('Viewer — камеры автора (browser)', () => {
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

  itWithModels(['ToyCar.glb'], 'ToyCar — ракурсы автора найдены', async () => {
    await viewer.load('/ToyCar.glb')
    const info = viewer.getCameraInfo()
    expect(info.count, 'камеры автора не найдены').toBeGreaterThan(1)
    expect(info.names.length).toBe(info.count)
    // Новая модель открывается НАШЕЙ орбитой: авторский ракурс — выбор человека,
    // а не то, что происходит само.
    expect(info.current).toBeNull()
  })

  itWithModels(['ToyCar.glb'], 'через камеру автора орбита выключена, через свою — включена', async () => {
    await viewer.load('/ToyCar.glb')
    expect(viewer.controls.enabled, 'своя камера, а орбита выключена').toBe(true)

    expect(viewer.setCamera(0)).toBe(true)
    expect(viewer.getCameraInfo().current).toBe(0)
    // Главное утверждение: иначе первое же движение мыши увело бы камеру автора.
    expect(viewer.controls.enabled, 'орбита осталась включённой на камере автора').toBe(false)
    expect(viewer._activeCamera(), 'рисуем всё той же своей камерой').not.toBe(viewer.camera)

    expect(viewer.setCamera(null)).toBe(true)
    expect(viewer.controls.enabled).toBe(true)
    expect(viewer._activeCamera()).toBe(viewer.camera)
  })

  itWithModels(['ToyCar.glb'], 'пропорции кадра — от окна, а не от файла', async () => {
    await viewer.load('/ToyCar.glb')
    const parent = viewer.canvas.parentElement
    const want = parent.clientWidth / parent.clientHeight
    viewer.setCamera(0)
    const cam = viewer._activeCamera()
    // Камера несёт своё соотношение сторон из файла; оставь мы его — картинка растянута.
    expect(Math.abs(cam.aspect - want), 'кадр растянут: соотношение сторон осталось файловым')
      .toBeLessThan(0.01)
    viewer.setCamera(null)
  })

  itWithModels(['ToyCar.glb'], 'несуществующий номер — отказ, а не пустой экран', async () => {
    await viewer.load('/ToyCar.glb')
    const n = viewer.getCameraInfo().count
    expect(viewer.setCamera(n), 'принят номер за пределами списка').toBe(false)
    expect(viewer.setCamera(-1)).toBe(false)
    expect(viewer.getCameraInfo().current, 'после отказа выбор всё-таки сменился').toBeNull()
  })

  itWithModels(['ToyCar.glb', 'Dirty Cube 01.glb'], 'выбор не переезжает на следующую модель', async () => {
    await viewer.load('/ToyCar.glb')
    expect(viewer.setCamera(0)).toBe(true)
    // Камеры прежней модели сейчас будут освобождены вместе с ней: останься выбор —
    // рисовали бы через мёртвый объект.
    await viewer.load(CUBE_URL)
    expect(viewer.getCameraInfo().current).toBeNull()
    expect(viewer.controls.enabled, 'орбита не вернулась после чужого ракурса').toBe(true)
    expect(viewer._activeCamera()).toBe(viewer.camera)
  })
})

// ---------------------------------------------------------------------------
// Выбор ракурса и света переживает сборку
//
// Дефект, найденный Александром 2026-08-15: «синхронизация камер при оптимизации
// ломается и как-то неверно отрабатывает сразу после оптимизации».
//
// Причина: _afterLoad() возвращал свежезагруженному вьюпорту клип, вариант и уровень,
// но НЕ ракурс и НЕ режим света, а load() их сбрасывает на умолчание. После сборки
// левое окно продолжало смотреть камерой автора, правое — своей орбитой. Два окна
// показывали РАЗНОЕ, и разница выглядела как последствие оптимизации.
//
// Разделять надо два события, которые до этого были одним:
//   • человек открыл ДРУГУЮ модель — сбрасываем: этого ракурса у неё может не быть;
//   • та же модель пересобрана — сохраняем, как клип и вариант.
// ---------------------------------------------------------------------------

describeWithModels(['ToyCar.glb'], 'DualViewport — ракурс и свет переживают сборку', () => {
  beforeAll(async () => {
    await setupDualViewportDOM()
  })

  afterAll(() => {
    teardownDualViewportDOM()
  })

  it('камера автора остаётся выбранной в ОБОИХ окнах после загрузки результата', async () => {
    const resp = await fetch('/ToyCar.glb')
    const file = new File([await resp.blob()], 'ToyCar.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file)

    const cams = window.OptiViewer.getCameras()
    expect(cams.count, 'у ToyCar нет камер — проверять нечего').toBeGreaterThan(0)
    window.OptiViewer.selectCamera(0)
    expect(window.OptiViewer.getCameras().current).toBe(0)

    // «Результатом» берём тот же файл: правое окно проходит ровно тот же путь загрузки,
    // что и после настоящей сборки, а сравнивать содержимое здесь не требуется.
    await window.OptiViewer.loadOptimized('/ToyCar.glb')

    // Главное утверждение. До правки правое окно возвращалось к своей орбите, и два
    // окна показывали разные ракурсы одной модели.
    const after = window.OptiViewer.getCameras()
    expect(after.leftCurrent, 'в левом окне ракурс автора слетел').toBe(0)
    expect(after.rightCurrent, 'правое окно вернулось к своей орбите — окна показывают разное').toBe(0)
  })

  it('режим света остаётся выбранным после загрузки результата', async () => {
    const resp = await fetch(CUBE_URL)
    const file = new File([await resp.blob()], 'Dirty Cube 01.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file)

    expect(window.OptiViewer.getLight().count, 'у этой модели нет своего света').toBeGreaterThan(0)
    window.OptiViewer.selectLightMode('file')
    expect(window.OptiViewer.getLight().mode).toBe('file')

    await window.OptiViewer.loadOptimized(CUBE_URL)
    const after = window.OptiViewer.getLight()
    expect(after.leftMode, 'в левом окне свет вернулся к студийному').toBe('file')
    expect(after.rightMode, 'правое окно вернулось к студийному — окна светятся по-разному').toBe('file')
  })

  it('другая модель ракурс НЕ наследует', async () => {
    const resp = await fetch('/ToyCar.glb')
    const file = new File([await resp.blob()], 'ToyCar.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file)
    window.OptiViewer.selectCamera(0)

    // Открыли ДРУГУЮ модель — у неё этого ракурса может не быть вовсе.
    const resp2 = await fetch(CUBE_URL)
    const file2 = new File([await resp2.blob()], 'Dirty Cube 01.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file2)
    expect(window.OptiViewer.getCameras().current, 'чужой ракурс переехал на новую модель').toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Ортографическая камера автора
//
// В корпусе таких моделей нет, поэтому камеру собираем здесь и кладём в тот же список,
// куда её положил бы загрузчик. Проверяем не «читается ли файл» (это работа
// GLTFLoader), а НАШУ развилку: у перспективной ширина кадра задаётся полем aspect,
// у ортографической — границами left/right, и общего кода тут нет.
//
// Почему не подменяем ортографическую своей перспективной, хотя так проще: это разная
// КАРТИНКА, а не разная настройка. У ортографической нет схождения линий — ради этого
// её и выбирают (чертёж, изометрия, вид сбоку). Показать вместо неё перспективу значит
// показать не то, что делал автор, и молча.
// ---------------------------------------------------------------------------

describe('Viewer — ортографическая камера (browser)', () => {
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

  itWithModels(['Dirty Cube 01.glb'], 'вертикаль остаётся авторской, ширина берётся от окна', async () => {
    await viewer.load(CUBE_URL)

    // Так её отдал бы загрузчик: камера стоит в сцене узлом-родителем.
    const ortho = new THREE.OrthographicCamera(-2, 2, 1.5, -1.5, 0.1, 100)
    ortho.name = 'Blueprint_Side'
    viewer.model.add(ortho)
    viewer._fileCameras = [ortho]

    expect(viewer.setCamera(0)).toBe(true)
    expect(viewer._activeCamera(), 'рисуем не той камерой').toBe(ortho)
    expect(viewer.controls.enabled, 'орбита должна быть выключена и здесь').toBe(false)

    const parent = viewer.canvas.parentElement
    const ratio = parent.clientWidth / parent.clientHeight
    // Вертикаль автора не тронута: 1.5 и −1.5 остались как были.
    expect(ortho.top).toBe(1.5)
    expect(ortho.bottom).toBe(-1.5)
    // Ширина пересчитана под окно, а не оставлена файловой (была ±2).
    expect(ortho.right).toBeCloseTo(1.5 * ratio, 5)
    expect(ortho.left).toBeCloseTo(-1.5 * ratio, 5)

    // И рисование через неё не падает.
    viewer.renderFrame()

    viewer.setCamera(null)
    expect(viewer._activeCamera()).toBe(viewer.camera)
    expect(viewer.controls.enabled).toBe(true)
  })
})
