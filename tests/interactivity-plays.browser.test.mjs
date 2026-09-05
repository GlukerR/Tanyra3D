import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createViewer, disposeViewer } from '../tests/helpers/viewer-test-utils.mjs'

const СВОЯ = 'Interactive Playback 01.glb'
const MODELS = [СВОЯ, 'TrafficLight.glb', 'Calculator.glb', 'WhackAMole.glb', 'MagicBall.glb', 'ConstructionSite.glb']
const PLAIN = 'Dirty Cube 01.glb'

const present = new Map(await Promise.all([...MODELS, PLAIN].map(async (file) => {
  try {
    const res = await fetch('/' + encodeURIComponent(file), { method: 'HEAD' })
    return [file, res.ok]
  } catch {
    return [file, false]
  }
})))

const itWithModels = (files, name, fn, timeout) => {
  const missing = files.filter((f) => !present.get(f))
  return missing.length
    ? it.skip(`${name} [пропущено: нет локально — ${missing.join(', ')}]`, () => {}, timeout)
    : it(name, fn, timeout)
}

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

const colours = () => {
  const out = []
  viewer.model.traverse((o) => {
    if (o.isMesh && o.material?.color) out.push(o.material.color.getHexString())
  })
  return out
}


describe('1. граф понят целиком', () => {
  for (const model of MODELS) {
    itWithModels([model], `${model} — ни одного незнакомого узла или адреса`, async () => {
      await viewer.load('/' + model)
      const info = viewer.getBehaviourInfo()
      expect(info.refusal, `в графе есть то, чего мы не знаем:\n  ${info.refusal.join('\n  ')}`).toEqual([])
      expect(info.playable, 'граф разобран, но не проигрывается').toBe(true)
    }, 120000)
  }

  itWithModels([PLAIN], 'модель без графа не «проигрывается» — играть нечего', async () => {
    await viewer.load('/' + encodeURIComponent(PLAIN))
    expect(viewer.getBehaviourInfo().playable).toBe(false)
  }, 120000)
})


describe('2. нажатие срабатывает', () => {
  itWithModels(['TrafficLight.glb'], 'светофор: нажатие красит материал', async () => {
    await viewer.load('/TrafficLight.glb')
    const было = colours()
    const откликнулся = viewer._behaviour.select(viewer._interactive[0].nodeIndex)
    expect(откликнулся, 'граф не отозвался на нажатие').toBe(true)
    const стало = colours()
    expect(стало.filter((c, i) => c !== было[i]).length, 'ни один материал не изменился')
      .toBeGreaterThan(0)
  }, 120000)

  itWithModels(['MagicBall.glb'], 'шар: нажатие меняет ВИДИМОСТЬ узлов', async () => {
    await viewer.load('/MagicBall.glb')
    const было = new Map()
    viewer.model.traverse((o) => было.set(o, o.visible))

    viewer._behaviour.select(viewer._interactive[0].nodeIndex)

    const сменили = [...было].filter(([o, v]) => o.visible !== v)
    expect(сменили.length, 'ни один узел не сменил видимость — pointer/set по видимости не сработал')
      .toBeGreaterThan(0)
  }, 120000)

  itWithModels(['Calculator.glb'], 'калькулятор: нажатие двигает развёртку', async () => {
    await viewer.load('/Calculator.glb')
    const карты = []
    viewer.model.traverse((o) => { if (o.isMesh && o.material?.map) карты.push(o.material.map) })
    expect(карты.length, 'в калькуляторе нет ни одной текстуры').toBeGreaterThan(0)
    const было = карты.map((m) => `${m.offset.x},${m.offset.y}`)

    viewer._behaviour.select(viewer._interactive[0].nodeIndex)
    const стало = карты.map((m) => `${m.offset.x},${m.offset.y}`)
    expect(стало.some((v, i) => v !== было[i]), 'развёртка не сдвинулась').toBe(true)
  }, 120000)

  itWithModels(['WhackAMole.glb'], 'крот: отложенный шаг доходит и двигает узел', async () => {
    await viewer.load('/WhackAMole.glb')
    const часть = viewer._interactive[0]
    const было = часть.object.position.clone()
    viewer._behaviour.select(часть.nodeIndex)
    await new Promise((r) => setTimeout(r, 4000))
    expect(часть.object.position.distanceTo(было), 'крот не шевельнулся даже через четыре секунды')
      .toBeGreaterThan(0)
  }, 120000)
})


