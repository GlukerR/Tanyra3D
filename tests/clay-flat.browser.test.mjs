// tests/clay-flat.browser.test.mjs — видно ли на глине ПЛОСКИЕ детали.
//
// Требование Александра, 2026-08-20: «глину нужно сделать максимально понятной. что бы
// даже плоские объекты были видны на ней».
//
// Почему именно плоские — в устройстве глины. Цвет берётся ТОЛЬКО по направлению
// поверхности (matcap): куда смотрит грань, такой у неё и тон. Отсюда два случая, в
// которых наивная глина показывает сплошное пятно:
//
//   1. Две грани, повёрнутые ПОЧТИ одинаково (скос в пять градусов). Тона почти равны,
//      ребро между ними пропадает.
//   2. Две ПАРАЛЛЕЛЬНЫЕ пластины, одна за другой. Направление у них одно и то же,
//      значит и тон один и тот же — никакой разницы в принципе.
//
// Первый случай лечится резкими ступенями тона в самой картинке шара, второй —
// затемнением по глубине. Здесь проверяется, что оба работают, и проверяется НА КАДРЕ:
// спор идёт о том, что человек увидит, а не о том, что написано в коде.
//
// Геометрия строится прямо здесь, а не берётся файлом: нужны пластины с точно заданным
// наклоном, а подбирать их среди готовых моделей значило бы проверять не то.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as THREE from 'three'
import {
  createViewer,
  disposeViewer,
  snapshotPixels,
} from '../tests/helpers/viewer-test-utils.mjs'

let viewer
let canvas

/** Плоская пластина: наклон вокруг горизонтальной оси, сдвиг вбок и вглубь. */
function plate(x, z, tiltDeg) {
  const geom = new THREE.PlaneGeometry(1.6, 1.6)
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xffffff }))
  mesh.rotation.x = THREE.MathUtils.degToRad(tiltDeg)
  mesh.position.set(x, 0, z)
  return mesh
}

/** Средняя яркость непрозрачных пикселей в прямоугольнике кадра (доли ширины/высоты). */
function meanLum({ w, h, px }, x0, x1, y0, y1) {
  let sum = 0
  let n = 0
  for (let y = Math.round(y0 * h); y < Math.round(y1 * h); y++) {
    for (let x = Math.round(x0 * w); x < Math.round(x1 * w); x++) {
      const i = (y * w + x) * 4
      if (px[i + 3] < 200) continue          // фон прозрачен — он не в счёт
      sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
      n++
    }
  }
  return n ? { lum: sum / n, n } : { lum: 0, n: 0 }
}

beforeAll(async () => {
  const made = await createViewer()
  viewer = made.viewer
  canvas = made.canvas
})

afterAll(() => {
  disposeViewer(viewer, canvas)
})

