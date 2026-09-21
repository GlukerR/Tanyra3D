import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBounds } from '@gltf-transform/core';
import { importForeign } from '../addons/gltf/importers.mjs';
import { inspectFile, optimizeFile } from '../optimize2.mjs';
import { CAD_PARAMS as ENGINE_PARAMS, CAD_FORMATS as ENGINE_FORMATS } from '../addons/gltf/cad-shared.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = path.join(ROOT, 'node_modules', 'occt-import-js', 'test', 'testfiles');
const sample = (...p) => path.join(SAMPLES, ...p);
const TIMEOUT = 60_000;

const size = (doc) => {
  const b = getBounds(doc.getRoot().listScenes()[0]);
  return b.max.map((v, i) => v - b.min[i]);
};

describe('CAD: STEP / IGES / BREP', () => {
  it('STEP: дерево сборки и имена деталей сохраняются', async () => {
    const doc = await importForeign(sample('cax-if', 'as1-oc-214.stp'));
    const names = doc.getRoot().listNodes().map((n) => n.getName());
    expect(names).toContain('rod-assembly');
    expect(names).toContain('nut');
    expect(doc.getRoot().listMeshes().length).toBe(18);
  }, TIMEOUT);

  it('STEP: цвет каждой грани — свой материал, в линейном цвете', async () => {
    const doc = await importForeign(sample('cube-fcstd', 'cube2.step'));
    const colors = doc.getRoot().listMaterials().map((m) => m.getBaseColorFactor().slice(0, 3).map((v) => +v.toFixed(3)));
    expect(colors.length).toBe(6);
    expect(colors).toContainEqual([1, 0, 0]);
    expect(colors).toContainEqual([1, 0.402, 1]);
  }, TIMEOUT);

  it('единицы переводятся в метры: один и тот же куб в мм, м и дюймах — 1 м', async () => {
    for (const f of ['cube-mm.step', 'cube-m.step', 'cube-in.step']) {
      const [x] = size(await importForeign(sample('cube-units', f)));
      expect(x, f).toBeCloseTo(1, 4);
    }
  }, TIMEOUT);

  it('IGES: куб 10 мм — 0,01 м', async () => {
    const [x, y, z] = size(await importForeign(sample('cube-10x10mm', 'Cube 10x10.igs')));
    for (const v of [x, y, z]) expect(v).toBeCloseTo(0.01, 5);
  }, TIMEOUT);

  it('BREP читается', async () => {
    const doc = await importForeign(sample('cax-if-brep', 'as1_pe_203.brep'));
    expect(doc.getRoot().listMeshes().length).toBeGreaterThan(0);
  }, TIMEOUT);

  it('STEP проходит весь путь: инспекция и сборка в GLB', async () => {
    const src = sample('cax-if', 'as1-oc-214.stp');
    const insp = await inspectFile(src);
    expect(insp.metrics.triangles).toBeGreaterThan(0);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-'));
    try {
      const res = await optimizeFile(src, { advancedFeatures: ['safe'], outDir: out });
      expect(res.status, res.error).toBe('ok');
      expect(res.metrics.after.triangles).toBe(insp.metrics.triangles);
      expect(fs.readdirSync(out)).toContain('as1-oc-214.glb');
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);

  it('битый STEP — понятный отказ, а не падение', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-bad-'));
    try {
      const f = path.join(dir, 'битый.step');
      fs.writeFileSync(f, 'ISO-10303-21;\nHEADER;\nENDSEC;\n');
      await expect(importForeign(f)).rejects.toHaveProperty('i18n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it('ядро и вьюпорт режут поверхность одинаково', () => {
    const ui = fs.readFileSync(path.join(ROOT, 'ui', 'viewer', 'cad.ts'), 'utf8');
    for (const [k, v] of Object.entries(ENGINE_PARAMS)) {
      expect(ui, `вьюпорт: ${k}`).toMatch(new RegExp(`${k}:\\s*"?${String(v).replace('.', '\\.')}"?`));
    }
    for (const ext of ENGINE_FORMATS) expect(ui).toContain(`"${ext}"`);
  });
});

describe('списки форматов для человека не отстают от приёма', () => {
  it('каждое принимаемое расширение названо в подсказках на обоих языках', () => {
    const app = fs.readFileSync(path.join(ROOT, 'ui', 'app.ts'), 'utf8');
    const exts = app.match(/const MODEL_RE = \/\\.\(([^)]+)\)/)[1].split('|');
    for (const file of [path.join(ROOT, 'ui', 'locales', 'en.js'), path.join(ROOT, 'translations', 'ru.js')]) {
      const text = fs.readFileSync(file, 'utf8');
      for (const key of ['dropzone.rejected', 'log.rejectedMany', 'log.rejected']) {
        const line = text.split('\n').find((l) => l.includes(`'${key}'`));
        for (const ext of exts) expect(line, `${path.basename(file)} ${key}: нет .${ext}`).toMatch(new RegExp(`\\.${ext}\\b`));
      }
    }
  });
});
