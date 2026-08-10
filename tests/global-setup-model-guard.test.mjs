// tests/global-setup-model-guard.test.mjs — сторож от повторения истории 2026-08-09
//
// parkergirl-build.setup.mjs бросал Error, когда локальной модели parkergirl.glb
// не было на диске. Это globalSetup: он исполняется ДО сбора тестовых файлов,
// поэтому падал не один тест, а весь browser-проект vitest — «No test files
// found, exiting with code 1». На чистом клоне (в git parkergirl.glb нет — это
// локальная модель, см. REPO_MODELS в tests/helpers/model-files.mjs) это валило
// CI на любом коммите: 13 красных прогонов из 13.
//
// Инвариант, который сторожит этот тест: ни один globalSetup не должен падать
// из-за отсутствия модели, которой нет в REPO_MODELS. Модель из REPO_MODELS
// коммитится в git — её отсутствие на диске это реальная поломка, и guard для
// неё не нужен. Локальная модель на чистом клоне отсутствует законно, поэтому
// любая ссылка на неё в globalSetup обязана идти через graceful-guard:
//
//   if (!fs.existsSync(modelPath('X'))) {
//     ...сообщить о пропуске...
//     return
//   }
//
// — без throw в теле. Если кто-то добавит в подготовку ссылку на локальную
// модель без такого guard (или с throw вместо пропуска) — этот тест покраснеет,
// и история 2026-08-09 не повторится.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { REPO_MODELS } from './helpers/model-files.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

// Список globalSetup берём из vitest.config.mjs, а не дублируем здесь: если
// кто-то добавит новый setup-файл, он автоматически попадёт под сторож.
function globalSetupFiles() {
  const config = fs.readFileSync(path.resolve(PROJECT_ROOT, 'vitest.config.mjs'), 'utf-8')
  return [...config.matchAll(/['"]([^'"]+\.setup\.mjs)['"]/g)].map((m) => m[1])
}

// Все modelPath('...') в файле — это модели, на которые подготовка завязана.
function modelRefs(source) {
  return [...source.matchAll(/modelPath\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Тело if-блока от позиции '{' до парной '}' с учётом строк и комментариев.
function blockBody(source, start) {
  let depth = 1
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return source.slice(start + 1, i)
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      i++
      while (i < source.length && source[i] !== q) {
        if (source[i] === '\\') i++
        i++
      }
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2
      while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++
      i++
    }
  }
  return null
}

// Убрать комментарии и строковые литералы: проверяем КОД, а не слова в
// комментариях и сообщениях (слово «throw» в поясняющем комментарии не делает
// guard бросающим).
function stripCommentsAndStrings(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
      out += ' '
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      out += ' '
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      i++
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++
        i++
      }
      i++
      out += ' '
      continue
    }
    out += c
    i++
  }
  return out
}

// Тело guard-блока для модели: содержимое if (!fs.existsSync(modelPath('X'))) { ... }.
// null — если такого guard в файле нет.
function findGuardBlock(source, model) {
  const re = new RegExp(
    `fs\\.existsSync\\s*\\(\\s*modelPath\\s*\\(\\s*['"]${escapeRegExp(model)}['"]\\s*\\)\\s*\\)`,
  )
  const m = re.exec(source)
  if (!m) return null
  const braceIdx = source.indexOf('{', m.index + m[0].length)
  if (braceIdx < 0) return null
  return blockBody(source, braceIdx)
}

