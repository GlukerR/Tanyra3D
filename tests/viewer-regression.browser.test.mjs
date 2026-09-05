import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as THREE from 'three'
import {
  createViewer,
  disposeViewer,
  setupDualViewportDOM,
  teardownDualViewportDOM,
  resetAnimationClipIndex,
} from '../tests/helpers/viewer-test-utils.mjs'

const CUBE_URL = '/Dirty%20Cube%2001.glb'
const ANIM_MODEL_URL = '/chibi_zenitsu.glb'
const LILITH_URL = '/Lilith%20Character%2001.glb'
const CTHULHU_URL = '/Cthulhu%20Stone%2001.glb'
const PARKERGIRL_URL = '/parkergirl.glb'
const DRACO_URL = '/Draco%20Compressed%20Input%2001.glb'
const MESHOPT_URL = '/Meshopt%20Compressed%20Input%2001.glb'

const MODEL_FILES = [
  'Dirty Cube 01.glb',
  'Instance Grid 01.glb',
  'Morph Cube 01.glb',
  'Ortho Camera 01.glb',
  'Vertex Colors 01.glb',
  'Draco Compressed Input 01.glb',
  'Meshopt Compressed Input 01.glb',
  'Linked Duplicates Grid 01.glb',
  'Orphan Texture Cube 01.glb',
  'Preinstanced Grid 01.glb',
  'Truncated Broken 01.glb',
  'chibi_zenitsu.glb',
  'Lilith Character 01.glb',
  'Cthulhu Stone 01.glb',
  'parkergirl.glb',
  'ABeautifulGame.glb',
  'MosquitoInAmber.glb',
  'IridescenceLamp.glb',
  'SunglassesKhronos.glb',
  'SpecularSilkPouf.glb',
  'DiffuseTransmissionTeacup.glb',
  'ToyCar.glb',
  'IridescentDishWithOlives.glb',
  'DiffuseTransmissionPlant.glb',
  'PotOfCoalsAnimationPointer.glb',
  'ChronographWatch.glb',
  'AnisotropyBarnLamp.glb',
  'AnimationPointerUVs.glb',
  'SheenWoodLeatherSofa.glb',
  'CommercialRefrigerator.glb',
  'CarConcept.glb',
  'StoneWellLods.glb',
  'StoneWellLodsFlat.glb',
  'Production Draco Webp 01.glb',
  'Production Multi UV 01.glb',
  'Production Many Materials 01.glb',
]

const EXPECT_FAIL = new Set(['Truncated Broken 01.glb'])

const MODEL_PROBES = await Promise.all(
  MODEL_FILES.map(async (file) => {
    const url = '/' + encodeURIComponent(file)
    try {
      const res = await fetch(url, { method: 'HEAD' })
      const len = Number(res.headers.get('content-length'))
      return { file, url, present: res.ok, size: Number.isFinite(len) ? len : 0 }
    } catch (e) {
      return { file, url, present: false, size: 0 }
    }
  }),
)

const modelPresent = (file) => MODEL_PROBES.some((p) => p.file === file && p.present)
const missingOf = (files) => files.filter((f) => !modelPresent(f))
const skipNote = (missing) => `[пропущено: нет локально — ${missing.join(', ')}]`

const itWithModels = (files, name, fn, timeout) => {
  const missing = missingOf(files)
  return missing.length
    ? it.skip(`${name} ${skipNote(missing)}`, () => {}, timeout)
    : it(name, fn, timeout)
}

const describeWithModels = (files, name, fn) => {
  const missing = missingOf(files)
  return missing.length ? describe.skip(`${name} ${skipNote(missing)}`, fn) : describe(name, fn)
}


describe('Viewer — camera state (browser)', () => {
  let canvas
  let viewer

  beforeAll(async () => {
    const result = await createViewer()
    canvas = result.canvas
    viewer = result.viewer
  })

  afterAll(() => {
    disposeViewer(viewer, canvas)
  })

  it('getCameraState() returns position, target, near, far, minDistance, maxDistance', () => {
    const state = viewer.getCameraState()
    expect(state).toHaveProperty('position')
    expect(state).toHaveProperty('target')
    expect(state).toHaveProperty('near')
    expect(state).toHaveProperty('far')
    expect(state).toHaveProperty('minDistance')
    expect(state).toHaveProperty('maxDistance')
    expect(Number.isFinite(state.position.x)).toBe(true)
    expect(Number.isFinite(state.target.x)).toBe(true)
    expect(Number.isFinite(state.near)).toBe(true)
    expect(Number.isFinite(state.far)).toBe(true)
    expect(state.minDistance).toBeGreaterThanOrEqual(0)
    expect(state.maxDistance).toBeGreaterThanOrEqual(0)
  })

  it('applyCameraState() sets near, far, minDistance, maxDistance and updates projection matrix', () => {
    const original = viewer.getCameraState()
    const newState = {
      position: { ...original.position },
      target: { ...original.target },
      near: 0.05,
      far: 500,
      minDistance: 0.1,
      maxDistance: 100,
    }
    viewer.applyCameraState(newState)

    const after = viewer.getCameraState()
    expect(after.near).toBe(0.05)
    expect(after.far).toBe(500)
    expect(after.minDistance).toBe(0.1)
    expect(after.maxDistance).toBe(100)

    viewer.applyCameraState(original)
  })

  it('снимок камеры — простые числа, а не объекты движка', () => {
    const state = viewer.getCameraState()
    for (const key of ['position', 'target']) {
      const v = state[key]
      expect(Object.getPrototypeOf(v), `${key} несёт объект движка, а не данные`)
        .toBe(Object.prototype)
      expect(Object.keys(v).sort()).toEqual(['x', 'y', 'z'])
      expect(() => structuredClone(v)).not.toThrow()
    }
  })

  it('setExposure() validates input, falls back to 1 for non-finite values', () => {
    viewer.setExposure(2)
    expect(viewer.renderer.toneMappingExposure).toBe(2)

    viewer.setExposure(NaN)
    expect(viewer.renderer.toneMappingExposure).toBe(1)

    viewer.setExposure(undefined)
    expect(viewer.renderer.toneMappingExposure).toBe(1)

    viewer.setExposure(null)
    expect(viewer.renderer.toneMappingExposure).toBe(0)
  })
})


