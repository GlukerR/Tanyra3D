import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as THREE from 'three'
import { createViewer, disposeViewer } from '../tests/helpers/viewer-test-utils.mjs'
import { DISPLAY_MODES } from '../ui/viewer/contract.js'

let viewer
let canvas

beforeAll(async () => {
  const made = await createViewer()
  viewer = made.viewer
  canvas = made.canvas
  canvas.setPointerCapture = () => {}
  canvas.releasePointerCapture = () => {}
})

afterAll(() => disposeViewer(viewer, canvas))

function двеПанели(шагA, шагB) {
  const сетка = (шаг, сдвиг) => {
    const pos = []
    const idx = []
    for (let y = 0; y <= шаг; y++) for (let x = 0; x <= шаг; x++) pos.push(сдвиг + x / шаг, y / шаг, 0)
    for (let y = 0; y < шаг; y++) for (let x = 0; x < шаг; x++) {
      const a = y * (шаг + 1) + x
      idx.push(a, a + 1, a + шаг + 1, a + 1, a + шаг + 2, a + шаг + 1)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setIndex(idx)
    g.computeBoundingBox()
    return g
  }
  const model = new THREE.Group()
  const плотная = new THREE.Mesh(сетка(шагA, 0), new THREE.MeshStandardMaterial({ color: 0x888888 }))
  плотная.name = 'Плотная'
  const редкая = new THREE.Mesh(сетка(шагB, 2), new THREE.MeshStandardMaterial({ color: 0x888888 }))
  редкая.name = 'Редкая'
  model.add(плотная, редкая)
  return model
}

async function дождаться() {
  for (let i = 0; i < 400 && (viewer._diffQueue.length || viewer._diffTimer); i++) {
    await new Promise((r) => requestAnimationFrame(r))
  }
}

const оттенок = (model, имя) => {
  let out = null
  model.traverse((o) => {
    if (o.isMesh && o.name === имя && o.material?.color) {
      const hsl = { h: 0, s: 0, l: 0 }
      o.material.color.getHSL(hsl)
      out = hsl.h
    }
  })
  return out
}

describe('подсветка плотности', () => {
  it('плотная деталь краснее редкой при одинаковом размере', () => {
    viewer.model = двеПанели(20, 2)
    viewer.setDisplayMaterial('wire')
    const плотная = оттенок(viewer.model, 'Плотная')
    const редкая = оттенок(viewer.model, 'Редкая')
    expect(плотная, 'у плотной детали нет цвета — подсветка не применилась').not.toBeNull()
    expect(плотная, `плотная ${плотная}, редкая ${редкая}: плотная обязана быть краснее`)
      .toBeLessThan(редкая)
  })

  it('у модели с одинаковыми деталями красного нет вовсе', () => {
    viewer.model = двеПанели(8, 8)
    viewer.setDisplayMaterial('wire')
    for (const имя of ['Плотная', 'Редкая']) {
      expect(оттенок(viewer.model, имя), `${имя}: детали одинаковы, а цвет разный`)
        .toBeCloseTo(1 / 3, 2)
    }
  })

  it('плоская мелочь не обгоняет объёмную деталь', () => {
    const model = new THREE.Group()

    const плоское = new THREE.BufferGeometry()
    плоское.setAttribute('position', new THREE.Float32BufferAttribute(
      [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3))
    плоское.setIndex([0, 1, 2, 0, 2, 3])
    плоское.computeBoundingBox()
    const стекло = new THREE.Mesh(плоское, new THREE.MeshStandardMaterial())
    стекло.name = 'Стекло'

    const pos = []
    const idx = []
    const шаг = 20
    for (let y = 0; y <= шаг; y++) for (let x = 0; x <= шаг; x++) pos.push(x / шаг, y / шаг, (x % 2) ? 1 : 0)
    for (let y = 0; y < шаг; y++) for (let x = 0; x < шаг; x++) {
      const a = y * (шаг + 1) + x
      idx.push(a, a + 1, a + шаг + 1, a + 1, a + шаг + 2, a + шаг + 1)
    }
    const объёмное = new THREE.BufferGeometry()
    объёмное.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    объёмное.setIndex(idx)
    объёмное.computeBoundingBox()
    const корпус = new THREE.Mesh(объёмное, new THREE.MeshStandardMaterial())
    корпус.name = 'Корпус'

    model.add(стекло, корпус)
    viewer.model = model
    viewer.setDisplayMaterial('wire')

    const с = оттенок(viewer.model, 'Стекло')
    const к = оттенок(viewer.model, 'Корпус')
    expect(к, `корпус ${к}, стекло ${с}: настоящая тяжёлая деталь обязана быть краснее плоской мелочи`)
      .toBeLessThan(с)
  })

  it('выход из режима возвращает родные материалы', () => {
    viewer.model = двеПанели(20, 2)
    const было = []
    viewer.model.traverse((o) => { if (o.isMesh) было.push(o.material) })
    viewer.setDisplayMaterial('wire')
    viewer.setDisplayMaterial('file')
    const стало = []
    viewer.model.traverse((o) => { if (o.isMesh) стало.push(o.material) })
    expect(стало, 'родные материалы не вернулись после выхода из подсветки').toEqual(было)
  })
})

function однотонная(размер, цвет) {
  const c = document.createElement('canvas')
  c.width = размер
  c.height = размер
  const g = c.getContext('2d')
  g.fillStyle = цвет
  g.fillRect(0, 0, размер, размер)
  const t = new THREE.CanvasTexture(c)
  t.needsUpdate = true
  return t
}

function шахматка(размер, цветА, цветБ) {
  const c = document.createElement('canvas')
  c.width = размер
  c.height = размер
  const g = c.getContext('2d')
  for (let y = 0; y < размер; y++) {
    for (let x = 0; x < размер; x++) {
      g.fillStyle = (x + y) % 2 ? цветА : цветБ
      g.fillRect(x, y, 1, 1)
    }
  }
  const t = new THREE.CanvasTexture(c)
  t.needsUpdate = true
  return t
}

function среднийЦвет(tex) {
  const img = tex.image
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(img, 0, 0)
  const d = g.getImageData(0, 0, img.width, img.height).data
  let r = 0
  let зел = 0
  for (let i = 0; i < d.length; i += 4) { r += d[i]; зел += d[i + 1] }
  const n = d.length / 4
  return { красный: r / n, зелёный: зел / n }
}

describe('различия текстур', () => {
  it('одинаковые текстуры дают зелёную карту', () => {
    const v = viewer
    const карта = v._diffTexture({ map: однотонная(8, '#3060a0') }, { map: однотонная(8, '#3060a0') })
    expect(карта, 'карта не построилась').toBeTruthy()
    const c = среднийЦвет(карта)
    expect(c.зелёный, `зелёного ${c.зелёный}, красного ${c.красный}: без изменений обязано быть зелено`)
      .toBeGreaterThan(c.красный)
  })

  it('сильно разошедшиеся текстуры дают красную карту', () => {
    const карта = viewer._diffTexture({ map: однотонная(8, '#000000') }, { map: однотонная(8, '#ffffff') })
    const c = среднийЦвет(карта)
    expect(c.красный, `красного ${c.красный}, зелёного ${c.зелёный}: чёрное против белого обязано быть красным`)
      .toBeGreaterThan(c.зелёный)
  })

  it('текстура вдвое меньше сравнивается в разрешении эталона, а не приводится к меньшему', () => {
    const карта = viewer._diffTexture({ map: однотонная(8, '#3060a0') }, { map: однотонная(4, '#3060a0') })
    expect(карта.image.width, 'карта построена не в разрешении эталона').toBe(8)
  })

  it('деталь без текстуры остаётся зелёной, а не красится наугад', () => {
    const карта = viewer._diffTexture({ map: однотонная(8, '#3060a0') }, {})
    const c = среднийЦвет(карта)
    expect(c.зелёный, 'у детали без текстуры карта обязана быть зелёной').toBeGreaterThan(c.красный)
  })
})

describe('переход между режимами не теряет родной материал', () => {
  function сТекстурой(цвет) {
    const g = new THREE.PlaneGeometry(1, 1)
    const мат = new THREE.MeshStandardMaterial({ map: однотонная(8, цвет), color: 0x8844cc })
    const mesh = new THREE.Mesh(g, мат)
    mesh.name = 'Плоскость'
    const model = new THREE.Group()
    model.add(mesh)
    return model
  }

  it('из сетки в различия карта детали не теряется', async () => {
    viewer.model = сТекстурой('#000000')
    viewer.setDiffReference([{ имя: '', карты: { map: однотонная(8, '#ffffff') } }])
    viewer.setDisplayMaterial('wire')
    viewer.setDisplayMaterial('texdiff')
    await дождаться()

    let карта = null
    viewer.model.traverse((o) => { if (o.isMesh && o.material?.map) карта = o.material.map })
    expect(карта, 'у детали нет карты различий — родной материал потерялся при переходе')
      .toBeTruthy()
    const c = среднийЦвет(карта)
    expect(c.красный, `красного ${c.красный}, зелёного ${c.зелёный}: чёрное против белого обязано краснеть`)
      .toBeGreaterThan(c.зелёный)
  })

  it('из сетки в глину цвет автора не теряется', () => {
    viewer.model = сТекстурой('#000000')
    viewer.setDisplayMaterial('wire')
    viewer.setDisplayMaterial('clay')
    let цвет = null
    viewer.model.traverse((o) => { if (o.isMesh && o.material?.color) цвет = o.material.color.getHexString() })
    expect(цвет, 'глина не применилась').toBeTruthy()
    expect(цвет, 'глина взяла цвет не у автора: перед ней материал уже подменили').toBe('8844cc')
  })
})

describe('в счёт идут все карты, а не только базовый цвет', () => {
  it('изменилась ТОЛЬКО нормаль — карта всё равно краснеет', () => {
    const карта = viewer._diffTexture(
      { map: однотонная(8, '#3060a0'), normalMap: однотонная(8, '#000000') },
      { map: однотонная(8, '#3060a0'), normalMap: однотонная(8, '#ffffff') },
    )
    const c = среднийЦвет(карта)
    expect(c.красный, `красного ${c.красный}, зелёного ${c.зелёный}: потеря в нормалях обязана быть видна`)
      .toBeGreaterThan(60)
  })

  it('решает САМАЯ пострадавшая карта, а нетронутая не разбавляет', () => {
    const однаИзДвух = среднийЦвет(viewer._diffTexture(
      { map: однотонная(8, '#000000'), normalMap: однотонная(8, '#000000') },
      { map: однотонная(8, '#000000'), normalMap: однотонная(8, '#ffffff') },
    ))
    const толькоОна = среднийЦвет(viewer._diffTexture(
      { normalMap: однотонная(8, '#000000') },
      { normalMap: однотонная(8, '#ffffff') },
    ))
    expect(однаИзДвух.красный, `с соседкой ${однаИзДвух.красный}, без неё ${толькоОна.красный}: `
      + 'целая карта разбавила разнесённую — значит снова усредняем')
      .toBe(толькоОна.красный)
  })

  it('разрешение берётся у САМОЙ КРУПНОЙ эталонной карты', () => {
    const карта = viewer._diffTexture(
      { map: однотонная(8, '#3060a0'), normalMap: однотонная(16, '#808080') },
      { map: однотонная(8, '#3060a0'), normalMap: однотонная(16, '#808080') },
    )
    expect(карта.image.width, 'взято не наибольшее разрешение среди карт').toBe(16)
  })
})

describe('память готовых карт', () => {
  it('повторный вход не пересчитывает: карта та же самая', async () => {
    const g = new THREE.PlaneGeometry(1, 1)
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: однотонная(8, '#000000') }))
    const model = new THREE.Group()
    model.add(mesh)
    viewer.model = model
    const эталон = [{ имя: '', карты: { map: однотонная(8, '#ffffff') } }]

    viewer.setDiffReference(эталон)
    viewer.setDisplayMaterial('texdiff')
    await дождаться()
    let первая = null
    viewer.model.traverse((o) => { if (o.isMesh && o.material?.map) первая = o.material.map })

    viewer.setDisplayMaterial('file')
    viewer.setDisplayMaterial('texdiff')
    await дождаться()
    let вторая = null
    viewer.model.traverse((o) => { if (o.isMesh && o.material?.map) вторая = o.material.map })

    expect(первая, 'карта не построилась').toBeTruthy()
    expect(вторая, 'при повторном входе карта пересчитана заново, память не работает').toBe(первая)
  })

  it('своя память у каждой пары моделей', async () => {
    const model = new THREE.Group()
    const деталь = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: однотонная(8, '#000000') }),
    )
    model.add(деталь)
    viewer.model = model

    const памятьA = new Map()
    viewer.useDiffStore(памятьA)
    viewer.setDiffReference([{ имя: '', карты: { map: однотонная(8, '#ffffff') } }])
    viewer.setDisplayMaterial('texdiff')
    await дождаться()
    let вА = null
    viewer.model.traverse((o) => { if (o.isMesh && o.material?.map) вА = o.material.map })
    expect(вА, 'карта для первой пары не построилась').toBeTruthy()
    expect(памятьA.size, 'посчитанное не легло в память пары').toBe(1)

    const памятьB = new Map()
    viewer.useDiffStore(памятьB)
    viewer.setDiffReference([{ имя: '', карты: { map: однотонная(8, '#000000') } }])
    let вБ = null
    viewer.model.traverse((o) => { if (o.isMesh && o.material?.map) вБ = o.material.map })
    expect(вБ, 'вторая пара взяла карту первой').not.toBe(вА)

    expect([...памятьA.values()][0]?.tex, 'память первой пары уничтожена при переходе ко второй').toBe(вА)
  })
})

