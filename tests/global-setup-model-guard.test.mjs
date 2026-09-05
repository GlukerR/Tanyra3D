import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { REPO_MODELS } from './helpers/model-files.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

function globalSetupFiles() {
  const config = fs.readFileSync(path.resolve(PROJECT_ROOT, 'vitest.config.mjs'), 'utf-8')
  return [...config.matchAll(/['"]([^'"]+\.setup\.mjs)['"]/g)].map((m) => m[1])
}

function modelRefs(source) {
  return [...source.matchAll(/modelPath\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

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
        if (REPO_MODELS.has(model)) continue

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


const GRACEFUL = /isPresent|describeLocal|describeIfModels|itIfModel|eachModel|modelPresent|itWithModels|existsSync|skipIf/

function codeLines(source) {
  return source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
}

function fixtureConsts(source) {
  const out = new Set()
  for (const m of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)/g)) {
    if (/fixtures/.test(m[2])) out.add(m[1])
  }
  return out
}

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
