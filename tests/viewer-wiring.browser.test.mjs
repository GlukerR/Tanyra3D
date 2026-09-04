// tests/viewer-wiring.browser.test.mjs — подписки приложения доезжают до движка.
//
// ПОВОД. Кубик долгой работы не загорался НИ РАЗУ с момента появления, и запись о нажатии
// на интерактивную часть не попадала в журнал тоже никогда. Причина оказалась не одна, а
// цепочка из трёх звеньев, и каждое рвалось МОЛЧА:
//
//   1. `app.js` подключён обычным <script>, а вьюпорт — модуль, то есть приходит ПОЗЖЕ.
//      Строка `window.OptiViewer?.setOnBusy?.(…)` уходила в `undefined`, и `?.` гасил её
//      без ошибки. Лечится мостом `onOptiViewerReady`.
//   2. Слоты (`ViewportSlot`) рождаются лениво, при первой загрузке модели, — то есть тоже
//      позже подписки. Колбэк оставался лежать у обвязки.
//   3. Сам движок рождается ещё позже, при первой модели в слоте.
//
// Ни одно из трёх не было покрыто: проверки создавали движок НАПРЯМУЮ и всю обвязку
// проходили мимо. Поэтому сторож здесь работает через `window.OptiViewer` — ровно так, как
// это делает приложение, и в том же порядке: сначала подписка, потом модель.
//
// ПРОБА НА КРАСНОТУ (2026-09-04): убрал раздачу подписки слотам в `_init()` — КРАСНЫЙ.
//
// ЧЕГО ЭТОТ СТОРОЖ НЕ ЛОВИТ, и честнее сказать это вслух: снятие моста
// `onOptiViewerReady` он не заметил. Проверка подписывается через `window.OptiViewer`
// напрямую, дождавшись импорта, — то есть первого звена (порядок «обычный скрипт против
// модуля») она не проходит вовсе. Это звено живёт в `app.js`, куда браузерная проверка не
// достаёт: она поднимает вьюпорт без приложения. Ловится оно только глазами.

import { describe, it, expect, beforeAll } from 'vitest'

/**
 * Наименьшая GLB, какую примет загрузчик: один квадрат с одноцветной текстурой.
 *
 * Собирается прямо здесь, а не берётся из корпуса, по двум причинам: проверка про ПРОВОДКУ,
 * а не про модели, и цвет карты должен отличаться у пары — иначе сравнивать нечего и
 * расчёт не начнётся вовсе.
 */
function глб(цвет) {
  const c = document.createElement('canvas')
  c.width = 8; c.height = 8
  const g = c.getContext('2d')
  g.fillStyle = цвет
  g.fillRect(0, 0, 8, 8)
  const png = Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]), (ch) => ch.charCodeAt(0))

  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])
  const uv = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0])
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3])
  const дополнить = (a) => {
    const r = a.length % 4
    if (!r) return a
    const o = new Uint8Array(a.length + 4 - r)
    o.set(a)
    return o
  }
  const части = [new Uint8Array(pos.buffer), new Uint8Array(uv.buffer), new Uint8Array(idx.buffer), png]
    .map(дополнить)
  const bin = new Uint8Array(части.reduce((n, p) => n + p.length, 0))
  const сдвиги = []
  let off = 0
  for (const p of части) { bin.set(p, off); сдвиги.push(off); off += p.length }

  const json = {
    asset: { version: '2.0', generator: 'wiring test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Квадрат' }],
    meshes: [{ name: 'Квадрат', primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'Материал', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
    textures: [{ source: 0 }],
    images: [{ bufferView: 3, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2', min: [0, 0], max: [1, 1] },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: сдвиги[0], byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: сдвиги[1], byteLength: uv.byteLength, target: 34962 },
      { buffer: 0, byteOffset: сдвиги[2], byteLength: idx.byteLength, target: 34963 },
      { buffer: 0, byteOffset: сдвиги[3], byteLength: png.length },
    ],
    buffers: [{ byteLength: bin.length }],
  }

  const добить = (a, чем) => {
    const r = a.length % 4
    if (!r) return a
    const o = new Uint8Array(a.length + 4 - r)
    o.set(a); o.fill(чем, a.length)
    return o
  }
  const jc = добить(new TextEncoder().encode(JSON.stringify(json)), 0x20)
  const bc = добить(bin, 0)
  const всего = 12 + 8 + jc.length + 8 + bc.length
  const out = new Uint8Array(всего)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, всего, true)
  dv.setUint32(12, jc.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jc, 20)
  const o2 = 20 + jc.length
  dv.setUint32(o2, bc.length, true); dv.setUint32(o2 + 4, 0x004e4942, true); out.set(bc, o2 + 8)
  return out
}