describe('общая шкала плотности на оба окна', () => {
  it('заданная снаружи шкала важнее собственного разброса', () => {
    viewer.model = двеПанели(20, 2)
    viewer.setDensityScale(null)
    viewer.setDisplayMaterial('wire')
    const своя = оттенок(viewer.model, 'Плотная')

    const свой = viewer.densityRange()
    viewer.setDensityScale([свой[0], свой[1] * 1000])
    const общая = оттенок(viewer.model, 'Плотная')

    expect(общая, `на своей шкале ${своя}, на общей ${общая}: внешняя шкала не применилась`)
      .toBeGreaterThan(своя)
  })

  it('densityRange отдаёт разброс модели, а не одно число', () => {
    viewer.model = двеПанели(20, 2)
    const r = viewer.densityRange()
    expect(r, 'разброс не посчитан').toBeTruthy()
    expect(r[1], 'верх разброса обязан быть выше низа').toBeGreaterThan(r[0])
  })

  it('модель без геометрии разброса не даёт', () => {
    viewer.model = new THREE.Group()
    expect(viewer.densityRange(), 'пустая модель обязана честно ответить «нечего мерить»').toBeNull()
  })
})

describe('деталь без единой карты в режиме различий', () => {
  it('гасится прозрачностью, а не красится зелёным', async () => {
    const model = new THREE.Group()
    const стекло = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x88ccff }))
    стекло.name = 'Стекло'
    model.add(стекло)
    viewer.model = model
    viewer.setDiffReference([{ имя: '', карты: {} }])
    viewer.setDisplayMaterial('texdiff')
    await дождаться()

    let мат = null
    viewer.model.traverse((o) => { if (o.isMesh && o.name === 'Стекло') мат = o.material })
    expect(мат, 'материал не применился').toBeTruthy()
    expect(мат.transparent, 'деталь без карт обязана гаситься прозрачностью').toBe(true)
    expect(мат.opacity, 'прозрачность обязана быть заметной').toBeLessThan(0.3)
    const hsl = { h: 0, s: 0, l: 0 }
    мат.color.getHSL(hsl)
    expect(hsl.s, 'у погашенной детали не должно быть зелёного цвета').toBeLessThan(0.3)
  })

  it('деталь С картой по-прежнему сравнивается', async () => {
    const model = new THREE.Group()
    const кузов = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: однотонная(8, '#000000') }),
    )
    кузов.name = 'Кузов'
    model.add(кузов)
    viewer.model = model
    viewer.setDiffReference([{ имя: '', карты: { map: однотонная(8, '#ffffff') } }])
    viewer.setDisplayMaterial('texdiff')
    await дождаться()

    let мат = null
    viewer.model.traverse((o) => { if (o.isMesh && o.name === 'Кузов') мат = o.material })
    expect(мат.map, 'у детали с картой обязана быть карта различий').toBeTruthy()
    expect(мат.transparent, 'деталь с картой гасить нельзя').not.toBe(true)
  })
})

