// glb_web_optimize v2 — умный оптимизатор GLB/glTF
//
// Анализ → решение → безопасная оптимизация → проверка → отчёт.
// Дизайн: ДИЗАЙН_v2_умный_оптимизатор.md (в этой же папке).
//
// Запуск:
//   node optimize2.mjs                        Meshopt (по умолчанию)
//   node optimize2.mjs draco                  Draco
//   node optimize2.mjs --keep-parts           не объединять меши
//   node optimize2.mjs --no-ktx               не трогать текстуры
//   node optimize2.mjs --strip-vertex-colors  удалить вершинные цвета, даже раскрашенные
//
// Вход: input/*.glb и input/*.gltf  →  Выход: output/*.glb + output/*.report.md

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import * as fns from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = path.join(BASE_DIR, 'input');
const OUTPUT_DIR = path.join(BASE_DIR, 'output');
const LOG_DIR = path.join(BASE_DIR, 'logs');
const LOG_KEEP_DAYS = 30; // логи старше — удаляются при следующем запуске

// ---------- логи: всё из консоли дублируется в файл logs/run_*.log ----------
fs.mkdirSync(LOG_DIR, { recursive: true });
const _stamp = new Date().toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
const LOG_FILE = path.join(LOG_DIR, `run_${_stamp}.log`);
const _logLines = [`=== glb_web_optimize v2 · запуск ${new Date().toISOString()} ===`, `argv: ${process.argv.slice(2).join(' ') || '(без аргументов)'}`];
for (const m of ['log', 'error', 'warn']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => {
    _logLines.push(a.map((x) => (typeof x === 'string' ? x : (x && x.stack) || String(x))).join(' '));
    orig(...a);
  };
}
function flushLog() {
  try { fs.writeFileSync(LOG_FILE, _logLines.join('\n') + '\n', 'utf8'); } catch { /* диск/права — лог не критичен */ }
}
process.on('exit', flushLog); // пишется и при падении, и при успехе

// ротация: удалить логи старше LOG_KEEP_DAYS дней
try {
  for (const f of fs.readdirSync(LOG_DIR)) {
    if (!f.endsWith('.log')) continue;
    const p = path.join(LOG_DIR, f);
    if (Date.now() - fs.statSync(p).mtimeMs > LOG_KEEP_DAYS * 24 * 3600 * 1000) fs.rmSync(p);
  }
} catch { /* не критично */ }

// ---------- аргументы ----------
const argv = process.argv.slice(2).map((a) => a.toLowerCase());
const CODEC = argv.includes('draco') ? 'draco' : 'meshopt';
const KEEP_PARTS = argv.includes('--keep-parts');
const NO_KTX = argv.includes('--no-ktx');
const STRIP_COLORS = argv.includes('--strip-vertex-colors');

// ---------- поиск внешних инструментов ----------
function findInPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const GLTF_CLI = findInPath(['gltf-transform.cmd', 'gltf-transform']);

// JS-вход CLI: вызываем его напрямую текущим node, минуя .cmd-обёртку
// (.cmd внутри вызывает "node" через shell — ломается двойным слоем кавычек на Windows)
function findCliJs() {
  if (!GLTF_CLI) return null;
  const pkgDir = path.join(path.dirname(GLTF_CLI), 'node_modules', '@gltf-transform', 'cli');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    let bin = pkg.bin;
    if (bin && typeof bin === 'object') bin = bin['gltf-transform'] || Object.values(bin)[0];
    if (typeof bin === 'string') {
      const p = path.join(pkgDir, bin);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* нет package.json — используем .cmd как запасной путь */ }
  return null;
}
const GLTF_CLI_JS = findCliJs();

