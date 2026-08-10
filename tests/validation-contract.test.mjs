// tests/validation-contract.test.mjs — «не прошло проверку» и «не доработало» это разное.
//
// Ревью 2026-08-10 (P1.4): комментарии утверждали, что при провале финальной проверки
// файл не записывается, а код его писал. Расхождение жило с 2026-07-30 — с того дня,
// когда Александр решил, что отказ должен быть громким, а не запирающим: запись
// осталась, чтобы человек мог посмотреть, насколько всё плохо, и решить сам.
//
// Хуже комментария был вывод CLI: `validation failed — .glb NOT written`. Файл лежал
// на диске, а человек его не искал.
//
// Здесь закрепляется сам договор: у двух состояний разные признаки, и по ним всегда
// можно отличить одно от другого.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { runOptimize } from '../core/engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Мок-аддон на выдуманном формате: настоящая модель для этого не нужна, а нужен
// управляемый исход проверки.
function mockAddon({ failValidation = false, throwOnLoad = false } = {}) {
  return {
    formats: ['mock'],
    rules: [],
    BASELINE_METRICS: [],
    outputName: (src) => path.basename(src).replace(/\.[^.]+$/, '.mock'),
    normalizeOpts: (opts = {}) => ({
      outDir: String(opts.outDir || '.'),
      force: !!opts.force,
      dryRun: !!opts.dryRun,
      onProgress: null,
      log: () => {},
      locale: 'ru',
      codec: 'mock',
      advancedFeatures: [],
    }),
    createIO: async () => ({}),
    load: async () => {
      if (throwOnLoad) throw new Error('модель не читается');
      return { kind: 'mock-doc' };
    },
    writeBytes: async () => new Uint8Array([1, 2, 3]),
    readBytes: async () => ({ kind: 'mock-doc' }),
    collectMetrics: () => ({
      fileBytes: 0, drawCalls: 0, triangles: 0, vertices: 0,
      meshes: 0, materials: 0, textures: 0, nodes: 0, scenes: 0,
      animations: 0, skins: 0, gpuBytes: 0, textureBytes: 0,
    }),
    baselineMetrics: () => ({}),
    stripInputCompression: () => [],
    validate: ({ result }) => {
      result.validation.push(failValidation
        ? { level: 'fail', text: 'mock-validate: расхождение' }
        : { level: 'pass', text: 'mock-validate: ok' });
    },
    writeReport: ({ name, opts }) => {
      const reportName = name.replace(/\.mock$/, '.report.md');
      fs.writeFileSync(path.join(opts.outDir, reportName), '# mock report\n', 'utf8');
      return reportName;
    },
  };
}

async function run(addon, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-contract-'));
  const src = path.join(tmp, 'scene.mock');
  const outDir = path.join(tmp, 'out');
  fs.writeFileSync(src, 'mock-format-bytes', 'utf8');
  return runOptimize(addon, src, { outDir, force: true, ...opts });
}

describe('провал проверки целостности', () => {
  it('даёт status fail — но файл на диске есть', async () => {
    const r = await run(mockAddon({ failValidation: true }));
    expect(r.status).toBe('fail');
    expect(r.file.written, 'файл не записан — отказ стал запирающим').toBe(true);
    expect(fs.existsSync(r.file.dst), `нет файла ${r.file.dst}`).toBe(true);
  });

  it('и отличим от «прогон не доработал» по полю error', async () => {
    const failed = await run(mockAddon({ failValidation: true }));
    expect(failed.error, 'провал проверки не должен выглядеть как поломка прогона').toBeUndefined();
    expect(failed.validation.some((v) => v.level === 'fail')).toBe(true);

    const broken = await run(mockAddon({ throwOnLoad: true }));
    expect(broken.status).toBe('fail');
    expect(broken.error, 'поломка прогона обязана назвать причину').toBeTruthy();
    expect(broken.file.written, 'при поломке файла быть не должно').toBe(false);
  });

  it('контроль: удачный прогон — ok, файл есть, error пуст', async () => {
    const r = await run(mockAddon());
    expect(r.status).toBe('ok');
    expect(r.file.written).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('единственная причина не писать — пробный прогон', async () => {
    const r = await run(mockAddon({ failValidation: true }), { dryRun: true });
    expect(r.file.written).toBe(false);
    expect(fs.existsSync(r.file.dst)).toBe(false);
  });
});

describe('никто не обещает человеку того, чего нет', () => {
  it('CLI не сообщает «файл не записан», когда он записан', () => {
    const src = fs.readFileSync(path.join(ROOT, 'optimize2.mjs'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    // Утверждение «NOT written» допустимо только там, где оно зависит от file.written.
    for (const line of src.split('\n')) {
      if (!/NOT written/.test(line)) continue;
      expect(
        /dryRun|file\.written/.test(line),
        `безусловное «NOT written»: ${line.trim()}`,
      ).toBe(true);
    }
  });

  it('комментарии аддона не утверждают обратного коду', () => {
    const src = fs.readFileSync(path.join(ROOT, 'addons', 'gltf', 'index.mjs'), 'utf8');
    expect(src).not.toMatch(/движок не записывает \.glb/);
  });
});
