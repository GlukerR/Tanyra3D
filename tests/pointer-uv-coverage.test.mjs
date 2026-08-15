// tests/pointer-uv-coverage.test.mjs — покрытие таблицы развёрток `SLOT_TO_THREE`
// из ui/viewer/pointer-uv.ts на остальном корпусе (задание 2026-08-15).
//
// Зачем. Таблица переводит имена слотов glTF в имена свойств three.js. Проверено
// было только, что драйвер ВООБЩЕ двигает текстуры (PotOfCoals, AnimationPointerUVs).
// Не проверялось, что таблица покрывает все слоты, которые реально встречаются в
// корпусе, и что слот, которого в таблице нет, застывает молча, а не роняет показ.
//
// Слои (ПРАВИЛА_ТЕСТОВ_универсальность.md). Инвентаризация корпуса — это данные
// ФАЙЛА (слой 2): имена слотов в animation-pointer-каналах не зависят от движка.
// Сверка таблицы с three.js — слой 3 (рендер): сама таблица по своей природе
// привязана к three.js, потому что переводит в ИМЕНА ЕГО свойств. Поэтому тест
// честно написан под three.js и не претендует на переносимость на Babylon — там
// понадобится своя таблица и свой сторож.
//
// Что сторожится (три независимые вещи):
//   1. Таблица против three.js: каждый ключ — имя слота (оканчивается на Texture),
//      а каждое значение — свойство, которое реально существует на материале
//      three.js (MeshPhysicalMaterial покрывает и core-слоты MeshStandardMaterial).
//      Ловит опечатку в имени свойства и тихий дрейф таблицы при смене версии.
//   2. Покрытие корпуса: каждый слот, встреченный в pointer-каналах корпуса, либо
//      есть в таблице, либо в явном allowlist «three.js такой слот не умеет».
//      Слот, который three.js умеет, а таблица не переводит, — это баг: текстура
//      застынет молча, тест краснеет и называет слот и модель.
//   3. Нижняя граница размера: записей не меньше 17 — случайное усечение таблицы
//      не пройдёт незаметно.
//
// Таблица не экспортируется, поэтому читается из ПЕРВОИСТОЧНИКА `pointer-uv.ts` как
// текст (тот же приём, что у tests/i18n-discipline и tests/architecture/*: истина —
// в первоначальном файле, EXTENDING §5c). Скомпилированный `pointer-uv.js` в git не
// идёт — на чистом клоне до сборки его может не быть.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const POINTER_UV_SOURCE = path.join(PROJECT_ROOT, 'ui', 'viewer', 'pointer-uv.ts')
const FIXTURES_DIR = path.join(PROJECT_ROOT, 'fixtures', 'models')

// ── Извлечение таблицы из первоисточника ────────────────────────────────────

/**
 * Достаёт `SLOT_TO_THREE` из исходника как текст. Литерал простой: каждая запись —
 * отдельная строка `key: ['a', 'b']`. Если форма когда-нибудь сменится (значения
 * разъедутся по строкам, появятся вложенные скобки) — этот тест обязан упасть с
 * «не нашёл закрывающую скобку», а не тихо вернуть половину таблицы.
 */
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

// ── Инвентаризация корпуса ───────────────────────────────────────────────────
//
// Тот же разбор указателя, что в pointer-uv.ts (`POINTER_RE` + «последний сегмент,
// оканчивающийся на Texture»). Дублирование здесь намеренно и неизбежно: драйвер
// ничего не экспортирует, а расхождение с его логикой сделает этот тест лживым.
// Правка одного обязана сверяться с другим — поэтому ниже ссылка на строки.

// Копия POINTER_RE из ui/viewer/pointer-uv.ts (строка `const POINTER_RE =`).
const POINTER_RE = /^\/materials\/(\d+)\/(.+)\/extensions\/KHR_texture_transform\/(offset|rotation|scale)$/

/**
 * Обходит fixtures/models/*.glb, возвращает [{ model, slots: [...] }] — модели,
 * у которых есть animation-pointer-каналы на развёртку текстур, и набор имён
 * слотов в каждой. Битый/неразбираемый GLB пропускается: предмет инвентаризации —
 * каналы, а не валидность файла.
 */
