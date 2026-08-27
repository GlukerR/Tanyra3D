// tests/diffuse-transmission.browser.test.mjs — просвет насквозь виден в кадре.
//
// ЗАКАЗ (Александр, 2026-08-27): «KHR_materials_diffuse_transmission — это самая главная
// и скорая правка которая должна быть».
//
// ЧТО БЫЛО. Замер по установленному three.js 0.185.1 (это САМАЯ свежая опубликованная
// версия, обновиться некуда): ни в `src/`, ни в `examples/jsm/` расширения нет ни одним
// упоминанием. Загрузчик выбрасывал его молча, и лист, абажур, тонкий фарфор
// показывались плотными. Оптимизатор при этом расширение ПОНИМАЕТ (`gltf-transform`
// знает его как `KHRMaterialsDiffuseTransmission`) и довозит в файл целым — слеп был
// только просмотр. Человек видел одно, а увозил другое.
//
// ПОЧЕМУ ТЕСТ БРАУЗЕРНЫЙ И ПО ПИКСЕЛЯМ. Спор идёт о том, что человек УВИДИТ. Проверка
// «на материале появилось поле» подтвердила бы разбор JSON и ровно ничего про картинку:
// врезка в шейдер могла не собраться, попасть не в ту точку включения или считать долю
// не из того канала — поле осталось бы на месте, а кадр прежним.
//
// ЗАМЫСЕЛ ПРОВЕРКИ — свет СЗАДИ. Гасим всё: окружение и наш ключевой источник. Ставим
// один направленный источник ЗА моделью. Тогда:
//   · без просвета  — на видимые грани не падает ничего, кадр почти чёрный;
//   · с просветом   — те же грани светятся, потому что свет пришёл с изнанки.
// Разница между этими двумя кадрами и есть доказательство: она возникает ровно из-за
// перевёрнутой нормали, а не из-за яркости вообще. Сравнение «светлее/темнее» при
// обычном свете такого не доказывает — там достаточно любого множителя.
//
// ЧАЙНАЯ ПАРА И РАСТЕНИЕ — два РАЗНЫХ пути, поэтому нужны оба:
//   · `DiffuseTransmissionTeacup`  — доля `1.0` с картой доли (канал A), односторонний;
//   · `DiffuseTransmissionPlant`   — доля `0.1` с картой ЦВЕТА (RGB, sRGB), двусторонний,
//                                    с обрезкой по маске (`alphaMode: MASK`).
// Карту доли и карту цвета читают разные каналы разных текстур; перепутать их — обычная
// ошибка, и одна модель её не поймает.

import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest'
import * as THREE from 'three'
import { createViewer, disposeViewer, snapshotPixels } from '../tests/helpers/viewer-test-utils.mjs'

// Обе модели — образцы Khronos: в git их нет и не будет (Правило 0), на чистом клоне и
// на CI они отсутствуют ЗАКОННО. Условие читается ЗДЕСЬ, на этапе сбора файла: без
// моделей весь блок становится `describe.skip` с причиной в имени — не упавшим тестом.
// `isPresent()` тут не работает: файл исполняется в Chromium, `node:fs` ему недоступен —
// для этого и нужен канал из node-контекста (`diffuse-transmission-models.setup.mjs`).
//
// Красный прогон CI 2026-08-27 показал, чего стоит забыть об этом: `viewer.load` падал в
// `beforeAll`, и оба блока рапортовали «8 skipped» при провалившемся наборе.
const МОДЕЛИ_ЕСТЬ = inject('diffuse-transmission-models-available') === true
const БЕЗ_МОДЕЛЕЙ = ' [пропущено: нет локально DiffuseTransmissionTeacup.glb / DiffuseTransmissionPlant.glb]'
const блок = МОДЕЛИ_ЕСТЬ ? describe : describe.skip

let viewer
let canvas

/** Средняя яркость непрозрачных пикселей кадра. */
function meanLum({ w, h, px }) {
  let sum = 0
  let n = 0
  for (let i = 0; i < w * h * 4; i += 4) {
    if (px[i + 3] < 200) continue
    sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
    n++
  }
  return n ? sum / n : 0
}

/** Материалы модели, у которых есть просвет насквозь. */
function dtMaterials(model) {
  const found = []
  model.traverse((o) => {
    for (const m of Array.isArray(o.material) ? o.material : (o.material ? [o.material] : [])) {
      if (m.isMeshDiffuseTransmissionMaterial && !found.includes(m)) found.push(m)
    }
  })
  return found
}

/**
 * Погасить всё, кроме одного источника ЗА моделью.
 *
 * @returns функция, возвращающая сцену в прежнее состояние.
 */
function backlightOnly(v) {
  const env = v.scene.environment
  const keyWasVisible = v._key.visible
  v.scene.environment = null
  v._key.visible = false

  // Источник строго напротив камеры относительно модели: свет идёт В экран, то есть
  // падает на ту сторону поверхности, которой мы не видим.
  const centre = new THREE.Box3().setFromObject(v.model).getCenter(new THREE.Vector3())
  const away = centre.clone().sub(v.camera.position)
  const back = new THREE.DirectionalLight(0xffffff, 6)
  back.position.copy(centre).add(away)
  back.target.position.copy(centre)
  v.scene.add(back, back.target)

  return () => {
    v.scene.remove(back, back.target)
    v.scene.environment = env
    v._key.visible = keyWasVisible
  }
}

/** Яркость кадра при заданной доле просвета у всех материалов модели. */
function lumAt(v, materials, factor) {
  const было = materials.map((m) => m.diffuseTransmission)
  for (const m of materials) m.diffuseTransmission = factor
  v.renderFrame()
  const снимок = snapshotPixels(v)
  materials.forEach((m, i) => { m.diffuseTransmission = было[i] })
  return meanLum(снимок)
}

