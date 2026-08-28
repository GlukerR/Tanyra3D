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

// ═══════════════════════════════════════════════════════════════════════════
// «Без света» — третий режим, и он тоже выбор, а не отсутствие выбора
//
// ЗАКАЗ (Александр, 2026-08-28): «лайтинг стуидио\ничего. что бы модель могла
// рендерится чёрной. или если например у текстуры есть эмишн и он светится, мы же не
// выбираем свет встроенный в картинку. а хотелось бы его наверняка увидеть».
//
// Отсюда два требования, и второе легко потерять. Первое — гаснет ВСЁ: и наш ключевой,
// и авторские источники, и окружение. Второе — светящаяся карта при этом ОСТАЁТСЯ
// видна: она и есть единственное, ради чего режим заводился, а любой посторонний свет
// её забивает.
//
// Окружение гасится ДО НУЛЯ, а не до остатка, как в режиме файла. Металл и стекло
// станут чёрными — и это ровно то, что просили. Оговорка про FILE_MODE_ENV сюда не
// относится: там речь о чужом замысле, здесь — о прямом выборе человека (Правило 12).
// ═══════════════════════════════════════════════════════════════════════════

describe('свет можно выключить совсем', () => {
  let studio
  let none

  /** Две пластины рядом: одна обычная, вторая светится сама. */
  function modelWithGlow() {
    const group = new THREE.Group()
    const plain = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshStandardMaterial({ color: 0xb0b0b0, roughness: 0.8, metalness: 0 }),
    )
    plain.position.set(-1.2, 0, 0)
    group.add(plain)

    // Светящаяся деталь МАЛЕНЬКАЯ — так она и бывает: лампа, экран, шов. Заодно это
    // делает измеримым главное: почернел весь кадр, кроме неё.
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.6),
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x00ff00, emissiveIntensity: 1 }),
    )
    glow.position.set(1.2, 0, 0)
    group.add(glow)
    return group
  }

  /** Доля непрозрачных пикселей, которые почти чёрные. */
  const darkPct = ({ w, h, px }) => {
    let dark = 0
    let n = 0
    for (let i = 0; i < w * h * 4; i += 4) {
      if (px[i + 3] < 200) continue
      n++
      if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] < 10) dark++
    }
    return n ? (dark / n) * 100 : 0
  }

  /**
   * Сколько пикселей ЯРКИЕ. По яркости, а не по зелёному цвету: кадр проходит через
   * тональную кривую и sRGB, и чистый зелёный доезжает приглушённым — первая редакция
   * искала `g > 120 && r < 90` и не находила ничего, хотя эмиссия была на месте.
   */
  const litPixels = ({ w, h, px }) => {
    let n = 0
    for (let i = 0; i < w * h * 4; i += 4) {
      if (px[i + 3] < 200) continue
      if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] > 40) n++
    }
    return n
  }

  beforeAll(() => {
    // Сцена общая на весь файл, и предыдущие разделы оставили в ней свои заготовки —
    // вместе с авторским солнцем силой 683. Не убрав их, мы мерили бы чужой свет и
    // «полная темнота» не наступила бы никогда.
    for (const o of [...viewer.scene.children]) if (o.isGroup) viewer.scene.remove(o)

    const group = modelWithGlow()
    viewer.scene.add(group)
    viewer.model = group
    viewer._modelLights = viewer._collectModelLights()
    viewer.camera.position.set(0, 0, 5)
    viewer.camera.lookAt(0, 0, 0)

    viewer.setLightMode('studio')
    viewer.renderFrame()
    studio = snapshotPixels(viewer)

    viewer.setLightMode('none')
    viewer.renderFrame()
    none = snapshotPixels(viewer)
  })

  afterAll(() => {
    viewer.setLightMode('studio')
    viewer.model = null
  })

  it('работает и у модели без своих источников — гасить есть что всегда', () => {
    // В отличие от «из файла»: тот у такой модели отклоняется, потому что означал бы
    // необъяснённую темноту. Здесь темнота как раз и заказана.
    expect(viewer._modelLights.length).toBe(0)
    expect(viewer.setLightMode('none'), 'выключение света отклонено').toBe(true)
    expect(viewer.getLightInfo().mode).toBe('none')
  })

  it('гаснет ВСЁ, включая окружение', () => {
    viewer.setLightMode('none')
    expect(viewer._key.visible, 'наш ключевой продолжает светить').toBe(false)
    // Окружение — не свет, а то, что отражается; в режиме файла оно приглушается до
    // остатка. Здесь остатка быть не должно: «свет вырубить» значит вырубить.
    expect(viewer.scene.environmentIntensity, 'окружение осталось подсвечивать модель').toBe(0)
  })

  it('КАДР становится чёрным', () => {
    expect(darkPct(studio), 'студийный кадр и так чёрный — заготовка не та').toBeLessThan(50)
    expect(darkPct(none),
      `без света кадр не почернел (${darkPct(none).toFixed(0)}% тёмных против `
      + `${darkPct(studio).toFixed(0)}% в студии)`).toBeGreaterThan(80)
  })

  it('светящаяся карта видна — ради неё режим и заведён', () => {
    const lit = litPixels(none)
    expect(lit, 'эмиссия погасла вместе со светом — смотреть в этом режиме нечего')
      .toBeGreaterThan(0)
    // И светится ТОЛЬКО она. Если бы яркой осталась половина кадра, значит свет никуда
    // не делся, а тест меряет не то.
    expect(lit, 'ярким остался весь кадр, а не одна светящаяся деталь')
      .toBeLessThan(litPixels(studio) * 0.4)
  })

  it('переключение обратимо', () => {
    viewer.setLightMode('none')
    expect(viewer.setLightMode('studio')).toBe(true)
    expect(viewer._key.visible).toBe(true)
    expect(viewer.scene.environmentIntensity).toBe(1)
  })
})