describe('3. луч попадает по части', () => {
  itWithModels(['TrafficLight.glb'], 'попадание в центр нажимаемой части запускает отклик', async () => {
    await viewer.load('/TrafficLight.glb')
    const часть = viewer._interactive[0]
    const цель = new (await import('three')).Vector3()
    часть.object.getWorldPosition(цель)
    viewer.camera.position.set(цель.x, цель.y, цель.z + 1.5)
    viewer.camera.lookAt(цель)
    viewer.camera.updateMatrixWorld(true)

    expect(viewer.pickInteractive(0.5, 0.5), 'луч не попал по части в центре кадра').toBe(true)
  }, 120000)

  itWithModels(['TrafficLight.glb'], 'мимо модели — ничего не запускается', async () => {
    await viewer.load('/TrafficLight.glb')
    expect(viewer.pickInteractive(0.02, 0.02), 'отклик сработал по пустому месту').toBe(false)
  }, 120000)
})


describe('4. за собой убираем', () => {
  itWithModels(['WhackAMole.glb', PLAIN], 'задержка, начатая до смены модели, не трогает новую', async () => {
    await viewer.load('/WhackAMole.glb')
    viewer._behaviour.select(viewer._interactive[0].nodeIndex)
    await viewer.load('/' + encodeURIComponent(PLAIN))
    const было = viewer.model.position.clone()
    await new Promise((r) => setTimeout(r, 4000))

    expect(viewer._behaviour, 'исполнитель пережил модель').toBeFalsy()
    expect(viewer.model.position.distanceTo(было), 'чужой отложенный шаг подвинул новую модель')
      .toBe(0)
  }, 120000)
})


describe('5. нажимаем как человек', () => {
  itWithModels(['WhackAMole.glb'], 'анимация, запущенная графом, ИДЁТ сама', async () => {
    await viewer.load('/WhackAMole.glb')
    expect(viewer._behaviour.deps.clips.length, 'клипы не доехали до исполнителя')
      .toBeGreaterThan(0)
    expect(viewer._behaviourMixer, 'у графа нет своего микшера').toBeTruthy()

    const крот = viewer._interactive[0]
    const было = крот.object.position.clone()
    viewer._behaviour.select(крот.nodeIndex)

    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 33))
      viewer.renderFrame()
    }
    expect(крот.object.position.distanceTo(было), 'крот не сдвинулся за три секунды кадров')
      .toBeGreaterThan(0)
  }, 120000)

  itWithModels(['TrafficLight.glb'], 'ДОЛГОЕ нажатие без сдвига — тоже нажатие', async () => {
    await viewer.load('/TrafficLight.glb')
    const часть = viewer._interactive[0]
    const THREE = await import('three')
    const цель = new THREE.Vector3()
    часть.object.getWorldPosition(цель)
    viewer.camera.position.set(цель.x, цель.y, цель.z + 1.5)
    viewer.camera.lookAt(цель)
    viewer.camera.updateMatrixWorld(true)

    const было = colours()
    const box = canvas.getBoundingClientRect()
    const x = box.left + box.width / 2
    const y = box.top + box.height / 2
    const событие = (тип) => new PointerEvent(тип, { clientX: x, clientY: y, bubbles: true });

    canvas.dispatchEvent(событие('pointerdown'))
    await new Promise((r) => setTimeout(r, 1200))
    canvas.dispatchEvent(событие('pointerup'))

    expect(colours().filter((c, i) => c !== было[i]).length,
      'долгое нажатие не сработало — снова считаем нажатием только быстрое').toBeGreaterThan(0)
  }, 120000)

  itWithModels(['TrafficLight.glb'], 'нажатие СО СДВИГОМ — это вращение, не нажатие', async () => {
    await viewer.load('/TrafficLight.glb')
    const было = colours()
    const box = canvas.getBoundingClientRect()
    const x = box.left + box.width / 2
    const y = box.top + box.height / 2
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true }))
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: x + 60, clientY: y + 40, bubbles: true }))

    expect(colours().filter((c, i) => c !== было[i]).length,
      'вращение модели запустило отклик').toBe(0)
  }, 120000)
})


