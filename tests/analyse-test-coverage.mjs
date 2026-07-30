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

// Предварительный проход: собрать все const-массивы строк из кода
function collectConstArrays(code) {
  const re = /const\s+(\w+)\s*=\s*\[([^\]]+)\]/gs;
  let m;
  while ((m = re.exec(code)) !== null) {
    const name = m[1];
    const items = [...m[2].matchAll(/['"`]([^'"`]+\.glb)['"`]/g)].map((x) => x[1]);
    if (items.length) CONST_ARRAYS[name] = items;
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
//  3. Fallback-парсер (если babel недоступен)
// –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––

function fallbackParse(code) {
  const lines = code.split('\n');
  const describes = [];
  const its = [];
  const modelPaths = [];
  const flagCombos = [];

  const describeStack = [];
  let currentDescribe = null;

  const reDescribe = /^\s*(describe|describeLocal|describe\.skip)\s*\(\s*(['"`])([^'"`]+)\2/;
  const reIt = /^\s*(it|it\.skip)\s*\(\s*(['"`])([^'"`]+)\2/;
  const reEachModel = /^\s*eachModel\s*\(\s*(['"`])([^'"`]+)\1/;
  const reModelPath = /modelPath\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;

  for (const line of lines) {
    const trimmed = line.trim();

    let m = trimmed.match(reDescribe);
    if (m) {
      const type = m[1];
      const name = m[3];
      describeStack.push({ name, type, children: [] });
      currentDescribe = describeStack[describeStack.length - 1];
      describes.push(currentDescribe);
      continue;
    }

    m = trimmed.match(reIt);
    if (m) {
      const isSkipped = m[1] === 'it.skip';
      const itName = m[3];
      const dc = currentDescribe?.name || '(top-level)';
      its.push({ name: itName, skipped: isSkipped, describe: dc });

      let mp;
      const localRe = new RegExp(reModelPath.source, 'g');
      while ((mp = localRe.exec(trimmed)) !== null) {
        modelPaths.push({ modelName: mp[2], describe: dc, itName });
      }

      const af = findAdvancedFallback(trimmed);
      for (const flags of af) {
        flagCombos.push({ flags, describe: dc, itName });
      }
      continue;
    }

    m = trimmed.match(reEachModel);
    if (m) {
      const itDesc = m[2];
      const dc = currentDescribe?.name || '(top-level)';
      its.push({ name: `eachModel(${itDesc})`, skipped: false, describe: dc });
      continue;
    }

    if (trimmed === '});' && describeStack.length) {
      describeStack.pop();
      currentDescribe = describeStack.length ? describeStack[describeStack.length - 1] : null;
    }
  }

  return { describes, its, modelPaths, flagCombos };
}

function findAdvancedFallback(line) {
  const results = [];
  const re = /advancedFeatures\s*:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const flags = m[1].split(',').map((s) => s.trim().replace(/['"`]/g, '')).filter(Boolean);
    if (flags.length) results.push(flags);
  }
  return results;
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