describe('глина показывает плоские детали', () => {
  it('грань со скосом в пять градусов отличается по тону от плоской', () => {
    // Слева пластина плашмя, справа — та же, отклонённая на 5°. Если тон одинаков,
    // ребро между такими гранями на настоящей модели пропадёт.
    const group = new THREE.Group()
    group.add(plate(-1.1, 0, 0))
    group.add(plate(1.1, 0, 5))
    viewer.scene.add(group)
    viewer.model = group
    viewer.setDisplayMaterial('clay')
    viewer.camera.position.set(0, 0, 6)
    viewer.camera.lookAt(0, 0, 0)
    viewer.controls.target.set(0, 0, 0)
    viewer.renderFrame()

    const shot = snapshotPixels(viewer)
    const flat = meanLum(shot, 0.18, 0.42, 0.35, 0.65)
    const tilted = meanLum(shot, 0.58, 0.82, 0.35, 0.65)
    expect(flat.n, 'плоскую пластину не видно в кадре вовсе').toBeGreaterThan(500)
    expect(tilted.n, 'наклонённую пластину не видно в кадре вовсе').toBeGreaterThan(500)

    // Порог 12 из 255 — примерно та разница, которую глаз уже читает как «другая
    // поверхность», а не как шум сглаживания (тем же числом меряет diffStats).
    const diff = Math.abs(flat.lum - tilted.lum)
    expect(diff, `тона почти совпали: ${flat.lum.toFixed(1)} и ${tilted.lum.toFixed(1)}`)
      .toBeGreaterThan(12)

    viewer.scene.remove(group)
    viewer.model = null
  })

  it('две параллельные пластины различаются по глубине', () => {
    // Самый тяжёлый случай: направление у них ОДНО И ТО ЖЕ, и картинка шара тут бессильна
    // по устройству. Развести их может только расстояние до камеры.
    //
    // Первая редакция этой проверки была ЛОЖНОЙ и прошла бы при выключенном затемнении
    // (проверено пробой 2026-08-20). Две ошибки сразу: дальняя пластина в перспективе
    // мельче, поэтому одинаковые по размеру области кадра захватывали у неё яркую кромку
    // и меняли среднее — то есть мерилось не расстояние, а обрезка.
    //
    // Отсюда два требования к постановке, и оба обязательны:
    //   - дальняя пластина УВЕЛИЧЕНА ровно во столько раз, во сколько она дальше, значит
    //     на экране обе одного размера;
    //   - берётся маленький кусочек в самой середине каждой, куда кромка не достаёт.
    // Пластина ОДНА и снимается дважды: сперва ближе, потом дальше и увеличенной ровно
    // во столько раз, во сколько отодвинулась. На экране это один и тот же прямоугольник
    // в одном и том же месте — значит между двумя кадрами меняется РОВНО глубина, и
    // ошибиться, померив вместо неё разницу в размере или обрезке, уже нельзя.
    const CAM_Z = 6
    const NEAR_Z = 1.2
    const FAR_Z = -1.8
    const group = new THREE.Group()
    const p = plate(0, NEAR_Z, 0)
    group.add(p)
    viewer.scene.add(group)
    viewer.model = group
    viewer._clayBounds = null           // габарит другой — пересчитать
    viewer.setDisplayMaterial('clay')
    viewer.camera.position.set(0, 0, CAM_Z)
    viewer.camera.lookAt(0, 0, 0)
    viewer.controls.target.set(0, 0, 0)
    viewer.renderFrame()
    const nearPatch = meanLum(snapshotPixels(viewer), 0.45, 0.55, 0.45, 0.55)

    p.position.z = FAR_Z
    p.scale.setScalar((CAM_Z - FAR_Z) / (CAM_Z - NEAR_Z))
    viewer.renderFrame()
    const farPatch = meanLum(snapshotPixels(viewer), 0.45, 0.55, 0.45, 0.55)

    expect(nearPatch.n, 'пластины нет в кадре').toBeGreaterThan(200)
    // Проекция совпала — иначе сравнивались бы разные куски поверхности.
    expect(farPatch.n, 'отодвинутая пластина заняла на экране другое место').toBe(nearPatch.n)

    expect(nearPatch.lum, `ближняя ${nearPatch.lum.toFixed(1)} не светлее дальней ${farPatch.lum.toFixed(1)}`)
      .toBeGreaterThan(farPatch.lum + 8)

    viewer.scene.remove(group)
    viewer.model = null
  })

  it('«материалы из файла» не подкрашиваются глубиной', () => {
    // Затемнение принадлежит ГЛИНЕ. В режиме показа родных материалов модель обязана
    // выглядеть так, как она есть: подкрасить её значило бы соврать про неё.
    const group = new THREE.Group()
    group.add(plate(0, 0, 0))
    viewer.scene.add(group)
    viewer.model = group
    viewer._clayBounds = null
    viewer.setDisplayMaterial('clay')
    expect(viewer.scene.fog, 'на глине глубины нет').toBeTruthy()
    viewer.setDisplayMaterial('file')
    expect(viewer.scene.fog, 'глубина осталась на родных материалах').toBeFalsy()

    viewer.scene.remove(group)
    viewer.model = null
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Модель БЕЗ нормалей: глина досчитывает их для показа
//
// «в одном (исходном) модель выглядит нормально и с глубиной. а во втором случае (уже
// оптимизированная) модель выглядит очень плоско» (Александр, 2026-08-28).
//
// Причина, найденная замером: у модели материал `unlit`, «не освещать», и чистка
// справедливо убирает NORMAL — атрибут, которого не касается ни один материал, 12 байт на
// вершину. Из шести проверенных текстурных моделей так теряют нормали ровно две:
// `chibi_zenitsu` и `parkergirl`, обе unlit. НА САЙТЕ они выглядят как прежде — unlit и
// раньше на нормали не смотрел, — а в нашем окне сравнения появлялась разница, которой в
// продукте нет.
//
// Правило 11 не нарушено: считаем в СЦЕНЕ ПОКАЗА, в файл не уходит ни байта. Ровно тот же
// род действия, что подмена материала на глину, — способ посмотреть, а не правка модели.
//
// Геометрия строится здесь: нужна пластина ГАРАНТИРОВАННО без нормалей, а искать такую
// среди готовых моделей значило бы проверять не то (и `parkergirl` в git не едет).
// ═══════════════════════════════════════════════════════════════════════════

describe('глина у модели без нормалей', () => {
  /** Та же пластина, но с начисто снятым атрибутом нормалей. */
  const безНормалей = (x, z, tiltDeg) => {
    const mesh = plate(x, z, tiltDeg)
    mesh.geometry.deleteAttribute('normal')
    return mesh
  }

  it('нормали досчитываются, и в файле модели их не прибавляется', () => {
    const group = new THREE.Group()
    const a = безНормалей(-1.1, 0, 0)
    const b = безНормалей(1.1, 0, 5)
    group.add(a)
    group.add(b)
    viewer.scene.add(group)
    viewer.model = group

    expect(a.geometry.attributes.normal, 'нормали были на месте — проверять нечего').toBeUndefined()
    viewer.setDisplayMaterial('clay')
    viewer.renderFrame()
    expect(a.geometry.attributes.normal, 'глина не досчитала нормали — маткапу нечем шейдить')
      .toBeTruthy()

    viewer.scene.remove(group)
    viewer.model = null
  })

  it('плоская и наклонённая грань различаются по тону, как и с родными нормалями', () => {
    // Тот же замер, что в первом разделе, на той же геометрии. Числа обязаны сойтись:
    // человек не должен видеть разницы между окнами там, где её нет в продукте.
    const group = new THREE.Group()
    group.add(безНормалей(-1.1, 0, 0))
    group.add(безНормалей(1.1, 0, 5))
    viewer.scene.add(group)
    viewer.model = group
    viewer.setDisplayMaterial('clay')
    viewer.camera.position.set(0, 0, 6)
    viewer.camera.lookAt(0, 0, 0)
    viewer.controls.target.set(0, 0, 0)
    viewer.renderFrame()

    const shot = snapshotPixels(viewer)
    const flat = meanLum(shot, 0.18, 0.42, 0.35, 0.65)
    const tilted = meanLum(shot, 0.58, 0.82, 0.35, 0.65)
    expect(flat.n, 'плоской пластины нет в кадре').toBeGreaterThan(500)
    expect(tilted.n, 'наклонённой пластины нет в кадре').toBeGreaterThan(500)
    expect(Math.abs(flat.lum - tilted.lum),
      `без нормалей глина осталась плоской: ${flat.lum.toFixed(1)} и ${tilted.lum.toFixed(1)}`)
      .toBeGreaterThan(12)

    viewer.scene.remove(group)
    viewer.model = null
  })

  it('«материалы из файла» ничего не досчитывают — модель показана как есть', () => {
    // Граница Правила 11 с другой стороны: досчёт делается ДЛЯ ГЛИНЫ. В режиме файла
    // модель показывается такой, какая она есть, и добавлять ей чужие данные нельзя.
    const group = new THREE.Group()
    const a = безНормалей(0, 0, 0)
    group.add(a)
    viewer.scene.add(group)
    viewer.model = group
    viewer.setDisplayMaterial('file')
    viewer.renderFrame()
    expect(a.geometry.attributes.normal, 'режим файла досчитал нормали за автора').toBeUndefined()

    viewer.scene.remove(group)
    viewer.model = null
    viewer.setDisplayMaterial('clay')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Находка ревью 2026-08-31: досчитанные нормали переживали выход из глины
//
// «Материалы из файла» переставали значить «как в файле»: у модели без нормалей и с
// обычным (не unlit) материалом three.js затеняет по граням, а после захода в глину —
// гладко. Один и тот же режим показывал разное в зависимости от того, куда человек
// заглядывал до этого.
// ═══════════════════════════════════════════════════════════════════════════

describe('глина убирает за собой', () => {
  it('выход из глины снимает досчитанные нормали, родные не трогает', () => {
    const group = new THREE.Group()
    const без = plate(-1.1, 0, 0)
    без.geometry.deleteAttribute('normal')
    const родные = plate(1.1, 0, 0)          // у этой нормали свои, из геометрии
    group.add(без, родные)
    viewer.scene.add(group)
    viewer.model = group

    viewer.setDisplayMaterial('clay')
    viewer.renderFrame()
    expect(без.geometry.attributes.normal, 'глина не досчитала').toBeTruthy()

    viewer.setDisplayMaterial('file')
    viewer.renderFrame()
    expect(без.geometry.attributes.normal, 'досчитанные нормали пережили выход из глины')
      .toBeUndefined()
    expect(родные.geometry.attributes.normal, 'сняли ЧУЖИЕ нормали, а не только свои')
      .toBeTruthy()

    viewer.scene.remove(group)
    viewer.model = null
    viewer.setDisplayMaterial('clay')
  })
})