describe('6. нажатие отвечает', () => {
  itWithModels(['TrafficLight.glb'], 'попадание зовёт слушателя и называет часть', async () => {
    await viewer.load('/TrafficLight.glb')
    const пойманное = []
    viewer.onInteractivePick = (p) => пойманное.push(p)

    const часть = viewer._interactive[0]
    const THREE = await import('three')
    const цель = new THREE.Vector3()
    часть.object.getWorldPosition(цель)
    viewer.camera.position.set(цель.x, цель.y, цель.z + 1.5)
    viewer.camera.lookAt(цель)
    viewer.camera.updateMatrixWorld(true)

    viewer.pickInteractive(0.5, 0.5)
    viewer.onInteractivePick = null

    expect(пойманное.length, 'о нажатии никто не узнал').toBe(1)
    expect(пойманное[0].name, 'часть не названа').toBeTruthy()
    expect(пойманное[0].responded, 'отклик был, а сказано обратное').toBe(true)
  }, 120000)

  itWithModels(['TrafficLight.glb'], 'промах мимо модели никого не зовёт', async () => {
    await viewer.load('/TrafficLight.glb')
    const пойманное = []
    viewer.onInteractivePick = (p) => пойманное.push(p)
    viewer.pickInteractive(0.02, 0.02)
    viewer.onInteractivePick = null
    expect(пойманное, 'промах записан как нажатие').toEqual([])
  }, 120000)
})


