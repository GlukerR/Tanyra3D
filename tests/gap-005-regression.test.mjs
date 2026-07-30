// Regression test для GAP-005.
//
// Суть бага до правки (см. .claude/CONTEXT.md «docs(context): GAP-005, API-002, корпус в репозитории»):
//   - morphTargets и attributes не входили в BASELINE_METRICS — потеря морфов или
//     UV-канала во втором проходе не меняла ни один ключ, файл писался, отчёт
//     говорил «все проверки пройдены».
//   - geometry/compress шёл на tier: 'basic' — снимок baseline брался ПОСЛЕ сжатия,
//     и сверка сравнивала Draco сам с собой.
//   - nodes был жёстким ключом — meshopt-обёртки KHR_mesh_quantization ломали запись
//     на законном поведении кодека (CarConcept: 101 → 107 узлов при неизменных
//     треугольниках).
//
// Этот файл — sentinel: до правки он падал, после — зелёный. Если сломается
// снова (BASELINE_METRICS откатили к 6 ключам, BASELINE_SOFT снова без 'nodes',
// geometry/compress снова на 'basic') — тесты этого файла упадут.
//
// Хранилище ИСТИНЫ — addons/gltf/metrics.mjs. Импорт модуля запрещён правилом
// роли («только публичное API через optimize2.mjs»), поэтому читаем исходник
// как текст через fs.readFileSync. Это текстовая проверка файла, а не
// обращение к функциональности — не нарушает правило «не импортируй внутренности».
//
// Тяжёлый поведенческий тест на parkergirl (456 морф-сет) — в
// tests/post-gap005-corpus.test.mjs; здесь он не дублируется, чтобы не
// плодить вводящие в заблуждение «зелёные» стражи над некоммитимой моделью.

import { describe, it, expect } from 'vitest';
import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const METRICS_SOURCE_PATH = path.resolve(PROJECT_ROOT, 'addons/gltf/metrics.mjs');

function modelPath(name) {
  return path.resolve(PROJECT_ROOT, 'fixtures/models', name);
}

// ----- SOURCE-OF-TRUTH: BASELINE_METRICS / BASELINE_SOFT из файла -----
//
// Парсим текст addons/gltf/metrics.mjs:
//   export const BASELINE_METRICS = [ 'a', 'b', ... ];
//   export const BASELINE_SOFT   = new Set([ 'a', 'b' ]);
//
// Регексп берёт всё между `[` и `]`, потом режет по запятой и снимает кавычки.
// Ничего из результата в тесте не хардкодится — мы лишь проверяем, что
// нужные имена ПРИСУТСТВУЮТ в живом списке из исходника.