function scanCorpus() {
  const found = []
  for (const file of fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.glb'))) {
    const slots = new Set()
    try {
      const buf = fs.readFileSync(path.join(FIXTURES_DIR, file))
      if (buf.length < 20) continue
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      if (view.getUint32(0, true) !== 0x46546c67) continue // магия 'glTF'
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
    } catch { /* неразбираемый файл — вклад в инвентаризацию ноль */ }
    if (slots.size) found.push({ model: file, slots: [...slots].sort() })
  }
  return found
}

// ── Allowlist: слоты, которых three.js НЕ умеет ──────────────────────────────
//
// Сюда можно только слот, у которого у установленного three.js (0.185.1) нет
// свойства на материале — иначе это не «не умеет», а «таблица не переводит», то
// есть баг. Каждая запись — РЕШЕНИЕ с причиной, а не способ позеленить тест:
// пополнить allowlist слотом, который three.js умеет, — подгонка под вывод движка,
// запрещённая ПРАВИЛАМИ_ТЕСТОВ_универсальность.
const UNSUPPORTED_BY_THREE = {
  // KHR_materials_diffuse_transmission: у three.js r185.1 нет ни свойства
  // `diffuseTransmissionMap`, ни ветки загрузчика (grep по src/ и examples/jsm/ —
  // ноль вхождений). Оба слота расширения застывают молча, и это правильно.
  diffuseTransmissionTexture: 'three.js r185.1 не загружает KHR_materials_diffuse_transmission (нет diffuseTransmissionMap)',
  diffuseTransmissionColorTexture: 'three.js r185.1 не загружает KHR_materials_diffuse_transmission (нет diffuseTransmissionColorMap)',
}

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 1 · ТАБЛИЦА ПРОТИВ THREE.JS — работает без моделей
// ═══════════════════════════════════════════════════════════════════════════

describe('SLOT_TO_THREE — таблица против three.js', () => {
  const src = fs.readFileSync(POINTER_UV_SOURCE, 'utf8')
  const table = extractSlotToThree(src)

  it('таблица непустая и записей не меньше 17', () => {
    expect(Object.keys(table).length).toBeGreaterThanOrEqual(17)
  })

  it('каждый ключ — имя слота glTF (оканчивается на Texture)', () => {
    const bad = Object.keys(table).filter((k) => !k.endsWith('Texture'))
    expect(bad, 'ключи не в форме <слот>Texture: ' + bad.join(', ')).toEqual([])
  })

  it('каждое свойство three.js из значений существует на материале', () => {
    // MeshPhysicalMaterial наследует MeshStandardMaterial, поэтому на одном его
    // экземпляре есть и core-слоты (map, normalMap, …), и слоты расширений
    // (anisotropyMap, transmissionMap, …). Свойства в three.js задаются в
    // конструкторе (`this.map = null`), поэтому проверяем `in` на экземпляре.
    const mat = new THREE.MeshPhysicalMaterial()
    const missing = []
    for (const [slot, props] of Object.entries(table)) {
      for (const prop of props) {
        if (!(prop in mat)) missing.push(`${slot} → ${prop}`)
      }
    }
    expect(missing, 'свойства, которых нет у three.js (опечатка или дрейф версии):\n  ' + missing.join('\n  ')).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 2 · ПОКРЫТИЕ КОРПУСА — нужны локальные модели
// ═══════════════════════════════════════════════════════════════════════════
//
// Образцы Khronos с развёрткой (AnimationPointerUVs, PotOfCoalsAnimationPointer)
// в git не едут — на чистом клоне инвентаризация пуста и блок честно пропускается
// с причиной. Когда модели есть, тест держит реальное покрытие.

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

  // Инвентаризация как наблюдение: печатается при прогоне, чтобы видеть состав
  // корпуса, даже когда утверждение зелёное (отчёт задания перечисляет то же).
  it('инвентаризация: какие модели и слоты реально анимируют развёртку', () => {
    if (!hasData) return
    for (const entry of inventory) {
      console.log(`  ${entry.model} → ${entry.slots.join(', ')}`)
    }
    // Утверждение о самом сканере, а не о корпусе: имя слота обязано быть именем слота.
    // Разъедется POINTER_RE или разбор последнего сегмента — инвентаризация начнёт
    // приносить мусор, и покрытие выше станет проверять не то. Заглушки `expect(true)`
    // здесь не годится: тест, который не может упасть, только раздувает набор.
    const notSlots = distinctSlots.filter((s) => !s.endsWith('Texture'))
    expect(notSlots, 'сканер принёс не слоты: ' + notSlots.join(', ')).toEqual([])
  })
})