describe('7. показ согласован с файлом', () => {
  const видно = (o) => {
    for (let p = o; p; p = p.parent) if (!p.visible) return false
    return true
  }

  const предсказания = () => {
    const out = []
    viewer.model.traverse((o) => {
      if (o.name.startsWith('FortuneWords') && !o.parent?.name.startsWith('FortuneWords')) out.push(o)
    })
    return out
  }

  itWithModels(['MagicBall.glb'], 'шар: спрятанное автором спрятано и у нас', async () => {
    await viewer.load('/MagicBall.glb')
    const слова = предсказания()
    expect(слова.length, 'в шаре не нашлось предсказаний').toBeGreaterThan(10)
    expect(слова.filter(видно).map((o) => o.name),
      'предсказания видны все разом — файл говорит обратное').toEqual([])
  }, 120000)

  itWithModels(['MagicBall.glb'], 'шар: нажатие открывает РОВНО ОДНО предсказание', async () => {
    await viewer.load('/MagicBall.glb')
    viewer._behaviour.select(viewer._interactive[0].nodeIndex)
    expect(предсказания().filter(видно).length,
      'после нажатия видно не одно предсказание').toBe(1)
  }, 120000)

  itWithModels(['Calculator.glb'], 'калькулятор: считающая кнопка меняет число на экране', async () => {
    await viewer.load('/Calculator.glb')
    const ключ = (s) => s.replace(/[\s_]+/g, ' ').trim()
    const части = Object.fromEntries(viewer._interactive.map((p) => [ключ(p.name), p]))
    const четыре = части['Button 4']
    const умножить = части['Button multiply']
    expect(четыре && умножить, 'в калькуляторе не нашлись кнопки «4» и «×»').toBeTruthy()

    const карты = []
    viewer.model.traverse((o) => { if (o.isMesh && o.material?.map) карты.push(o.material.map) })
    viewer._behaviour.select(четыре.nodeIndex)
    const было = карты.map((m) => `${m.offset.x},${m.offset.y}`)

    viewer._behaviour.select(умножить.nodeIndex)
    const стало = карты.map((m) => `${m.offset.x},${m.offset.y}`)
    expect(стало.some((v, i) => v !== было[i]),
      'после «×2» на экране осталось прежнее число — считающие кнопки не работают').toBe(true)
  }, 120000)

  itWithModels(['WhackAMole.glb'], 'обводка идёт за деталью, а не стоит где была', async () => {
    await viewer.load('/WhackAMole.glb')
    expect(viewer._interactiveMarks, 'обводки нет — проверять нечего').toBeTruthy()
    const THREE = await import('three')
    const часть = viewer._interactive[0]
    const рамка = viewer._interactiveMarks.children.find((c) => c._part === часть)
    expect(рамка, 'у части нет своей рамки').toBeTruthy()

    const центр = () => {
      const p = рамка.geometry.attributes.position
      const c = new THREE.Vector3()
      for (let i = 0; i < p.count; i++) c.add(new THREE.Vector3().fromBufferAttribute(p, i))
      return c.divideScalar(p.count)
    }
    viewer.renderFrame()
    const было = центр()

    часть.object.position.y += 1
    часть.object.updateMatrixWorld(true)
    viewer.renderFrame()

    expect(центр().distanceTo(было), 'деталь уехала, а рамка осталась на месте')
      .toBeGreaterThan(0.5)
  }, 120000)

  itWithModels(['WhackAMole.glb'], 'спрятанная деталь не обводится', async () => {
    await viewer.load('/WhackAMole.glb')
    const часть = viewer._interactive[0]
    const рамка = viewer._interactiveMarks.children.find((c) => c._part === часть)
    часть.object.visible = false
    viewer.renderFrame()
    expect(рамка.visible, 'рамка обещает нажатие на то, чего не видно').toBe(false)

    часть.object.visible = true
    viewer.renderFrame()
    expect(рамка.visible, 'деталь вернулась, а рамка не вернулась').toBe(true)
  }, 120000)
})


describe('8. пустая нажимаемая часть отличима от рабочей', () => {
  const МОДЕЛЬ = 'Dead Interactivity 01.glb'

  it('обведены все девять — метка у пустых та же, что у рабочей', async () => {
    await viewer.load('/' + encodeURIComponent(МОДЕЛЬ))
    const info = viewer.getInteractivityInfo()
    expect(info.count, 'нажимаемых частей не девять').toBe(9)
    const имена = info.names.map((n) => n.replace(/[\s_]+/g, ' '))
    expect(имена).toContain('Кнопка живая')
    expect(имена.some((n) => n.startsWith('Подставка')), 'обведено то, на что автор запретил нажимать')
      .toBe(false)
  }, 120000)

  it('рабочая откликается, пустые — нет', async () => {
    await viewer.load('/' + encodeURIComponent(МОДЕЛЬ))
    const части = Object.fromEntries(viewer._interactive.map((p) => [p.name.replace(/[\s_]+/g, ' '), p]))
    const живая = части['Кнопка живая']
    expect(живая, 'живой кнопки нет в списке').toBeTruthy()

    expect(viewer._behaviour.select(живая.nodeIndex), 'рабочая кнопка не откликнулась').toBe(true)
    for (let i = 1; i <= 8; i++) {
      const пустая = части[`Кнопка пустая ${i}`]
      expect(пустая, `пустой кнопки ${i} нет в списке`).toBeTruthy()
      expect(viewer._behaviour.select(пустая.nodeIndex), `пустая кнопка ${i} вдруг откликнулась`)
        .toBe(false)
    }
  }, 120000)

  it('недостижимая связка графа не исполняется сама', async () => {
    await viewer.load('/' + encodeURIComponent(МОДЕЛЬ))
    const первая = viewer._interactive[0]
    const было = первая.object.position.clone()
    viewer._behaviour.start()
    viewer._behaviour.select(первая.nodeIndex)
    await new Promise((r) => setTimeout(r, 500))
    expect(первая.object.position.distanceTo(было), 'связка без входящего потока всё-таки сработала')
      .toBe(0)
  }, 120000)
})


