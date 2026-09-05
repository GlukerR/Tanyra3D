import { describe, it, expect, afterAll } from 'vitest';
import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { sourcePath } from './helpers/source-files.mjs';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const METRICS_SOURCE_PATH = sourcePath('addons/gltf/metrics');

function modelPath(name) {
  return path.resolve(PROJECT_ROOT, 'fixtures/models', name);
}


function parseBaselineBlock(content, name) {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*(?::[^=]+)?=\\s*(?:new\\s+Set\\()?\\[([^\\]]*)\\]`, 'm');
  const m = content.match(re);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

describe('GAP-005 Source Code Checks — BASELINE_METRICS · BASELINE_SOFT', () => {
  it('источник метрик разбирается — both BASELINE_METRICS and BASELINE_SOFT found', () => {
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
    const text = fs.readFileSync(METRICS_SOURCE_PATH, 'utf-8');
    const items = parseBaselineBlock(text, 'BASELINE_SOFT');
    expect(items).toContain('nodes');
  });

  it('BASELINE_METRICS держит минимум 8 обязательных ключей', () => {
    const text = fs.readFileSync(METRICS_SOURCE_PATH, 'utf-8');
    const items = parseBaselineBlock(text, 'BASELINE_METRICS');
    const expected = ['triangles', 'vertices', 'drawCalls', 'skins', 'nodes', 'animations', 'morphTargets', 'attributes'];
    expect(items.length).toBeGreaterThanOrEqual(expected.length);
    for (const key of expected) expect(items).toContain(key);
  });
});


describe('GAP-005 Behavioral — Morph Cube 01 (committed, 2 morph targets)', () => {
  it('source: 2 morph targets (основа glTF targets[] без basis)', () => {
    const text = fs.readFileSync(modelPath('Morph Cube 01.glb'));
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

  const PRESERVE_MODES = [
    { name: 'safe', flags: ['safe'] },
    { name: 'safe+draco', flags: ['safe', 'draco'] },
    { name: 'safe+join', flags: ['safe', 'join'] },
  ];
  for (const { name, flags } of PRESERVE_MODES) {
    it(`${name} — morphTargets preserved (before === after, non-zero)`, async () => {
      const result = await optimizeFile(modelPath('Morph Cube 01.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: flags,
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(typeof result.metrics.before.morphTargets).toBe('number');
      expect(typeof result.metrics.after.morphTargets).toBe('number');
      expect(result.metrics.before.morphTargets).toBeGreaterThan(0);
      expect(result.metrics.before.morphTargets).toBe(result.metrics.after.morphTargets);
    });
  }

  it('attributes содержит POSITION — UV-канал и нормаль видны baseline-checkpoint', async () => {
    const result = await optimizeFile(modelPath('Morph Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(typeof result.metrics.before.attributes).toBe('string');
    expect(result.metrics.before.attributes.split(',').map((s) => s.trim())).toContain('POSITION');
  });
});

afterAll(cleanupTmpOutDirs);
