import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as THREE from 'three'
import { createViewer, disposeViewer, snapshotPixels } from '../tests/helpers/viewer-test-utils.mjs'

let viewer
let canvas

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

function modelWithOwnSun() {
  const group = new THREE.Group()
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(3, 3),
    new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 1, metalness: 0 }),
  )
  group.add(plate)

  const sun = new THREE.DirectionalLight(0xffffff, 683)
  sun.position.set(0, 0, 5)
  group.add(sun)

  const point = new THREE.PointLight(0xff2810, 543, 0)
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
    viewer.setLightMode('studio')
    expect(viewer.setLightMode('file'), 'переключение прошло, а показывать нечего').toBe(false)
    expect(viewer._key.visible, 'отказ погасил наш свет — модели стало нечем светиться').toBe(true)
  })
})


describe('свет можно выключить совсем', () => {
  let studio
  let none

  function modelWithGlow() {
    const group = new THREE.Group()
    const plain = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshStandardMaterial({ color: 0xb0b0b0, roughness: 0.8, metalness: 0 }),
    )
    plain.position.set(-1.2, 0, 0)
    group.add(plain)

    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.6),
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x00ff00, emissiveIntensity: 1 }),
    )
    glow.position.set(1.2, 0, 0)
    group.add(glow)
    return group
  }

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

  const litPixels = ({ w, h, px }) => {
    let n = 0
    for (let i = 0; i < w * h * 4; i += 4) {
      if (px[i + 3] < 200) continue
      if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] > 40) n++
    }
    return n
  }

  beforeAll(() => {
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
    expect(viewer._modelLights.length).toBe(0)
    expect(viewer.setLightMode('none'), 'выключение света отклонено').toBe(true)
    expect(viewer.getLightInfo().mode).toBe('none')
  })

  it('гаснет ВСЁ, включая окружение', () => {
    viewer.setLightMode('none')
    expect(viewer._key.visible, 'наш ключевой продолжает светить').toBe(false)
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