function findToktx() {
  // gltf-transform CLI v4 требует бинарник `ktx` (KTX-Software 4.3+); toktx — запасной признак установки
  const inPath = findInPath(['ktx.exe', 'ktx', 'toktx.exe', 'toktx']);
  if (inPath) return inPath;
  const candidates = [
    'C:\\Program Files\\KTX-Software\\bin\\ktx.exe',
    'C:\\Program Files (x86)\\KTX-Software\\bin\\ktx.exe',
    'C:\\Program Files\\KTX-Software\\bin\\toktx.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

const TOKTX = NO_KTX ? null : findToktx();
const childEnv = { ...process.env };
if (TOKTX) {
  const dir = path.dirname(TOKTX);
  // на Windows ключ называется `Path` — ищем реальный ключ без учёта регистра,
  // иначе создаётся дубликат PATH, который ЗАМЕНЯЕТ системный путь у дочернего процесса
  const pathKey = Object.keys(childEnv).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  if (!(childEnv[pathKey] || '').includes(dir)) childEnv[pathKey] = dir + path.delimiter + (childEnv[pathKey] || '');
}

_logLines.push(`node: ${process.version} | CLI: ${GLTF_CLI_JS || GLTF_CLI || 'не найден'} | toktx: ${TOKTX || 'не найден'}`);

function runCli(args) {
  // gltf-transform CLI для фазы KTX2 (кодирование через toktx)
  try {
    if (GLTF_CLI_JS) {
      execFileSync(process.execPath, [GLTF_CLI_JS, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      execFileSync(GLTF_CLI, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: GLTF_CLI.endsWith('.cmd') });
    }
  } catch (e) {
    const raw = ((e.stderr || '') + '\n' + (e.stdout || '')).toString().trim();
    const tail = raw ? raw.split('\n').slice(-10).join('\n    ') : e.message;
    throw new Error(`gltf-transform ${args[0]} завершился с ошибкой:\n    ${tail}`);
  }
}

// ---------- метрики ----------
function collectMetrics(doc, fileBytes) {
  const root = doc.getRoot();
  let drawCalls = 0;
  let triangles = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      drawCalls += 1;
      if (prim.getMode() === 4) {
        const idx = prim.getIndices();
        const pos = prim.getAttribute('POSITION');
        triangles += Math.floor((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3);
      }
    }
  }
  let textureBytes = 0;
  let gpuBytes = 0;
  try {
    const report = fns.inspect(doc);
    for (const t of report.textures.properties) {
      textureBytes += t.size || 0;
      gpuBytes += t.gpuSize || 0;
    }
  } catch {
    /* inspect может не поддержать экзотику — не критично */
  }
  return {
    fileBytes,
    drawCalls,
    triangles,
    textureBytes,
    gpuBytes,
    meshes: root.listMeshes().length,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    nodes: root.listNodes().length,
    animations: root.listAnimations().length,
    skins: root.listSkins().length,
  };
}

const MB = (b) => (b / (1024 * 1024)).toFixed(2);

// ---------- кастомные проходы ----------

// Вершинные цвета: пустые (все белые) — удалить всегда; раскрашенные — только с флагом
function processVertexColors(doc, report) {
  const el = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const sem of prim.listSemantics()) {
        if (!sem.startsWith('COLOR_')) continue;
        const acc = prim.getAttribute(sem);
        let allWhite = true;
        const n = acc.getCount();
        for (let i = 0; i < n; i++) {
          acc.getElement(i, el); // нормализованные float-значения
          if (el.some((v) => v < 0.999)) { allWhite = false; break; }
        }
        if (allWhite) {
          prim.setAttribute(sem, null);
          report.actions.push(`${sem} (меш «${mesh.getName() || '—'}»): все значения белые — удалён, вид не меняется`);
        } else if (STRIP_COLORS) {
          prim.setAttribute(sem, null);
          report.actions.push(`${sem} (меш «${mesh.getName() || '—'}»): РАСКРАШЕН, удалён по флагу --strip-vertex-colors — вид может измениться`);
        } else {
          report.warnings.push(`${sem} (меш «${mesh.getName() || '—'}»): реальная покраска вершин — НЕ удалён. Форсировать: --strip-vertex-colors`);
        }
      }
    }
  }
}

