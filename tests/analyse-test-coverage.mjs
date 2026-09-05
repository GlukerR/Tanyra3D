#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TARGET = path.resolve(PROJECT_ROOT, 'tests/golden-corpus.test.mjs');

const CONST_ARRAYS = {};

function collectConstArrays(code) {
  let re = /const\s+(\w+)\s*=\s*\[([^\]]+)\]/gs;
  let m;
  while ((m = re.exec(code)) !== null) {
    const items = [...m[2].matchAll(/['"`]([^'"`]+\.glb)['"`]/g)].map((x) => x[1]);
    if (items.length) CONST_ARRAYS[m[1]] = items;
  }
  re = /const\s+(\w+)\s*=\s*new\s+Set\s*\(\s*\[([^\]]+)\]\s*\)/gs;
  while ((m = re.exec(code)) !== null) {
    const items = [...m[2].matchAll(/['"`]([^'"`]+\.glb)['"`]/g)].map((x) => x[1]);
    if (items.length) CONST_ARRAYS[m[1]] = items;
  }
}

function resolveModelFilter(node) {
  if (!node) return [];

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

  if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
    const objName = node.callee.object?.type === 'Identifier' ? node.callee.object.name : null;
    if (objName && CONST_ARRAYS[objName]) {
      return CONST_ARRAYS[objName];
    }
  }

  if (node.type === 'Identifier' && CONST_ARRAYS[node.name]) {
    return CONST_ARRAYS[node.name];
  }

  return [];
}

let ast = null;
let parserUsed = 'babel';

const code = fs.readFileSync(TARGET, 'utf-8');

collectConstArrays(code);

try {
  const babelParser = await import('@babel/parser');
  ast = babelParser.parse(code, {
    sourceType: 'module',
    plugins: ['importAssertions'],
    errorRecovery: true,
  });
} catch (err) {
  parserUsed = `fallback (${err.message})`;
}

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

function findMatchingBrace(code, start, open = '{', close = '}') {
  let depth = 1;
  for (let i = start + 1; i < code.length; i++) {
    const c = code[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < code.length && code[i] !== q) {
        if (code[i] === '\\') i++;
        i++;
      }
    }
    if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
    }
    if (c === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < code.length - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i++;
    }
  }
  return -1;
}

function extractFlagsFromBody(body, codeBeforeBlock) {
  const results = [];

  const re = /advancedFeatures\s*:\s*\[([^\]]*)\]/gs;
  let m;
  while ((m = re.exec(body)) !== null) {
    const flags = m[1].split(',').map((s) => s.trim().replace(/['"`]/g, '')).filter(Boolean);
    if (flags.length) results.push(flags);
  }

  if (/advancedFeatures\s*:\s*flags\b/.test(body)) {
    const forRe = /for\s*\(\s*(?:const|let|var)\s+flags\s+of\s*(\[[\s\S]*?\n\s*\])\s*\)/g;
    let lastFor;
    let fm;
    while ((fm = forRe.exec(codeBeforeBlock)) !== null) lastFor = fm;
    if (lastFor) {
      const arrText = lastFor[1];
      const innerArrs = [...arrText.matchAll(/\[([^\]]*)\]/g)];
      for (const ia of innerArrs) {
        const flags = ia[1].split(',').map((s) => s.trim().replace(/['"`]/g, '')).filter(Boolean);
        if (flags.length) results.push(flags);
      }
    }
  }

  return results;
}

function resolveModelListFromText(text) {
  const inlineRe = /^\s*\[([^\]]*)\]/;
  const im = text.match(inlineRe);
  if (im) {
    const spreadInner = im[1].trim();
    if (spreadInner.startsWith('...')) {
      const name = spreadInner.slice(3).trim();
      if (CONST_ARRAYS[name]) return CONST_ARRAYS[name];
    }
    return [...im[1].matchAll(/['"`]([^'"`]+\.glb)['"`]/g)].map((x) => x[1]);
  }

  const nameRe = /^\s*(\w+)(?:\.filter\([^)]*\))?/;
  const nm = text.match(nameRe);
  if (nm && CONST_ARRAYS[nm[1]]) {
    return CONST_ARRAYS[nm[1]];
  }

  return [];
}

function fallbackParse(code) {
  const describes = [];
  const its = [];
  const modelPaths = [];
  const flagCombos = [];

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

  const describeStack = [];

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];

    if (block.keyword.startsWith('describe')) {
      describeStack.push(block);
      describes.push({ name: block.name, type: block.keyword });
      continue;
    }

    const dc = describeStack.length > 0
      ? describeStack[describeStack.length - 1].name
      : '(top-level)';

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
      const isSkipped = block.keyword === 'it.skip';
      its.push({ name: block.name, skipped: isSkipped, describe: dc });

      for (const re of [
        /modelPath\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
        /runAndRead\s*\(\s*['"`]([^'"`]+\.glb)['"`]\s*,/g,
      ]) {
        let mpm;
        while ((mpm = re.exec(body)) !== null) {
          modelPaths.push({ modelName: mpm[1], describe: dc, itName: block.name });
        }
      }

      const flags = extractFlagsFromBody(body, codeBeforeBlock);
      for (const f of flags) {
        flagCombos.push({ flags: f, describe: dc, itName: block.name });
      }
    } else if (block.keyword === 'eachModel') {
      its.push({ name: `eachModel(${block.name})`, skipped: false, describe: dc });

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

    const nextBlock = blocks[bi + 1];
    while (describeStack.length > 0) {
      const top = describeStack[describeStack.length - 1];
      if (nextBlock && nextBlock.indent > top.indent) break;
      describeStack.pop();
    }
  }

  return { describes, its, modelPaths, flagCombos };
}

let data;

if (ast) {
  data = walkAST(ast);
} else {
  parserUsed = 'fallback (regex)';
  data = fallbackParse(code);
}

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

const modelsDir = path.resolve(PROJECT_ROOT, 'fixtures/models');

const repoModels = fs.readFileSync(path.resolve(PROJECT_ROOT, 'fixtures/.gitignore'), 'utf-8')
  .split(/\r?\n/)
  .map((line) => /^!models\/(.+\.(?:glb|gltf))\s*$/.exec(line.trim()))
  .filter(Boolean)
  .map((m) => m[1]);
if (!repoModels.length) {
  throw new Error('fixtures/.gitignore не дал ни одной коммитимой модели — разбор сломан, '
    + 'а с пустым списком гейт «коммитимая модель пропала с диска» проверяет пустоту');
}

const absentFromDisk = goldenModels.filter((m) => !fs.existsSync(path.join(modelsDir, m)));
const missingFromDisk = absentFromDisk.filter((m) => repoModels.includes(m));
const localModelsAbsent = absentFromDisk.filter((m) => !repoModels.includes(m));

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
    modelsMissing: missingFromDisk,
    localModelsAbsent,
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
if (missingFromDisk.length) {
  console.log(`  ⚠ REPO-МОДЕЛИ ПОТЕРЯНЫ:       ${missingFromDisk.length}`);
  for (const m of missingFromDisk) console.log(`    — ${m}`);
} else {
  console.log(`  ✓ Все REPO-модели на месте`);
}
if (localModelsAbsent.length) {
  console.log(`  · локальных нет на диске:      ${localModelsAbsent.length} (норма на чистом клоне)`);
}
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
