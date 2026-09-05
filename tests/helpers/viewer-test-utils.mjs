export async function createViewer() {
  const canvas = document.createElement('canvas')
  canvas.width = 400
  canvas.height = 300
  canvas.style.width = '400px'
  canvas.style.height = '300px'
  canvas.style.display = 'block'
  document.body.appendChild(canvas)

  const { Viewer } = await import('../../ui/viewer/viewer.js')
  const viewer = new Viewer(canvas)
  return { canvas, viewer }
}

export function disposeViewer(viewer, canvas) {
  viewer?.dispose()
  canvas?.remove()
}

export async function setupDualViewportDOM() {
  const leftContainer = document.createElement('div')
  leftContainer.id = 'preview-original'
  leftContainer.innerHTML = '<canvas class="viewer-canvas"></canvas><div class="viewer-status"></div>'
  document.body.appendChild(leftContainer)

  const rightContainer = document.createElement('div')
  rightContainer.id = 'preview-optimized'
  rightContainer.innerHTML = '<canvas class="viewer-canvas"></canvas><div class="viewer-status"></div>'
  document.body.appendChild(rightContainer)

  await import('../../ui/viewer/index.js')
}

export function teardownDualViewportDOM() {
  if (window.OptiViewer) window.OptiViewer.reset()
  const left = document.getElementById('preview-original')
  const right = document.getElementById('preview-optimized')
  left?.remove()
  right?.remove()
}

export function resetAnimationClipIndex() {
  window.OptiViewer?.selectAnimationClip?.(0)
}

export function snapshotPixels(viewer) {
  const gl = viewer.renderer.getContext()
  const w = gl.drawingBufferWidth
  const h = gl.drawingBufferHeight
  const px = new Uint8Array(w * h * 4)
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
  return { w, h, px }
}

export function diffStats(a, b, threshold = 12, extreme = 60) {
  const n = a.px.length
  let over = 0
  let extremeCount = 0
  let total = 0
  let maxDiff = 0
  let sumDiff = 0
  let lit = 0
  for (let i = 0; i < n; i += 4) {
    total++
    if (a.px[i + 3] > 8) lit++
    const d =
      Math.abs(a.px[i] - b.px[i]) +
      Math.abs(a.px[i + 1] - b.px[i + 1]) +
      Math.abs(a.px[i + 2] - b.px[i + 2])
    sumDiff += d
    maxDiff = Math.max(maxDiff, d)
    if (d > threshold) over++
    if (d > extreme) extremeCount++
  }
  return {
    over,
    total,
    overPct: (over / total) * 100,
    meanDiff: sumDiff / total,
    maxDiff,
    extremeCount,
    extremePct: (extremeCount / total) * 100,
    litPct: (lit / total) * 100,
  }
}