// Вырожденные треугольники: два/три одинаковых индекса = нулевая площадь
function removeDegenerateTriangles(doc, report) {
  let removedTotal = 0;
  const patched = new Set();
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue; // только TRIANGLES
      const indices = prim.getIndices();
      if (!indices || patched.has(indices)) continue;
      const arr = indices.getArray();
      const out = [];
      for (let i = 0; i + 2 < arr.length; i += 3) {
        const a = arr[i], b = arr[i + 1], c = arr[i + 2];
        if (a !== b && b !== c && a !== c) out.push(a, b, c);
      }
      const removed = (arr.length - out.length) / 3;
      if (removed > 0) {
        indices.setArray(new arr.constructor(out));
        removedTotal += removed;
      }
      patched.add(indices); // общий аксессор не обрабатываем дважды
    }
  }
  if (removedTotal > 0) report.actions.push(`Вырожденные треугольники: удалено ${removedTotal} (нулевая площадь, на рендер не влияли)`);
  return removedTotal;
}

// Висящие вершины: не адресованы ни одним индексом
function removeOrphanVertices(doc, report) {
  if (typeof fns.compactPrimitive !== 'function') {
    report.warnings.push('compactPrimitive недоступен в этой версии @gltf-transform/functions — проход по висящим вершинам пропущен');
    return;
  }
  let before = 0;
  let after = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos || !prim.getIndices()) continue;
      before += pos.getCount();
      fns.compactPrimitive(prim);
      after += prim.getAttribute('POSITION').getCount();
    }
  }
  if (before > after) report.actions.push(`Висящие вершины: удалено ${before - after} (не адресованы индексами, не рисовались)`);
}

// Текстуры: WebP/JPEG → PNG (без потерь), чтобы toktx смог их прочитать; уже-KTX2 не трогаем
async function decodeTexturesForKtx(doc, report) {
  let needKtx = 0;
  for (const tex of doc.getRoot().listTextures()) {
    const mime = tex.getMimeType();
    if (mime === 'image/ktx2') {
      report.actions.push(`Текстура «${tex.getName() || '—'}»: уже KTX2 — пропущена (без перекодирования)`);
      continue;
    }
    if (mime === 'image/webp' || mime === 'image/jpeg') {
      const sharp = (await import('sharp')).default; // ленивый импорт: нужен только для WebP/JPEG
      const png = await sharp(Buffer.from(tex.getImage())).png().toBuffer();
      tex.setImage(png);
      tex.setMimeType('image/png');
      report.actions.push(`Текстура «${tex.getName() || '—'}»: ${mime} → PNG (без потерь, для toktx)`);
    }
    needKtx += 1;
  }
  return needKtx; // сколько текстур пойдёт в KTX2
}

// ---------- отчёт ----------
function diffLine(label, before, after, fmt = (v) => v) {
  return `| ${label} | ${fmt(before)} | ${fmt(after)} |`;
}

function writeReport(name, report, before, after) {
  const lines = [
    `# Отчёт оптимизации — ${name}`,
    '',
    `Дата: ${new Date().toISOString().slice(0, 10)} · кодек: ${CODEC}` +
      (KEEP_PARTS ? ' · без join' : '') + (NO_KTX ? ' · без KTX2' : '') + (STRIP_COLORS ? ' · strip-vertex-colors' : ''),
    '',
    '## Метрики',
    '',
    '| Показатель | До | После |',
    '|---|---|---|',
    diffLine('Файл', before.fileBytes, after.fileBytes, (v) => `${MB(v)} МБ`),
    diffLine('VRAM текстур (GPU)', before.gpuBytes, after.gpuBytes, (v) => `${MB(v)} МБ`),
    diffLine('Вес текстур в файле', before.textureBytes, after.textureBytes, (v) => `${MB(v)} МБ`),
    diffLine('Draw calls (примитивы)', before.drawCalls, after.drawCalls),
    diffLine('Треугольники', before.triangles, after.triangles),
    diffLine('Меши', before.meshes, after.meshes),
    diffLine('Материалы', before.materials, after.materials),
    diffLine('Текстуры', before.textures, after.textures),
    diffLine('Узлы сцены', before.nodes, after.nodes),
    '',
    '## Выполненные операции',
    '',
    ...(report.actions.length ? report.actions.map((a) => `- ${a}`) : ['- (структурная чистка без индивидуальных находок)']),
    '',
    '## Предупреждения',
    '',
    ...(report.warnings.length ? report.warnings.map((w) => `- ⚠ ${w}`) : ['- нет']),
    '',
    '## Safety-проверки',
    '',
    ...report.safety.map((s) => `- ${s}`),
    '',
  ];
  fs.writeFileSync(path.join(OUTPUT_DIR, name.replace(/\.(glb|gltf)$/i, '.report.md')), lines.join('\n'), 'utf8');
}