describe('globalSetup не падает из-за локальной модели (сторож 2026-08-09)', () => {
  const files = globalSetupFiles()

  it(`globalSetup-файлы найдены в vitest.config.mjs (${files.length})`, () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('модели вне REPO_MODELS в globalSetup идут только через graceful-guard без throw', () => {
    const violations = []

    for (const rel of files) {
      const filePath = path.resolve(PROJECT_ROOT, rel)
      if (!fs.existsSync(filePath)) {
        violations.push(`${rel}: файл из vitest.config.mjs не существует`)
        continue
      }

      const source = fs.readFileSync(filePath, 'utf-8')
      for (const model of modelRefs(source)) {
        if (REPO_MODELS.has(model)) continue // коммитится — отсутствие это поломка, guard не нужен

        const body = findGuardBlock(source, model)
        if (body === null) {
          violations.push(
            `${rel}: ссылка на локальную модель ${model} без existsSync-guard — на чистом клоне это падение`,
          )
          continue
        }
        const code = stripCommentsAndStrings(body)
        if (/\bthrow\b/.test(code)) {
          violations.push(
            `${rel}: guard для ${model} бросает throw — это падение на чистом клоне, а не пропуск`,
          )
          continue
        }
        if (!/\breturn\b/.test(code)) {
          violations.push(
            `${rel}: guard для ${model} не делает return — подготовка продолжится без модели`,
          )
        }
      }
    }

    expect(violations).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Тот же класс, но в обычных тестах. Добавлено 2026-08-10, после того как история
// повторилась: tests/run-isolation.test.mjs читал BoomBox.glb напрямую через
// path.join(ROOT, 'fixtures', 'models', ...). У автора модель на диске есть, в
// репозитории её нет (эталон Khronos, чужая лицензия) — тест был зелёным локально и
// красным на раннере GitHub. Сторож выше это пропустил: он смотрит только globalSetup.
//
// Что считается ссылкой на модель: имя файла .glb/.gltf литералом внутри modelPath()
// или path.join/resolve, где рядом стоит fixtures-путь. Имена, собранные из переменных,
// сюда не попадают — их и не проверить статически.
//
// Страховкой считается ЛЮБОЕ упоминание проверки присутствия в файле. Проверка грубая:
// она не сверяет, что страховка накрывает именно эту модель. Это осознанный размен —
// точная проверка требует разбора области видимости, а грубая ловит ровно тот случай,
// который уже дважды стоил красного CI: модель читают, не подумав о чистом клоне.
// ---------------------------------------------------------------------------

const GRACEFUL = /isPresent|describeLocal|describeIfModels|itIfModel|eachModel|modelPresent|itWithModels|existsSync|skipIf/

/** Строки кода без строк-комментариев: имя модели в пояснении ссылкой не считается. */
function codeLines(source) {
  return source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
}

/** Имена констант, которые указывают в fixtures. */
function fixtureConsts(source) {
  const out = new Set()
  for (const m of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)/g)) {
    if (/fixtures/.test(m[2])) out.add(m[1])
  }
  return out
}

/** Модели, которые файл читает из fixtures/models. */
function fixtureModelRefs(source) {
  const code = codeLines(source)
  const consts = fixtureConsts(code)
  const names = new Set()
  for (const call of code.matchAll(/(?:modelPath|path\.(?:join|resolve))\s*\(([^)]*)\)/g)) {
    const args = call[1]
    const literal = args.match(/['"`]([^'"`\n]+\.(?:glb|gltf))['"`]/)
    if (!literal) continue
    const intoFixtures = /fixtures/.test(args)
      || /^modelPath/.test(call[0])
      || [...consts].some((c) => new RegExp(`\\b${c}\\b`).test(args))
    if (intoFixtures) names.add(literal[1])
  }
  return names
}

describe('обычные тесты не читают модель, которой нет на чистом клоне', () => {
  const testFiles = fs.readdirSync(path.resolve(PROJECT_ROOT, 'tests'))
    .filter((f) => f.endsWith('.test.mjs'))

  it(`тестовые файлы найдены (${testFiles.length})`, () => {
    expect(testFiles.length).toBeGreaterThan(10)
  })

  it('модель вне REPO_MODELS читается только при наличии проверки присутствия', () => {
    const violations = []

    for (const file of testFiles) {
      const source = fs.readFileSync(path.resolve(PROJECT_ROOT, 'tests', file), 'utf-8')
      const risky = [...fixtureModelRefs(source)].filter((n) => !REPO_MODELS.has(n))
      if (!risky.length) continue
      if (GRACEFUL.test(codeLines(source))) continue
      violations.push(
        `${file}: читает ${risky.join(', ')} из fixtures/models без проверки присутствия. `
          + 'В git этих моделей нет — на чистом клоне и на раннере это ENOENT. '
          + 'Взять модель из REPO_MODELS (tests/helpers/model-files.mjs) '
          + 'или обернуть в describeLocal/itIfModel.',
      )
    }

    expect(violations).toEqual([])
  })
})
