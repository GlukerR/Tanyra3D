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
