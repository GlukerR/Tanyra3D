// tests/render-snapshot.browser.test.mjs — снимок кадра и три способа показа.
//
// ЗАКАЗ (Александр, 2026-08-27). Про картинку: «при скачивании модели не нужно рендерить.
// Это отдельная кнопка должна быть… пока просто нажимаешь и картинка которая сейчас во
// вьюпорте второй модели (оптимизированной) выбрана, то и будет рендериться». Про сетку:
// «логику берём как у блендера. слева направо. сетка-глина-рендер с материалами».
//
// ПОЧЕМУ ПО ПИКСЕЛЯМ. Спор идёт о картинке. Проверка «метод вернул Blob» подтвердила бы
// только вызов: прозрачность могла оказаться залитой, подложка — не закраситься, сетка —
// не отличаться от материалов, а размер — молча съехать. Всё это видно только в пикселях.
//
// ПОЧЕМУ СЦЕНА СИНТЕТИЧЕСКАЯ, А НЕ МОДЕЛЬ ИЗ КОРПУСА. Урок того же дня: браузерный тест,
// опёртый на образцы Khronos, покраснел на CI, потому что в git их нет и не будет
// (Правило 0). Здесь спорить не о чьей-то модели, а о ПОВЕДЕНИИ снимка — значит заготовка
// строится тут же и работает на любом клоне.
//
// ГРАНИЦА. Снимок — ПОКАЗ, а не правка: файл не трогается вовсе. Раздел 4 сторожит именно
// это — родные материалы возвращаются на место после сетки и глины (Правило 11).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as THREE from 'three'
import { createViewer, disposeViewer } from '../tests/helpers/viewer-test-utils.mjs'

let viewer
let canvas

/** Куб с ярким материалом: заметен в кадре и на белом, и на прозрачном. */
function makeModel() {
  const group = new THREE.Group()
  group.add(new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xcc3355, roughness: 0.6, metalness: 0 }),
  ))
  return group
}

/** Разбор PNG обратно в пиксели: спор о картинке решается только так. */
async function pixels(blob) {
  const bmp = await createImageBitmap(blob)
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  const g = c.getContext('2d')
  g.drawImage(bmp, 0, 0)
  const px = g.getImageData(0, 0, bmp.width, bmp.height).data
  let opaque = 0
  let clear = 0
  let sum = 0
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] > 250) { opaque++; sum += px[i] + px[i + 1] + px[i + 2] }
    else if (px[i + 3] < 5) clear++
  }
  const total = px.length / 4
  return {
    w: bmp.width,
    h: bmp.height,
    corner: [px[0], px[1], px[2], px[3]],
    opaquePct: (opaque / total) * 100,
    clearPct: (clear / total) * 100,
    meanLit: opaque ? sum / opaque / 3 : 0,
  }
}

beforeAll(async () => {
  const made = await createViewer()
  viewer = made.viewer
  canvas = made.canvas
  viewer.scene.add(makeModel())
  viewer.model = viewer.scene.children.find((o) => o.type === 'Group')
  viewer.camera.position.set(2, 2, 3)
  viewer.camera.lookAt(0, 0, 0)
  viewer.renderFrame()
})

afterAll(() => disposeViewer(viewer, canvas))

describe('1. прозрачность и подложка', () => {
  it('без подложки фон ПУСТОЙ, а модель непрозрачна', async () => {
    // Прозрачность не настраивается и не включается: рендерер создан с `alpha: true`,
    // земли под моделью нет. Проверяем, что так и осталось, — залитый фон обесценил бы
    // весь смысл PNG.
    const shot = await viewer.snapshot({ width: 320, height: 240 })
    expect(shot, 'снимок не сделан вовсе').toBeTruthy()
    const p = await pixels(shot.blob)
    expect(p.corner[3], `угол кадра не прозрачен (альфа ${p.corner[3]})`).toBeLessThan(5)
    expect(p.clearPct, `прозрачного фона почти нет (${p.clearPct.toFixed(1)}%)`).toBeGreaterThan(40)
    expect(p.opaquePct, `модели в кадре не видно (${p.opaquePct.toFixed(1)}%)`).toBeGreaterThan(2)
  })

  it('с подложкой прозрачных пикселей не остаётся', async () => {
    const shot = await viewer.snapshot({ width: 320, height: 240, background: '#ffffff' })
    const p = await pixels(shot.blob)
    expect(p.corner.slice(0, 3), 'угол не белый').toEqual([255, 255, 255])
    expect(p.clearPct, `подложка не закрасила фон (${p.clearPct.toFixed(1)}% прозрачных)`).toBe(0)
  })
})