beforeAll(async () => {
  if (!МОДЕЛИ_ЕСТЬ) return
  const made = await createViewer()
  viewer = made.viewer
  canvas = made.canvas
})

afterAll(() => disposeViewer(viewer, canvas))

блок('чайная пара: доля просвета лежит в карте' + (МОДЕЛИ_ЕСТЬ ? '' : БЕЗ_МОДЕЛЕЙ), () => {
  let materials
  let shaderErrors

  beforeAll(async () => {
    // Ошибки сборки шейдера three.js не бросает — он пишет их в консоль и рисует пустоту.
    // Ловим их явно: иначе «кадр не изменился» объяснялось бы чем угодно, кроме причины.
    shaderErrors = []
    const было = console.error
    console.error = (...a) => { shaderErrors.push(a.join(' ')); было(...a) }
    try {
      await viewer.load('/DiffuseTransmissionTeacup.glb')
      viewer.renderFrame()
    } finally {
      console.error = было
    }
    materials = dtMaterials(viewer.model)
  })

  it('оба материала прочитаны как материалы с просветом', () => {
    expect(materials.length, 'расширение не дошло до материалов').toBe(2)
    for (const m of materials) {
      expect(m.diffuseTransmission, `${m.name}: доля просвета не та`).toBe(1)
      expect(m.diffuseTransmissionMap, `${m.name}: карта доли не загружена`).toBeTruthy()
      // Цвет спецификация задаёт в ЛИНЕЙНОМ пространстве. Прочитать его как sRGB —
      // показать заметно более светлый просвет, чем задумал автор.
      const c = m.diffuseTransmissionColor
      expect(c.r, `${m.name}: красная доля цвета`).toBeCloseTo(0.84, 2)
      expect(c.g, `${m.name}: зелёная доля цвета`).toBeCloseTo(0.8, 2)
      expect(c.b, `${m.name}: синяя доля цвета`).toBeCloseTo(0.74, 2)
    }
  })

  it('карта доли — не цветная: гамму к ней не применяют', () => {
    // Доля лежит в канале прозрачности той же картинки, что «шероховатость+затенение».
    // Назначить ей sRGB значит разогнуть числа гаммой и получить чужую долю.
    for (const m of materials) {
      expect(m.diffuseTransmissionMap.colorSpace, `${m.name}: карте доли назначено цветовое пространство`)
        .not.toBe(THREE.SRGBColorSpace)
    }
  })

  it('шейдер собрался — в консоли нет ошибок сборки', () => {
    const плохие = shaderErrors.filter((s) => /WebGLProgram|Shader Error|GLSL/i.test(s))
    expect(плохие, 'врезка в шейдер не собралась:\n' + плохие.join('\n')).toEqual([])
  })

  it('свет СЗАДИ доходит до видимых граней — и только через просвет', () => {
    const вернуть = backlightOnly(viewer)
    try {
      const без = lumAt(viewer, materials, 0)
      const с = lumAt(viewer, materials, 1)
      // Без просвета видимые грани отвёрнуты от единственного источника — кадр тёмный.
      expect(без, `без просвета кадр не тёмный (${без.toFixed(1)}) — заготовка светит не сзади`)
        .toBeLessThan(12)
      expect(с, `просвет ничего не добавил: ${без.toFixed(1)} → ${с.toFixed(1)}`)
        .toBeGreaterThan(без + 10)
    } finally {
      вернуть()
    }
  })
})

блок('растение: цвет просвета лежит в отдельной карте' + (МОДЕЛИ_ЕСТЬ ? '' : БЕЗ_МОДЕЛЕЙ), () => {
  let leaves

  beforeAll(async () => {
    await viewer.load('/DiffuseTransmissionPlant.glb')
    viewer.renderFrame()
    leaves = dtMaterials(viewer.model)
  })

  it('расширение стоит ровно на листьях', () => {
    // В файле три материала, расширение — только у `leaves`. Раздать его всем значило бы
    // осветлить подставку и крылья, которых автор просвечивать не просил.
    expect(leaves.length, 'просвет достался не тому числу материалов').toBe(1)
    expect(leaves[0].name).toBe('leaves')
    expect(leaves[0].diffuseTransmission).toBeCloseTo(0.1, 5)
    expect(leaves[0].diffuseTransmissionColorMap, 'карта цвета просвета не загружена').toBeTruthy()
    expect(leaves[0].diffuseTransmissionMap, 'карты доли в этом файле нет — откуда взялась').toBe(null)
  })

  it('карта цвета — цветная: читается как sRGB', () => {
    expect(leaves[0].diffuseTransmissionColorMap.colorSpace).toBe(THREE.SRGBColorSpace)
  })

  it('обрезка по маске и двусторонность не потеряны', () => {
    // Свой класс материала наследует `MeshPhysicalMaterial`, и всё остальное обязано
    // работать как прежде. Лист без `alphaTest` — это прямоугольник вместо листа.
    expect(leaves[0].side, 'лист перестал быть двусторонним').toBe(THREE.DoubleSide)
    expect(leaves[0].alphaTest, 'обрезка по маске потеряна').toBeGreaterThan(0)
  })

  it('свет СЗАДИ проходит сквозь лист', () => {
    const вернуть = backlightOnly(viewer)
    try {
      const без = lumAt(viewer, leaves, 0)
      // Доля в файле — 0.1, для замера поднимаем до 1: спор идёт о том, работает ли
      // канал, а не о том, различима ли глазом десятая его часть.
      const с = lumAt(viewer, leaves, 1)
      expect(с, `просвет ничего не добавил: ${без.toFixed(1)} → ${с.toFixed(1)}`)
        .toBeGreaterThan(без + 5)
    } finally {
      вернуть()
    }
  })
})
