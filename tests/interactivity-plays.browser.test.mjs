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
  // Орбита ловит указатель через setPointerCapture, а у ПРИДУМАННОГО нами события
  // указателя в системе нет — браузер отвечает отказом, и он всплывает наверх как
  // «необработанная ошибка» рядом с зелёными тестами. К делу это не относится: мы
  // проверяем НАШУ обработку нажатия, а не захват указателя орбитой.
  //
  // Глушим заглушкой, а не try/catch: код внутри OrbitControls нам не принадлежит.
  // Шум в прогоне опаснее, чем кажется: строка «Errors 2» рядом с «всё зелено» приучает
  // не смотреть на неё, и настоящая ошибка однажды проедет мимо.
  canvas.setPointerCapture = () => {}
  canvas.releasePointerCapture = () => {}
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

// ═══════════════════════════════════════════════════════════════════════════
// 5. Две поломки, найденные Александром на живых моделях
//
// Обе прошли мимо первых сторожей, и обе — из-за того, что тест звал движок напрямую,
// а человек нажимает мышью и ждёт кадров.
//
//   • «WhackAMole MagicBall не работают никак». Исполнитель поднимался РАНЬШЕ, чем
//     создавался микшер, и забирал `clips` пустыми: каждый `animation/start` уходил в
//     никуда. Вдобавок анимации графа некому было продвигать — полоса времени вьюпорта
//     стоит, пока человек не нажал «играть».
//   • «многие кнопки не работают». Нажатием считалось только то, что уложилось в
//     полсекунды. Осмысленное нажатие по маленькой кнопке в это не укладывается.
// ═══════════════════════════════════════════════════════════════════════════

describe('5. нажимаем как человек', () => {
  itWithModels(['WhackAMole.glb'], 'анимация, запущенная графом, ИДЁТ сама', async () => {
    await viewer.load('/WhackAMole.glb')
    // Проверяем то, что ДОЕХАЛО ДО ИСПОЛНИТЕЛЯ, а не то, что есть у вьюера. Разница и
    // была поломкой: исполнитель поднимался раньше `_setupAnimations` и забирал пустой
    // список, хотя у вьюера клипы через миг появлялись. Сдвиг крота этого не ловит — он
    // едет ещё и через `pointer/set`, и тест зеленел на сломанном коде.
    expect(viewer._behaviour.deps.clips.length, 'клипы не доехали до исполнителя')
      .toBeGreaterThan(0)
    expect(viewer._behaviourMixer, 'у графа нет своего микшера').toBeTruthy()

    const крот = viewer._interactive[0]
    const было = крот.object.position.clone()
    viewer._behaviour.select(крот.nodeIndex)

    // Крутим кадры настоящим временем: микшер графа продвигается именно ими, а не
    // полосой вьюпорта.
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 33))
      viewer.renderFrame()
    }
    expect(крот.object.position.distanceTo(было), 'крот не сдвинулся за три секунды кадров')
      .toBeGreaterThan(0)
  }, 120000)

  itWithModels(['TrafficLight.glb'], 'ДОЛГОЕ нажатие без сдвига — тоже нажатие', async () => {
    await viewer.load('/TrafficLight.glb')
    const часть = viewer._interactive[0]
    const THREE = await import('three')
    const цель = new THREE.Vector3()
    часть.object.getWorldPosition(цель)
    viewer.camera.position.set(цель.x, цель.y, цель.z + 1.5)
    viewer.camera.lookAt(цель)
    viewer.camera.updateMatrixWorld(true)

    const было = colours()
    const box = canvas.getBoundingClientRect()
    const x = box.left + box.width / 2
    const y = box.top + box.height / 2
    const событие = (тип) => new PointerEvent(тип, { clientX: x, clientY: y, bubbles: true });

    canvas.dispatchEvent(событие('pointerdown'))
    await new Promise((r) => setTimeout(r, 1200)) // держим больше секунды
    canvas.dispatchEvent(событие('pointerup'))

    expect(colours().filter((c, i) => c !== было[i]).length,
      'долгое нажатие не сработало — снова считаем нажатием только быстрое').toBeGreaterThan(0)
  }, 120000)

  itWithModels(['TrafficLight.glb'], 'нажатие СО СДВИГОМ — это вращение, не нажатие', async () => {
    await viewer.load('/TrafficLight.glb')
    const было = colours()
    const box = canvas.getBoundingClientRect()
    const x = box.left + box.width / 2
    const y = box.top + box.height / 2
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true }))
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: x + 60, clientY: y + 40, bubbles: true }))

    expect(colours().filter((c, i) => c !== было[i]).length,
      'вращение модели запустило отклик').toBe(0)
  }, 120000)
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Нажатие говорит о себе
//
// «неработает странно. может я просто не понимаю» (Александр, 2026-08-28). И это не
// придирка к словам: отклики у этих моделей тихие — цвет лампы, сдвиг развёртки на
// пиксель, анимация через секунду. Без ответа «попал» человек не отличает промах от
// сломанного интерактива, и оба выглядят одинаково — никак.
// ═══════════════════════════════════════════════════════════════════════════

