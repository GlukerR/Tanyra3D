import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const POINTER_UV_SOURCE = path.join(PROJECT_ROOT, 'ui', 'viewer', 'pointer-uv.ts')
const DT_SOURCE = path.join(PROJECT_ROOT, 'ui', 'viewer', 'diffuse-transmission.ts')
const FIXTURES_DIR = path.join(PROJECT_ROOT, 'fixtures', 'models')


function extractSlotToThree(src) {
  const start = src.indexOf('SLOT_TO_THREE')
  if (start === -1) throw new Error('SLOT_TO_THREE не найден в ' + POINTER_UV_SOURCE)
  const open = src.indexOf('{', start)
  if (open === -1) throw new Error('нет открывающей скобки после SLOT_TO_THREE')
  const close = src.indexOf('\n};', open)
  if (close === -1) throw new Error('не нашёл закрывающую скобку таблицы (форма литерала изменилась?)')
  const body = src.slice(open + 1, close)
  const table = {}
  const re = /(\w+)\s*:\s*\[([^\]]*)\]/g
  let m
  while ((m = re.exec(body)) !== null) {
    const values = m[2]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && (s[0] === "'" || s[0] === '"'))
      .map((s) => s.slice(1, -1))
    table[m[1]] = values
  }
  return table
}


const POINTER_RE = /^\/materials\/(\d+)\/(.+)\/extensions\/KHR_texture_transform\/(offset|rotation|scale)$/

function scanCorpus() {
  const found = []
  for (const file of fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.glb'))) {
    const slots = new Set()
    try {
      const buf = fs.readFileSync(path.join(FIXTURES_DIR, file))
      if (buf.length < 20) continue
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      if (view.getUint32(0, true) !== 0x46546c67) continue
      const jsonLen = view.getUint32(12, true)
      if (jsonLen + 20 > buf.length) continue
      const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)))
      for (const anim of json.animations || []) {
        for (const ch of anim.channels || []) {
          const target = ch.target
          if (!target || target.path !== 'pointer') continue
          const pointer = target.extensions?.['KHR_animation_pointer']?.pointer
          if (!pointer) continue
          const m = POINTER_RE.exec(pointer)
          if (!m) continue
          const slot = (m[2] || '').split('/').filter((s) => s.endsWith('Texture')).pop()
          if (slot) slots.add(slot)
        }
      }
    } catch {  }
    if (slots.size) found.push({ model: file, slots: [...slots].sort() })
  }
  return found
}

const UNSUPPORTED_BY_THREE = {
}


describe('SLOT_TO_THREE — таблица против three.js', () => {
  const src = fs.readFileSync(POINTER_UV_SOURCE, 'utf8')
  const table = extractSlotToThree(src)

  it('таблица непустая и записей не меньше 19', () => {
    expect(Object.keys(table).length).toBeGreaterThanOrEqual(19)
  })

  it('каждый ключ — имя слота glTF (оканчивается на Texture)', () => {
    const bad = Object.keys(table).filter((k) => !k.endsWith('Texture'))
    expect(bad, 'ключи не в форме <слот>Texture: ' + bad.join(', ')).toEqual([])
  })

  it('каждое свойство из значений существует на материале просмотрщика', () => {
    const mat = new THREE.MeshPhysicalMaterial()
    const наши = new Set(
      [...fs.readFileSync(DT_SOURCE, 'utf8').matchAll(/^\s*(?:get|set)\s+(\w+)\s*\(/gm)].map((m) => m[1]),
    )
    expect(наши.size, 'в diffuse-transmission.ts не нашлось ни одного свойства — форма файла сменилась')
      .toBeGreaterThan(0)

    const missing = []
    for (const [slot, props] of Object.entries(table)) {
      for (const prop of props) {
        if (!(prop in mat) && !наши.has(prop)) missing.push(`${slot} → ${prop}`)
      }
    }
    expect(missing, 'свойства, которых нет ни у three.js, ни у наших материалов (опечатка или дрейф версии):\n  ' + missing.join('\n  ')).toEqual([])
  })
})


const inventory = scanCorpus()
const distinctSlots = [...new Set(inventory.flatMap((x) => x.slots))].sort()
const tableForCoverage = extractSlotToThree(fs.readFileSync(POINTER_UV_SOURCE, 'utf8'))

describe('SLOT_TO_THREE — покрытие корпуса', () => {
  const hasData = inventory.length > 0
  const skipNote = hasData ? '' : ' [пропущено: нет локально моделей с развёрткой текстур — AnimationPointerUVs.glb, PotOfCoalsAnimationPointer.glb]'
  const body = hasData
    ? () => {
        const uncovered = distinctSlots.filter((s) => !(s in tableForCoverage) && !(s in UNSUPPORTED_BY_THREE))
        expect(uncovered, 'слоты корпуса вне таблицы и вне allowlist — развёртка застынет молча:\n  ' + uncovered.join('\n  ')).toEqual([])
      }
    : () => {}

  if (hasData) {
    it('каждый слот корпуса покрыт таблицей или оправданно пропущен', body)
  } else {
    it.skip('каждый слот корпуса покрыт таблицей или оправданно пропущен' + skipNote, body)
  }

  it('инвентаризация: какие модели и слоты реально анимируют развёртку', () => {
    if (!hasData) return
    for (const entry of inventory) {
      console.log(`  ${entry.model} → ${entry.slots.join(', ')}`)
    }
    const notSlots = distinctSlots.filter((s) => !s.endsWith('Texture'))
    expect(notSlots, 'сканер принёс не слоты: ' + notSlots.join(', ')).toEqual([])
  })
})
