import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest'
import * as THREE from 'three'
import { createViewer, disposeViewer, snapshotPixels } from '../tests/helpers/viewer-test-utils.mjs'

const МОДЕЛИ_ЕСТЬ = inject('diffuse-transmission-models-available') === true
const БЕЗ_МОДЕЛЕЙ = ' [пропущено: нет локально DiffuseTransmissionTeacup.glb / DiffuseTransmissionPlant.glb]'
const блок = МОДЕЛИ_ЕСТЬ ? describe : describe.skip

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

function dtMaterials(model) {
  const found = []
  model.traverse((o) => {
    for (const m of Array.isArray(o.material) ? o.material : (o.material ? [o.material] : [])) {
      if (m.isMeshDiffuseTransmissionMaterial && !found.includes(m)) found.push(m)
    }
  })
  return found
}

function backlightOnly(v) {
  const env = v.scene.environment
  const keyWasVisible = v._key.visible
  v.scene.environment = null
  v._key.visible = false

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
      const c = m.diffuseTransmissionColor
      expect(c.r, `${m.name}: красная доля цвета`).toBeCloseTo(0.84, 2)
      expect(c.g, `${m.name}: зелёная доля цвета`).toBeCloseTo(0.8, 2)
      expect(c.b, `${m.name}: синяя доля цвета`).toBeCloseTo(0.74, 2)
    }
  })

  it('карта доли — не цветная: гамму к ней не применяют', () => {
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
    expect(leaves[0].side, 'лист перестал быть двусторонним').toBe(THREE.DoubleSide)
    expect(leaves[0].alphaTest, 'обрезка по маске потеряна').toBeGreaterThan(0)
  })

  it('свет СЗАДИ проходит сквозь лист', () => {
    const вернуть = backlightOnly(viewer)
    try {
      const без = lumAt(viewer, leaves, 0)
      const с = lumAt(viewer, leaves, 1)
      expect(с, `просвет ничего не добавил: ${без.toFixed(1)} → ${с.toFixed(1)}`)
        .toBeGreaterThan(без + 5)
    } finally {
      вернуть()
    }
  })
})
