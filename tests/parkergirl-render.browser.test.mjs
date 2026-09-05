import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest'
import {
  createViewer,
  disposeViewer,
  snapshotPixels,
  diffStats,
} from './helpers/viewer-test-utils.mjs'

const PARKERGIRL_AVAILABLE = inject('parkergirl-artifact-available') === true

const ORIG_URL = '/parkergirl.glb'
const OPT_URL = '/optimized/parkergirl-sq.glb'

const ORIG_TRIANGLES = 27854

const POSE_FRACTIONS = [0, 0.15, 0.35, 0.55, 0.75, 0.92]

function morphInfluencesDigest(viewer) {
  const digests = []
  viewer.model?.traverse((o) => {
    if (o.isMesh && o.morphTargetInfluences?.length) {
      digests.push(
        o.morphTargetInfluences.map((v) => +v.toFixed(3)).join(','),
      )
    }
  })
  return digests
}

const parkergirlDescribe = PARKERGIRL_AVAILABLE ? describe : describe.skip

parkergirlDescribe(
  'parkergirl — safe+quantize: скин-анимация и морфы рендерятся без артефактов (browser)' +
    (PARKERGIRL_AVAILABLE ? '' : ' [skipped: parkergirl.glb отсутствует локально — артефакт не собран]'),
  () => {
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

  it('обе модели грузятся; треугольники и анимация на месте', async () => {
    await viewer.load(ORIG_URL)
    const orig = viewer.getStats()
    expect(orig).not.toBeNull()
    expect(orig.triangles).toBe(ORIG_TRIANGLES)
    const origAnim = viewer.getAnimationInfo()
    expect(origAnim.count).toBe(1)

    await viewer.load(OPT_URL)
    const opt = viewer.getStats()
    expect(opt).not.toBeNull()
    expect(opt.triangles).toBe(ORIG_TRIANGLES)
    const optAnim = viewer.getAnimationInfo()
    expect(optAnim.count).toBe(1)
    expect(optAnim.duration).toBeCloseTo(origAnim.duration, 3)
  })

  it('сторож: анимация реально анимирует морфы (инлюенсы различаются между позами)', async () => {
    await viewer.load(ORIG_URL)
    const anim = viewer.getAnimationInfo()
    const dur = anim.duration
    expect(dur).toBeGreaterThan(0)

    const states = new Set()
    for (const frac of POSE_FRACTIONS) {
      viewer.setAnimationTime(dur * frac)
      states.add(morphInfluencesDigest(viewer).join('|'))
    }

    console.log(
      `[parkergirl-render] guard: уникальных состояний инлюенсов ` +
        `среди ${POSE_FRACTIONS.length} поз = ${states.size} (из ${8} мешей × 57 морфов)`,
    )
    expect(states.size).toBeGreaterThan(1)

    viewer.setAnimationTime(0)
    viewer.renderFrame()
    const base = diffStats(snapshotPixels(viewer), snapshotPixels(viewer))
    expect(base.litPct).toBeGreaterThan(0.5)
  })

  it('рендер без артефактов: кадры оригинала и результата совпадают в каждой позе', async () => {
    await viewer.load(ORIG_URL)
    const camOrig = viewer.getCameraState()
    const anim = viewer.getAnimationInfo()
    const dur = anim.duration
    expect(dur).toBeGreaterThan(0)

    const origShots = []
    for (const frac of POSE_FRACTIONS) {
      viewer.setAnimationTime(dur * frac)
      viewer.renderFrame()
      origShots.push(snapshotPixels(viewer))
    }

    await viewer.load(OPT_URL, { camera: camOrig })
    for (let i = 0; i < POSE_FRACTIONS.length; i++) {
      const frac = POSE_FRACTIONS[i]
      viewer.setAnimationTime(dur * frac)
      viewer.renderFrame()
      const b = snapshotPixels(viewer)

      const stats = diffStats(origShots[i], b)
      console.log(
        `[parkergirl-render] pose ${frac}: overPct=${stats.overPct.toFixed(3)}% ` +
          `meanDiff=${stats.meanDiff.toFixed(3)} maxDiff=${stats.maxDiff} ` +
          `extremePct=${stats.extremePct.toFixed(4)}% litPct=${stats.litPct.toFixed(2)}%`,
      )
      expect(stats.litPct).toBeGreaterThan(0.5)

      expect(stats.overPct).toBeLessThan(0.5)
      expect(stats.meanDiff).toBeLessThan(2)
      expect(stats.extremePct).toBeLessThan(0.1)
    }
  })
  },
)