/** Дождаться, пока расчёт сообщит о своём конце. Кадры идут сами — окно живое. */
async function дождатьсяРаботы(события) {
  for (let i = 0; i < 600; i++) {
    if (события.length && события[события.length - 1] === false) return
    await new Promise((r) => requestAnimationFrame(r))
  }
}

/** Панели, которые обвязка ищет по имени. Без них слоты не создаются вовсе. */
function поставитьПанели() {
  for (const id of ['preview-original', 'preview-optimized']) {
    if (document.getElementById(id)) continue
    const el = document.createElement('div')
    el.id = id
    const canvas = document.createElement('canvas')
    canvas.className = 'viewer-canvas'
    canvas.width = 32
    canvas.height = 32
    const status = document.createElement('div')
    status.className = 'viewer-status'
    el.append(canvas, status)
    document.body.appendChild(el)
  }
}

beforeAll(async () => {
  поставитьПанели()
  // Подписка ДО загрузки модуля — так и делает app.js, который выполняется раньше.
  await import('../ui/viewer/index.js')
})

describe('лицо вьюпорта объявляет о себе', () => {
  it('мост готовности вызывается, а не остаётся пустым обещанием', () => {
    // Приложение вешает свои подписки в `window.onOptiViewerReady`. Если модуль его не
    // позовёт, они не встанут никогда — и ни одной ошибки при этом не будет.
    expect(typeof window.OptiViewer, 'модуль не выложил лицо в window').toBe('object')
    expect(typeof window.OptiViewer.setOnBusy, 'нет способа подписаться на долгую работу')
      .toBe('function')
    expect(typeof window.OptiViewer.diffScale, 'нет способа узнать, чему равен красный')
      .toBe('function')
  })

  it('подписка, сделанная ДО первой модели, доходит до расчёта', async () => {
    // СКВОЗНАЯ проверка всех трёх звеньев разом: подписываемся, когда нет ещё ни слотов,
    // ни движка, потом кладём пару моделей и включаем режим различий. События обязаны
    // прийти — иначе кубик не загорится, как и было до 2026-09-04.
    const события = []
    window.OptiViewer.setOnBusy((b) => события.push(b))

    const исходник = new File([глб('#000000')], 'проба.glb', { type: 'model/gltf-binary' })
    const результат = URL.createObjectURL(new Blob([глб('#ffffff')], { type: 'model/gltf-binary' }))
    try {
      await window.OptiViewer.loadOriginal(исходник, null)
      await window.OptiViewer.loadOptimized(результат)
      window.OptiViewer.setDisplayMaterial('texdiff')
      await дождатьсяРаботы(события)

      expect(события[0], 'о начале работы не сообщили — кубик не загорится').toBe(true)
      expect(события[события.length - 1], 'о конце работы не сообщили — кубик не погаснет')
        .toBe(false)
    } finally {
      URL.revokeObjectURL(результат)
      window.OptiViewer.setOnBusy(null)
    }
  })

  it('подпись «насколько» доезжает до приложения', async () => {
    // Цвет отвечает «где», подпись — «насколько». Пара выше: чёрное против белого, то есть
    // худшая деталь изменилась целиком.
    const доля = window.OptiViewer.diffScale()
    expect(доля, 'подпись не посчиталась').not.toBeNull()
    expect(доля, 'чёрное против белого — это полное изменение').toBeGreaterThan(0.9)
  })
})
