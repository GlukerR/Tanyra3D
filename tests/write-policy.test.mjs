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

        if (result.file.dst) {
          expect(fs.existsSync(result.file.dst)).toBe(false);
        }
      });
    }
  },
);


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

        if (result.file.dst) {
          expect(fs.existsSync(result.file.dst)).toBe(false);
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  },
);


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

        const stat = fs.statSync(result.file.dst);
        expect(stat.size).toBeGreaterThan(0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  },
);


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