describe('Viewer — model loading (browser)', () => {
  let canvas
  let viewer

  beforeAll(async () => {
    const result = await createViewer()
    canvas = result.canvas
    viewer = result.viewer
  })

  afterAll(() => {
    disposeViewer(viewer, canvas)
  })

  it('loads a GLB model and returns stats', async () => {
    const gltf = await viewer.load(CUBE_URL)
    expect(gltf).toBeTruthy()
    expect(gltf.scene).toBeTruthy()

    const stats = viewer.getStats()
    expect(stats).not.toBeNull()
    expect(stats.triangles).toBeGreaterThan(0)
    expect(stats.vertices).toBeGreaterThan(0)
    expect(stats.drawCalls).toBeGreaterThan(0)
  })

  it('camera state is set after model load (frame() ran)', () => {
    const state = viewer.getCameraState()
    expect(state.near).toBeGreaterThan(0)
    expect(state.near).toBeLessThan(1)
    expect(state.far).toBeGreaterThan(10)
    expect(state.minDistance).toBeGreaterThan(0)
    expect(state.maxDistance).toBeGreaterThan(state.minDistance)
    expect(Number.isFinite(state.maxDistance)).toBe(true)
    expect(Number.isFinite(state.target.x)).toBe(true)
    expect(Number.isFinite(state.target.y)).toBe(true)
    expect(Number.isFinite(state.target.z)).toBe(true)
  })

  it('detectSource() returns compression info for the loaded model', () => {
    const detected = viewer.getDetection()
    expect(detected).not.toBeNull()
    expect(typeof detected.draco).toBe('boolean')
    expect(typeof detected.meshopt).toBe('boolean')
    expect(typeof detected.ktx2).toBe('boolean')
  })
})


describe('Viewer — animation (browser)', () => {
  let canvas
  let viewer

  beforeAll(async () => {
    const result = await createViewer()
    canvas = result.canvas
    viewer = result.viewer
  })

  afterAll(() => {
    disposeViewer(viewer, canvas)
  })

  itWithModels(['chibi_zenitsu.glb'], 'loads an animated model and getAnimationInfo() returns clip info', async () => {
    await viewer.load(ANIM_MODEL_URL)
    const info = viewer.getAnimationInfo()
    expect(info.count).toBeGreaterThanOrEqual(1)
    expect(info.names.length).toBe(info.count)
    expect(info.index).toBe(0)
    expect(info.duration).toBeGreaterThan(0)
  })

  itWithModels(['chibi_zenitsu.glb'], 'playClip() switches to a different clip and getAnimationInfo().index matches', () => {
    const info = viewer.getAnimationInfo()
    if (info.count < 2) return

    viewer.playClip(1)
    const after = viewer.getAnimationInfo()
    expect(after.index).toBe(1)

    viewer.playClip(0)
    expect(viewer.getAnimationInfo().index).toBe(0)
  })

  itWithModels(['chibi_zenitsu.glb'], 'setAnimationTime() advances animation without throwing', () => {
    viewer.setAnimationTime(0.5)
    expect(true).toBe(true)
  })

  it('Animated Pointer 01 — канал по указателю доезжает дорожкой, а не пустым клипом', async () => {
    await viewer.load('/Animated%20Pointer%2001.glb')
    const info = viewer.getAnimationInfo()
    expect(info.count).toBe(1)
    expect(info.duration).toBeGreaterThan(0)

    const clip = viewer.clips[0]
    expect(clip.tracks.length).toBeGreaterThan(0)
    expect(clip.tracks.some((t) => /color/i.test(t.name))).toBe(true)
  })

  it('Animated Pointer 01 — цвет материала действительно меняется во времени', async () => {
    await viewer.load('/Animated%20Pointer%2001.glb')

    const colorAt = (t) => {
      viewer.setAnimationTime(t)
      let found = null
      viewer.model.traverse((o) => {
        if (found === null && o.material && o.material.color) found = o.material.color.clone()
      })
      return found
    }

    const start = colorAt(0)
    const later = colorAt(0.9)
    expect(start).not.toBeNull()
    expect(later).not.toBeNull()
    expect(later.r).toBeLessThan(start.r)
    expect(later.b).toBeGreaterThan(start.b)
  })

  it('Animated Pointer 01 — осиротевший канал не рушит загрузку модели', async () => {
    const buf = new Uint8Array(await (await fetch('/Animated%20Pointer%2001.glb')).arrayBuffer())
    const view = new DataView(buf.buffer)
    const jsonLen = view.getUint32(12, true)
    const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)))

    delete json.extensionsUsed
    delete json.animations[0].channels[0].target.extensions

    let text = JSON.stringify(json)
    while (text.length % 4) text += ' '
    const jsonBytes = new TextEncoder().encode(text)
    const bin = buf.subarray(20 + jsonLen)

    const out = new Uint8Array(20 + jsonBytes.length + bin.length)
    const ov = new DataView(out.buffer)
    out.set(buf.subarray(0, 20))
    ov.setUint32(8, out.length, true)
    ov.setUint32(12, jsonBytes.length, true)
    out.set(jsonBytes, 20)
    out.set(bin, 20 + jsonBytes.length)

    const url = URL.createObjectURL(new Blob([out], { type: 'model/gltf-binary' }))
    try {
      const stats = await viewer.load(url)
      expect(stats).toBeTruthy()
      expect(viewer.model).toBeTruthy()
      const info = viewer.getAnimationInfo()
      expect(info.count === 0 || viewer.clips[0].tracks.length === 0).toBe(true)
    } finally {
      URL.revokeObjectURL(url)
    }
  })

  itWithModels(['PotOfCoalsAnimationPointer.glb'], 'PotOfCoals — марево над углями действительно вращается', async () => {
    await viewer.load('/PotOfCoalsAnimationPointer.glb')

    const read = (t) => {
      viewer.setAnimationTime(t)
      let normal = null; let thickness = null
      viewer.model.traverse((o) => {
        const m = o.material
        if (!m || m.name !== 'HeatDome') return
        if (m.normalMap) normal = m.normalMap.rotation
        if (m.thicknessMap) thickness = m.thicknessMap.rotation
      })
      return { normal, thickness }
    }

    const a = read(0)
    const b = read(1.5)
    expect(a.normal, 'у материала нет карты нормалей — модель не та').not.toBeNull()
    expect(a.thickness, 'у материала нет карты толщины — модель не та').not.toBeNull()
    expect(b.normal, 'поворот нормалей стоит на месте').not.toBe(a.normal)
    expect(b.thickness, 'поворот толщины стоит на месте').not.toBe(a.thickness)
    expect(Math.sign(b.normal - a.normal)).not.toBe(Math.sign(b.thickness - a.thickness))
  })

  itWithModels(['AnimationPointerUVs.glb'], 'AnimationPointerUVs — развёртки едут больше чем у пары слотов', async () => {
    await viewer.load('/AnimationPointerUVs.glb')

    const snapshot = (t) => {
      viewer.setAnimationTime(t)
      const out = []
      viewer.model.traverse((o) => {
        const m = o.material
        if (!m) return
        for (const [key, v] of Object.entries(m)) {
          if (v && v.isTexture) out.push(`${key}:${v.rotation}:${v.offset.x},${v.offset.y}:${v.repeat.x},${v.repeat.y}`)
        }
      })
      return out
    }

    const a = snapshot(0)
    const b = snapshot(2)
    expect(a.length).toBeGreaterThan(10)
    const moved = a.filter((s, i) => s !== b[i]).length
    expect(moved, 'развёртки текстур стоят на месте').toBeGreaterThan(50)
  })

  itWithModels(['AnimationPointerUVs.glb'], 'AnimationPointerUVs — незнакомый слот в канале тихо пропускается, остальные развёртки едут', async () => {
    const buf = new Uint8Array(await (await fetch('/AnimationPointerUVs.glb')).arrayBuffer())
    const view = new DataView(buf.buffer)
    const jsonLen = view.getUint32(12, true)
    const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)))

    let changed = false
    for (const anim of json.animations || []) {
      for (const ch of anim.channels || []) {
        const ext = ch.target && ch.target.extensions && ch.target.extensions['KHR_animation_pointer']
        if (!ext || typeof ext.pointer !== 'string') continue
        const m = ext.pointer.match(/^(\/materials\/\d+\/)(.+)(\/extensions\/KHR_texture_transform\/(?:offset|rotation|scale))$/)
        if (!m) continue
        const segs = m[2].split('/')
        const slot = segs[segs.length - 1]
        if (!slot || !slot.endsWith('Texture')) continue
        segs[segs.length - 1] = 'notInTableTexture'
        ext.pointer = m[1] + segs.join('/') + m[3]
        changed = true
        break
      }
      if (changed) break
    }
    expect(changed).toBe(true)

    let text = JSON.stringify(json)
    while (text.length % 4) text += ' '
    const jsonBytes = new TextEncoder().encode(text)
    const bin = buf.subarray(20 + jsonLen)
    const out = new Uint8Array(20 + jsonBytes.length + bin.length)
    const ov = new DataView(out.buffer)
    out.set(buf.subarray(0, 20))
    ov.setUint32(8, out.length, true)
    ov.setUint32(12, jsonBytes.length, true)
    out.set(jsonBytes, 20)
    out.set(bin, 20 + jsonBytes.length)

    const url = URL.createObjectURL(new Blob([out], { type: 'model/gltf-binary' }))
    try {
      const stats = await viewer.load(url)
      expect(stats).toBeTruthy()
      expect(viewer.model).toBeTruthy()

      const snapshot = (t) => {
        viewer.setAnimationTime(t)
        const out = []
        viewer.model.traverse((o) => {
          const m = o.material
          if (!m) return
          for (const [key, v] of Object.entries(m)) {
            if (v && v.isTexture) out.push(`${key}:${v.rotation}:${v.offset.x},${v.offset.y}:${v.repeat.x},${v.repeat.y}`)
          }
        })
        return out
      }
      const a = snapshot(0)
      const b = snapshot(2)
      const moved = a.filter((s, i) => s !== b[i]).length
      expect(moved, 'развёртки текстур застыли после пропуска незнакомого слота').toBeGreaterThan(50)
    } finally {
      URL.revokeObjectURL(url)
    }
  })

  itWithModels(['Cthulhu Stone 01.glb'], 'loads Cthulhu Stone (morph targets) — getAnimationInfo shows 1 clip named Scene', async () => {
    await viewer.load(CTHULHU_URL)
    const info = viewer.getAnimationInfo()
    expect(info.count).toBe(1)
    expect(info.names.length).toBe(1)
    expect(info.names[0]).toMatch(/Scene/)
    expect(info.index).toBe(0)
    expect(info.duration).toBeGreaterThan(0)
  })

  itWithModels(['Cthulhu Stone 01.glb'], 'playClip(0) does not throw on single-clip Cthulhu', () => {
    expect(() => viewer.playClip(0)).not.toThrow()
    const info = viewer.getAnimationInfo()
    expect(info.count).toBe(1)
    expect(info.index).toBe(0)
  })

  itWithModels(['parkergirl.glb'], 'loads parkergirl (skinning) — getAnimationInfo shows 1 clip named MorphBake', async () => {
    await viewer.load(PARKERGIRL_URL)
    const info = viewer.getAnimationInfo()
    expect(info.count).toBe(1)
    expect(info.names.length).toBe(1)
    expect(info.names[0]).toMatch(/MorphBake/)
    expect(info.index).toBe(0)
    expect(info.duration).toBeGreaterThan(0)
  })

  itWithModels(['parkergirl.glb'], 'playClip(0) does not throw on single-clip parkergirl', () => {
    expect(() => viewer.playClip(0)).not.toThrow()
    const info = viewer.getAnimationInfo()
    expect(info.count).toBe(1)
    expect(info.index).toBe(0)
  })

  it('model without animations returns count: 0 and index: -1', async () => {
    await viewer.load(CUBE_URL)
    const info = viewer.getAnimationInfo()
    expect(info.count).toBe(0)
    expect(info.names).toEqual([])
    expect(info.index).toBe(-1)
  })
})


