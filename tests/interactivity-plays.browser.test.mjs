// tests/interactivity-plays.browser.test.mjs — интерактив ПРОИГРЫВАЕТСЯ.
//
// ЗАКАЗ (Александр, 2026-08-28): «да, теперь видно интерактивные элементы. Но нажать я на
// них всё так же не могу». Из трёх предложенных границ выбрана самая широкая — все пять
// моделей набора Khronos.
//
// УСЛОВИЕ, НА КОТОРОМ РАБОТА БРАЛАСЬ, и раздел 1 сторожит именно его: встретили узел или
// адрес, которых не знаем, — гасим интерактив ЦЕЛИКОМ. Половинчатое проигрывание хуже
// отсутствия: на одной модели работает, на другой половина, и человек не понимает,
// сломана его модель или сломаны мы. Поэтому «играем» — это утверждение обо ВСЁМ графе,
// а не о том, что хоть что-то шевельнулось.
//
// ПОЧЕМУ ПРОВЕРЯЕМ РАЗНОЕ У РАЗНЫХ МОДЕЛЕЙ. Они и делают разное, и в этом смысл набора:
// светофор красит материалы, калькулятор двигает развёртку и гасит узлы, шар меняет
// видимость. Одна общая проверка «что-то изменилось» пропустила бы подмену одного
// действия другим.
//
// ГРАНИЦА (Правило 11). Всё это живёт в СЦЕНЕ ПРОСМОТРА: сдвинутый узел и перекрашенный
// материал в файл не попадают. Раздел 4 сторожит вторую половину того же — отложенный
// шаг не должен пережить модель и подвинуть чужие узлы.
//
// Моделей в git нет и не будет (Правило 0) — без них проверки пропускаются.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createViewer, disposeViewer } from '../tests/helpers/viewer-test-utils.mjs'

const MODELS = ['TrafficLight.glb', 'Calculator.glb', 'WhackAMole.glb', 'MagicBall.glb', 'ConstructionSite.glb']
const PLAIN = 'Dirty Cube 01.glb'

const present = new Map(await Promise.all([...MODELS, PLAIN].map(async (file) => {
  try {
    const res = await fetch('/' + encodeURIComponent(file), { method: 'HEAD' })
    return [file, res.ok]
  } catch {
    return [file, false]
  }
})))

const itWithModels = (files, name, fn, timeout) => {
  const missing = files.filter((f) => !present.get(f))
  return missing.length
    ? it.skip(`${name} [пропущено: нет локально — ${missing.join(', ')}]`, () => {}, timeout)
    : it(name, fn, timeout)
}

let viewer
let canvas

beforeAll(async () => {
  const made = await createViewer()
  viewer = made.viewer
  canvas = made.canvas
})

afterAll(() => disposeViewer(viewer, canvas))