describe('эталон берётся из файла, а не с экрана', () => {
  it('после режима сетки эталон всё ещё содержит карты', () => {
    const model = new THREE.Group()
    const деталь = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: однотонная(8, '#ffffff') }),
    )
    деталь.name = 'Кузов'
    model.add(деталь)
    viewer.model = model

    viewer.setDisplayMaterial('wire')
    const refs = viewer.textureRefs()

    expect(refs.length, 'эталон пуст — деталь не попала в список').toBe(1)
    expect(refs[0].карты.map, 'эталон собран с ЭКРАНА, а не из файла: карта потерялась').toBeTruthy()
  })

  it('и сравнение после этого краснеет, а не зеленеет', async () => {
    const белая = new THREE.Group()
    const было = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: однотонная(8, '#ffffff') }),
    )
    было.name = 'Кузов'
    белая.add(было)
    viewer.model = белая

    viewer.setDisplayMaterial('wire')
    const эталон = viewer.textureRefs()
    viewer.setDisplayMaterial('file')

    const чёрная = new THREE.Group()
    const стало = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: однотонная(8, '#000000') }),
    )
    стало.name = 'Кузов'
    чёрная.add(стало)
    viewer.model = чёрная
    viewer.useDiffStore(new Map())
    viewer.setDiffReference(эталон)
    viewer.setDisplayMaterial('texdiff')
    await дождаться()

    let карта = null
    viewer.model.traverse((o) => { if (o.isMesh && o.material?.map) карта = o.material.map })
    expect(карта, 'карты различий нет: эталон приехал пустым').toBeTruthy()
    const c = среднийЦвет(карта)
    expect(c.красный, `красного ${c.красный}, зелёного ${c.зелёный}: чёрное против белого обязано краснеть`)
      .toBeGreaterThan(c.зелёный)
  })
})

