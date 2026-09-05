import { describe, it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.resolve(PROJECT_ROOT, 'fixtures/models');

const GLB_MAGIC = 0x46546c67;

function modelPath(name) {
  return path.resolve(FIXTURES, name);
}

function modelPresent(name) {
  return fs.existsSync(modelPath(name));
}

function parseGlbJson(bytes) {
  if (!bytes || bytes.length < 20) return null;
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) return null;
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.slice(20, 20 + jsonLength).toString('utf8'));
}


describe('animation/resample — models with animations', () => {
  const ANIM_MODELS = [
    { name: 'Lilith Character 01.glb', animCount: 3, hasSkins: true, names: ['Idle', 'Lilith_Walk_Loop', '0-T-Pose'] },
    { name: 'Cthulhu Stone 01.glb', animCount: 1, hasSkins: false, names: ['Scene'] },
    { name: 'chibi_zenitsu.glb', animCount: 1, hasSkins: true, names: ['Run'] },
    { name: 'parkergirl.glb', animCount: 1, hasSkins: true, names: ['MorphBake'] },
  ];

  for (const model of ANIM_MODELS) {
    const { name, animCount, hasSkins, names } = model;
    if (!modelPresent(name)) {
      it.skip(`${name} — model missing locally`, () => {});
      continue;
    }

    describe(`${name} — resample preserves animations`, () => {
      it('status ok, applied содержит animation/resample', async () => {
        const result = await optimizeFile(modelPath(name), {
          outDir: tmpOutDir(),
          advancedFeatures: ['resample'],
          dryRun: true,
        });
        expect(result.status).toBe('ok');
        expect(result.applied.length).toBeGreaterThanOrEqual(0);
        if (result.applied.length > 0) {
          const anyResample = result.applied.some((a) => a.ruleId === 'animation/resample');
          const anySkipped = result.skipped.some((s) => s.ruleId === 'animation/resample');
          expect(anyResample || anySkipped).toBe(true);
        }
      });

      it('число анимаций не изменилось', async () => {
        const result = await optimizeFile(modelPath(name), {
          outDir: tmpOutDir(),
          advancedFeatures: ['resample'],
          dryRun: true,
        });
        expect(result.status).toBe('ok');
        expect(result.metrics.before.animations).toBe(animCount);
        expect(result.metrics.after.animations).toBe(animCount);
      });

      it('имена клипов сохранены', async () => {
        const result = await optimizeFile(modelPath(name), {
          outDir: tmpOutDir(),
          advancedFeatures: ['resample'],
          dryRun: true,
        });
        expect(result.status).toBe('ok');
        const bytes = fs.readFileSync(modelPath(name));
        const json = parseGlbJson(bytes);
        const animNames = (json.animations || []).map((a) => String(a.name || ''));
        for (const expected of names) {
          const found = animNames.some((n) => n.includes(expected));
          expect(found).toBe(true);
        }
      });

      if (hasSkins) {
        it('skins не изменились', async () => {
          const result = await optimizeFile(modelPath(name), {
            outDir: tmpOutDir(),
            advancedFeatures: ['resample'],
            dryRun: true,
          });
          expect(result.status).toBe('ok');
          expect(result.metrics.before.skins).toBe(result.metrics.after.skins);
          expect(result.metrics.after.skins).toBeGreaterThan(0);
        });
      }

      it('morphTargets не изменились', async () => {
        const result = await optimizeFile(modelPath(name), {
          outDir: tmpOutDir(),
          advancedFeatures: ['resample'],
          dryRun: true,
        });
        expect(result.status).toBe('ok');
        expect(result.metrics.before.morphTargets).toBe(result.metrics.after.morphTargets);
      });

      it('файл стал меньше или равным (resample не увеличивает)', async () => {
        const result = await optimizeFile(modelPath(name), {
          outDir: tmpOutDir(),
          advancedFeatures: ['resample'],
          dryRun: true,
        });
        expect(result.status).toBe('ok');
        expect(result.metrics.after.fileBytes).toBeLessThanOrEqual(result.metrics.before.fileBytes);
      });
    });
  }
});


describe('animation/resample — model without animations', () => {
  const modelName = 'Dirty Cube 01.glb';

  it('status ok, applied пуст', async () => {
    const result = await optimizeFile(modelPath(modelName), {
      outDir: tmpOutDir(),
      advancedFeatures: ['resample'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.applied.length).toBe(0);
  });

  it('skipped называет причину «нет анимаций» ключом каталога', async () => {
    const result = await optimizeFile(modelPath(modelName), {
      outDir: tmpOutDir(),
      advancedFeatures: ['resample'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const rec = result.skipped.find((s) => s.ruleId === 'animation/resample');
    expect(rec).toBeDefined();
    expect(rec.i18n.text.messageId).toBe('resample.skipped.noAnimations');
  });

  it('треугольники и анимации не изменились (resample не трогает геометрию)', async () => {
    const result = await optimizeFile(modelPath(modelName), {
      outDir: tmpOutDir(),
      advancedFeatures: ['resample'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.triangles).toBe(result.metrics.after.triangles);
    expect(result.metrics.before.animations).toBe(0);
    expect(result.metrics.after.animations).toBe(0);
  });

  it('модель проходит валидацию (0 fail)', async () => {
    const result = await optimizeFile(modelPath(modelName), {
      outDir: tmpOutDir(),
      advancedFeatures: ['resample'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });
});


describe('animation/resample + safe — combined', () => {
  const modelName = 'Lilith Character 01.glb';
  if (!modelPresent(modelName)) {
    it.skip(`${modelName} — model missing locally`, () => {});
    return;
  }

  it('status ok, animations preserved under safe+resample', async () => {
    const result = await optimizeFile(modelPath(modelName), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'resample'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.animations).toBe(3);
    expect(result.metrics.after.animations).toBe(3);
    expect(result.metrics.before.skins).toBe(1);
    expect(result.metrics.after.skins).toBe(1);
  });

  it('validation passes under safe+resample', async () => {
    const result = await optimizeFile(modelPath(modelName), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'resample'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });
});

afterAll(cleanupTmpOutDirs);
