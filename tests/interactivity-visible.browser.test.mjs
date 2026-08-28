// tests/interactivity-visible.browser.test.mjs — интерактив ВИДНО в окне.
//
// ЗАКАЗ (Александр, 2026-08-28): «я не вижу вообще никаких интерактивов. должен видеть.
// мы можем добавить в движок виденье интерактивных элементов?»
//
// ЧТО СТОРОЖИМ И ПОЧЕМУ ПО ПИКСЕЛЯМ. Спор идёт о том, что человек УВИДИТ. Проверка
// «метод вернул true» подтвердила бы вызов: обводка могла оказаться нулевого размера,
// спрятаться внутри модели или не попасть в кадр — и всё это выглядело бы зелёным.
// Поэтому кадр сравнивается до и после.
//
// ГРАНИЦА, И ОНА ГЛАВНАЯ. Это ПОКАЗ, а не исполнение: граф поведения мы не проигрываем
// (ROADMAP §6д). И это не правка модели: материалы её частей обязаны остаться теми же
// объектами — обводка живёт отдельной вещью рядом (Правило 11). Раздел 3 сторожит
// именно это.
//
// Модели в git нет и не будет (Правило 0) — проверки пропускаются там, где файла на
// диске нет.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createViewer, disposeViewer, snapshotPixels } from '../tests/helpers/viewer-test-utils.mjs'

const MODEL = 'WhackAMole.glb'
const PLAIN = 'Dirty Cube 01.glb'

// Есть ли модель на диске — спрашиваем у сервера, как это делает viewer-regression.
// Проба идёт на этапе СБОРА файла (top-level await), поэтому к моменту объявления `it`
// ответ уже известен и отсутствующая модель становится честным skip, а не падением:
// на 404 сервер отдаёт страницу, three.js разбирает её как GLB и умирает с
// «RangeError: Invalid typed array length» — по такому сообщению причину не угадать.
const present = new Map(await Promise.all([MODEL, PLAIN].map(async (file) => {
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

/** Сколько пикселей кадра отличаются заметно. Спор о картинке решается только так. */
function differing(a, b) {
  let n = 0
  for (let i = 0; i < a.px.length; i += 4) {
    if (Math.abs(a.px[i] - b.px[i]) > 12
      || Math.abs(a.px[i + 1] - b.px[i + 1]) > 12
      || Math.abs(a.px[i + 2] - b.px[i + 2]) > 12) n++
  }
  return n
}

describe('интерактив виден в окне', () => {
  itWithModels([MODEL], '1. нажимаемые части найдены — семь, как в файле', async () => {
    await viewer.load('/' + MODEL)
    const info = viewer.getInteractivityInfo()
    // Семь узлов помечены выбираемыми — замер по самому файлу 2026-08-28.
    expect(info.count, 'нажимаемые части не найдены').toBe(7)
    expect(info.shown, 'обводка показана до того, как её попросили').toBe(false)
    expect(info.names.every((n) => typeof n === 'string')).toBe(true)
  })

  itWithModels([MODEL], '2. обводка МЕНЯЕТ КАДР, а снятие возвращает его', async () => {
    await viewer.load('/' + MODEL)
    viewer.renderFrame()
    const без = snapshotPixels(viewer)

    expect(viewer.setInteractivityMarks(true), 'обводка не поставилась').toBe(true)
    viewer.renderFrame()
    const с = snapshotPixels(viewer)

    // Порог в тысячу пикселей, а не «хоть один»: одиночные точки дал бы и шум
    // сглаживания, а семь рамок вокруг частей модели — это заметная площадь.
    expect(differing(без, с), 'кадр не изменился — обводки не видно').toBeGreaterThan(1000)

    viewer.setInteractivityMarks(false)
    viewer.renderFrame()
    const снова = snapshotPixels(viewer)
    expect(differing(без, снова), 'после снятия обводки кадр не вернулся').toBeLessThan(100)
  })

  itWithModels([MODEL], '3. модель не тронута: материалы те же ОБЪЕКТЫ', async () => {
    // Правило 11: показ не правит модель. Сравниваем сами объекты материалов, а не их
    // вид — подменённый на равный по виду материал уехал бы в файл чужим.
    await viewer.load('/' + MODEL)
    const родные = new Map()
    viewer.model.traverse((o) => { if (o.isMesh) родные.set(o, o.material) })
    expect(родные.size, 'в модели нет ни одного меша').toBeGreaterThan(0)

    viewer.setInteractivityMarks(true)
    for (const [mesh, было] of родные) {
      expect(mesh.material, 'материал части подменён ради обводки').toBe(было)
    }
    viewer.setInteractivityMarks(false)
  })

  itWithModels([MODEL], '4. обводка не остаётся от прошлой модели', async () => {
    // Сцена живёт всё время работы программы, модель — нет. Первая версия уровней
    // детализации на этом уже обожглась: запасные узлы переживали смену модели и
    // рисовались поверх новой.
    await viewer.load('/' + MODEL)
    viewer.setInteractivityMarks(true)
    await viewer.load('/Dirty%20Cube%2001.glb')

    expect(viewer.getInteractivityInfo().count, 'у куба взялся чужой интерактив').toBe(0)
    const оставшиеся = []
    viewer.scene.traverse((o) => { if (o.name === 'InteractivityHighlight') оставшиеся.push(o) })
    expect(оставшиеся, 'обводка пережила смену модели').toEqual([])
  })

  itWithModels([PLAIN], '5. у модели без интерактива обводить нечего', async () => {
    await viewer.load('/Dirty%20Cube%2001.glb')
    expect(viewer.getInteractivityInfo().count).toBe(0)
    // Отказ, а не пустая рамка: показанная кнопка, которая ничего не делает, запрещена
    // (Правило 12), и движок обязан честно ответить «нечего».
    expect(viewer.setInteractivityMarks(true)).toBe(false)
  })
})
