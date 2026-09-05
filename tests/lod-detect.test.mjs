import { describe, it, expect } from 'vitest'
import * as THREE from 'three'

import { detectLods, showLod } from '../ui/viewer/lod.js'

const texture = (px) => new THREE.Texture({ width: px, height: px })

function node(name, { seg = 1, size = [1, 1, 1], at = [0, 0, 0], px = 0 } = {}) {
  const material = new THREE.MeshStandardMaterial()
  if (px) material.map = texture(px)
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size, seg, seg, seg), material)
  mesh.name = name
  mesh.position.set(...at)
  return mesh
}

function billboard(name, { w = 1, h = 1, at = [0, 0, 0] } = {}) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial())
  mesh.name = name
  mesh.position.set(...at)
  return mesh
}

const scene = (...children) => {
  const group = new THREE.Group()
  for (const c of children) group.add(c)
  return group
}

const detect = (group) => detectLods({ scene: group })


describe('уровни без слова LOD в именах', () => {
  it('три ступени в одной точке — узнаны измерением', async () => {
    const set = await detect(scene(
      node('well', { seg: 4 }),
      node('well_far', { seg: 2 }),
      node('Plane.003', { seg: 1 }),
    ))
    expect(set, 'уровни не найдены — распознавание опять держится на имени').toBeTruthy()
    expect(set.source).toBe('measured')
    expect(set.levels.map((l) => l.triangles)).toEqual([192, 48, 12])
    expect(set.levels.map((l) => l.name)).toEqual(['well', 'well_far', 'Plane.003'])
  })

  it('колодец, ставший плоским плейном, — тоже уровень', async () => {
    const set = await detect(scene(
      node('well', { seg: 4, size: [1.3, 0.7, 1.3] }),
      node('well2', { seg: 2, size: [1.3, 0.7, 1.3] }),
      billboard('well3', { w: 1.28, h: 0.72 }),
    ))
    expect(set, 'плоский уровень не узнан — габарит принят за чужой').toBeTruthy()
    expect(set.levels.map((l) => l.triangles)).toEqual([192, 48, 2])
  })

  it('витрина в ряд — уровни, а не раскладка частей', async () => {
    const set = await detect(scene(
      node('a', { seg: 4, at: [0, 0, 0] }),
      node('b', { seg: 2, at: [2, 0, 0] }),
      node('c', { seg: 1, at: [4, 0, 0] }),
    ))
    expect(set, 'ряд с ровным шагом не узнан').toBeTruthy()
    expect(set.source).toBe('measured')
  })

  it('лестница по картинкам при одинаковой сетке — тоже уровни', async () => {
    const set = await detect(scene(
      node('a', { seg: 2, px: 2048 }),
      node('b', { seg: 2, px: 1024 }),
      node('c', { seg: 2, px: 512 }),
    ))
    expect(set, 'уровни по размеру текстур не узнаны').toBeTruthy()
    expect(set.levels.map((l) => l.texturePixels)).toEqual([2048 * 2048, 1024 * 1024, 512 * 512])
  })
})


describe('обычные части модели уровнями не считаются', () => {
  it('одинаковые куски (четыре колеса) — не уровни', async () => {
    const set = await detect(scene(
      node('wheel_fl', { seg: 2, at: [-1, 0, 1] }),
      node('wheel_fr', { seg: 2, at: [1, 0, 1] }),
      node('wheel_rl', { seg: 2, at: [-1, 0, -1] }),
      node('wheel_rr', { seg: 2, at: [1, 0, -1] }),
    ))
    expect(set, 'одинаковые части приняты за уровни').toBeNull()
  })

  it('части разного габарита — не уровни', async () => {
    const set = await detect(scene(
      node('body', { seg: 4, size: [2, 2, 2] }),
      node('mirror', { seg: 2, size: [0.5, 0.5, 0.5] }),
      node('bolt', { seg: 1, size: [0.2, 0.2, 0.2] }),
    ))
    expect(set, 'разные по размеру части приняты за уровни').toBeNull()
  })

  it('лестница подробности, но части стоят вразнобой — не уровни', async () => {
    const set = await detect(scene(
      node('a', { seg: 4, at: [0, 0, 0] }),
      node('b', { seg: 2, at: [1.5, 0, 0] }),
      node('c', { seg: 1, at: [5, 0, 0] }),
    ))
    expect(set, 'вразнобой расставленные части приняты за уровни').toBeNull()
  })

  it('двух неподписанных ступеней мало', async () => {
    const set = await detect(scene(
      node('frame', { seg: 4 }),
      node('glass', { seg: 1 }),
    ))
    expect(set, 'пара «крупное + мелкое» принята за уровни').toBeNull()
  })

  it('ступени слишком близкие по подробности — не уровни', async () => {
    const a = node('a', { seg: 4 })
    const b = node('b', { seg: 4 })
    b.geometry = new THREE.BoxGeometry(1, 1, 1, 5, 5, 2)
    const c = node('c', { seg: 4 })
    c.geometry = new THREE.BoxGeometry(1, 1, 1, 4, 4, 3)
    const set = await detect(scene(a, b, c))
    expect(set, 'близкие по подробности части приняты за уровни').toBeNull()
  })

  it('грубее сеткой, но крупнее картинкой — не уровень', async () => {
    const set = await detect(scene(
      node('a', { seg: 4, px: 1024 }),
      node('b', { seg: 2, px: 2048 }),
      node('c', { seg: 1, px: 512 }),
    ))
    expect(set, 'растущая текстура не помешала счесть узлы уровнями').toBeNull()
  })

  it('уровень шире подробного — не огрубление', async () => {
    const set = await detect(scene(
      node('a', { seg: 4, size: [2, 1, 0.5] }),
      node('b', { seg: 2, size: [2, 1, 0.5] }),
      node('c', { seg: 1, size: [2, 1.5, 0.1] }),
    ))
    expect(set, 'раздувшийся узел принят за уровень').toBeNull()
  })
})