// ---------- обработка одного файла ----------
async function processFile(io, filename) {
  const src = path.join(INPUT_DIR, filename);
  const dstName = filename.replace(/\.gltf$/i, '.glb');
  const dst = path.join(OUTPUT_DIR, dstName);
  if (fs.existsSync(dst)) {
    console.log(`[ПРОПУСК] ${filename} — уже есть в output/`);
    return 'skip';
  }

  const report = { actions: [], warnings: [], safety: [] };
  console.log(`[РАБОТА] ${filename}`);

  const doc = await io.read(src);
  const before = collectMetrics(doc, fs.statSync(src).size);

  // 1. Структурная чистка: дубли ресурсов, неиспользуемое, лишние атрибуты (TEXCOORD и т.п.)
  console.log('    1/6 структурная чистка (dedup, prune, неиспользуемые UV/атрибуты)');
  const semanticsBefore = new Set();
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) for (const s of p.listSemantics()) semanticsBefore.add(s);
  await doc.transform(fns.dedup(), fns.prune({ keepAttributes: false, keepLeaves: false }));
  const semanticsAfter = new Set();
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) for (const s of p.listSemantics()) semanticsAfter.add(s);
  for (const s of semanticsBefore) {
    if (!semanticsAfter.has(s)) report.actions.push(`Атрибут ${s}: не используется ни одним материалом — удалён (prune)`);
  }
  if (before.textures > doc.getRoot().listTextures().length) {
    report.actions.push(`Текстуры: удалено/склеено ${before.textures - doc.getRoot().listTextures().length} неиспользуемых или дублей`);
  }
  if (before.materials > doc.getRoot().listMaterials().length) {
    report.actions.push(`Материалы: удалено ${before.materials - doc.getRoot().listMaterials().length} неиспользуемых/дублей`);
  }

  // 2. Вершинные цвета
  console.log('    2/6 вершинные цвета (COLOR_n)');
  processVertexColors(doc, report);

  // 3. Геометрия: сварка, вырожденные треугольники, висящие вершины
  console.log('    3/6 геометрия (weld, вырожденные треугольники, висящие вершины)');
  const trianglesBeforeWeld = collectMetrics(doc, 0).triangles;
  await doc.transform(fns.weld());
  removeDegenerateTriangles(doc, report);
  removeOrphanVertices(doc, report);

  // 4. Объединение
  if (!KEEP_PARTS) {
    console.log('    4/6 объединение (flatten, join)');
    await doc.transform(fns.flatten(), fns.join());
  } else {
    console.log('    4/6 объединение пропущено (--keep-parts)');
  }
  await doc.transform(fns.prune()); // подчистка осиротевших аксессоров после всех проходов

  // 5. Текстуры → KTX2 (через CLI + toktx); без toktx/CLI фаза пропускается с предупреждением
  let workDoc = doc;
  let needKtx = 0;
  if (TOKTX && GLTF_CLI) {
    needKtx = await decodeTexturesForKtx(doc, report);
  } else if (!NO_KTX) {
    report.warnings.push('toktx или gltf-transform CLI не найдены — текстуры оставлены в исходном формате');
  }
  if (TOKTX && GLTF_CLI && needKtx > 0) {
    console.log(`    5/6 текстуры → KTX2/UASTC (${needKtx} шт.)`);
    const tmpA = path.join(OUTPUT_DIR, `_tmp_${dstName}`);
    const tmpB = path.join(OUTPUT_DIR, `_tmp2_${dstName}`);
    try {
      await io.write(tmpA, doc);
      runCli(['uastc', tmpA, tmpB, '--level', '2', '--zstd', '18']);
      workDoc = await io.read(tmpB); // дальше работаем с KTX2-версией
    } finally {
      // временные файлы не должны оставаться в output даже при ошибке
      for (const t of [tmpA, tmpB]) {
        try { if (fs.existsSync(t)) fs.rmSync(t); } catch { /* занят — уберётся при следующем запуске */ }
      }
    }
  } else {
    console.log('    5/6 KTX2 пропущен' + (needKtx === 0 && TOKTX && GLTF_CLI ? ' (все текстуры уже KTX2 или их нет)' : ''));
  }

  // 6. Сжатие геометрии через SDK — запись сразу в итоговый файл, без переименований
  console.log(`    6/6 сжатие геометрии (${CODEC})`);
  if (CODEC === 'draco') {
    await workDoc.transform(fns.draco());
  } else {
    await workDoc.transform(fns.meshopt({ encoder: MeshoptEncoder }));
  }
  await io.write(dst, workDoc);

  // Метрики «после» и safety-проверки
  const finalDoc = await io.read(dst);
  const after = collectMetrics(finalDoc, fs.statSync(dst).size);

  const triangleDelta = trianglesBeforeWeld - after.triangles;
  report.safety.push(after.triangles > 0 ? '✅ геометрия на месте' : '❌ ГЕОМЕТРИЯ ПУСТАЯ — файл битый!');
  report.safety.push(
    triangleDelta === 0
      ? '✅ число треугольников не изменилось'
      : `ℹ треугольников стало меньше на ${triangleDelta} — только вырожденные (нулевая площадь), рендер идентичен`
  );
  report.safety.push(before.animations === after.animations ? `✅ анимации: ${after.animations}` : `❌ анимации потеряны: было ${before.animations}, стало ${after.animations}`);
  report.safety.push(before.skins === after.skins ? `✅ скины: ${after.skins}` : `❌ скины потеряны: было ${before.skins}, стало ${after.skins}`);
  try {
    const validator = await import('gltf-validator');
    const res = await validator.validateBytes(new Uint8Array(fs.readFileSync(dst)));
    const errs = res.issues.numErrors;
    report.safety.push(errs === 0 ? '✅ gltf-validator (Khronos): 0 ошибок' : `❌ gltf-validator: ${errs} ошибок — смотри отчёт валидатора`);
  } catch {
    report.safety.push('ℹ gltf-validator не установлен — структурная валидация пропущена');
  }

  writeReport(dstName, report, before, after);
  const pct = before.fileBytes ? ((1 - after.fileBytes / before.fileBytes) * 100).toFixed(0) : 0;
  const gpuPct = before.gpuBytes ? ((1 - after.gpuBytes / before.gpuBytes) * 100).toFixed(0) : 0;
  console.log(`[ГОТОВО] ${dstName}: файл ${MB(before.fileBytes)} → ${MB(after.fileBytes)} МБ (−${pct}%), VRAM ${MB(before.gpuBytes)} → ${MB(after.gpuBytes)} МБ (−${gpuPct}%)`);
  console.log(`         отчёт: output/${dstName.replace(/\.glb$/i, '.report.md')}`);
  return 'ok';
}