describe('DualViewport — animation sync (browser)', () => {
  beforeAll(async () => {
    await setupDualViewportDOM()
  })

  afterAll(() => {
    teardownDualViewportDOM()
  })

  it('OptiViewer global API is available', () => {
    expect(window.OptiViewer).toBeTruthy()
    expect(typeof window.OptiViewer.loadOriginal).toBe('function')
    expect(typeof window.OptiViewer.getAnimation).toBe('function')
    expect(typeof window.OptiViewer.selectAnimationClip).toBe('function')
    expect(typeof window.OptiViewer.resetView).toBe('function')
    expect(typeof window.OptiViewer.setExposure).toBe('function')
    expect(typeof window.OptiViewer.cameraStates).toBe('function')
  })

  itWithModels(['chibi_zenitsu.glb'], 'loadOriginal() loads a model and getAnimation() returns leftIndex/rightIndex', async () => {
    const response = await fetch(ANIM_MODEL_URL)
    const blob = await response.blob()
    const file = new File([blob], 'chibi_zenitsu.glb', { type: 'model/gltf-binary' })

    const result = await window.OptiViewer.loadOriginal(file)
    expect(result).not.toBeNull()
    expect(result.stats).toBeTruthy()
    expect(result.stats.triangles).toBeGreaterThan(0)

    const anim = window.OptiViewer.getAnimation()
    expect(anim).toHaveProperty('leftIndex')
    expect(anim).toHaveProperty('rightIndex')
    expect(typeof anim.leftIndex).toBe('number')
    expect(typeof anim.rightIndex).toBe('number')
  })

  itWithModels(['chibi_zenitsu.glb'], 'selectAnimationClip() updates both leftIndex and rightIndex', () => {
    const before = window.OptiViewer.getAnimation()
    if (before.count < 2) return

    window.OptiViewer.selectAnimationClip(1)
    const after = window.OptiViewer.getAnimation()
    expect(after.leftIndex).toBe(1)
    expect(after.rightIndex).toBe(1)

    window.OptiViewer.selectAnimationClip(0)
  })

  itWithModels(['Lilith Character 01.glb'], 'selectAnimationClip() persists non-zero index across reloads (same animated model)', async () => {
    const resp1 = await fetch(LILITH_URL)
    const file1 = new File([await resp1.blob()], 'Lilith Character 01.glb', { type: 'model/gltf-binary' })
    const result1 = await window.OptiViewer.loadOriginal(file1)
    expect(result1).not.toBeNull()

    const anim1 = window.OptiViewer.getAnimation()
    expect(anim1.count).toBeGreaterThanOrEqual(3)

    window.OptiViewer.selectAnimationClip(1)
    const anim2 = window.OptiViewer.getAnimation()
    expect(anim2.leftIndex).toBe(1)
    expect(anim2.rightIndex).toBe(-1)

    const resp2 = await fetch(LILITH_URL)
    const file2 = new File([await resp2.blob()], 'Lilith Character 01.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file2)

    const anim3 = window.OptiViewer.getAnimation()
    expect(anim3.leftIndex).toBe(1)
    expect(anim3.count).toBeGreaterThanOrEqual(3)

    const resp3 = await fetch(CUBE_URL)
    const file3 = new File([await resp3.blob()], 'Dirty Cube 01.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file3)

    const anim4 = window.OptiViewer.getAnimation()
    expect(anim4.leftIndex).toBe(-1)
    expect(anim4.rightIndex).toBe(-1)
    expect(anim4.count).toBe(0)
  })

  it('cameraStates() returns camera state for both viewports', () => {
    const states = window.OptiViewer.cameraStates()
    expect(states).toHaveProperty('left')
    expect(states).toHaveProperty('right')
    if (states.left) {
      expect(states.left).toHaveProperty('near')
      expect(states.left).toHaveProperty('far')
      expect(states.left).toHaveProperty('position')
    }
  })

  it('setExposure() applies to both viewports', () => {
    window.OptiViewer.setExposure(1.5)
    expect(window.OptiViewer.getExposure()).toBe(1.5)
    window.OptiViewer.setExposure(1.0)
    expect(window.OptiViewer.getExposure()).toBe(1)
  })

  it('resetView() frames one viewport and copies camera state', () => {
    expect(() => window.OptiViewer.resetView()).not.toThrow()
  })
})


describe('Animation panel (DOM) — anim-controls visibility and clip list', () => {
  let animControls
  let animClipSel

  beforeAll(async () => {
    await setupDualViewportDOM()
    resetAnimationClipIndex()

    animControls = document.createElement('div')
    animControls.id = 'anim-controls'
    animControls.className = 'vp-anim hidden'
    animControls.style.display = ''

    animClipSel = document.createElement('select')
    animClipSel.id = 'anim-clip'
    animClipSel.className = 'vp-anim-clip'

    animControls.appendChild(animClipSel)

    const playBtn = document.createElement('button')
    playBtn.id = 'anim-play-btn'
    playBtn.className = 'vp-tool is-on'
    animControls.appendChild(playBtn)

    const seek = document.createElement('input')
    seek.id = 'anim-seek'
    seek.className = 'vp-slider'
    seek.type = 'range'
    animControls.appendChild(seek)

    const timeEl = document.createElement('span')
    timeEl.id = 'anim-time'
    timeEl.className = 'vp-ctl-value'
    timeEl.textContent = '0.0s'
    animControls.appendChild(timeEl)

    document.body.appendChild(animControls)

    window.onOptiViewerModelLoaded = () => {
      if (!window.OptiViewer || !window.OptiViewer.getAnimation) return
      const info = window.OptiViewer.getAnimation()
      const has = info.count > 0
      animControls.classList.toggle('hidden', !has)
      if (!has) {
        animClipSel.innerHTML = ''
        return
      }

      const signature = info.names.join('\u0000')
      if (animClipSel.dataset.signature !== signature) {
        animClipSel.dataset.signature = signature
        animClipSel.innerHTML = ''
        info.names.forEach((name, i) => {
          const opt = document.createElement('option')
          opt.value = String(i)
          opt.textContent = name
          animClipSel.appendChild(opt)
        })
        animClipSel.classList.toggle('hidden', info.count < 2)
      }
      if (Number(animClipSel.value) !== info.index) {
        animClipSel.value = String(info.index)
      }
    }

    window.onOptiViewerModelLoaded()
  })

  afterAll(() => {
    animControls?.remove()
    teardownDualViewportDOM()
    delete window.onOptiViewerModelLoaded
  })

  it('starts hidden — no model loaded', () => {
    expect(animControls.classList.contains('hidden')).toBe(true)
    expect(animClipSel.children.length).toBe(0)
  })

  it('non-animated model (Dirty Cube) — panel stays hidden, clip list empty', async () => {
    const resp = await fetch(CUBE_URL)
    const file = new File([await resp.blob()], 'Dirty Cube 01.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file)

    expect(animControls.classList.contains('hidden')).toBe(true)
    expect(animClipSel.children.length).toBe(0)
  })

  itWithModels(['chibi_zenitsu.glb'], 'animated model with 1 clip (chibi_zenitsu) — panel visible, clip selector hidden', async () => {
    const resp = await fetch(ANIM_MODEL_URL)
    const file = new File([await resp.blob()], 'chibi_zenitsu.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file)

    expect(animControls.classList.contains('hidden')).toBe(false)
    expect(animClipSel.children.length).toBe(1)
    expect(animClipSel.classList.contains('hidden')).toBe(true)
  })

  itWithModels(['Lilith Character 01.glb'], 'model with 3 clips (Lilith) — panel visible, clip selector has 3 options', async () => {
    const resp = await fetch(LILITH_URL)
    const file = new File([await resp.blob()], 'Lilith Character 01.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file)

    expect(animControls.classList.contains('hidden')).toBe(false)
    expect(animClipSel.children.length).toBe(3)
    expect(animClipSel.classList.contains('hidden')).toBe(false)

    const names = [...animClipSel.options].map((o) => o.textContent)
    expect(names.some((n) => n.includes('Idle'))).toBe(true)
    expect(names.some((n) => n.includes('Lilith_Walk_Loop'))).toBe(true)
    expect(names.some((n) => n.includes('0-T-Pose'))).toBe(true)
  })

  itWithModels(['Cthulhu Stone 01.glb'], 'single-clip model (Cthulhu Stone) — panel visible, clip selector hidden', async () => {
    const resp = await fetch(CTHULHU_URL)
    const file = new File([await resp.blob()], 'Cthulhu Stone 01.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file)

    expect(animControls.classList.contains('hidden')).toBe(false)
    expect(animClipSel.children.length).toBe(1)
    expect(animClipSel.classList.contains('hidden')).toBe(true)
    expect(animClipSel.options[0].textContent).toMatch(/Scene/)
  })

  it('after reset() — panel hides again', () => {
    window.OptiViewer.reset()
    expect(animControls.classList.contains('hidden')).toBe(true)
    expect(animClipSel.children.length).toBe(0)
  })
})


describe('Viewer — compressed models (browser)', () => {
  let canvas
  let viewer

  beforeAll(async () => {
    const result = await createViewer()
    canvas = result.canvas
    viewer = result.viewer
  })

  afterAll(() => {
    disposeViewer(viewer, canvas)
  })

  it('loads a Draco-compressed model and returns stats', async () => {
    const gltf = await viewer.load(DRACO_URL)
    expect(gltf).toBeTruthy()
    expect(gltf.scene).toBeTruthy()

    const stats = viewer.getStats()
    expect(stats).not.toBeNull()
    expect(stats.triangles).toBeGreaterThan(0)
    expect(stats.vertices).toBeGreaterThan(0)
    expect(stats.drawCalls).toBeGreaterThan(0)

    const state = viewer.getCameraState()
    expect(Number.isFinite(state.near)).toBe(true)
    expect(Number.isFinite(state.far)).toBe(true)
  })

  it('detectSource correctly identifies Draco compression', () => {
    const detected = viewer.getDetection()
    expect(detected).not.toBeNull()
    expect(detected.draco).toBe(true)
    expect(detected.meshopt).toBe(false)
    expect(detected.ktx2).toBe(false)
  })

  it('loads a Meshopt-compressed model and returns stats', async () => {
    const gltf = await viewer.load(MESHOPT_URL)
    expect(gltf).toBeTruthy()
    expect(gltf.scene).toBeTruthy()

    const stats = viewer.getStats()
    expect(stats).not.toBeNull()
    expect(stats.triangles).toBeGreaterThan(0)
    expect(stats.vertices).toBeGreaterThan(0)
    expect(stats.drawCalls).toBeGreaterThan(0)
  })

  it('detectSource correctly identifies Meshopt compression', () => {
    const detected = viewer.getDetection()
    expect(detected).not.toBeNull()
    expect(detected.draco).toBe(false)
    expect(detected.meshopt).toBe(true)
    expect(detected.ktx2).toBe(false)
  })

  it('loads an uncompressed model after a compressed one (reuses viewer)', async () => {
    const gltf = await viewer.load(CUBE_URL)
    expect(gltf).toBeTruthy()

    const detected = viewer.getDetection()
    expect(detected).not.toBeNull()
    expect(detected.draco).toBe(false)
    expect(detected.meshopt).toBe(false)
    expect(detected.ktx2).toBe(false)
  })

  it('handles 404 gracefully — non-existent model URL', async () => {
    await expect(viewer.load('/nonexistent.glb')).rejects.toThrow()
  })

  it('reloads a working model after a failed load', async () => {
    await expect(viewer.load('/nonexistent.glb')).rejects.toThrow()

    const gltf = await viewer.load(CUBE_URL)
    expect(gltf).toBeTruthy()
    expect(viewer.getStats()?.triangles).toBeGreaterThan(0)
  })
})


describeWithModels(['Lilith Character 01.glb'], 'DualViewport — both viewports loaded with Lilith (3 clips)', () => {
  beforeAll(async () => {
    await setupDualViewportDOM()
    resetAnimationClipIndex()
  })

  afterAll(() => {
    teardownDualViewportDOM()
  })

  it('loads Lilith into left (loadOriginal) then right (loadOptimized)', async () => {
    const resp1 = await fetch(LILITH_URL)
    const file = new File([await resp1.blob()], 'Lilith Character 01.glb', { type: 'model/gltf-binary' })
    const result1 = await window.OptiViewer.loadOriginal(file)
    expect(result1).not.toBeNull()
    expect(result1.stats.triangles).toBeGreaterThan(0)

    let anim = window.OptiViewer.getAnimation()
    expect(anim.count).toBeGreaterThanOrEqual(3)
    expect(anim.leftIndex).toBe(0)
    expect(anim.rightIndex).toBe(-1)

    await window.OptiViewer.loadOptimized(LILITH_URL)

    anim = window.OptiViewer.getAnimation()
    expect(anim.count).toBeGreaterThanOrEqual(3)
    expect(anim.leftIndex).toBe(0)
    expect(anim.rightIndex).toBe(0)
  })

  it('selectAnimationClip(1) synchronizes leftIndex and rightIndex to 1', () => {
    window.OptiViewer.selectAnimationClip(1)

    const anim = window.OptiViewer.getAnimation()
    expect(anim.count).toBeGreaterThanOrEqual(3)
    expect(anim.leftIndex).toBe(1)
    expect(anim.rightIndex).toBe(1)

    window.OptiViewer.selectAnimationClip(0)
  })

  it('cameraStates() returns camera state for both viewports', () => {
    const states = window.OptiViewer.cameraStates()
    expect(states.left).not.toBeNull()
    expect(states.right).not.toBeNull()
    if (states.left && states.right) {
      expect(Number.isFinite(states.left.near)).toBe(true)
      expect(Number.isFinite(states.right.near)).toBe(true)
    }
  })

  it('camera state matches between left and right — all 6 fields', () => {
    const states = window.OptiViewer.cameraStates()
    expect(states.left).not.toBeNull()
    expect(states.right).not.toBeNull()
    if (!states.left || !states.right) return

    expect(states.left.position.x).toBeCloseTo(states.right.position.x, 4)
    expect(states.left.position.y).toBeCloseTo(states.right.position.y, 4)
    expect(states.left.position.z).toBeCloseTo(states.right.position.z, 4)

    expect(states.left.target.x).toBeCloseTo(states.right.target.x, 4)
    expect(states.left.target.y).toBeCloseTo(states.right.target.y, 4)
    expect(states.left.target.z).toBeCloseTo(states.right.target.z, 4)

    expect(states.left.near).toBe(states.right.near)
    expect(states.left.far).toBe(states.right.far)

    expect(states.left.minDistance).toBe(states.right.minDistance)
    expect(states.left.maxDistance).toBe(states.right.maxDistance)
  })

  it('resetView() works with both viewports loaded', () => {
    expect(() => window.OptiViewer.resetView()).not.toThrow()
  })
})


describe('Viewer — all models parameterized (browser)', () => {
  let canvas
  let viewer

  const timings = []

  beforeAll(async () => {
    const result = await createViewer()
    canvas = result.canvas
    viewer = result.viewer
  })

  afterAll(() => {
    const sorted = [...timings].sort((a, b) => b.time - a.time).slice(0, 5)
    if (sorted.length > 0) {
      console.log('\n═══ Топ-5 медленных моделей ═══')
      for (let i = 0; i < sorted.length; i++) {
        const t = sorted[i]
        const sizeMb = (t.size / 1_000_000).toFixed(1)
        console.log(`  ${i + 1}. ${t.name} — ${t.time.toFixed(0)}ms (${sizeMb}MB)`)
      }
      console.log('')
    }

    disposeViewer(viewer, canvas)
  })


  for (const { file, url, present, size } of MODEL_PROBES) {
    const name = file.replace(/\.glb$/i, '')
    const expectFail = EXPECT_FAIL.has(file)

    if (!present) {
      it.skip(`${name} — loads, has stats, detectSource valid [нет локально — пропущено]`, () => {})
      continue
    }

    it(`${name} — loads, has stats, detectSource valid`, async () => {
      const startTime = performance.now()
      let gltf

      try {
        gltf = await viewer.load(url)
      } catch (err) {
        if (expectFail) {
          timings.push({ name, time: performance.now() - startTime, size })
          return
        }
        throw err
      }

      if (expectFail) {
        throw new Error(`${name} marked as expectFail but loaded successfully`)
      }

      timings.push({ name, time: performance.now() - startTime, size })


      expect(gltf).toBeTruthy()
      expect(gltf.scene).toBeTruthy()

      const stats = viewer.getStats()
      expect(stats).not.toBeNull()
      expect(stats.triangles).toBeGreaterThan(0)
      expect(stats.vertices).toBeGreaterThan(0)
      expect(typeof stats.drawCalls).toBe('number')
      expect(stats.drawCalls).toBeGreaterThan(0)

      const detected = viewer.getDetection()
      expect(detected).not.toBeNull()
      expect(typeof detected.draco).toBe('boolean')
      expect(typeof detected.meshopt).toBe('boolean')
      expect(typeof detected.ktx2).toBe('boolean')
    })
  }
})

describe('Viewer — compressed models via DualViewport (browser)', () => {
  beforeAll(async () => {
    await setupDualViewportDOM()
  })

  afterAll(() => {
    teardownDualViewportDOM()
  })

  it('loads a Draco model via loadOriginal and getAnimation() works', async () => {
    const response = await fetch(DRACO_URL)
    const blob = await response.blob()
    const file = new File([blob], 'Draco Compressed Input 01.glb', { type: 'model/gltf-binary' })

    const result = await window.OptiViewer.loadOriginal(file)
    expect(result).not.toBeNull()
    expect(result.stats).toBeTruthy()
    expect(result.stats.triangles).toBeGreaterThan(0)

    const anim = window.OptiViewer.getAnimation()
    expect(anim.count).toBe(0)
    expect(anim.leftIndex).toBe(-1)
    expect(anim.rightIndex).toBe(-1)
  })

  it('loads a Meshopt model after Draco, works correctly', async () => {
    const response = await fetch(MESHOPT_URL)
    const blob = await response.blob()
    const file = new File([blob], 'Meshopt Compressed Input 01.glb', { type: 'model/gltf-binary' })

    const result = await window.OptiViewer.loadOriginal(file)
    expect(result).not.toBeNull()
    expect(result.stats).toBeTruthy()

    const states = window.OptiViewer.cameraStates()
    expect(states.left).not.toBeNull()
    if (states.left) {
      expect(Number.isFinite(states.left.near)).toBe(true)
    }
  })
})


describe('Viewer — material variants (browser)', () => {
  let canvas
  let viewer

  beforeAll(async () => {
    const result = await createViewer()
    canvas = result.canvas
    viewer = result.viewer
  })

  afterAll(() => {
    disposeViewer(viewer, canvas)
  })

  const materialFingerprint = () => {
    const out = []
    viewer.model.traverse((o) => {
      if (o.material) out.push(o.material.uuid)
    })
    return out
  }

  itWithModels(['CarConcept.glb'], 'CarConcept — три окраски видны в getVariantInfo', async () => {
    await viewer.load('/CarConcept.glb')
    const info = viewer.getVariantInfo()
    expect(info.count).toBe(3)
    expect(info.names).toEqual(['Carmine Candy', 'Pearly Swirly', 'Torched Graphite'])
    expect(info.current).toBeNull()
  })

  itWithModels(['CarConcept.glb'], 'CarConcept — три окраски дают три РАЗНЫЕ раскраски сцены', async () => {
    await viewer.load('/CarConcept.glb')
    const base = materialFingerprint()
    expect(base.length, 'в сцене нет мешей с материалами').toBeGreaterThan(0)

    const looks = {}
    for (const name of viewer.getVariantInfo().names) {
      expect(await viewer.setVariant(name)).toBe(true)
      looks[name] = materialFingerprint().join(' ')
    }
    const distinct = new Set(Object.values(looks))
    expect(distinct.size, `три варианта дали одинаковую раскраску: ${JSON.stringify(Object.keys(looks))}`).toBe(3)

    expect(distinct.has(base.join(' ')), 'исходный вид не совпал ни с одним вариантом').toBe(true)
  })

  itWithModels(['CarConcept.glb'], 'CarConcept — null возвращает вид, записанный в файле', async () => {
    await viewer.load('/CarConcept.glb')
    const base = materialFingerprint()
    await viewer.setVariant('Pearly Swirly')
    expect(materialFingerprint()).not.toEqual(base)
    expect(await viewer.setVariant(null)).toBe(true)
    expect(viewer.getVariantInfo().current).toBeNull()
    expect(materialFingerprint(), 'возврат «как в файле» не восстановил исходную раскраску').toEqual(base)
  })

  itWithModels(['CarConcept.glb'], 'неизвестное имя — отказ, а не исключение и не смена вида', async () => {
    await viewer.load('/CarConcept.glb')
    const base = materialFingerprint()
    expect(await viewer.setVariant('Такого варианта нет')).toBe(false)
    expect(materialFingerprint()).toEqual(base)
  })

  itWithModels(['ChronographWatch.glb'], 'ChronographWatch — четыре отделки', async () => {
    await viewer.load('/ChronographWatch.glb')
    const info = viewer.getVariantInfo()
    expect(info.count).toBe(4)
    expect(info.names).toEqual(['Surgical White', 'Midnight Gold', 'Commerce Green', 'Khronos Red'])
  })

  itWithModels(['Dirty Cube 01.glb'], 'модель без вариантов — пустой список, а не выдуманный', async () => {
    await viewer.load('/Dirty%20Cube%2001.glb')
    const info = viewer.getVariantInfo()
    expect(info.count).toBe(0)
    expect(info.names).toEqual([])
    expect(await viewer.setVariant('что угодно')).toBe(false)
  })
})


describe('Viewer — levels of detail (browser)', () => {
  let canvas
  let viewer

  beforeAll(async () => {
    const result = await createViewer()
    canvas = result.canvas
    viewer = result.viewer
  })

  afterAll(() => {
    disposeViewer(viewer, canvas)
  })

  const visibleTriangles = () => {
    let tri = 0
    viewer.scene.traverse((o) => {
      if (!o.visible) return
      for (let p = o.parent; p; p = p.parent) if (!p.visible) return
      const g = o.geometry
      if (!g || !g.attributes || !g.attributes.position) return
      tri += g.index ? g.index.count / 3 : g.attributes.position.count / 3
    })
    return Math.round(tri)
  }

  itWithModels(['StoneWellLods.glb'], 'StoneWellLods — шесть уровней найдены через расширение', async () => {
    await viewer.load('/StoneWellLods.glb')
    const info = viewer.getLodInfo()
    expect(info.count).toBe(6)
    expect(info.source).toBe('extension')
    expect(info.triangles).toEqual([67247, 9915, 2230, 480, 126, 2])
    expect(info.current).toBeNull()
  })

  itWithModels(['StoneWellLods.glb'], 'StoneWellLods — каждый уровень показывается по отдельности', async () => {
    await viewer.load('/StoneWellLods.glb')
    const info = viewer.getLodInfo()
    for (let i = 0; i < info.count; i++) {
      expect(viewer.setLod(i), `уровень ${i} не переключился`).toBe(true)
      expect(visibleTriangles(), `на уровне ${i} рисуется не он`).toBe(info.triangles[i])
    }
  })

  itWithModels(['StoneWellLods.glb'], 'скрытый уровень остаётся в сцене — его не удаляют', async () => {
    await viewer.load('/StoneWellLods.glb')
    viewer.setLod(5)
    const info = viewer.getLodInfo()
    expect(info.count).toBe(6)
    expect(info.triangles).toEqual([67247, 9915, 2230, 480, 126, 2])
    expect(viewer.setLod(0)).toBe(true)
    expect(visibleTriangles()).toBe(67247)
  })

  itWithModels(['StoneWellLods.glb'], 'номер вне списка — отказ, а не исключение', async () => {
    await viewer.load('/StoneWellLods.glb')
    viewer.setLod(0)
    const before = visibleTriangles()
    expect(viewer.setLod(6)).toBe(false)
    expect(viewer.setLod(-1)).toBe(false)
    expect(visibleTriangles()).toBe(before)
  })


  itWithModels(['StoneWellLodsFlat.glb'], 'StoneWellLodsFlat — шесть уровней узнаны по именам соседей', async () => {
    await viewer.load('/StoneWellLodsFlat.glb')
    const info = viewer.getLodInfo()
    expect(info.count).toBe(6)
    expect(info.source).toBe('names')
    expect(info.triangles).toEqual([67247, 9915, 2230, 480, 126, 2])
  })

  itWithModels(['StoneWellLodsFlat.glb'], 'StoneWellLodsFlat — «как в файле» показывает ВСЕ уровни сразу', async () => {
    await viewer.load('/StoneWellLodsFlat.glb')
    const all = 67247 + 9915 + 2230 + 480 + 126 + 2
    expect(visibleTriangles()).toBe(all)

    expect(viewer.setLod(0)).toBe(true)
    expect(visibleTriangles()).toBe(67247)
    expect(viewer.setLod(5)).toBe(true)
    expect(visibleTriangles()).toBe(2)

    expect(viewer.setLod(null)).toBe(true)
    expect(visibleTriangles()).toBe(all)
  })

  itWithModels(['CarConcept.glb'], 'обычная модель из многих частей уровнями не считается', async () => {
    await viewer.load('/CarConcept.glb')
    expect(viewer.getLodInfo().count).toBe(0)
  })

  itWithModels(['StoneWellLods.glb'], 'уровни совмещены в одной точке — переключение не уводит модель', async () => {
    await viewer.load('/StoneWellLods.glb')
    const centers = []
    for (let i = 0; i < viewer.getLodInfo().count; i++) {
      viewer.setLod(i)
      const box = new THREE.Box3().setFromObject(viewer.model)
      centers.push(box.getCenter(new THREE.Vector3()))
    }
    const first = centers[0]
    for (const c of centers) {
      expect(c.distanceTo(first), 'уровень уехал в сторону при переключении').toBeLessThan(0.05)
    }
  })

  itWithModels(['StoneWellLods.glb'], '«показать все сразу» рисует сумму всех уровней', async () => {
    await viewer.load('/StoneWellLods.glb')
    const info = viewer.getLodInfo()
    const sum = info.triangles.reduce((a, b) => a + b, 0)
    expect(viewer.setLod('all')).toBe(true)
    expect(visibleTriangles(), 'показаны не все уровни').toBe(sum)
    expect(viewer.setLod(0)).toBe(true)
    expect(visibleTriangles()).toBe(info.triangles[0])
  })

  itWithModels(['Dirty Cube 01.glb'], 'модель без уровней — пустой список', async () => {
    await viewer.load('/Dirty%20Cube%2001.glb')
    const info = viewer.getLodInfo()
    expect(info.count).toBe(0)
    expect(info.source).toBeNull()
    expect(viewer.setLod(0)).toBe(false)
  })
})


describe('Viewer — свет модели (browser)', () => {
  let canvas
  let viewer

  beforeAll(async () => {
    const result = await createViewer()
    canvas = result.canvas
    viewer = result.viewer
  })

  afterAll(() => {
    disposeViewer(viewer, canvas)
  })

  itWithModels(['Dirty Cube 01.glb'], 'Dirty Cube несёт свои источники — они посчитаны', async () => {
    await viewer.load(CUBE_URL)
    const info = viewer.getLightInfo()
    expect(info.count, 'свой свет модели не найден').toBeGreaterThanOrEqual(1)
    expect(info.mode).toBe('studio')
  })

  itWithModels(['Dirty Cube 01.glb'], 'переключение гасит НАШ источник, но не окружение', async () => {
    await viewer.load(CUBE_URL)
    expect(viewer._key.visible, 'студийный источник погашен в исходном состоянии').toBe(true)

    expect(viewer.setLightMode('file')).toBe(true)
    expect(viewer._key.visible, 'наш источник продолжает светить поверх авторского').toBe(false)
    expect(viewer.scene.environmentIntensity).toBeGreaterThan(0)
    expect(viewer.scene.environmentIntensity).toBeLessThan(1)
    expect(viewer.getLightInfo().mode).toBe('file')

    expect(viewer.setLightMode('studio')).toBe(true)
    expect(viewer._key.visible).toBe(true)
    expect(viewer.scene.environmentIntensity).toBe(1)
  })

  itWithModels(['Morph Cube 01.glb'], 'у модели без своих источников переключать нечего', async () => {
    await viewer.load('/Morph%20Cube%2001.glb')
    const info = viewer.getLightInfo()
    expect(info.count, 'у этой модели не должно быть своих источников').toBe(0)
    expect(viewer.setLightMode('file'), 'сцену увели в темноту вместо отказа').toBe(false)
    expect(viewer._key.visible, 'студийный источник всё-таки погас').toBe(true)
    expect(viewer.scene.environmentIntensity).toBe(1)
  })

  itWithModels(['Dirty Cube 01.glb', 'Morph Cube 01.glb'], 'режим не переезжает на следующую модель', async () => {
    await viewer.load(CUBE_URL)
    expect(viewer.setLightMode('file')).toBe(true)
    await viewer.load('/Morph%20Cube%2001.glb')
    expect(viewer.getLightInfo().mode).toBe('studio')
    expect(viewer._key.visible).toBe(true)
    expect(viewer.scene.environmentIntensity).toBe(1)
  })
})


describe('Viewer — камеры автора (browser)', () => {
  let canvas
  let viewer

  beforeAll(async () => {
    const result = await createViewer()
    canvas = result.canvas
    viewer = result.viewer
  })

  afterAll(() => {
    disposeViewer(viewer, canvas)
  })

  itWithModels(['ToyCar.glb'], 'ToyCar — ракурсы автора найдены', async () => {
    await viewer.load('/ToyCar.glb')
    const info = viewer.getCameraInfo()
    expect(info.count, 'камеры автора не найдены').toBeGreaterThan(1)
    expect(info.names.length).toBe(info.count)
    expect(info.current).toBeNull()
  })

  itWithModels(['ToyCar.glb'], 'через камеру автора орбита выключена, через свою — включена', async () => {
    await viewer.load('/ToyCar.glb')
    expect(viewer.controls.enabled, 'своя камера, а орбита выключена').toBe(true)

    expect(viewer.setCamera(0)).toBe(true)
    expect(viewer.getCameraInfo().current).toBe(0)
    expect(viewer.controls.enabled, 'орбита осталась включённой на камере автора').toBe(false)
    expect(viewer._activeCamera(), 'рисуем всё той же своей камерой').not.toBe(viewer.camera)

    expect(viewer.setCamera(null)).toBe(true)
    expect(viewer.controls.enabled).toBe(true)
    expect(viewer._activeCamera()).toBe(viewer.camera)
  })

  itWithModels(['ToyCar.glb'], 'пропорции кадра — от окна, а не от файла', async () => {
    await viewer.load('/ToyCar.glb')
    const parent = viewer.canvas.parentElement
    const want = parent.clientWidth / parent.clientHeight
    viewer.setCamera(0)
    const cam = viewer._activeCamera()
    expect(Math.abs(cam.aspect - want), 'кадр растянут: соотношение сторон осталось файловым')
      .toBeLessThan(0.01)
    viewer.setCamera(null)
  })

  itWithModels(['ToyCar.glb'], 'несуществующий номер — отказ, а не пустой экран', async () => {
    await viewer.load('/ToyCar.glb')
    const n = viewer.getCameraInfo().count
    expect(viewer.setCamera(n), 'принят номер за пределами списка').toBe(false)
    expect(viewer.setCamera(-1)).toBe(false)
    expect(viewer.getCameraInfo().current, 'после отказа выбор всё-таки сменился').toBeNull()
  })

  itWithModels(['ToyCar.glb', 'Dirty Cube 01.glb'], 'выбор не переезжает на следующую модель', async () => {
    await viewer.load('/ToyCar.glb')
    expect(viewer.setCamera(0)).toBe(true)
    await viewer.load(CUBE_URL)
    expect(viewer.getCameraInfo().current).toBeNull()
    expect(viewer.controls.enabled, 'орбита не вернулась после чужого ракурса').toBe(true)
    expect(viewer._activeCamera()).toBe(viewer.camera)
  })
})


describeWithModels(['ToyCar.glb'], 'DualViewport — ракурс и свет переживают сборку', () => {
  beforeAll(async () => {
    await setupDualViewportDOM()
  })

  afterAll(() => {
    teardownDualViewportDOM()
  })

  it('камера автора остаётся выбранной в ОБОИХ окнах после загрузки результата', async () => {
    const resp = await fetch('/ToyCar.glb')
    const file = new File([await resp.blob()], 'ToyCar.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file)

    const cams = window.OptiViewer.getCameras()
    expect(cams.count, 'у ToyCar нет камер — проверять нечего').toBeGreaterThan(0)
    window.OptiViewer.selectCamera(0)
    expect(window.OptiViewer.getCameras().current).toBe(0)

    await window.OptiViewer.loadOptimized('/ToyCar.glb')

    const after = window.OptiViewer.getCameras()
    expect(after.leftCurrent, 'в левом окне ракурс автора слетел').toBe(0)
    expect(after.rightCurrent, 'правое окно вернулось к своей орбите — окна показывают разное').toBe(0)
  })

  it('режим света остаётся выбранным после загрузки результата', async () => {
    const resp = await fetch(CUBE_URL)
    const file = new File([await resp.blob()], 'Dirty Cube 01.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file)

    expect(window.OptiViewer.getLight().count, 'у этой модели нет своего света').toBeGreaterThan(0)
    window.OptiViewer.selectLightMode('file')
    expect(window.OptiViewer.getLight().mode).toBe('file')

    await window.OptiViewer.loadOptimized(CUBE_URL)
    const after = window.OptiViewer.getLight()
    expect(after.leftMode, 'в левом окне свет вернулся к студийному').toBe('file')
    expect(after.rightMode, 'правое окно вернулось к студийному — окна светятся по-разному').toBe('file')
  })

  it('другая модель ракурс НЕ наследует', async () => {
    const resp = await fetch('/ToyCar.glb')
    const file = new File([await resp.blob()], 'ToyCar.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file)
    window.OptiViewer.selectCamera(0)

    const resp2 = await fetch(CUBE_URL)
    const file2 = new File([await resp2.blob()], 'Dirty Cube 01.glb', { type: 'model/gltf-binary' })
    await window.OptiViewer.loadOriginal(file2)
    expect(window.OptiViewer.getCameras().current, 'чужой ракурс переехал на новую модель').toBeNull()
  })
})


describe('Viewer — ортографическая камера (browser)', () => {
  let canvas
  let viewer

  beforeAll(async () => {
    const result = await createViewer()
    canvas = result.canvas
    viewer = result.viewer
  })

  afterAll(() => {
    disposeViewer(viewer, canvas)
  })

  itWithModels(['Ortho Camera 01.glb'], 'ортографическая камера доезжает из ФАЙЛА в список', async () => {
    await viewer.load('/Ortho%20Camera%2001.glb')
    const info = viewer.getCameraInfo()
    expect(info.count, 'камеры из файла не доехали').toBe(2)
    expect(info.names).toEqual(['OrthoCameraNode', 'PerspCameraNode'])

    expect(viewer.setCamera(0)).toBe(true)
    const cam = viewer._activeCamera()
    expect(cam.isOrthographicCamera, 'первая камера должна быть ортографической').toBe(true)
    expect(viewer.controls.enabled, 'орбита должна быть выключена и здесь').toBe(false)

    const parent = viewer.canvas.parentElement
    const ratio = parent.clientWidth / parent.clientHeight
    expect(cam.top).toBeCloseTo(1.5, 5)
    expect(cam.bottom).toBeCloseTo(-1.5, 5)
    expect(cam.right).toBeCloseTo(1.5 * ratio, 5)
    expect(cam.left).toBeCloseTo(-1.5 * ratio, 5)
    viewer.renderFrame()

    expect(viewer.setCamera(1)).toBe(true)
    const persp = viewer._activeCamera()
    expect(persp.isPerspectiveCamera).toBe(true)
    expect(persp.aspect).toBeCloseTo(ratio, 5)
    viewer.renderFrame()

    viewer.setCamera(null)
    expect(viewer._activeCamera()).toBe(viewer.camera)
    expect(viewer.controls.enabled).toBe(true)
  })

  itWithModels(['Dirty Cube 01.glb'], 'вертикаль остаётся авторской, ширина берётся от окна', async () => {
    await viewer.load(CUBE_URL)

    const ortho = new THREE.OrthographicCamera(-2, 2, 1.5, -1.5, 0.1, 100)
    ortho.name = 'Blueprint_Side'
    viewer.model.add(ortho)
    viewer._fileCameras = [ortho]

    expect(viewer.setCamera(0)).toBe(true)
    expect(viewer._activeCamera(), 'рисуем не той камерой').toBe(ortho)
    expect(viewer.controls.enabled, 'орбита должна быть выключена и здесь').toBe(false)

    const parent = viewer.canvas.parentElement
    const ratio = parent.clientWidth / parent.clientHeight
    expect(ortho.top).toBe(1.5)
    expect(ortho.bottom).toBe(-1.5)
    expect(ortho.right).toBeCloseTo(1.5 * ratio, 5)
    expect(ortho.left).toBeCloseTo(-1.5 * ratio, 5)

    viewer.renderFrame()

    viewer.setCamera(null)
    expect(viewer._activeCamera()).toBe(viewer.camera)
    expect(viewer.controls.enabled).toBe(true)
  })
})
