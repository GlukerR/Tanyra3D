// Write Policy tests — проверка поведения при записи .glb файла.
//
// Контекст (задание 2026-07-30): core/engine.mjs теперь пишет файл даже при
// провале проверки целостности. Единственная причина не писать — dryRun:true.
//
// Все тесты используют только REPO-модели из tests/helpers/model-files.mjs,
// доступные после `git clone`.
//
// Ловушка 1: провал проверки целостности при записанном файле воспроизводится
// не на всех моделях и зависит от внешних кодировщиков. Целенаправленный
// перебор не проводится — три базовых пункта работы важнее.

import { it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

import { optimizeFile } from '../optimize2.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  REPO_MODELS,
  modelPath,
  describeIfModels,
} from './helpers/model-files.mjs';

// ========================================================================
// Работа 1, пункт 1: dryRun:true → written === false
// ========================================================================

describeIfModels(
  [...REPO_MODELS].filter((m) => m !== 'Truncated Broken 01.glb'),
  'Write policy — dryRun:true never writes',
  () => {
    for (const modelName of [...REPO_MODELS].filter((m) => m !== 'Truncated Broken 01.glb')) {
      it(`${modelName} — dryRun:true → written === false`, async () => {
        const result = await optimizeFile(modelPath(modelName), {
          outDir: tmpOutDir(),
          advancedFeatures: [],
          dryRun: true,
        });
        expect(result.status).toBe('ok');
        expect(result.file.written).toBe(false);

        // Если dst заполнен — убедимся, что файла реально нет
        if (result.file.dst) {
          expect(fs.existsSync(result.file.dst)).toBe(false);
        }
      });
    }
  },
);

// ========================================================================
// Работа 1, пункт 2: битый вход (Truncated Broken 01.glb) с dryRun:false
//   → status: 'fail', result.error определён, written === false, файла нет
// ========================================================================

describeIfModels(
  ['Truncated Broken 01.glb'],
  'Write policy — corrupted input does not write',
  () => {
    it('Truncated Broken 01.glb with dryRun:false → status fail, no file written', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-policy-'));
      try {
        const result = await optimizeFile(modelPath('Truncated Broken 01.glb'), {
          advancedFeatures: [],
          dryRun: false,
          force: true,
          outDir: tmpDir,
        });
        expect(result.status).toBe('fail');
        expect(result.error).toBeDefined();
        expect(result.error.length).toBeGreaterThan(5);
        expect(result.file.written).toBe(false);

        // Убедимся, что файла на диске нет
        if (result.file.dst) {
          expect(fs.existsSync(result.file.dst)).toBe(false);
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  },
);

// ========================================================================
// Работа 1, пункт 3: обычный прогон REPO-модели с dryRun:false
//   → status: 'ok', written === true, файл есть на диске
// ========================================================================

describeIfModels(
  ['Dirty Cube 01.glb'],
  'Write policy — normal write produces file',
  () => {
    it('Dirty Cube 01.glb with dryRun:false → status ok, file written', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-policy-'));
      try {
        const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
          advancedFeatures: [],
          dryRun: false,
          force: true,
          outDir: tmpDir,
        });
        expect(result.status).toBe('ok');
        expect(result.file.written).toBe(true);
        expect(result.file.dst).toBeTruthy();

        const exists = fs.existsSync(result.file.dst);
        expect(exists).toBe(true);

        // Файл должен быть непустым .glb
        const stat = fs.statSync(result.file.dst);
        expect(stat.size).toBeGreaterThan(0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  },
);

// ========================================================================
// Проверка на нескольких REPO-моделях: dryRun:false → файл пишется
// ========================================================================

describeIfModels(
  ['Dirty Cube 01.glb', 'Morph Cube 01.glb', 'Vertex Colors 01.glb'],
  'Write policy — multiple REPO models write correctly',
  () => {
    for (const modelName of ['Dirty Cube 01.glb', 'Morph Cube 01.glb', 'Vertex Colors 01.glb']) {
      it(`${modelName} — dryRun:false → written === true`, async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-policy-'));
        try {
          const result = await optimizeFile(modelPath(modelName), {
            advancedFeatures: [],
            dryRun: false,
            force: true,
            outDir: tmpDir,
          });
          expect(result.status).toBe('ok');
          expect(result.file.written).toBe(true);
          expect(fs.existsSync(result.file.dst)).toBe(true);
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      });
    }
  },
);

afterAll(cleanupTmpOutDirs);