describe('9. ревью: нажатие считается от той камеры, которой нарисован кадр', () => {
  itWithModels(['TrafficLight.glb'], 'через камеру автора нажатие попадает по детали', async () => {
    await viewer.load('/TrafficLight.glb')
    const THREE = await import('three')
    const часть = viewer._interactive[0]
    const цель = new THREE.Vector3()
    часть.object.getWorldPosition(цель)

    viewer.camera.position.set(цель.x + 50, цель.y + 50, цель.z + 50)
    viewer.camera.lookAt(цель.x + 100, цель.y, цель.z)
    viewer.camera.updateMatrixWorld(true)

    const своя = new THREE.PerspectiveCamera(50, 1, 0.01, 100)
    своя.position.set(цель.x, цель.y, цель.z + 1.5)
    своя.lookAt(цель)
    своя.updateMatrixWorld(true)
    viewer._fileCameras = [своя]
    viewer._cameraIndex = 0

    expect(viewer.pickInteractive(0.5, 0.5), 'луч построен не от активной камеры').toBe(true)
    viewer._cameraIndex = null
    viewer._fileCameras = []
  }, 120000)
})

describe('9б. ревью: чтение нажимаемости видит собственную запись графа', () => {
  itWithModels(['Calculator.glb'], 'погасили узел — чтение отвечает «нет»', async () => {
    await viewer.load('/Calculator.glb')
    const runtime = viewer._behaviour
    expect(runtime, 'исполнителя нет').toBeTruthy()
    const адрес = '/nodes/5/extensions/KHR_node_selectability/selectable'

    expect(runtime.readPointer(адрес, 'bool'), 'до записи узел обязан считаться нажимаемым')
      .toEqual([1])
    runtime.writePointer(адрес, 'bool', [0])
    expect(runtime.readPointer(адрес, 'bool'), 'чтение не увидело собственной записи')
      .toEqual([0])
    runtime.writePointer(адрес, 'bool', [1])
    expect(runtime.readPointer(адрес, 'bool'), 'узел не вернулся в нажимаемые').toEqual([1])
  }, 120000)
})

describe('9в. ревью: нечитаемая ссылка — отказ, а не первый попавшийся узел', () => {
  it('шаблонный адрес без ссылки не пишет никуда', async () => {
    const { InteractivityGraph } = await import('../ui/viewer/interactivity-graph.js')
    const записи = []
    const хозяин = {
      readPointer: () => null,
      writePointer: (path, type, value) => записи.push({ path, value }),
      startAnimation: () => {},
      stopAnimation: () => {},
      delay: () => {},
      log: () => {},
    }
    const граф = {
      types: [{ signature: 'float3' }, { signature: 'ref' }],
      declarations: [{ op: 'event/onSelect' }, { op: 'pointer/set' }],
      nodes: [
        { declaration: 0, configuration: { nodeIndex: { value: [7] } }, flows: { out: { node: 1, socket: 'in' } } },
        {
          declaration: 1,
          configuration: { pointer: { value: ['/nodes/{nodeRef}/translation'] }, type: { value: [0] } },
          values: { value: { type: 0, value: [0, 5, 0] } },
        },
      ],
    }
    new InteractivityGraph(граф, хозяин).select(7)
    expect(записи, 'граф записал по выдуманному адресу вместо отказа').toEqual([])
  })

  it('ссылка на месте — адрес собирается и запись проходит', async () => {
    const { InteractivityGraph } = await import('../ui/viewer/interactivity-graph.js')
    const записи = []
    const хозяин = {
      readPointer: () => null,
      writePointer: (path, type, value) => записи.push({ path, value }),
      startAnimation: () => {},
      stopAnimation: () => {},
      delay: () => {},
      log: () => {},
    }
    const граф = {
      types: [{ signature: 'float3' }, { signature: 'ref' }],
      declarations: [{ op: 'event/onSelect' }, { op: 'pointer/set' }],
      nodes: [
        { declaration: 0, configuration: { nodeIndex: { value: [7] } }, flows: { out: { node: 1, socket: 'in' } } },
        {
          declaration: 1,
          configuration: { pointer: { value: ['/nodes/{nodeRef}/translation'] }, type: { value: [0] } },
          values: { value: { type: 0, value: [0, 5, 0] }, nodeRef: { type: 1, value: ['/nodes/12'] } },
        },
      ],
    }
    new InteractivityGraph(граф, хозяин).select(7)
    expect(записи.map((z) => z.path)).toEqual(['/nodes/12/translation'])
  })
})



