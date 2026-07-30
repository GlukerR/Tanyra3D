#!/usr/bin/env node
// tests/analyse-test-coverage.mjs — AST-анализ golden-corpus.test.mjs
//
// Собирает метрики без запуска vitest:
//   — число describe-блоков (describe / describeLocal / describe.skip)
//   — число it-тестов (it / it.skip), разделение на active / skipped
//   — какие модели упомянуты в modelPath()
//   — какие комбинации advancedFeatures проверяются
//   — модель → сколько тестов её проверяют
//
// Парсинг через @babel/parser — единственный внешний парсер, который уже
// есть в дереве зависимостей (@babel/core / @babel/parser — транзитив через
// vitest). Если парсер недоступен — fallback на grep-подобную эвристику.
//
// Запуск:
//   node tests/analyse-test-coverage.mjs
//   node tests/analyse-test-coverage.mjs --json   # JSON-вывод

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TARGET = path.resolve(PROJECT_ROOT, 'tests/golden-corpus.test.mjs');

// –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
//  0. CONST-массивы — ДО babel-парсинга (должны быть инициализированы
//     раньше collectConstArrays(code) на уровне модуля, иначе TDZ).
// –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––

// Разрешает GOLDEN_MODELS.filter(...) / [...APPLY_ON_PASSTHROUGH] / DIRTY_SAFE_MODELS —
// ищет const-определение массива со строками в том же файле.
const CONST_ARRAYS = {};