describe('2. размер — обещание, а не пожелание', () => {
  it('запрошенный размер соблюдён', async () => {
    const shot = await viewer.snapshot({ width: 640, height: 360 })
    expect([shot.width, shot.height]).toEqual([640, 360])
    const p = await pixels(shot.blob)
    expect([p.w, p.h], 'в самом PNG размер другой').toEqual([640, 360])
  })

  it('запредельный размер ОБРЕЗАН, и ответ называет настоящий', async () => {
    // Молчаливая подмена запрещена Правилом 12: человек просил 8К — он обязан узнать,
    // что получил меньше. Поэтому потолок не только применяется, но и возвращается.
    const shot = await viewer.snapshot({ width: 999_999, height: 999_999 })
    expect(shot.width, 'потолок не применён — кадр вышел бы пустым').toBeLessThan(999_999)
    const p = await pixels(shot.blob)
    expect([p.w, p.h], 'ответ соврал о размере').toEqual([shot.width, shot.height])
  })
})

describe('3. окно возвращается на место', () => {
  it('после снимка полотно прежнего размера', async () => {
    // Снимок временно меняет размер буфера. Не вернуть его значит испортить живое окно
    // ради картинки — человек увидел бы растянутую модель и не понял бы почему.
    const было = new THREE.Vector2()
    viewer.renderer.getSize(было)
    const ratio = viewer.renderer.getPixelRatio()
    await viewer.snapshot({ width: 1200, height: 900 })
    const стало = new THREE.Vector2()
    viewer.renderer.getSize(стало)
    expect([стало.x, стало.y], 'размер окна остался снимочным').toEqual([было.x, было.y])
    expect(viewer.renderer.getPixelRatio(), 'плотность пикселей не восстановлена').toBe(ratio)
  })
})

describe('4. три способа показа — и все три разные', () => {
  it('сетка заполняет кадр заметно меньше, чем глина и материалы', async () => {
    const снимки = {}
    for (const mode of ['wire', 'clay', 'file']) {
      viewer.setDisplayMaterial(mode)
      expect(viewer.getDisplayMaterial(), `режим ${mode} не установился`).toBe(mode)
      const shot = await viewer.snapshot({ width: 320, height: 240 })
      снимки[mode] = await pixels(shot.blob)
    }
    // Сетка — это РЁБРА: закрашенного в кадре кратно меньше. Если бы подмена материала не
    // случилась, число совпало бы с материалами до доли процента.
    expect(снимки.wire.opaquePct,
      `сетка закрасила столько же, сколько материалы (${снимки.wire.opaquePct.toFixed(1)}% против ${снимки.file.opaquePct.toFixed(1)}%) — подмены не было`)
      .toBeLessThan(снимки.file.opaquePct * 0.6)
    // Глина закрашивает столько же, сколько материалы, но ДРУГИМ тоном: у неё картинка
    // шара вместо цвета и света.
    expect(Math.abs(снимки.clay.meanLit - снимки.file.meanLit),
      'глина и материалы дали один и тот же тон — глина не применилась')
      .toBeGreaterThan(5)
  })

  it('родные материалы возвращаются на место', async () => {
    // Правило 11: показ не правит модель. Сравниваем сами ОБЪЕКТЫ материалов, а не их
    // вид: подменённый на равный по виду материал уехал бы в файл чужим.
    const родные = new Map()
    viewer.setDisplayMaterial('file')
    viewer.model.traverse((o) => { if (o.isMesh) родные.set(o, o.material) })
    expect(родные.size, 'в заготовке нет ни одного меша').toBeGreaterThan(0)

    for (const mode of ['wire', 'clay']) {
      viewer.setDisplayMaterial(mode)
      for (const [mesh, было] of родные) {
        expect(mesh.material, `${mode}: материал не подменён — режим не работает`).not.toBe(было)
      }
      viewer.setDisplayMaterial('file')
      for (const [mesh, было] of родные) {
        expect(mesh.material, `${mode}: родной материал не вернулся`).toBe(было)
      }
    }
  })
})