/** Цвета всех материалов сцены — по ним видно работу `pointer/set`. */
const colours = () => {
  const out = []
  viewer.model.traverse((o) => {
    if (o.isMesh && o.material?.color) out.push(o.material.color.getHexString())
  })
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Берёмся ЦЕЛИКОМ или не берёмся вовсе
// ═══════════════════════════════════════════════════════════════════════════

describe('1. граф понят целиком', () => {
  for (const model of MODELS) {
    itWithModels([model], `${model} — ни одного незнакомого узла или адреса`, async () => {
      await viewer.load('/' + model)
      const info = viewer.getBehaviourInfo()
      expect(info.refusal, `в графе есть то, чего мы не знаем:\n  ${info.refusal.join('\n  ')}`).toEqual([])
      expect(info.playable, 'граф разобран, но не проигрывается').toBe(true)
    }, 120000)
  }

  itWithModels([PLAIN], 'модель без графа не «проигрывается» — играть нечего', async () => {
    await viewer.load('/' + encodeURIComponent(PLAIN))
    expect(viewer.getBehaviourInfo().playable).toBe(false)
  }, 120000)
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Нажатие делает ровно то, что задумал автор
// ═══════════════════════════════════════════════════════════════════════════

describe('2. нажатие срабатывает', () => {
  itWithModels(['TrafficLight.glb'], 'светофор: нажатие красит материал', async () => {
    await viewer.load('/TrafficLight.glb')
    const было = colours()
    const откликнулся = viewer._behaviour.select(viewer._interactive[0].nodeIndex)
    expect(откликнулся, 'граф не отозвался на нажатие').toBe(true)
    const стало = colours()
    expect(стало.filter((c, i) => c !== было[i]).length, 'ни один материал не изменился')
      .toBeGreaterThan(0)
  }, 120000)

  itWithModels(['MagicBall.glb'], 'шар: нажатие меняет ВИДИМОСТЬ узлов', async () => {
    // У шара нажимаемая часть одна, а прячет и показывает он ДРУГИЕ узлы: нажали на шар
    // (узел 7) — спрятался узел 0 и показался узел 25. Проверять видимость самой нажатой
    // части было бы неправильно: первая редакция теста так и сделала и покраснела по делу.
    await viewer.load('/MagicBall.glb')
    const было = new Map()
    viewer.model.traverse((o) => было.set(o, o.visible))

    viewer._behaviour.select(viewer._interactive[0].nodeIndex)

    const сменили = [...было].filter(([o, v]) => o.visible !== v)
    expect(сменили.length, 'ни один узел не сменил видимость — pointer/set по видимости не сработал')
      .toBeGreaterThan(0)
  }, 120000)

  itWithModels(['Calculator.glb'], 'калькулятор: нажатие двигает развёртку', async () => {
    // Цифры на экране рисуются сдвигом текстуры, а не сменой материала.
    await viewer.load('/Calculator.glb')
    const карты = []
    viewer.model.traverse((o) => { if (o.isMesh && o.material?.map) карты.push(o.material.map) })
    expect(карты.length, 'в калькуляторе нет ни одной текстуры').toBeGreaterThan(0)
    const было = карты.map((m) => `${m.offset.x},${m.offset.y}`)

    viewer._behaviour.select(viewer._interactive[0].nodeIndex)
    const стало = карты.map((m) => `${m.offset.x},${m.offset.y}`)
    expect(стало.some((v, i) => v !== было[i]), 'развёртка не сдвинулась').toBe(true)
  }, 120000)

  itWithModels(['WhackAMole.glb'], 'крот: отложенный шаг доходит и двигает узел', async () => {
    // Первым действием крота идёт задержка, и только потом сдвиг. Проверка без ожидания
    // показала бы «ничего не произошло» — и была бы неправа.
    await viewer.load('/WhackAMole.glb')
    const часть = viewer._interactive[0]
    const было = часть.object.position.clone()
    viewer._behaviour.select(часть.nodeIndex)
    await new Promise((r) => setTimeout(r, 4000))
    expect(часть.object.position.distanceTo(было), 'крот не шевельнулся даже через четыре секунды')
      .toBeGreaterThan(0)
  }, 120000)
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Нажимаем МЫШЬЮ, а не вызовом метода
// ═══════════════════════════════════════════════════════════════════════════

describe('3. луч попадает по части', () => {
  itWithModels(['TrafficLight.glb'], 'попадание в центр нажимаемой части запускает отклик', async () => {
    await viewer.load('/TrafficLight.glb')
    const часть = viewer._interactive[0]
    // Наводим камеру ровно на часть, чтобы луч из центра кадра гарантированно попал.
    const цель = new (await import('three')).Vector3()
    часть.object.getWorldPosition(цель)
    viewer.camera.position.set(цель.x, цель.y, цель.z + 1.5)
    viewer.camera.lookAt(цель)
    viewer.camera.updateMatrixWorld(true)

    expect(viewer.pickInteractive(0.5, 0.5), 'луч не попал по части в центре кадра').toBe(true)
  }, 120000)

  itWithModels(['TrafficLight.glb'], 'мимо модели — ничего не запускается', async () => {
    await viewer.load('/TrafficLight.glb')
    expect(viewer.pickInteractive(0.02, 0.02), 'отклик сработал по пустому месту').toBe(false)
  }, 120000)
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Отложенный шаг не переживает модель
// ═══════════════════════════════════════════════════════════════════════════

describe('4. за собой убираем', () => {
  itWithModels(['WhackAMole.glb', PLAIN], 'задержка, начатая до смены модели, не трогает новую', async () => {
    await viewer.load('/WhackAMole.glb')
    viewer._behaviour.select(viewer._interactive[0].nodeIndex)
    // Меняем модель НЕ ДОЖИДАЯСЬ задержки: отложенный шаг ещё висит.
    await viewer.load('/' + encodeURIComponent(PLAIN))
    const было = viewer.model.position.clone()
    await new Promise((r) => setTimeout(r, 4000))

    expect(viewer._behaviour, 'исполнитель пережил модель').toBeFalsy()
    expect(viewer.model.position.distanceTo(было), 'чужой отложенный шаг подвинул новую модель')
      .toBe(0)
  }, 120000)
})