describe('память переживает переключение режимов', () => {
  it('повторная установка ТОГО ЖЕ эталона не выбрасывает посчитанное', async () => {
    const model = new THREE.Group()
    const деталь = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: однотонная(8, '#000000') }),
    )
    деталь.name = 'Кузов'
    model.add(деталь)
    viewer.model = model

    const эталон = [{ имя: '', карты: { map: однотонная(8, '#ffffff') } }]

    viewer.setDiffReference(эталон)
    viewer.setDisplayMaterial('texdiff')
    await дождаться()
    let первая = null
    viewer.model.traverse((o) => { if (o.isMesh && o.material?.map) первая = o.material.map })

    viewer.setDisplayMaterial('wire')
    viewer.setDiffReference(эталон)
    viewer.setDisplayMaterial('texdiff')
    await дождаться()
    let вторая = null
    viewer.model.traverse((o) => { if (o.isMesh && o.material?.map) вторая = o.material.map })

    expect(первая, 'карта не построилась').toBeTruthy()
    expect(вторая, 'после возврата в режим карта пересчитана заново — память не пережила переключение')
      .toBe(первая)
  })

  it('возврат к прежней паре ничего не пересчитывает', async () => {
    const model = new THREE.Group()
    const деталь = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: однотонная(8, '#000000') }),
    )
    model.add(деталь)
    viewer.model = model

    const память = new Map()
    const эталон = [{ имя: '', карты: { map: однотонная(8, '#ffffff') } }]
    viewer.useDiffStore(память)
    viewer.setDiffReference(эталон)
    viewer.setDisplayMaterial('texdiff')
    await дождаться()
    const первая = [...память.values()][0]?.tex

    viewer.setDisplayMaterial('wire')
    viewer.useDiffStore(память)
    viewer.setDiffReference(эталон)
    viewer.setDisplayMaterial('texdiff')
    await дождаться()

    expect([...память.values()][0]?.tex, 'при возврате к той же паре карта пересчитана заново').toBe(первая)
  })
})

describe('память различий не зависит от того, откуда пришли', () => {
  const промежуточные = DISPLAY_MODES.filter((m) => m !== 'texdiff')

  for (const режим of промежуточные) {
    it(`через «${режим}» и обратно — расчёт не повторяется`, async () => {
      const model = new THREE.Group()
      const деталь = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshStandardMaterial({ map: однотонная(8, '#000000') }),
      )
      model.add(деталь)
      viewer.model = model

      const память = new Map()
      const эталон = [{ имя: '', карты: { map: однотонная(8, '#ffffff') } }]
      viewer.useDiffStore(память)
      viewer.setDiffReference(эталон)
      viewer.setDisplayMaterial('texdiff')
      await дождаться()
      const первая = [...память.values()][0]?.tex
      expect(первая, 'карта не построилась').toBeTruthy()

      viewer.setDisplayMaterial(режим)
      viewer.useDiffStore(память)
      viewer.setDiffReference(эталон)
      viewer.setDisplayMaterial('texdiff')
      await дождаться()

      expect([...память.values()][0]?.tex, `после «${режим}» карта пересчитана заново`).toBe(первая)
    })
  }
})

describe('расчёт не морозит окно', () => {
  function несколькоДеталей(n) {
    const model = new THREE.Group()
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshStandardMaterial({ map: однотонная(8, '#000000'), name: `Деталь ${i}` }),
      )
      m.name = `Деталь ${i}`
      model.add(m)
    }
    return model
  }

  it('после переключения деталь видна СРАЗУ, до конца расчёта', () => {
    viewer.model = несколькоДеталей(4)
    viewer.useDiffStore(new Map())
    viewer.setDiffReference(Array.from({ length: 4 }, (_, i) => ({ имя: `Деталь ${i}`, карты: { map: однотонная(8, '#ffffff') } })))
    viewer.setDisplayMaterial('texdiff')

    let без = 0
    viewer.model.traverse((o) => { if (o.isMesh && !o.material) без++ })
    expect(без, 'деталь осталась без материала: окно показало бы пустоту').toBe(0)
  })

  it('о начале и конце работы сообщается наружу', async () => {
    await дождаться()
    const события = []
    viewer.setOnBusy((b) => события.push(b))

    viewer.model = несколькоДеталей(3)
    viewer.useDiffStore(new Map())
    viewer.setDiffReference(Array.from({ length: 3 }, (_, i) => ({ имя: `Деталь ${i}`, карты: { map: однотонная(8, '#ffffff') } })))
    viewer.setDisplayMaterial('texdiff')
    await дождаться()

    expect(события[0], 'о начале работы не сообщили — кубик не появится').toBe(true)
    expect(события[события.length - 1], 'о конце работы не сообщили — кубик не погаснет').toBe(false)
    viewer.setOnBusy(null)
  })

  it('деталь, ответ по которой известен сразу, в очередь не идёт', () => {
    const model = new THREE.Group()
    const стекло = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial())
    стекло.name = 'Стекло'
    стекло.material.name = 'Стекло'
    model.add(стекло)
    viewer.model = model
    viewer.useDiffStore(new Map())
    viewer.setDiffReference([{ имя: 'Стекло', карты: {} }])
    viewer.setDisplayMaterial('texdiff')

    expect(viewer._diffQueue.length, 'деталь без карт попала в очередь расчёта').toBe(0)
  })
})

