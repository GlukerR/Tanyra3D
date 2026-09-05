import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { optimizeFile } from '../optimize2.mjs';
import { REPO_MODELS, modelPath, isPresent } from './helpers/model-files.mjs';

const validator = await import('gltf-validator');

const FLAG_SETS = [
  [],
  ['safe'],
  ['safe', 'join'],
  ['safe', 'instance'],
  ['safe', 'meshopt'],
  ['safe', 'draco'],
  ['safe', 'quantize'],
  ['safe', 'join', 'instance'],
];

const KNOWN_BROKEN = new Map([]);

const MODELS = [...REPO_MODELS];

async function issues(bytes) {
  const res = await validator.validateBytes(new Uint8Array(bytes));
  const all = res.issues.messages || [];
  return {
    errors: all.filter((m) => m.severity === 0),
    warnings: all.filter((m) => m.severity === 1),
  };
}

const codesOf = (list) => new Set(list.map((m) => m.code));

async function run(model, flags) {
  const src = modelPath(model);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validator-net-'));
  try {
    const result = await optimizeFile(src, {
      outDir, force: true, locale: 'ru', advancedFeatures: flags,
    });
    return { result, outDir };
  } catch (e) {
    fs.rmSync(outDir, { recursive: true, force: true });
    throw e;
  }
}

describe('сеть по валидатору — наша обработка не добавляет замечаний', () => {
  for (const model of MODELS) {
    for (const flags of FLAG_SETS) {
      const label = `${model} [${flags.join(',') || 'passthrough'}]`;
      const body = async () => {
        const before = await issues(fs.readFileSync(modelPath(model)));
        const { result, outDir } = await run(model, flags);
        try {
          if (!result.file.written || !result.file.dst) return;

          const after = await issues(fs.readFileSync(result.file.dst));
          const wasErr = codesOf(before.errors);
          const wasWarn = codesOf(before.warnings);

          const newErrors = [...codesOf(after.errors)].filter((c) => !wasErr.has(c));
          expect(
            newErrors,
            `появились ОШИБКИ, которых во входном файле не было: ${newErrors.join(', ')}. `
              + 'Это наша порча файла, а не дефект модели.',
          ).toEqual([]);

          const newWarnings = [...codesOf(after.warnings)].filter((c) => !wasWarn.has(c));
          expect(
            newWarnings,
            `появились предупреждения, которых во входном файле не было: ${newWarnings.join(', ')}`,
          ).toEqual([]);
        } finally {
          fs.rmSync(outDir, { recursive: true, force: true });
        }
      };
      const known = flags.length ? KNOWN_BROKEN.get(model) : null;
      if (known) it.skip(`${label} [известный дефект ${known}, закреплён в bugs-found]`, () => {}, 120_000);
      else if (isPresent(model)) it(label, body, 120_000);
      else it.skip(`${label} [skipped: ${model} missing locally]`, () => {}, 120_000);
    }
  }
});


describe('вырожденные записи сериализатора', () => {
  const CASES = ['Texture Only 01.glb', 'Empty Nodes 01.glb', 'Two Scenes 01.glb', 'Pre KTX2 01.glb'];

  for (const model of CASES) {
    const body = async () => {
      const { result, outDir } = await run(model, ['safe', 'join']);
      try {
        expect(result.file.written).toBe(true);
        const glb = fs.readFileSync(result.file.dst);
        const jsonLen = glb.readUInt32LE(12);
        const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));

        for (const scene of json.scenes || []) {
          expect(scene.nodes, `сцена "${scene.name || '—'}" пишется с пустым nodes`).not.toEqual([]);
        }
        for (const buffer of json.buffers || []) {
          expect(buffer.byteLength, 'запись буфера без byteLength').toBeTypeOf('number');
        }

        expect(glb.readUInt32LE(8), 'длина в заголовке GLB разошлась с размером файла').toBe(glb.length);
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    };
    if (isPresent(model)) it(`${model} — join не оставляет пустых записей`, body, 120_000);
    else it.skip(`${model} [skipped: missing locally]`, () => {}, 120_000);
  }
});
