// tests/helpers/viewer-test-utils.mjs — утилиты для браузерных тестов вьюера.
//
// Выносит повторяющийся boilerplate (создание canvas, DOM для DualViewport)
// из viewer-regression.browser.test.mjs в переиспользуемые функции.
//
// Все describe блоки с Viewer или DualViewport имели идентичные beforeAll/afterAll,
// различающиеся только импортом. Теперь они вызывают эти функции.

/**
 * Создать canvas и Viewer для теста.
 * Canvas добавляется в document.body с размером 400×300.
 *
 * @returns {Promise<{ canvas: HTMLCanvasElement, viewer: import('../../ui/viewer/viewer.js').Viewer }>}
 */
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

/**
 * Освободить ресурсы Viewer и удалить canvas из DOM.
 * Безопасно вызывать с null/undefined.
 *
 * @param {import('../../ui/viewer/viewer.js').Viewer | null | undefined} viewer
 * @param {HTMLCanvasElement | null | undefined} canvas
 */
export function disposeViewer(viewer, canvas) {
  viewer?.dispose()
  canvas?.remove()
}

/**
 * Создать DOM-элементы для DualViewport (preview-original / preview-optimized)
 * и импортировать ui/viewer/index.js (синглтон — ES-модуль кешируется).
 *
 * Предусловие: глобальный OptiViewer ещё не сброшен (или сброшен в teardown).
 * Постусловие: window.OptiViewer создан, DOM готов к _init().
 */
export async function setupDualViewportDOM() {
  const leftContainer = document.createElement('div')
  leftContainer.id = 'preview-original'
  leftContainer.innerHTML = '<canvas class="viewer-canvas"></canvas><div class="viewer-status"></div>'
  document.body.appendChild(leftContainer)

  const rightContainer = document.createElement('div')
  rightContainer.id = 'preview-optimized'
  rightContainer.innerHTML = '<canvas class="viewer-canvas"></canvas><div class="viewer-status"></div>'
  document.body.appendChild(rightContainer)

  // Импорт создаёт DualViewport и window.OptiViewer (синглтон).
  // Повторный import возвращает кешированный модуль — новых экземпляров не будет.
  await import('../../ui/viewer/index.js')
}

/**
 * Сбросить OptiViewer и удалить DOM-элементы DualViewport.
 * Безопасно вызывать в afterAll, даже если setup не выполнялся.
 */
export function teardownDualViewportDOM() {
  if (window.OptiViewer) window.OptiViewer.reset()
  const left = document.getElementById('preview-original')
  const right = document.getElementById('preview-optimized')
  left?.remove()
  right?.remove()
}

/**
 * Сбросить _animClipIndex в DualViewport (нужно между describe блоками,
 * т.к. синглтон сохраняет состояние).
 */
export function resetAnimationClipIndex() {
  window.OptiViewer?.selectAnimationClip?.(0)
}

/**
 * Снимок пикселей WebGL-буфера сразу после renderFrame(). Читаем до композитинга —
 * preserveDrawingBuffer у рендерера нет, но в том же макротаске буфер ещё на месте.
 *
 * @param {import('../../ui/viewer/viewer.js').Viewer} viewer
 * @returns {{ w: number, h: number, px: Uint8Array }}
 */
export function snapshotPixels(viewer) {
  const gl = viewer.renderer.getContext()
  const w = gl.drawingBufferWidth
  const h = gl.drawingBufferHeight
  const px = new Uint8Array(w * h * 4)
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
  return { w, h, px }
}

/**
 * Сравнение двух кадров (snapshotPixels). Возвращает:
 *   overPct    — доля пикселей, где суммарное расхождение каналов (R+G+B) > threshold
 *   meanDiff   — среднее суммарное расхождение каналов по всем пикселям
 *   maxDiff    — максимальное расхождение одного пикселя
 *   extremePct — доля пикселей с расхождением > extreme (субпиксельный сдвиг кромки)
 *   litPct     — доля непрозрачных пикселей (модель должна быть видна в кадре)
 *
 * Порог 12 = в среднем по 4 на канал — это уже видимая разница, не шум сглаживания.
 * «Экстремальные» (d > 60) могут быть одиночными — субпиксельный сдвиг кромки силуэта
 * переключает единичный пиксель целиком, поэтому считаются долей, а не запрещаются вовсе.
 */
export function diffStats(a, b, threshold = 12, extreme = 60) {
  const n = a.px.length
  let over = 0
  let extremeCount = 0
  let total = 0
  let maxDiff = 0
  let sumDiff = 0
  let lit = 0 // нарисованные (непрозрачные) пиксели — модель должна быть видна
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