describe('деталь узнаётся по имени, а не по месту в обходе', () => {
  function параДеталей(верхЦвет, низЦвет) {
    const model = new THREE.Group()
    const верх = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: однотонная(8, верхЦвет), name: 'Верх' }),
    )
    верх.name = 'Верх'
    const низ = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: однотонная(8, низЦвет), name: 'Низ' }),
    )
    низ.name = 'Низ'
    model.add(верх, низ)
    return model
  }

  function картаДетали(имя) {
    let м = null
    viewer.model.traverse((o) => { if (o.isMesh && o.name === имя) м = o.material })
    return м
  }

  it('переставленные детали сравниваются со СВОИМИ эталонами', async () => {
    const эталон = [
      { имя: 'Низ', карты: { map: однотонная(8, '#000000') } },
      { имя: 'Верх', карты: { map: однотонная(8, '#ffffff') } },
    ]
    viewer.model = параДеталей('#ffffff', '#000000')
    viewer.useDiffStore(new Map())
    viewer.setDiffReference(эталон)
    viewer.setDisplayMaterial('texdiff')
    await дождаться()

    for (const имя of ['Верх', 'Низ']) {
      const c = среднийЦвет(картаДетали(имя).map)
      expect(c.зелёный, `«${имя}»: красного ${c.красный}, зелёного ${c.зелёный} — деталь `
        + 'сравнили с чужим эталоном').toBeGreaterThan(c.красный)
    }
  })

  it('одинаковые детали на одной текстуре красятся ОДИНАКОВО', async () => {
    const общийЭталон = однотонная(8, '#ffffff')
    const общаяСтавшая = однотонная(8, '#000000')
    const model = new THREE.Group()
    const общийМатериал = new THREE.MeshStandardMaterial({ map: общаяСтавшая, name: 'Пешки' })
    for (const имя of ['Пешка A', 'Пешка Б']) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), общийМатериал)
      m.name = имя
      model.add(m)
    }
    viewer.model = model
    const память = new Map()
    viewer.useDiffStore(память)
    viewer.setDiffReference([{ имя: 'Пешки', карты: { map: общийЭталон } }])
    viewer.setDisplayMaterial('texdiff')
    await дождаться()

    const a = картаДетали('Пешка A').map
    const б = картаДетали('Пешка Б').map
    expect(a, 'карта не построилась').toBeTruthy()
    expect(б, 'вторая деталь на той же паре текстур получила ДРУГУЮ карту').toBe(a)
    expect(память.size, 'одно и то же сравнение посчитано дважды: память по паре текстур '
      + 'не работает, а на ABeautifulGame это 49 расчётов вместо двух').toBe(1)
  })

  it('деталь без пары ГАСНЕТ, а не зеленеет', async () => {
    viewer.model = параДеталей('#ffffff', '#000000')
    viewer.useDiffStore(new Map())
    viewer.setDiffReference([{ имя: 'Верх', карты: { map: однотонная(8, '#ffffff') } }])
    viewer.setDisplayMaterial('texdiff')
    await дождаться()

    const низ = картаДетали('Низ')
    expect(низ.transparent, 'деталь без пары показана как обычная — человек прочтёт это как ответ')
      .toBe(true)
    expect(низ.color.getHex(), 'деталь без пары покрашена зелёным: это ложь про сохранность')
      .not.toBe(0x22c55e)
  })

  it('когда по именам не сходится НИЧЕГО — идём по порядку', async () => {
    viewer.model = параДеталей('#000000', '#000000')
    viewer.useDiffStore(new Map())
    viewer.setDiffReference([
      { имя: 'совсем другое имя', карты: { map: однотонная(8, '#ffffff') } },
      { имя: 'и это тоже', карты: { map: однотонная(8, '#ffffff') } },
    ])
    viewer.setDisplayMaterial('texdiff')
    await дождаться()

    const c = среднийЦвет(картаДетали('Верх').map)
    expect(c.красный, `красного ${c.красный}, зелёного ${c.зелёный}: запасной путь по порядку `
      + 'не сработал, модель осталась без ответа').toBeGreaterThan(c.зелёный)
  })
  it('склеенные детали не теряют ответ: ключ — материал, а не деталь', async () => {
    const материал = new THREE.MeshStandardMaterial({ map: однотонная(8, '#000000'), name: 'Стены' })
    const склеенная = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), материал)
    склеенная.name = 'Merged_0'
    const model = new THREE.Group()
    model.add(склеенная)
    viewer.model = model
    viewer.useDiffStore(new Map())
    viewer.setDiffReference([{ имя: 'Стены', карты: { map: однотонная(8, '#ffffff') } }])
    viewer.setDisplayMaterial('texdiff')
    await дождаться()

    const мат = картаДетали('Merged_0')
    expect(мат.map, 'склеенная деталь осталась без ответа: материал её не спас').toBeTruthy()
    const c = среднийЦвет(мат.map)
    expect(c.красный, `красного ${c.красный}, зелёного ${c.зелёный}: чёрное против белого обязано краснеть`)
      .toBeGreaterThan(c.зелёный)
  })
})