describe('6. нажатие отвечает', () => {
  itWithModels(['TrafficLight.glb'], 'попадание зовёт слушателя и называет часть', async () => {
    await viewer.load('/TrafficLight.glb')
    const пойманное = []
    viewer.onInteractivePick = (p) => пойманное.push(p)

    const часть = viewer._interactive[0]
    const THREE = await import('three')
    const цель = new THREE.Vector3()
    часть.object.getWorldPosition(цель)
    viewer.camera.position.set(цель.x, цель.y, цель.z + 1.5)
    viewer.camera.lookAt(цель)
    viewer.camera.updateMatrixWorld(true)

    viewer.pickInteractive(0.5, 0.5)
    viewer.onInteractivePick = null

    expect(пойманное.length, 'о нажатии никто не узнал').toBe(1)
    expect(пойманное[0].name, 'часть не названа').toBeTruthy()
    expect(пойманное[0].responded, 'отклик был, а сказано обратное').toBe(true)
  }, 120000)

  itWithModels(['TrafficLight.glb'], 'промах мимо модели никого не зовёт', async () => {
    await viewer.load('/TrafficLight.glb')
    const пойманное = []
    viewer.onInteractivePick = (p) => пойманное.push(p)
    viewer.pickInteractive(0.02, 0.02)
    viewer.onInteractivePick = null
    expect(пойманное, 'промах записан как нажатие').toEqual([])
  }, 120000)
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. Три поломки, названные Александром по отдельности
//
// «у крота они пропадают и появляются в разных местах. а ты этого не ловишь совершенно»
// «у магического шара появляется обводка но сама модель не меняется»
// «у калькулятора… только цифры меняются на калькуляторе и всё»
//                                                     (Александр, 2026-08-28)
//
// Причины разные, и потому проверок три, а не одна:
//
//   • рамки строились один раз и не шли за деталью;
//   • `KHR_node_visibility` не применялось при загрузке — все двадцать предсказаний шара
//     висели на экране сразу, и показывать было нечего;
//   • память вычисления жила всю активацию, и ветка показа читала переменную ДО того, как
//     кнопка её меняла; плюс запись в переменную искала сокет с именем «0», хотя он
//     назван номером переменной.
// ═══════════════════════════════════════════════════════════════════════════

describe('7. показ согласован с файлом', () => {
  /** Виден ли объект на самом деле: `visible` у него самого молчит про родителей. */
  const видно = (o) => {
    for (let p = o; p; p = p.parent) if (!p.visible) return false
    return true
  }

  /**
   * Части шара, спрятанные автором. Ищем по имени: узлы в файле так и названы.
   *
   * Берём ВЕРХНИЕ объекты с этим именем — узел и его меш названы одинаково, а прячется
   * узел; считать оба значило бы удвоить счёт.
   */
  const предсказания = () => {
    const out = []
    viewer.model.traverse((o) => {
      if (o.name.startsWith('FortuneWords') && !o.parent?.name.startsWith('FortuneWords')) out.push(o)
    })
    return out
  }

  itWithModels(['MagicBall.glb'], 'шар: спрятанное автором спрятано и у нас', async () => {
    await viewer.load('/MagicBall.glb')
    const слова = предсказания()
    expect(слова.length, 'в шаре не нашлось предсказаний').toBeGreaterThan(10)
    expect(слова.filter(видно).map((o) => o.name),
      'предсказания видны все разом — файл говорит обратное').toEqual([])
  }, 120000)

  itWithModels(['MagicBall.glb'], 'шар: нажатие открывает РОВНО ОДНО предсказание', async () => {
    await viewer.load('/MagicBall.glb')
    viewer._behaviour.select(viewer._interactive[0].nodeIndex)
    expect(предсказания().filter(видно).length,
      'после нажатия видно не одно предсказание').toBe(1)
  }, 120000)

  itWithModels(['Calculator.glb'], 'калькулятор: считающая кнопка меняет число на экране', async () => {
    // Цифровые кнопки кладут в переменную готовое число и работали всегда. Ломались
    // именно считающие — «×2», «÷2», «+1», «−1»: они СНАЧАЛА читают переменную.
    await viewer.load('/Calculator.glb')
    // Загрузчик three.js правит имена под свои пути анимации: пробел становится
    // подчёркиванием. Ищем по имени, приведённому к общему виду, а не по букве файла.
    const ключ = (s) => s.replace(/[\s_]+/g, ' ').trim()
    const части = Object.fromEntries(viewer._interactive.map((p) => [ключ(p.name), p]))
    const четыре = части['Button 4']
    const умножить = части['Button multiply']
    expect(четыре && умножить, 'в калькуляторе не нашлись кнопки «4» и «×»').toBeTruthy()

    const карты = []
    viewer.model.traverse((o) => { if (o.isMesh && o.material?.map) карты.push(o.material.map) })
    viewer._behaviour.select(четыре.nodeIndex)
    const было = карты.map((m) => `${m.offset.x},${m.offset.y}`)

    viewer._behaviour.select(умножить.nodeIndex)
    const стало = карты.map((m) => `${m.offset.x},${m.offset.y}`)
    expect(стало.some((v, i) => v !== было[i]),
      'после «×2» на экране осталось прежнее число — считающие кнопки не работают').toBe(true)
  }, 120000)

  itWithModels(['WhackAMole.glb'], 'обводка идёт за деталью, а не стоит где была', async () => {
    await viewer.load('/WhackAMole.glb')
    expect(viewer._interactiveMarks, 'обводки нет — проверять нечего').toBeTruthy()
    const THREE = await import('three')
    const часть = viewer._interactive[0]
    const рамка = viewer._interactiveMarks.children.find((c) => c._part === часть)
    expect(рамка, 'у части нет своей рамки').toBeTruthy()

    // Центр по вершинам рамки, а не через `Box3.setFromObject`: у того габарит геометрии
    // кэшируется, и он вернул бы прежние числа даже у обновлённой рамки.
    const центр = () => {
      const p = рамка.geometry.attributes.position
      const c = new THREE.Vector3()
      for (let i = 0; i < p.count; i++) c.add(new THREE.Vector3().fromBufferAttribute(p, i))
      return c.divideScalar(p.count)
    }
    viewer.renderFrame()
    const было = центр()

    часть.object.position.y += 1
    часть.object.updateMatrixWorld(true)
    viewer.renderFrame()

    expect(центр().distanceTo(было), 'деталь уехала, а рамка осталась на месте')
      .toBeGreaterThan(0.5)
  }, 120000)

  itWithModels(['WhackAMole.glb'], 'спрятанная деталь не обводится', async () => {
    await viewer.load('/WhackAMole.glb')
    const часть = viewer._interactive[0]
    const рамка = viewer._interactiveMarks.children.find((c) => c._part === часть)
    часть.object.visible = false
    viewer.renderFrame()
    expect(рамка.visible, 'рамка обещает нажатие на то, чего не видно').toBe(false)

    часть.object.visible = true
    viewer.renderFrame()
    expect(рамка.visible, 'деталь вернулась, а рамка не вернулась').toBe(true)
  }, 120000)
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. Лишний интерактив: восемь пустых кнопок и одна рабочая
//
// «ты можешь сделать модель с кучей интерактивных элементов которые ничего не делают и с
// одним работающим? что бы эту теорию удаления интерактива неиспользуемого мы могли
// обработать» (Александр, 2026-08-28). Модель сделана — `Dead Interactivity 01.glb`,
// скрипт `_work/make-dead-interactivity-fixture.mjs`, разбор в её `.license.md`.
//
// Она НАША и лежит в git, поэтому пропусков здесь нет: раздел работает и на чистом клоне.
// Проверяем ровно одно свойство, на котором будет стоять будущая кнопка «убрать лишнее»:
// пустая часть и рабочая снаружи неразличимы, отличает их только граф — и мы отличаем.
// ═══════════════════════════════════════════════════════════════════════════

describe('8. пустая нажимаемая часть отличима от рабочей', () => {
  const МОДЕЛЬ = 'Dead Interactivity 01.glb'

  it('обведены все девять — метка у пустых та же, что у рабочей', async () => {
    await viewer.load('/' + encodeURIComponent(МОДЕЛЬ))
    const info = viewer.getInteractivityInfo()
    expect(info.count, 'нажимаемых частей не девять').toBe(9)
    // Загрузчик three.js правит имена под свои пути анимации: пробел → подчёркивание.
    const имена = info.names.map((n) => n.replace(/[\s_]+/g, ' '))
    expect(имена).toContain('Кнопка живая')
    // Подставка помечена «не нажимать» — решение автора, и в списке ей не место.
    expect(имена.some((n) => n.startsWith('Подставка')), 'обведено то, на что автор запретил нажимать')
      .toBe(false)
  }, 120000)

  it('рабочая откликается, пустые — нет', async () => {
    await viewer.load('/' + encodeURIComponent(МОДЕЛЬ))
    const части = Object.fromEntries(viewer._interactive.map((p) => [p.name.replace(/[\s_]+/g, ' '), p]))
    const живая = части['Кнопка живая']
    expect(живая, 'живой кнопки нет в списке').toBeTruthy()

    expect(viewer._behaviour.select(живая.nodeIndex), 'рабочая кнопка не откликнулась').toBe(true)
    for (let i = 1; i <= 8; i++) {
      const пустая = части[`Кнопка пустая ${i}`]
      expect(пустая, `пустой кнопки ${i} нет в списке`).toBeTruthy()
      expect(viewer._behaviour.select(пустая.nodeIndex), `пустая кнопка ${i} вдруг откликнулась`)
        .toBe(false)
    }
  }, 120000)

  it('недостижимая связка графа не исполняется сама', async () => {
    // Узлы 2 и 3 графа двигают первые две кнопки на пять единиц. К ним не ведёт ни один
    // поток — значит кнопки обязаны остаться на месте, что бы ни нажимали.
    await viewer.load('/' + encodeURIComponent(МОДЕЛЬ))
    const первая = viewer._interactive[0]
    const было = первая.object.position.clone()
    viewer._behaviour.start()
    viewer._behaviour.select(первая.nodeIndex)
    await new Promise((r) => setTimeout(r, 500))
    expect(первая.object.position.distanceTo(было), 'связка без входящего потока всё-таки сработала')
      .toBe(0)
  }, 120000)
})
