import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createViewer, disposeViewer, snapshotPixels } from '../tests/helpers/viewer-test-utils.mjs'

const MODEL = 'WhackAMole.glb'
const PLAIN = 'Dirty Cube 01.glb'

const present = new Map(await Promise.all([MODEL, PLAIN, 'MagicBall.glb', 'Calculator.glb'].map(async (file) => {
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
    expect(info.count, 'нажимаемые части не найдены').toBe(7)
    expect(info.shown, 'обводку опять надо включать вручную').toBe(true)
    expect(info.names.every((n) => typeof n === 'string')).toBe(true)
  })

  itWithModels([MODEL], '2. обводка МЕНЯЕТ КАДР, а снятие возвращает его', async () => {
    await viewer.load('/' + MODEL)
    viewer.setInteractivityMarks(false)
    viewer.renderFrame()
    const без = snapshotPixels(viewer)

    expect(viewer.setInteractivityMarks(true), 'обводка не поставилась').toBe(true)
    viewer.renderFrame()
    const с = snapshotPixels(viewer)

    expect(differing(без, с), 'кадр не изменился — обводки не видно').toBeGreaterThan(1000)

    viewer.setInteractivityMarks(false)
    viewer.renderFrame()
    const снова = snapshotPixels(viewer)
    expect(differing(без, снова), 'после снятия обводки кадр не вернулся').toBeLessThan(100)
  })

  itWithModels([MODEL], '3. модель не тронута: материалы те же ОБЪЕКТЫ', async () => {
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
    expect(viewer.setInteractivityMarks(true)).toBe(false)
  })
})


describe('запрет автора уважается', () => {
  itWithModels(['MagicBall.glb'], 'MagicBall: нажимаемый ОДИН, остальные двадцать запрещены', async () => {
    await viewer.load('/MagicBall.glb')
    const info = viewer.getInteractivityInfo()
    expect(info.count, 'узлы с `selectable: false` снова считаются нажимаемыми').toBe(1)
    expect(info.names[0]).toMatch(/Ball/)
  })

  itWithModels(['Calculator.glb'], 'Calculator: пятнадцать кнопок обведены', async () => {
    await viewer.load('/Calculator.glb')
    expect(viewer.getInteractivityInfo().count).toBe(15)
  })
})