describe('цвет различий — постоянная шкала, а подпись говорит «насколько»', () => {
  function модельИзДвух(слабый, сильный) {
    const model = new THREE.Group()
    const a = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: однотонная(8, слабый), name: 'Слабая' }))
    a.name = 'Слабая'
    const b = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: однотонная(8, сильный), name: 'Сильная' }))
    b.name = 'Сильная'
    model.add(a, b)
    return model
  }

  async function показать(слабый, сильный) {
    viewer.model = модельИзДвух(слабый, сильный)
    viewer.useDiffStore(new Map())
    viewer.setDiffReference([
      { имя: 'Слабая', карты: { map: однотонная(8, '#000000') } },
      { имя: 'Сильная', карты: { map: однотонная(8, '#000000') } },
    ])
    viewer.setDisplayMaterial('texdiff')
    await дождаться()
  }

  function цвет(имя) {
    let м = null
    viewer.model.traverse((o) => { if (o.isMesh && o.name === имя) м = o.material })
    return среднийЦвет(м.map)
  }

  it('мелкое изменение остаётся ЗЕЛЁНЫМ, а не краснеет', async () => {
    await показать('#020202', '#040404')
    for (const имя of ['Слабая', 'Сильная']) {
      const c = цвет(имя)
      expect(c.зелёный, `«${имя}»: красного ${c.красный}, зелёного ${c.зелёный} — мелкое `
        + 'изменение покрашено как разгром').toBeGreaterThan(c.красный)
    }
  })

  it('цвет не зависит от того, что рядом', async () => {
    await показать('#020202', '#040404')
    const одна = цвет('Слабая')
    await показать('#020202', '#ffffff')
    const другая = цвет('Слабая')
    expect(Math.abs(одна.красный - другая.красный), 'та же деталь покрашена по-разному из-за '
      + 'соседей — значит шкала снова поехала за моделью').toBeLessThan(8)
  })

  it('полное изменение краснеет', async () => {
    await показать('#020202', '#ffffff')
    const c = цвет('Сильная')
    expect(c.красный, `красного ${c.красный}, зелёного ${c.зелёный}: полная потеря обязана `
      + 'быть красной').toBeGreaterThan(c.зелёный)
  })

  it('подпись говорит, насколько цела структура худшей детали', async () => {
    await показать('#020202', '#040404')
    expect(viewer.diffScale(), 'ровные заливки: структуре терять нечего').toBe(1)
  })

  it('размытая деталь роняет схожесть структуры', async () => {
    const model = new THREE.Group()
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: однотонная(16, '#858585'), name: 'Плоская' }))
    m.name = 'Плоская'
    model.add(m)
    viewer.model = model
    viewer.useDiffStore(new Map())
    viewer.setDiffReference([{ имя: 'Плоская', карты: { map: шахматка(16, '#404040', '#c0c0c0') } }])
    viewer.setDisplayMaterial('texdiff')
    await дождаться()
    expect(viewer.diffScale(), 'узор стёрт в ровное, а схожесть структуры не упала')
      .toBeLessThan(0.5)
  })

  it('ничего не изменилось — подпись это и говорит', async () => {
    await показать('#000000', '#000000')
    expect(viewer.diffScale(), 'при полном совпадении структура цела').toBe(1)
    const c = цвет('Сильная')
    expect(c.зелёный, 'ничего не изменилось, а деталь не зелёная').toBeGreaterThan(c.красный)
  })
})

describe('подписка на долгую работу доходит до движка', () => {
  it('движок, созданный после подписки, всё равно сообщает о работе', async () => {
    const события = []
    viewer.setOnBusy((b) => события.push(b))

    const model = new THREE.Group()
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: однотонная(8, '#000000'), name: 'Деталь' }),
    )
    m.name = 'Деталь'
    model.add(m)
    viewer.model = model
    viewer.useDiffStore(new Map())
    viewer.setDiffReference([{ имя: 'Деталь', карты: { map: однотонная(8, '#ffffff') } }])
    viewer.setDisplayMaterial('texdiff')
    await дождаться()

    expect(события[0], 'о начале работы не сообщили').toBe(true)
    expect(события[события.length - 1], 'о конце работы не сообщили — кубик не погаснет').toBe(false)
    viewer.setOnBusy(null)
  })
})

describe('пропавшие детали считаются потерей наравне с цветом', () => {
  it('размытие мелкого узора краснеет сильнее, чем тот же сдвиг цвета', () => {
    const узор = среднийЦвет(viewer._diffTexture(
      { map: шахматка(16, '#808080', '#8a8a8a') },
      { map: однотонная(16, '#858585') },
    ))
    const ровно = среднийЦвет(viewer._diffTexture(
      { map: однотонная(16, '#808080') },
      { map: однотонная(16, '#858585') },
    ))
    expect(узор.красный, `узор ${узор.красный}, ровное ${ровно.красный}: пропавшие детали не `
      + 'считаются потерей — уменьшение размера так и останется невидимым')
      .toBeGreaterThan(ровно.красный + 20)
  })

  it('целая картинка остаётся зелёной: деталей не убыло', () => {
    const c = среднийЦвет(viewer._diffTexture(
      { map: шахматка(16, '#808080', '#8a8a8a') },
      { map: шахматка(16, '#808080', '#8a8a8a') },
    ))
    expect(c.зелёный, `красного ${c.красный}, зелёного ${c.зелёный}: ничего не изменилось, а `
      + 'карта не зелёная').toBeGreaterThan(240)
    expect(c.красный, 'ничего не изменилось, а карта покраснела').toBeLessThan(20)
  })

  it('SSIM симметричен: расхождение структуры важно, а не его знак', () => {
    const прибавилось = среднийЦвет(viewer._diffTexture(
      { map: однотонная(16, '#858585') },
      { map: шахматка(16, '#808080', '#8a8a8a') },
    ))
    const пропало = среднийЦвет(viewer._diffTexture(
      { map: шахматка(16, '#808080', '#8a8a8a') },
      { map: однотонная(16, '#858585') },
    ))
    expect(прибавилось.красный, `прибавилось ${прибавилось.красный}, пропало ${пропало.красный}`)
      .toBe(пропало.красный)
  })
})

