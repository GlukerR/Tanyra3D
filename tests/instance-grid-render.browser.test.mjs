import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  createViewer,
  disposeViewer,
  snapshotPixels,
  diffStats,
} from './helpers/viewer-test-utils.mjs'

const ORIG_URL = '/Instance%20Grid%2001.glb'
const OPT_URL = '/optimized/instance-grid-sqj.glb'

const ORIG_TRIANGLES = 7500
const ORIG_DRAW_CALLS = 625

describe('Instance Grid 01 — safe+quantize+join: рендер без артефактов, позиции те же (browser)', () => {
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

  it('обе модели грузятся; треугольники не изменились, drawCalls 625 → 1', async () => {
    await viewer.load(ORIG_URL)
    const orig = viewer.getStats()
    expect(orig).not.toBeNull()
    expect(orig.triangles).toBe(ORIG_TRIANGLES)
    expect(orig.drawCalls).toBe(ORIG_DRAW_CALLS)

    await viewer.load(OPT_URL)
    const opt = viewer.getStats()
    expect(opt).not.toBeNull()
    expect(opt.triangles).toBe(ORIG_TRIANGLES)
    expect(opt.drawCalls).toBe(1)
  })

  it('позиции те же: авто-кадрирование оригинала и результата даёт одну камеру', async () => {
    await viewer.load(ORIG_URL)
    const camOrig = viewer.getCameraState()
    await viewer.load(OPT_URL)
    const camOpt = viewer.getCameraState()

    const rel = (a, b) => (Math.abs(a - b) / Math.max(Math.abs(b), 1e-9)) * 100
    for (const k of ['x', 'y', 'z']) {
      expect(rel(camOpt.position[k], camOrig.position[k])).toBeLessThan(0.5)
      expect(rel(camOpt.target[k], camOrig.target[k])).toBeLessThan(0.5)
    }
    expect(rel(camOpt.near, camOrig.near)).toBeLessThan(1)
    expect(rel(camOpt.far, camOrig.far)).toBeLessThan(1)
  })

  it('рендер без артефактов: пиксели совпадают в допуске квантования', async () => {
    await viewer.load(ORIG_URL)
    const camOrig = viewer.getCameraState()
    viewer.renderFrame()
    const a = snapshotPixels(viewer)

    await viewer.load(OPT_URL, { camera: camOrig })
    viewer.renderFrame()
    const b = snapshotPixels(viewer)

    const base = diffStats(a, b)
    console.log(
      `[instance-grid-render] overPct=${base.overPct.toFixed(3)}% ` +
        `meanDiff=${base.meanDiff.toFixed(3)} maxDiff=${base.maxDiff} ` +
        `extremePct=${base.extremePct.toFixed(4)}% litPct=${base.litPct.toFixed(2)}%`,
    )
    expect(base.litPct).toBeGreaterThan(0.5)

    expect(base.overPct).toBeLessThan(0.5)
    expect(base.meanDiff).toBeLessThan(2)
    expect(base.extremePct).toBeLessThan(0.1)
  })
})
