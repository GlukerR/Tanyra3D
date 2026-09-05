import { describe, it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const INPUT_DIR = path.resolve(PROJECT_ROOT, 'input');

const HEAVY_BYTES = 50 * 1024 * 1024;

const COMBOS = [
  { name: 'passthrough',   flags: [] },
  { name: 'safe',          flags: ['safe'] },
  { name: 'safe+quantize', flags: ['safe', 'quantize'] },
  { name: 'safe+webp',     flags: ['safe', 'webp'] },
];

const TEST_TIMEOUT_MS = 300_000;

const inputExists = fs.existsSync(INPUT_DIR);
let heavyModels = [];
if (inputExists) {
  heavyModels = fs.readdirSync(INPUT_DIR)
    .filter((f) => /\.(glb|gltf)$/i.test(f))
    .filter((f) => fs.statSync(path.join(INPUT_DIR, f)).size > HEAVY_BYTES)
    .sort();
}

describe('Тяжёлые модели input/ — стресс (класс heavy)', () => {
  if (!inputExists) {
    it.skip('папка input/ отсутствует (чистый клон) — стресс тяжёлых моделей недоступен', () => {});
    return;
  }

  it('в input/ есть хотя бы одна модель тяжелее 50 МБ (представитель класса heavy)', () => {
    expect(heavyModels.length).toBeGreaterThan(0);
  });

  for (const name of heavyModels) {
    for (const combo of COMBOS) {
      it(`${name} — ${combo.name}: завершается в таймаут, без исключений наружу`, async () => {
        const result = await optimizeFile(
          path.join(INPUT_DIR, name),
          { outDir: tmpOutDir(), advancedFeatures: combo.flags, dryRun: true },
          TEST_TIMEOUT_MS,
        );

        expect(result.status).toMatch(/ok|fail|skip/);

        if (result.status === 'ok') {
          expect(result.metrics.before).toBeTruthy();
          expect(result.metrics.after).toBeTruthy();
          expect(result.metrics.before.triangles).toBeGreaterThan(0);
          expect(result.metrics.after.triangles).toBeLessThanOrEqual(result.metrics.before.triangles);
          expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
        } else if (result.status === 'fail') {
          const reason = result.error || result.validation.find((v) => v.level === 'fail')?.message;
          expect(reason).toBeTruthy();
        }
      }, TEST_TIMEOUT_MS);
    }
  }
});

afterAll(cleanupTmpOutDirs);