// Предварительный проход: собрать все const-массивы строк из кода.
// Также обрабатывает new Set([...]) — распространённый паттерн в тестовых файлах.
function collectConstArrays(code) {
  // const NAME = [...] — прямое определение
  let re = /const\s+(\w+)\s*=\s*\[([^\]]+)\]/gs;
  let m;
  while ((m = re.exec(code)) !== null) {
    const items = [...m[2].matchAll(/['"`]([^'"`]+\.glb)['"`]/g)].map((x) => x[1]);
    if (items.length) CONST_ARRAYS[m[1]] = items;
  }
  // const NAME = new Set([...]) — Set-обёртка
  re = /const\s+(\w+)\s*=\s*new\s+Set\s*\(\s*\[([^\]]+)\]\s*\)/gs;
  while ((m = re.exec(code)) !== null) {
    const items = [...m[2].matchAll(/['"`]([^'"`]+\.glb)['"`]/g)].map((x) => x[1]);
    if (items.length) CONST_ARRAYS[m[1]] = items;
  }
}

// Пытается разрешить AST-узел, который может быть GOLDEN_MODELS.filter(...) или
// [...APPLY_ON_PASSTHROUGH] или просто именем массива.
function resolveModelFilter(node) {
  if (!node) return [];

  // [...APPLY_ON_PASSTHROUGH] — spread expression
  if (node.type === 'ArrayExpression') {
    const items = [];
    for (const el of node.elements) {
      if (el?.type === 'SpreadElement' && el.argument?.type === 'Identifier') {
        const resolved = CONST_ARRAYS[el.argument.name];
        if (resolved) items.push(...resolved);
      }
    }
    return items;
  }

  // GOLDEN_MODELS.filter(...) — CallExpression
  if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
    const objName = node.callee.object?.type === 'Identifier' ? node.callee.object.name : null;
    if (objName && CONST_ARRAYS[objName]) {
      // .filter(callback) — возвращаем исходный массив как есть; фильтр не влияет на состав
      return CONST_ARRAYS[objName];
    }
  }

  // Прямое имя массива (DIRTY_SAFE_MODELS)
  if (node.type === 'Identifier' && CONST_ARRAYS[node.name]) {
    return CONST_ARRAYS[node.name];
  }

  return [];
}

// –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
//  1. Попытка babel-парсинга
// –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––

let ast = null;
let parserUsed = 'babel';

const code = fs.readFileSync(TARGET, 'utf-8');

// Предварительный проход: собрать const-массивы (.glb внутри) для разрешения
// GOLDEN_MODELS.filter(...) в eachModel-вызовах.
collectConstArrays(code);

try {
  const babelParser = await import('@babel/parser');
  ast = babelParser.parse(code, {
    sourceType: 'module',
    plugins: ['importAssertions'],
    errorRecovery: true,
  });
} catch (err) {
  // fallback — регулярки
  parserUsed = `fallback (${err.message})`;
}

// –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
//  2. Обход AST / fallback
// –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––

function walkAST(astRoot) {
  const describes = [];
  const its = [];
  const modelPaths = [];
  const flagCombos = [];

  let currentDescribe = null;

  function pushDescribe(name, type) {
    const node = { name, type, children: [] };
    describes.push(node);
    currentDescribe = node;
  }

  function popDescribe() {
    describes.pop();
    currentDescribe = describes.length > 0 ? describes[describes.length - 1] : null;
  }

  function traverse(node, depth = 0) {
    if (!node || typeof node !== 'object') return;

    // Ищем выражения-вызовы describe / describeLocal / it
    if (node.type === 'ExpressionStatement' && node.expression?.type === 'CallExpression') {
      const callee = node.expression.callee;
      const calleeName = extractCalleeName(callee);

      if (calleeName === 'describe' || calleeName === 'describeLocal' || calleeName === 'describe.skip') {
        const name = extractStringArg(node.expression);
        if (calleeName === 'describe') {
          pushDescribe(name, 'describe');
        } else if (calleeName === 'describeLocal') {
          pushDescribe(name, 'describeLocal');
        } else {
          pushDescribe(name, 'describe.skip');
        }
        const callback = node.expression.arguments[node.expression.arguments.length - 1];
        if (callback?.type === 'ArrowFunctionExpression' || callback?.type === 'FunctionExpression') {
          for (const stmt of (callback.body?.body || [])) {
            traverse(stmt, depth + 1);
          }
        }
        popDescribe();
        return;
      }

      if (calleeName === 'it' || calleeName === 'it.skip') {
        const itName = extractStringArg(node.expression);
        const isSkipped = calleeName === 'it.skip';
        const dc = currentDescribe?.name || '(top-level)';
        its.push({ name: itName, skipped: isSkipped, describe: dc });

        const callback = node.expression.arguments[node.expression.arguments.length - 1];
        const modelsInIt = findModelPathCalls(callback);
        for (const m of modelsInIt) {
          modelPaths.push({ modelName: m, describe: dc, itName });
        }

        const flags = findAdvancedFeatures(node.expression);
        if (flags.length) {
          flagCombos.push({ flags, describe: dc, itName });
        }
        return;
      }

      // eachModel — параметризованный вызов с моделью
      if (calleeName === 'eachModel') {
        const itDesc = extractStringArg(node.expression);
        const dc = currentDescribe?.name || '(top-level)';

        let modelList = extractArrayArg(node.expression, 1);
        if (!modelList.length) {
          modelList = resolveModelFilter(node.expression.arguments?.[1]);
        }

        for (const m of modelList) {
          const itName = `${m} — ${itDesc}`;
          its.push({ name: itName, skipped: false, describe: dc });
          modelPaths.push({ modelName: m, describe: dc, itName });
        }

        const callback = node.expression.arguments[2];
        const flags = findAdvancedFeatures(callback);
        if (flags.length) {
          for (const m of modelList) {
            flagCombos.push({ flags, describe: dc, itName: `${m} — ${itDesc}` });
          }
        }
        return;
      }
    }

    for (const key of Object.keys(node)) {
      if (key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      traverse(node[key], depth);
    }
  }

  traverse(astRoot);
  return { describes, its, modelPaths, flagCombos };
}

function extractCalleeName(callee) {
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression') {
    const obj = extractCalleeName(callee.object);
    const prop = callee.property?.type === 'Identifier' ? callee.property.name : '';
    return `${obj}.${prop}`;
  }
  return null;
}

function extractStringArg(expr) {
  const first = expr.arguments?.[0];
  if (!first) return '';
  if (first.type === 'StringLiteral' || first.type === 'Literal') return String(first.value);
  if (first.type === 'TemplateLiteral') {
    return first.quasis.map((q) => q.value.cooked || q.value.raw).join('${...}');
  }
  return `(${first.type})`;
}

function extractArrayArg(expr, index) {
  const arg = expr.arguments?.[index];
  if (!arg || arg.type !== 'ArrayExpression') return [];
  return arg.elements
    .filter((e) => e && (e.type === 'StringLiteral' || e.type === 'Literal'))
    .map((e) => String(e.value));
}

function findModelPathCalls(node) {
  const results = [];
  if (!node || typeof node !== 'object') return results;

  if (node.type === 'CallExpression') {
    const callee = node.callee;
    if (callee?.type === 'Identifier' && callee.name === 'modelPath') {
      const arg = node.arguments?.[0];
      if (arg && (arg.type === 'StringLiteral' || arg.type === 'Literal')) {
        results.push(String(arg.value));
      }
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    results.push(...findModelPathCalls(node[key]));
  }

  return results;
}

function findAdvancedFeatures(node) {
  const results = [];
  if (!node || typeof node !== 'object') return results;

  if (node.type === 'ObjectExpression') {
    for (const prop of node.properties) {
      if (prop.type !== 'ObjectProperty') continue;
      const key = prop.key;
      const keyName = key.type === 'Identifier' ? key.name : key.type === 'StringLiteral' ? key.value : null;
      if (keyName === 'advancedFeatures' && prop.value?.type === 'ArrayExpression') {
        const flags = prop.value.elements
          .filter((e) => e && (e.type === 'StringLiteral' || e.type === 'Literal'))
          .map((e) => String(e.value));
        if (flags.length) results.push(flags);
      }
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    results.push(...findAdvancedFeatures(node[key]));
  }

  return results;
}

// –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
//  3. Fallback-парсер (блочный — brace matching вместо line-by-line)
//
//  В отличие от старой «построчной» версии, этот парсер:
//   1. Находит it()/eachModel() блоки и извлекает callback-тело через
//      findMatchingBrace (счётчик скобок с учётом строк и комментариев).
//   2. Из тела извлекает modelPath('...') и advancedFeatures: [...] —
//      оба работают поперёк строк.
//   3. Для eachModel — разбирает аргумент-массив моделей через
//      resolveModelListFromText (фильтры, spread, inline).
//   4. Для for (const flags of [...]) — ищет охватывающий цикл и
//      извлекает массивы флагов, когда в теле стоит переменная flags.
// –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––

// Найти парную скобку: от start (где уже стоит '{') ищем '}' с учётом
// строковых литералов и однострочных комментариев.
function findMatchingBrace(code, start, open = '{', close = '}') {
  let depth = 1;
  for (let i = start + 1; i < code.length; i++) {
    const c = code[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
    // Строки — пропускаем содержимое
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < code.length && code[i] !== q) {
        if (code[i] === '\\') i++;
        i++;
      }
    }
    // Однострочный комментарий — до конца строки
    if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
    }
    // Блочный комментарий /* ... */ — пропускаем до закрытия
    if (c === '/' && code[i + 1] === '*') {
      i += 2; // за '/*'
      while (i < code.length - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i++; // за '/'
    }
  }
  return -1;
}

// Извлечь все комбинации advancedFeatures из тела блока.
// Обрабатывает два случая:
//   (а) литерал  advancedFeatures: ['safe', 'instance']
//   (б) переменная advancedFeatures: flags  →  ищем охватывающий
//       for (const flags of [['safe'], ...]) в codeBeforeBlock.
function extractFlagsFromBody(body, codeBeforeBlock) {
  const results = [];

  // (а) Литерал: advancedFeatures: [...]  — через /s работает поперёк строк
  const re = /advancedFeatures\s*:\s*\[([^\]]*)\]/gs;
  let m;
  while ((m = re.exec(body)) !== null) {
    const flags = m[1].split(',').map((s) => s.trim().replace(/['"`]/g, '')).filter(Boolean);
    if (flags.length) results.push(flags);
  }

  // (б) Переменная: advancedFeatures: flags — ищем for (const flags of [...])
  if (/advancedFeatures\s*:\s*flags\b/.test(body)) {
    // Ищем ПОСЛЕДНИЙ подходящий for-цикл перед этим блоком
    const forRe = /for\s*\(\s*(?:const|let|var)\s+flags\s+of\s*(\[[\s\S]*?\n\s*\])\s*\)/g;
    let lastFor;
    let fm;
    while ((fm = forRe.exec(codeBeforeBlock)) !== null) lastFor = fm;
    if (lastFor) {
      const arrText = lastFor[1];
      // Внутри внешнего массива — вложенные массивы флагов: ['safe'], ['safe','instance'], …
      const innerArrs = [...arrText.matchAll(/\[([^\]]*)\]/g)];
      for (const ia of innerArrs) {
        const flags = ia[1].split(',').map((s) => s.trim().replace(/['"`]/g, '')).filter(Boolean);
        if (flags.length) results.push(flags);
      }
    }
  }

  return results;
}

// Распарсить список моделей из текста первого аргумента eachModel.
// Поддерживает:
//   inline:    ['Model1.glb', 'Model2.glb']
//   spread:    [...APPLY_ON_PASSTHROUGH]
//   filter:    GOLDEN_MODELS.filter(isSafeEligible)
//   bare name: DIRTY_SAFE_MODELS
function resolveModelListFromText(text) {
  // inline массив: ['Model1.glb', 'Model2.glb']
  const inlineRe = /^\s*\[([^\]]*)\]/;
  const im = text.match(inlineRe);
  if (im) {
    // Может быть [...SPREAD] — проверяем
    const spreadInner = im[1].trim();
    if (spreadInner.startsWith('...')) {
      const name = spreadInner.slice(3).trim();
      if (CONST_ARRAYS[name]) return CONST_ARRAYS[name];
    }
    return [...im[1].matchAll(/['"`]([^'"`]+\.glb)['"`]/g)].map((x) => x[1]);
  }

  // Имя + опциональный .filter(...): GOLDEN_MODELS.filter(isSafeEligible)
  const nameRe = /^\s*(\w+)(?:\.filter\([^)]*\))?/;
  const nm = text.match(nameRe);
  if (nm && CONST_ARRAYS[nm[1]]) {
    return CONST_ARRAYS[nm[1]];
  }

  return [];
}

// Основной fallback-парсер — блочный, с brace-matching.
function fallbackParse(code) {
  const describes = [];
  const its = [];
  const modelPaths = [];
  const flagCombos = [];

  // Шаг 1: найти все describe / it / eachModel на верхнем уровне
  const blocks = [];
  const re = /(?:^|\n)(\s*)(describe|describeLocal|describe\.skip|it|it\.skip|eachModel)\s*\(\s*['"`]([^'"`]*)['"`]/g;
  let bm;
  while ((bm = re.exec(code)) !== null) {
    blocks.push({
      index: bm.index,
      endOfName: bm.index + bm[0].length,
      indent: bm[1].length,
      keyword: bm[2],
      name: bm[3],
    });
  }

  // Стек describe-блоков
  const describeStack = [];

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];

    // --- describe / describeLocal / describe.skip ---------------------
    if (block.keyword.startsWith('describe')) {
      describeStack.push(block);
      describes.push({ name: block.name, type: block.keyword });
      continue;
    }

    const dc = describeStack.length > 0
      ? describeStack[describeStack.length - 1].name
      : '(top-level)';

    // --- it / it.skip / eachModel ------------------------------------

    // Найти тело стрелочной функции: «=>» → «{» → парный «}»
    const afterName = code.slice(block.endOfName);
    const arrowIdx = afterName.indexOf('=>');
    if (arrowIdx < 0) continue;
    const afterArrow = code.slice(block.endOfName + arrowIdx + 2);
    const braceIdx = afterArrow.indexOf('{');
    if (braceIdx < 0) continue;

    const bodyStart = block.endOfName + arrowIdx + 2 + braceIdx;
    const bodyEnd = findMatchingBrace(code, bodyStart);
    if (bodyEnd < 0) continue;

    const body = code.slice(bodyStart + 1, bodyEnd);
    const codeBeforeBlock = code.slice(0, block.index);

    if (block.keyword === 'it' || block.keyword === 'it.skip') {
      // --- it-блок -----------------------------------------------------
      const isSkipped = block.keyword === 'it.skip';
      its.push({ name: block.name, skipped: isSkipped, describe: dc });

      // modelPath('...') и runAndRead('...')
      for (const re of [
        /modelPath\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
        /runAndRead\s*\(\s*['"`]([^'"`]+\.glb)['"`]\s*,/g,
      ]) {
        let mpm;
        while ((mpm = re.exec(body)) !== null) {
          modelPaths.push({ modelName: mpm[1], describe: dc, itName: block.name });
        }
      }

      // advancedFeatures
      const flags = extractFlagsFromBody(body, codeBeforeBlock);
      for (const f of flags) {
        flagCombos.push({ flags: f, describe: dc, itName: block.name });
      }
    } else if (block.keyword === 'eachModel') {
      // --- eachModel-блок ----------------------------------------------
      its.push({ name: `eachModel(${block.name})`, skipped: false, describe: dc });

      // Разобрать список моделей из аргумента после имени
      const afterNameText = code.slice(block.endOfName);
      const argStart = afterNameText.indexOf(',');
      if (argStart >= 0) {
        const modelArgText = afterNameText.slice(argStart + 1).trim().slice(0, 600);
        const modelList = resolveModelListFromText(modelArgText);

        for (const model of modelList) {
          const itName = `${model} — ${block.name}`;
          its.push({ name: itName, skipped: false, describe: dc });
          modelPaths.push({ modelName: model, describe: dc, itName });
        }

        // advancedFeatures из callback-тела
        const flags = extractFlagsFromBody(body, codeBeforeBlock);
        for (const f of flags) {
          for (const model of modelList) {
            flagCombos.push({
              flags: f,
              describe: dc,
              itName: `${model} — ${block.name}`,
            });
          }
        }
      }
    }

    // --- Pop describe stack: следующий блок на том же / меньшем отступе?
    const nextBlock = blocks[bi + 1];
    while (describeStack.length > 0) {
      const top = describeStack[describeStack.length - 1];
      if (nextBlock && nextBlock.indent > top.indent) break;
      describeStack.pop();
    }
  }

  return { describes, its, modelPaths, flagCombos };
}

// –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
//  4. Статистика
// –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––

let data;

if (ast) {
  data = walkAST(ast);
} else {
  parserUsed = 'fallback (regex)';
  data = fallbackParse(code);
}

// Если AST не смог разобрать eachModel-массивы — дорезаем через CONST_ARRAYS
if (!data.modelPaths.length) {
  const constModels = new Set(Object.values(CONST_ARRAYS).flat());
  for (const model of constModels) {
    if (!data.modelPaths.some((mp) => mp.modelName === model)) {
      data.modelPaths.push({ modelName: model, describe: '(const array)', itName: '(parameterized)' });
    }
  }
}

const uniqueModels = [...new Set(data.modelPaths.map((m) => m.modelName))].sort();

const goldenModelsMatch = code.match(/const\s+GOLDEN_MODELS\s*=\s*\[([^\]]+)\]/s);
const goldenModels = goldenModelsMatch
  ? [...goldenModelsMatch[1].matchAll(/['"`]([^'"`]+\.glb)['"`]/g)].map((m) => m[1])
  : [];

const describedModels = data.describes
  .filter((d) => /\.glb/.test(d.name))
  .map((d) => d.name.match(/(['"`]?)([^'"`]+\.glb)\1/)?.[2] || d.name);

function modelCoverage() {
  const map = {};
  for (const mp of data.modelPaths) {
    if (!map[mp.modelName]) map[mp.modelName] = { count: 0, flags: new Set(), its: [] };
    map[mp.modelName].count++;
    if (!map[mp.modelName].its.includes(mp.itName)) map[mp.modelName].its.push(mp.itName);
  }
  for (const fc of data.flagCombos) {
    for (const mp of data.modelPaths) {
      if (mp.itName === fc.itName && map[mp.modelName]) {
        map[mp.modelName].flags.add(JSON.stringify(fc.flags));
      }
    }
  }
  return map;
}

const coverage = modelCoverage();

// –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
//  5. Вывод
// –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––

const isJson = process.argv.includes('--json');

if (isJson) {
  const output = {
    parser: parserUsed,
    file: 'tests/golden-corpus.test.mjs',
    describeBlocks: data.describes.map((d) => ({ name: d.name, type: d.type })),
    totalDescribes: data.describes.length,
    totalIts: data.its.length,
    activeIts: data.its.filter((t) => !t.skipped).length,
    skippedIts: data.its.filter((t) => t.skipped).length,
    uniqueModels: uniqueModels.length,
    goldenModels: goldenModels.length,
    modelsWithOwnDescribe: describedModels.filter((d) => !goldenModels.includes(d)).length,
    modelCoverage: Object.fromEntries(
      Object.entries(coverage).map(([model, info]) => [
        model,
        { tests: info.count, flags: [...info.flags].map((f) => JSON.parse(f)) },
      ]),
    ),
    flagCombinations: data.flagCombos.map((fc) => ({
      describe: fc.describe,
      itName: fc.itName,
      flags: fc.flags,
    })),
  };
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

console.log(`\n📊  Analyse — ${path.relative(PROJECT_ROOT, TARGET)}\n`);
console.log(`Парсер: ${parserUsed}\n`);

console.log('── DESCRIBE БЛОКИ ──');
for (const d of data.describes) {
  const icon = d.type === 'describe.skip' ? '⏭' : d.type === 'describeLocal' ? '📍' : '📁';
  console.log(`  ${icon}  ${d.name}`);
}
console.log();
console.log(`  Итого describe: ${data.describes.length}\n`);

console.log('── ТЕСТЫ ──');
console.log(`  Всего it:        ${data.its.length}`);
console.log(`  Активных:        ${data.its.filter((t) => !t.skipped).length}`);
console.log(`  Пропущенных:     ${data.its.filter((t) => t.skipped).length}`);
console.log();

console.log('── МОДЕЛИ ──');
console.log(`  Уникальных моделей в modelPath(): ${uniqueModels.length}`);
console.log(`  В GOLDEN_MODELS:                 ${goldenModels.length}`);
console.log(`  С собственным describe:          ${describedModels.length}`);
console.log();

console.log('── ПОКРЫТИЕ ПО МОДЕЛЯМ ──');
for (const model of uniqueModels) {
  const c = coverage[model];
  const flags = c ? [...c.flags].map((f) => JSON.parse(f)) : [];
  const flagSummary = flags.length ? flags.map((f) => `[${f.join(', ')}]`).join(', ') : '(через параметризацию)';
  console.log(`  ${model.padEnd(35)} ${String(c?.count || 0).padStart(3)} тестов  ${flagSummary}`);
}
console.log();

console.log('── КОМБИНАЦИИ ФЛАГОВ ──');
const seen = new Set();
for (const fc of data.flagCombos) {
  const key = JSON.stringify(fc.flags);
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  [${fc.flags.join(', ')}]  —  ${fc.describe}`);
}
console.log();

const active = data.its.filter((t) => !t.skipped).length;
const skipped_ = data.its.filter((t) => t.skipped).length;
const needBabel = parserUsed.startsWith('fallback')
  ? '⚠ fallback: eachModel-параметризация не раскрыта — реальное число тестов выше (см. vitest output)'
  : '';
console.log(`📈 Сводка: ${data.describes.length} describe, ${active} активных тестов (${skipped_} пропущено), ${uniqueModels.length} моделей`);
if (needBabel) console.log(`   ${needBabel}\n`);