describe('пороги красного постоянны, названы числами и взяты из замера', () => {
  it('оба порога стоят там, где их поставил замер двух моделей', () => {
    expect(viewer.constructor.ПОЛНЫЙ_КРАСНЫЙ, 'порог сдвига цвета переехал молча').toBe(0.10)
    expect(viewer.constructor.ПОРОГ_SSIM, 'порог потери структуры переехал молча').toBe(0.40)
  })

  it('на пороге — красный, вдесятеро меньше — зелёный', () => {
    const наПороге = среднийЦвет(viewer._diffTexture(
      { map: однотонная(8, '#000000') }, { map: однотонная(8, '#1a1a1a') },
    ))
    const вдесятероМеньше = среднийЦвет(viewer._diffTexture(
      { map: однотонная(8, '#000000') }, { map: однотонная(8, '#030303') },
    ))
    expect(наПороге.красный, `на пороге красного ${наПороге.красный}: порог не достигается`)
      .toBeGreaterThan(240)
    expect(вдесятероМеньше.зелёный, `вдесятеро меньше порога: зелёного ${вдесятероМеньше.зелёный}`)
      .toBeGreaterThan(200)
  })

  it('прежние пять процентов дают жёлтое, а не красное', () => {
    const прежний = среднийЦвет(viewer._diffTexture(
      { map: однотонная(8, '#000000') }, { map: однотонная(8, '#0d0d0d') },
    ))
    const наПороге = среднийЦвет(viewer._diffTexture(
      { map: однотонная(8, '#000000') }, { map: однотонная(8, '#1a1a1a') },
    ))
    expect(прежний.зелёный, `сдвиг на 5%: зелёного ${прежний.зелёный} — снова красное, как было`)
      .toBeGreaterThan(200)
    expect(наПороге.зелёный, `сдвиг на 10%: зелёного ${наПороге.зелёный} — красное не достигнуто`)
      .toBeLessThan(40)
  })

  it('шкала ЛИНЕЙНАЯ: четверть порога зеленее, чем три четверти', () => {
    const четверть = среднийЦвет(viewer._diffTexture(
      { map: однотонная(8, '#000000') }, { map: однотонная(8, '#060606') },
    ))
    const триЧетверти = среднийЦвет(viewer._diffTexture(
      { map: однотонная(8, '#000000') }, { map: однотонная(8, '#131313') },
    ))
    expect(четверть.красный, `у четверти шкалы красного ${четверть.красный}`).toBeLessThan(160)
    expect(триЧетверти.красный, `у трёх четвертей красного ${триЧетверти.красный}`).toBe(255)
    expect(триЧетверти.зелёный, `зелёного ${триЧетверти.зелёный} против ${четверть.зелёный}: `
      + 'к порогу зелень обязана уходить').toBeLessThan(четверть.зелёный)
  })
})

describe('пиксели текстур снимаются видеокартой, а не холстом', () => {
  it('цвет переживает круг через видеокарту без изменений', () => {
    const t = однотонная(8, '#3060a0')
    t.colorSpace = THREE.SRGBColorSpace
    const пиксели = viewer._пикселиТекстуры(t, 8, 8)
    expect(пиксели, 'пиксели не сняты вовсе').toBeTruthy()
    expect(пиксели[0], `красный ${пиксели[0]} вместо 0x30: цветовые пространства не погасились`)
      .toBeGreaterThan(0x30 - 3)
    expect(пиксели[0]).toBeLessThan(0x30 + 3)
    expect(пиксели[1], `зелёный ${пиксели[1]} вместо 0x60`).toBeGreaterThan(0x60 - 3)
    expect(пиксели[1]).toBeLessThan(0x60 + 3)
    expect(пиксели[2], `синий ${пиксели[2]} вместо 0xa0`).toBeGreaterThan(0xa0 - 3)
    expect(пиксели[2]).toBeLessThan(0xa0 + 3)
  })

  it('текстуры без картинки не роняют расчёт', () => {
    expect(viewer._пикселиТекстуры(null, 8, 8), 'пустая текстура должна давать null').toBeNull()
    expect(() => viewer._пикселиТекстуры({}, 8, 8), 'текстура без картинки роняет расчёт')
      .not.toThrow()
  })

  it('одна текстура читается с видеокарты ОДИН раз', () => {
    const t = однотонная(8, '#204060')
    const первый = viewer._пикселиТекстуры(t, 8, 8)
    const второй = viewer._пикселиТекстуры(t, 8, 8)
    expect(второй, 'снято заново вместо того, чтобы взять из памяти').toBe(первый)
  })
})

