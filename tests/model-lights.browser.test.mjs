// tests/model-lights.browser.test.mjs — можно ли погасить свет, который принесла модель.
//
// ЗАКАЗ (Александр, 2026-08-26, про свою модель `вулкан5.glb`): «есть модели которые очень
// пересвечены (потому что там внутри уже стоит моё солнце)… по итогу в моём приложении я
// не могу отключить весь свет в модели и оставить только свой. это проблема будет для
// таких моделей».
//
// ЧТО БЫЛО. Переключатель света гасил ТОЛЬКО наш ключевой источник. Авторские он не
// трогал никогда, потому что до них было нечем дотянуться: вьюер хранил их ЧИСЛО, а не
// список. Значит «студийный» означал наш свет ПОВЕРХ авторского — то есть ни то, ни
// другое, и у модели с солнцем внутри выхода не было вовсе.
//
// Замер по файлу `вулкан5.glb`: два источника, `Sun` силой 683 и точечный силой 543. Наш
// ключевой имеет силу 1.1 — рядом с ними его попросту не видно.
//
// ПОЧЕМУ ТЕСТ БРАУЗЕРНЫЙ И ПО ПИКСЕЛЯМ. Спор идёт о том, что человек УВИДИТ. Проверка
// `light.visible === false` подтвердила бы только флаг; яркость кадра подтверждает
// результат. Сцена строится здесь же — нужен источник заведомо непомерной силы, а
// подбирать его среди готовых моделей значило бы проверять не то (и `вулкан5.glb`
// локальный: на чистом клоне его нет).
//
// ГРАНИЦА. Это ПОКАЗ, а не правка модели: `visible` живёт в сцене просмотра, в файл не
// попадает ничего, и собранная модель увозит оба источника целыми (Правило 11).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as THREE from 'three'
import { createViewer, disposeViewer, snapshotPixels } from '../tests/helpers/viewer-test-utils.mjs'

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

/**
 * Модель с ВСТРОЕННЫМ солнцем — то же, что приносит `вулкан5.glb`.
 *
 * Источник кладётся ВНУТРЬ модели: именно так его создаёт GLTFLoader из
 * KHR_lights_punctual, и именно поэтому до него нельзя было дотянуться снаружи.
 */
function modelWithOwnSun() {
  const group = new THREE.Group()
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(3, 3),
    new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 1, metalness: 0 }),
  )
  group.add(plate)

  const sun = new THREE.DirectionalLight(0xffffff, 683)   // сила как у «Sun» в вулкане
  sun.position.set(0, 0, 5)
  group.add(sun)

  const point = new THREE.PointLight(0xff2810, 543, 0)    // и его же точечный
  point.position.set(0, 0, 2)
  group.add(point)
  return group
}

beforeAll(async () => {
  const made = await createViewer()
  viewer = made.viewer
  canvas = made.canvas
})

afterAll(() => disposeViewer(viewer, canvas))

describe('свет, который принесла модель, можно погасить', () => {
  let studio
  let file

  beforeAll(() => {
    const group = modelWithOwnSun()
    viewer.scene.add(group)
    viewer.model = group
    viewer._modelLights = viewer._collectModelLights()
    viewer.camera.position.set(0, 0, 6)
    viewer.camera.lookAt(0, 0, 0)

    viewer.setLightMode('studio')
    viewer.renderFrame()
    studio = snapshotPixels(viewer)

    viewer.setLightMode('file')
    viewer.renderFrame()
    file = snapshotPixels(viewer)
  })

  afterAll(() => { viewer.model = null })

  it('источники внутри модели найдены — иначе гасить нечего', () => {
    // Заготовка обязана воспроизводить случай: солнце ВНУТРИ модели, а не в сцене.
    expect(viewer._modelLights.length, 'вьюер не увидел источники внутри модели').toBe(2)
  })

  it('в студийном режиме авторские источники ПОГАШЕНЫ', () => {
    viewer.setLightMode('studio')
    for (const l of viewer._modelLights) {
      expect(l.visible, `${l.type} автора остался гореть в студийном режиме`).toBe(false)
    }
    expect(viewer._key.visible, 'наш ключевой погас вместе с ними').toBe(true)
  })

  it('в режиме «из файла» горят авторские, а наш погашен', () => {
    viewer.setLightMode('file')
    for (const l of viewer._modelLights) {
      expect(l.visible, `${l.type} автора не зажёгся в режиме файла`).toBe(true)
    }
    expect(viewer._key.visible, 'наш ключевой светит поверх авторского').toBe(false)
  })

  it('КАДР становится темнее: солнце силой 683 действительно выключено', () => {
    // Главное утверждение файла, и оно про то, что видит человек. Наш ключевой имеет
    // силу 1.1 — если авторские остались бы гореть, кадры совпали бы почти точно.
    const lumStudio = meanLum(studio)
    const lumFile = meanLum(file)
    expect(lumFile, 'кадр со включённым солнцем автора не пересвечен — заготовка не та')
      .toBeGreaterThan(200)
    expect(lumStudio,
      `студийный кадр так же ярок (${lumStudio.toFixed(0)} против ${lumFile.toFixed(0)}): `
      + 'похоже, авторские источники не гаснут').toBeLessThan(lumFile - 40)
  })

  it('переключение обратимо — режим не «залипает»', () => {
    viewer.setLightMode('file')
    viewer.setLightMode('studio')
    expect(viewer._modelLights.every((l) => !l.visible)).toBe(true)
    viewer.setLightMode('file')
    expect(viewer._modelLights.every((l) => l.visible)).toBe(true)
  })
})

describe('модель без своих источников', () => {
  afterAll(() => { viewer.model = null })

  it('режим «из файла» отклоняется — иначе экран станет чёрным', () => {
    const group = new THREE.Group()
    group.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshStandardMaterial()))
    viewer.scene.add(group)
    viewer.model = group
    viewer._modelLights = viewer._collectModelLights()

    expect(viewer._modelLights.length).toBe(0)
    // Так делает и приложение: после каждой загрузки режим сбрасывается в студийный
    // (viewer.ts, _finishLoad). Без этой строки проверка мерила бы не отказ, а остаток
    // состояния от соседнего блока — на чём она и покраснела при первом прогоне.
    viewer.setLightMode('studio')
    expect(viewer.setLightMode('file'), 'переключение прошло, а показывать нечего').toBe(false)
    expect(viewer._key.visible, 'отказ погасил наш свет — модели стало нечем светиться').toBe(true)
  })
})
