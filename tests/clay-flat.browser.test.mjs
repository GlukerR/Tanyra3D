import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as THREE from 'three'
import {
  createViewer,
  disposeViewer,
  snapshotPixels,
} from '../tests/helpers/viewer-test-utils.mjs'

let viewer
let canvas

function plate(x, z, tiltDeg) {
  const geom = new THREE.PlaneGeometry(1.6, 1.6)
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xffffff }))
  mesh.rotation.x = THREE.MathUtils.degToRad(tiltDeg)
  mesh.position.set(x, 0, z)
  return mesh
}

function meanLum({ w, h, px }, x0, x1, y0, y1) {
  let sum = 0
  let n = 0
  for (let y = Math.round(y0 * h); y < Math.round(y1 * h); y++) {
    for (let x = Math.round(x0 * w); x < Math.round(x1 * w); x++) {
      const i = (y * w + x) * 4
      if (px[i + 3] < 200) continue
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

    const diff = Math.abs(flat.lum - tilted.lum)
    expect(diff, `тона почти совпали: ${flat.lum.toFixed(1)} и ${tilted.lum.toFixed(1)}`)
      .toBeGreaterThan(12)

    viewer.scene.remove(group)
    viewer.model = null
  })

  it('две параллельные пластины различаются по глубине', () => {
    const CAM_Z = 6
    const NEAR_Z = 1.2
    const FAR_Z = -1.8
    const group = new THREE.Group()
    const p = plate(0, NEAR_Z, 0)
    group.add(p)
    viewer.scene.add(group)
    viewer.model = group
    viewer._clayBounds = null
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
    expect(farPatch.n, 'отодвинутая пластина заняла на экране другое место').toBe(nearPatch.n)

    expect(nearPatch.lum, `ближняя ${nearPatch.lum.toFixed(1)} не светлее дальней ${farPatch.lum.toFixed(1)}`)
      .toBeGreaterThan(farPatch.lum + 8)

    viewer.scene.remove(group)
    viewer.model = null
  })

  it('«материалы из файла» не подкрашиваются глубиной', () => {
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


describe('глина у модели без нормалей', () => {
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

describe('глина убирает за собой', () => {
  it('выход из глины снимает досчитанные нормали, родные не трогает', () => {
    const group = new THREE.Group()
    const без = plate(-1.1, 0, 0)
    без.geometry.deleteAttribute('normal')
    const родные = plate(1.1, 0, 0)
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