describe('карта различий ложится ТУДА ЖЕ, куда лежала текстура', () => {
  function модельСРазмещением(настроить) {
    const карта = однотонная(8, '#000000')
    настроить(карта)
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: карта, name: 'Деталь' }))
    m.name = 'Деталь'
    const model = new THREE.Group()
    model.add(m)
    return model
  }

  async function показать(model) {
    viewer.model = model
    viewer.useDiffStore(new Map())
    viewer.setDiffReference([{ имя: 'Деталь', карты: { map: однотонная(8, '#ffffff') } }])
    viewer.setDisplayMaterial('texdiff')
    await дождаться()
    let м = null
    viewer.model.traverse((o) => { if (o.isMesh && o.name === 'Деталь') м = o.material })
    return м
  }

  it('сдвиг и масштаб переносятся на карту', async () => {
    const м = await показать(модельСРазмещением((t) => {
      t.offset.set(0.25, 0.5)
      t.repeat.set(2, 3)
      t.wrapS = THREE.RepeatWrapping
      t.wrapT = THREE.RepeatWrapping
    }))
    expect(м.map.offset.x, 'сдвиг не перенесён — карта ляжет не туда').toBeCloseTo(0.25, 5)
    expect(м.map.offset.y, 'сдвиг по второй оси не перенесён').toBeCloseTo(0.5, 5)
    expect(м.map.repeat.x, 'масштаб не перенесён — отсюда «растяжки линиями»').toBeCloseTo(2, 5)
    expect(м.map.repeat.y, 'масштаб по второй оси не перенесён').toBeCloseTo(3, 5)
    expect(м.map.wrapS, 'обёртка не перенесена: при повторе края разъедутся')
      .toBe(THREE.RepeatWrapping)
  })

  it('поворот переносится на карту', async () => {
    const м = await показать(модельСРазмещением((t) => {
      t.rotation = Math.PI / 4
      t.center.set(0.5, 0.5)
    }))
    expect(м.map.rotation, 'поворот не перенесён').toBeCloseTo(Math.PI / 4, 5)
    expect(м.map.center.x, 'середина поворота не перенесена').toBeCloseTo(0.5, 5)
  })

  it('номер набора развёртки переносится', async () => {
    const м = await показать(модельСРазмещением((t) => { t.channel = 2 }))
    expect(м.map.channel, 'карта повешена на чужой набор развёртки').toBe(2)
  })

  it('анимация сдвига догоняется: карта едет вместе с текстурой', async () => {
    const model = модельСРазмещением((t) => { t.offset.set(0, 0) })
    const м = await показать(model)
    let исходная = null
    model.traverse((o) => { if (o.isMesh) исходная = viewer._родной(o)?.map })
    expect(исходная, 'исходной карты нет — проверка вышла пустой').toBeTruthy()

    исходная.offset.set(0.7, 0.2)
    viewer.renderFrame()
    expect(м.map.offset.x, 'карта не поехала за текстурой: анимация не отыграется')
      .toBeCloseTo(0.7, 5)
    expect(м.map.offset.y, 'карта не поехала по второй оси').toBeCloseTo(0.2, 5)
  })

  it('одни карты, разное размещение — одна запись в памяти и своя копия каждому', async () => {
    const эталон = однотонная(8, '#ffffff')
    const общая = однотонная(8, '#000000')
    const слева = { map: общая }
    const справа = { map: общая }
    expect(viewer.constructor._ключПары({ map: эталон }, слева),
      'то же содержимое дало разные ключи — память будет пересчитываться зря')
      .toBe(viewer.constructor._ключПары({ map: эталон }, справа))

    const первый = однотонная(8, '#000000')
    первый.offset.set(0.1, 0)
    const второй = однотонная(8, '#000000')
    второй.offset.set(0.9, 0)
    const карта = однотонная(8, '#123456')
    const мA = viewer._картой(карта, первый)
    const мB = viewer._картой(карта, второй)
    expect(мA.map.offset.x, 'первый материал потерял своё размещение').toBeCloseTo(0.1, 5)
    expect(мB.map.offset.x, 'второй материал получил чужое размещение').toBeCloseTo(0.9, 5)
    expect(мB.map.image, 'копия завела свою картинку — память выросла вдвое зря')
      .toBe(мA.map.image)
  })

  it('сдвиг анимации не заставляет считать заново', async () => {
    const model = модельСРазмещением((t) => { t.offset.set(0, 0) })
    const м1 = await показать(model)
    const карта1 = м1.map

    let исходная = null
    model.traverse((o) => { if (o.isMesh) исходная = viewer._родной(o)?.map })
    исходная.offset.set(0.42, 0.17)

    viewer.setDisplayMaterial('file')
    viewer.setDisplayMaterial('texdiff')
    await дождаться()
    let м2 = null
    viewer.model.traverse((o) => { if (o.isMesh && o.name === 'Деталь') м2 = o.material })
    expect(м2.map, 'после сдвига анимации карта пересчитана заново').toBe(карта1)
    expect(м2.map.offset.x, 'карта не догнала новый сдвиг').toBeCloseTo(0.42, 5)
  })
})

describe('карта различий совпадает с исходной по МЕСТУ, а не только по развёртке', () => {
  function половинки(размер, верх, низ, flipY) {
    const c = document.createElement('canvas')
    c.width = размер
    c.height = размер
    const g = c.getContext('2d')
    g.fillStyle = верх
    g.fillRect(0, 0, размер, размер / 2)
    g.fillStyle = низ
    g.fillRect(0, размер / 2, размер, размер / 2)
    const t = new THREE.CanvasTexture(c)
    t.flipY = flipY
    t.needsUpdate = true
    return t
  }

  function половины(карта) {
    const c = document.createElement('canvas')
    c.width = карта.image.width
    c.height = карта.image.height
    const g = c.getContext('2d')
    g.drawImage(карта.image, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    let верх = 0
    let низ = 0
    const половина = (c.height / 2) * c.width
    for (let p = 0; p < c.width * c.height; p++) {
      if (p < половина) верх += d[p * 4]
      else низ += d[p * 4]
    }
    return { верх: верх / половина, низ: низ / половина }
  }

  for (const flipY of [true, false]) {
    it(`испорчен ВЕРХ — краснеет верх (flipY: ${flipY})`, () => {
      const карта = viewer._diffTexture(
        { map: половинки(16, '#808080', '#808080', flipY) },
        { map: половинки(16, '#000000', '#808080', flipY) },
      )
      expect(карта, 'карта не построилась').toBeTruthy()
      const { верх, низ } = половины(карта)
      expect(верх, `верх ${верх.toFixed(0)}, низ ${низ.toFixed(0)}: карта перевёрнута — `
        + 'красное показано не на той половине').toBeGreaterThan(низ + 40)
    })

    it(`испорчен НИЗ — краснеет низ (flipY: ${flipY})`, () => {
      const карта = viewer._diffTexture(
        { map: половинки(16, '#808080', '#808080', flipY) },
        { map: половинки(16, '#808080', '#000000', flipY) },
      )
      const { верх, низ } = половины(карта)
      expect(низ, `верх ${верх.toFixed(0)}, низ ${низ.toFixed(0)}: карта перевёрнута`)
        .toBeGreaterThan(верх + 40)
    })
  }

  it('готовая карта наследует flipY эталона', () => {
    for (const flipY of [true, false]) {
      const карта = viewer._diffTexture(
        { map: половинки(16, '#808080', '#404040', flipY) },
        { map: половинки(16, '#000000', '#404040', flipY) },
      )
      expect(карта.flipY, `flipY эталона ${flipY} не перенесён на карту`).toBe(flipY)
    }
  })
})