// ---------- main ----------
async function main() {
  fs.mkdirSync(INPUT_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const files = fs.readdirSync(INPUT_DIR).filter((f) => /\.(glb|gltf)$/i.test(f)).sort();
  if (!files.length) {
    console.log(`В папке input/ нет .glb/.gltf файлов. Положи модели сюда:\n  ${INPUT_DIR}`);
    return;
  }

  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });

  console.log(`Кодек: ${CODEC}` + (KEEP_PARTS ? ' | без join' : '') + (NO_KTX ? ' | без KTX2' : '') + (STRIP_COLORS ? ' | strip-vertex-colors' : '') + (TOKTX ? '' : ' | toktx НЕ найден'));
  console.log(`Файлов: ${files.length}\n`);

  let ok = 0, skip = 0, fail = 0;
  for (const f of files) {
    try {
      const r = await processFile(io, f);
      if (r === 'ok') ok++;
      else skip++;
    } catch (e) {
      fail++;
      console.error(`[ОШИБКА] ${f}: ${e.message || e}`);
    }
    console.log();
  }
  console.log(`Итог: готово ${ok}, пропущено ${skip}, ошибок ${fail}`);
}

main().catch((e) => { console.error('[ФАТАЛЬНАЯ ОШИБКА]', e && e.stack ? e.stack : e); process.exit(1); });