describe('10. четыре отклика на своей модели', () => {
  const тоЖеИмя = (a, b) => String(a).replace(/\s/g, '_') === b.replace(/\s/g, '_')

  const кнопка = (имя) => {
    const part = viewer._interactive.find((p) => тоЖеИмя(p.name, имя))
    expect(part, `нет нажимаемой части «${имя}»; в модели: ${viewer._interactive.map((p) => p.name).join(', ') || '—'}`)
      .toBeTruthy()
    return part
  }
  const узел = (имя) => {
    let out = null
    viewer.model.traverse((o) => { if (тоЖеИмя(o.name, имя)) out = o })
    expect(out, `в сцене нет узла «${имя}»`).toBeTruthy()
    return out
  }

  itWithModels([СВОЯ], 'цвет: нажатие красит материал кнопки', async () => {
    await viewer.load('/' + encodeURIComponent(СВОЯ))
    const было = colours()
    expect(viewer._behaviour.select(кнопка('Кнопка цвета').nodeIndex), 'граф не отозвался').toBe(true)
    expect(colours().filter((c, i) => c !== было[i]).length, 'ни один материал не изменился')
      .toBeGreaterThan(0)
  }, 120000)

  itWithModels([СВОЯ], 'видимость: нажатие прячет ДРУГОЙ узел', async () => {
    await viewer.load('/' + encodeURIComponent(СВОЯ))
    const лампа = узел('Лампа')
    expect(лампа.visible, 'лампа спрятана ещё до нажатия — проверять нечего').toBe(true)
    viewer._behaviour.select(кнопка('Кнопка видимости').nodeIndex)
    expect(лампа.visible, 'лампа не спряталась — запись видимости не дошла').toBe(false)
  }, 120000)

  itWithModels([СВОЯ], 'развёртка: нажатие двигает текстуру, а не меняет материал', async () => {
    await viewer.load('/' + encodeURIComponent(СВОЯ))
    const карты = []
    viewer.model.traverse((o) => { if (o.isMesh && o.material?.map) карты.push(o.material.map) })
    expect(карты.length, 'в модели нет ни одной текстуры').toBeGreaterThan(0)
    const было = карты.map((m) => `${m.offset.x},${m.offset.y}`)
    viewer._behaviour.select(кнопка('Кнопка развёртки').nodeIndex)
    expect(карты.map((m) => `${m.offset.x},${m.offset.y}`).some((v, i) => v !== было[i]), 'развёртка не сдвинулась')
      .toBe(true)
  }, 120000)

  itWithModels([СВОЯ], 'задержка: шаг доходит ПОСЛЕ паузы, а не сразу', async () => {
    await viewer.load('/' + encodeURIComponent(СВОЯ))
    const ползун = узел('Ползун')
    const было = ползун.position.clone()
    viewer._behaviour.select(кнопка('Кнопка задержки').nodeIndex)
    expect(ползун.position.distanceTo(было), 'ползун поехал сразу — паузу не исполнили').toBe(0)
    await new Promise((r) => setTimeout(r, 600))
    expect(ползун.position.distanceTo(было), 'ползун не поехал и после паузы').toBeGreaterThan(0)
  }, 120000)
})