describe('имя как улика', () => {
  it('двух подписанных ступеней достаточно', async () => {
    const set = await detect(scene(
      node('well_LOD0', { seg: 4 }),
      node('well_LOD1', { seg: 1 }),
    ))
    expect(set, 'подписанная пара не узнана').toBeTruthy()
    expect(set.source).toBe('names')
    expect(set.levels.map((l) => l.triangles)).toEqual([192, 12])
  })

  it('та же пара без подписи уровнями не считается', async () => {
    const set = await detect(scene(
      node('well_a', { seg: 4 }),
      node('well_b', { seg: 1 }),
    ))
    expect(set).toBeNull()
  })

  it('подписанные узлы отбираются из общей толпы соседей', async () => {
    const set = await detect(scene(
      node('ground', { seg: 1, size: [10, 0.1, 10], at: [0, -1, 0] }),
      node('well_LOD0', { seg: 4 }),
      node('well_LOD1', { seg: 2 }),
    ))
    expect(set.source).toBe('names')
    expect(set.levels).toHaveLength(2)
    expect(set.levels.map((l) => l.name)).toEqual(['well_LOD0', 'well_LOD1'])
  })

  it('порядок решает подробность, а не номер в имени', async () => {
    const set = await detect(scene(
      node('w_LOD0', { seg: 1 }),
      node('w_LOD1', { seg: 4 }),
      node('w_LOD2', { seg: 2 }),
    ))
    expect(set.levels.map((l) => l.name)).toEqual(['w_LOD1', 'w_LOD2', 'w_LOD0'])
  })
})


describe('переключение — состояние показа', () => {
  it('«как в файле» у соседей показывает все уровни сразу', async () => {
    const root = scene(
      node('a', { seg: 4 }),
      node('b', { seg: 2 }),
      node('c', { seg: 1 }),
    )
    const set = await detect(root)

    showLod(set, root, 1)
    expect(root.children.map((o) => o.visible)).toEqual([false, true, false])

    showLod(set, root, null)
    expect(root.children.map((o) => o.visible)).toEqual([true, true, true])

    expect(root.children).toHaveLength(3)
  })
})


describe('куски одного меша уровнями не считаются', () => {
  const withParser = (group, mark) => ({
    scene: group,
    parser: { associations: new Map(group.children.map((c, i) => [c, mark(i)])) },
  })

  it('три примитива одного меша — не уровни', async () => {
    const group = scene(
      node('Cube_1', { seg: 4 }),
      node('Cube_2', { seg: 2 }),
      node('Cube_3', { seg: 1 }),
    )
    const set = await detectLods(withParser(group, (i) => ({ meshes: 0, primitives: i })))
    expect(set, 'разрезанный по материалам меш принят за три уровня').toBeNull()
  })

  it('те же объекты как узлы файла — уровни', async () => {
    const group = scene(
      node('Cube_1', { seg: 4 }),
      node('Cube_2', { seg: 2 }),
      node('Cube_3', { seg: 1 }),
    )
    const set = await detectLods(withParser(group, (i) => ({ nodes: i })))
    expect(set, 'узлы файла не узнаны').toBeTruthy()
    expect(set.levels).toHaveLength(3)
  })
})