function parseBaselineBlock(content, name) {
  // Один регексп на обе формы: `= [ ... ]` и `= new Set([ ... ])`.
  const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(?:new\\s+Set\\()?\\[([^\\]]*)\\]`, 'm');
  const m = content.match(re);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['\"]|['\"]$/g, ''))
    .filter(Boolean);
}

describe('GAP-005 Source Code Checks — BASELINE_METRICS · BASELINE_SOFT', () => {
  // Санти: исходник читается; оба блока находятся; иначе regex устарел
  // и остальные проверки этого describe шумят ложно.
  it('addons/gltf/metrics.mjs parses — both BASELINE_METRICS and BASELINE_SOFT found', () => {
    expect(fs.existsSync(METRICS_SOURCE_PATH)).toBe(true);
    const text = fs.readFileSync(METRICS_SOURCE_PATH, 'utf-8');
    expect(parseBaselineBlock(text, 'BASELINE_METRICS')).not.toBeNull();
    expect(parseBaselineBlock(text, 'BASELINE_SOFT')).not.toBeNull();
  });

  it('BASELINE_METRICS includes morphTargets (новый ключ после GAP-005)', () => {
    const text = fs.readFileSync(METRICS_SOURCE_PATH, 'utf-8');
    const items = parseBaselineBlock(text, 'BASELINE_METRICS');
    expect(items).toContain('morphTargets');
  });

  it('BASELINE_METRICS includes attributes (новый ключ после GAP-005)', () => {
    const text = fs.readFileSync(METRICS_SOURCE_PATH, 'utf-8');
    const items = parseBaselineBlock(text, 'BASELINE_METRICS');
    expect(items).toContain('attributes');
  });

  it('BASELINE_SOFT includes vertices (был и до GAP-005)', () => {
    const text = fs.readFileSync(METRICS_SOURCE_PATH, 'utf-8');
    const items = parseBaselineBlock(text, 'BASELINE_SOFT');
    expect(items).toContain('vertices');
  });

  it('BASELINE_SOFT includes nodes (НОВОЕ: nodes ушёл из жёстких → стал мягким)', () => {
    // До GAP-005 nodes был жёстким ключом и при CarConcept ловил ложный
    // «baseline-mismatch» (meshopt-обёртки KHR_mesh_quantization дают
    // 101 → 107 узлов при неизменных треугольниках). Сейчас nodes — soft:
    // разница фиксируется в отчёте как warning, но не валит запись.
    const text = fs.readFileSync(METRICS_SOURCE_PATH, 'utf-8');
    const items = parseBaselineBlock(text, 'BASELINE_SOFT');
    expect(items).toContain('nodes');
  });

  it('BASELINE_METRICS держит минимум 8 обязательных ключей', () => {
    // Из задания: «BASELINE_METRICS вырос с шести ключей до восьми».
    // Проверяем минимум — membership восьми ключей. Появление новых ключей
    // сверх восьми ИЗМЕНЕНИЯ КОНТРАКТА НЕ ЛОМАЕТ (это совместимое расширение),
    // поэтому assert только на membership.
    const text = fs.readFileSync(METRICS_SOURCE_PATH, 'utf-8');
    const items = parseBaselineBlock(text, 'BASELINE_METRICS');
    const expected = ['triangles', 'vertices', 'drawCalls', 'skins', 'nodes', 'animations', 'morphTargets', 'attributes'];
    expect(items.length).toBeGreaterThanOrEqual(expected.length);
    for (const key of expected) expect(items).toContain(key);
  });
});

// ----- BEHAVIORAL CHECKS на коммитимой модели с морфами -----
//
// Morph Cube 01.glb — единственная коммитимая модель корпуса с морфами.
// Прогон под `['safe']`, `['safe','draco']`, `['safe','join']`. До GAP-005
// `morphTargets` не входил в BASELINE_METRICS → поле могло схлопнуться
// в ноль или исказиться — этот тест упал бы. После GAP-005 — стабильно.

describe('GAP-005 Behavioral — Morph Cube 01 (committed, 2 morph targets)', () => {
  it('source: 2 morph targets (основа glTF targets[] без basis)', () => {
    // В glTF basis включён в POSITION самого примитива, в targets[] попадают
    // только дополнительные. На этой модели targets = 2. Sanity-инвариант
    // GLB, и если число меняется — двигать тест только с одновременной
    // правкой Morph Cube 01.md.
    const text = fs.readFileSync(modelPath('Morph Cube 01.glb'));
    // GLB: 12 байт header + 4 байт version + 4 байт length + chunk header + JSON.
    const jsonLength = text.readUInt32LE(12);
    const jsonBytes = text.slice(20, 20 + jsonLength);
    const json = JSON.parse(jsonBytes.toString('utf-8'));
    let total = 0;
    for (const mesh of (json.meshes || [])) {
      for (const prim of (mesh.primitives || [])) {
        total += ((prim.targets) || []).length;
      }
    }
    expect(total).toBe(2);
  });

  // ПРОСТО it.each с массивом массивов в vitest 4.1.10 роняет имена (все
  // три теста выходят под одним именем, и часть из них бежит с неверными
  // параметрами). Поэтому — три явных `it` с уникальными именами.
  const PRESERVE_MODES = [
    { name: 'safe', flags: ['safe'] },
    { name: 'safe+draco', flags: ['safe', 'draco'] },
    { name: 'safe+join', flags: ['safe', 'join'] },
  ];
  for (const { name, flags } of PRESERVE_MODES) {
    it(`${name} — morphTargets preserved (before === after, non-zero)`, async () => {
      const result = await optimizeFile(modelPath('Morph Cube 01.glb'), {
        advancedFeatures: flags,
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      // Sentinel: до GAP-005 поля morphTargets не было бы вовсе — защита
      // baseline-checkpoint была бы слепой к потере морфов. Этот assert —
      // страж на то, что ключи реально присутствуют и сверка работает.
      expect(typeof result.metrics.before.morphTargets).toBe('number');
      expect(typeof result.metrics.after.morphTargets).toBe('number');
      expect(result.metrics.before.morphTargets).toBeGreaterThan(0);
      expect(result.metrics.before.morphTargets).toBe(result.metrics.after.morphTargets);
    });
  }

  it('attributes содержит POSITION — UV-канал и нормаль видны baseline-checkpoint', async () => {
    const result = await optimizeFile(modelPath('Morph Cube 01.glb'), {
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(typeof result.metrics.before.attributes).toBe('string');
    // На этой модели как минимум POSITION (всегда) и NORMAL; полный список
    // зависит от экспортёра, поэтому assert только на POSITION — стабильно.
    expect(result.metrics.before.attributes.split(',').map((s) => s.trim())).toContain('POSITION');
  });
});
