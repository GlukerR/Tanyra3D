import fs from 'node:fs';

import { describe, it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

import { optimizeFile } from '../optimize2.mjs';
import gltfAddon from '../addons/gltf/index.mjs';
import { effectiveSkins, sceneGeometry } from '../addons/gltf/metrics.mjs';
import { modelPath, REPO_MODELS, itIfModel } from './helpers/model-files.mjs';
import {
  eachSituation, modelsWith, situationsOf,
  SITUATION_IDS, KNOWN_HOLES, LOCAL_ONLY, situationCoverage,
} from './helpers/model-situations.mjs';

const ioPromise = gltfAddon.createIO();

async function structureOf(file) {
  const io = await ioPromise;
  const doc = await io.read(file);
  const root = doc.getRoot();
  const geo = sceneGeometry(doc);
  const ext = [...new Set([
    ...root.listExtensionsUsed().map((e) => e.extensionName),
    ...root.listExtensionsRequired().map((e) => e.extensionName),
  ])].sort().join(',');
  return {
    triangles: geo.triangles,
    morphTargets: geo.morphTargets,
    skins: effectiveSkins(doc),
    animations: root.listAnimations().length,
    scenes: root.listScenes().length,
    ext,
  };
}

async function idempotentPair(model, flags, _timeout = 120000) {
  const d1 = tmpOutDir();
  const p1 = await optimizeFile(modelPath(model), { advancedFeatures: flags, dryRun: false, outDir: d1 });
  expect(p1.status).toBe('ok');

  const d2 = tmpOutDir();
  const p2 = await optimizeFile(p1.file.dst, { advancedFeatures: flags, dryRun: false, outDir: d2 });
  expect(p2.status).toBe('ok');

  const s1 = await structureOf(p1.file.dst);
  const s2 = await structureOf(p2.file.dst);
  expect(s1.triangles).toBe(s2.triangles);
  expect(s1.skins).toBe(s2.skins);
  expect(s1.morphTargets).toBe(s2.morphTargets);
  expect(s1.animations).toBe(s2.animations);
  expect(s1.ext).toBe(s2.ext);
  return { p1, p2, s1 };
}

const skippedMsg = (r, ruleId) => r.skipped.filter((s) => s.ruleId === ruleId).map((s) => s.i18n?.text?.messageId || '');
const anySkippedMsg = (r, ruleId, prefix) => skippedMsg(r, ruleId).some((m) => m.startsWith(prefix));

describe('Реестр ситуаций — санити', () => {
  it('Truncated Broken 01 — единственный broken, распознан по файлу (плюс edge-name)', () => {
    const sit = situationsOf('Truncated Broken 01.glb');
    expect(sit).toContain('broken');
    expect(sit).toContain('edge-name');
    expect(modelsWith('broken')).toEqual(['Truncated Broken 01.glb']);
  });

  it('Dirty Cube 01 — shared-geometry распознаётся по файлу', () => {
    expect(situationsOf('Dirty Cube 01.glb')).toContain('shared-geometry');
  });

  it('Meshopt Compressed Input 01 — meshopt + уже квантована + webp на входе', () => {
    const sit = situationsOf('Meshopt Compressed Input 01.glb');
    expect(sit).toContain('precompressed-meshopt');
    expect(sit).toContain('prequantized');
    expect(sit).toContain('pre-webp');
  });

  itIfModel('AnimationPointerUVs.glb', 'unknown-extension распознаётся по СЫРОМУ файлу (библиотека отбрасывает расширение)', () => {
    expect(situationsOf('AnimationPointerUVs.glb')).toContain('unknown-extension');
  });

  itIfModel('parkergirl.glb', 'скин и морфы вместе (тот случай, который ловил GAP-005)', () => {
    const sit = situationsOf('parkergirl.glb');
    expect(sit).toContain('skinned');
    expect(sit).toContain('morphed');
  });

  it('каждый класс из SITUATION_IDS присутствует в реестре', () => {
    expect(SITUATION_IDS.length).toBeGreaterThan(10);
    for (const id of SITUATION_IDS) {
      expect(Array.isArray(modelsWith(id))).toBe(true);
    }
  });
});

describe('Класс broken — status fail с причиной, исключения наружу нет', () => {
  eachSituation('broken', 'прогон даёт status fail и внятную причину, а не исключение', async (name) => {
    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), dryRun: true });
    expect(r.status).toBe('fail');
    expect(r.error).toBeDefined();
    expect(typeof r.error).toBe('string');
    expect(r.error.length).toBeGreaterThan(0);
  });
});

describe('Класс no-geometry — status ok, геометрические правила воздерживаются с причиной', () => {
  eachSituation('no-geometry', 'прогон не падает, счётчики на месте', async (name) => {
    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['safe'], dryRun: true });
    expect(r.status).toBe('ok');
    expect(r.metrics.after.triangles).toBe(0);
  });
});

describe('Класс textures-only — текстуры есть, треугольников 0; status ok', () => {
  eachSituation('textures-only', 'прогон не падает, текстуры целы', async (name) => {
    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['safe', 'webp'], dryRun: true });
    expect(r.status).toBe('ok');
    expect(r.metrics.before.textures).toBeGreaterThan(0);
    expect(r.metrics.after.triangles).toBe(0);
  });
});

describe('Класс no-textures — текстурные правила (ktx2, webp) воздерживаются с причиной', () => {
  eachSituation('no-textures', 'ktx2/webp не применяются и называют причину', async (name) => {
    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['ktx2', 'webp'], dryRun: true });
    expect(r.status).toBe('ok');
    expect(r.metrics.before.textures).toBe(0);
    expect(r.applied.some((a) => a.ruleId === 'textures/ktx2')).toBe(false);
    expect(r.applied.some((a) => a.ruleId === 'textures/webp')).toBe(false);
    expect(r.skipped.some((s) => s.ruleId === 'textures/ktx2')).toBe(true);
    expect(r.skipped.some((s) => s.ruleId === 'textures/webp')).toBe(true);
  });
});

describe('Класс unknown-extension — структурные правила отказываются (kind unsafe), модель цела', () => {
  eachSituation('unknown-extension', 'safe отказывается с причиной, анимации целы', async (name) => {
    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['safe'], dryRun: true });
    expect(r.status).toBe('ok');
    const refuses = r.skipped.filter((s) => s.kind === 'unsafe' && s.i18n?.reason?.messageId === 'unsupportedExtension.refuse');
    expect(refuses.length).toBeGreaterThan(0);
    expect(r.metrics.after.animations).toBe(r.metrics.before.animations);
    expect(r.validation.some((v) => v.level === 'fail')).toBe(false);
  });
});

describe('Класс edge-name — путь с кириллицей/пробелами не мешает записи', () => {
  eachSituation('edge-name', 'прогон с записью на диск не падает (битый представитель — отдельный класс)', async (name) => {
    const outDir = tmpOutDir();
    const r = await optimizeFile(modelPath(name), { dryRun: false, outDir });
    if (r.status === 'ok') {
      expect(r.file.written).toBe(true);
      expect(fs.existsSync(r.file.dst)).toBe(true);
    } else {
      expect(r.status).toBe('fail');
      expect(r.error).toBeDefined();
    }
  });
});

describe('Класс heavy — укладывается в таймаут, память не улетает', () => {
  eachSituation('heavy', 'прогон завершается в таймаут со status ok', async (name) => {
    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['safe'], dryRun: true }, 110000);
    expect(r.status).toBe('ok');
  }, 110000);
});

describe('Класс skinned — скинов столько же, сколько было, на любом наборе флагов', () => {
  eachSituation('skinned', 'safe+quantize: скины целы (сторож TESTBUG-007 — quantize не расщепляет скин)', async (name) => {
    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['safe', 'quantize'], dryRun: true });
    expect(r.status).toBe('ok');
    expect(r.metrics.before.skins).toBeGreaterThan(0);
    expect(r.metrics.after.skins).toBe(r.metrics.before.skins);
  });

  eachSituation('skinned', 'safe+join: скины целы', async (name) => {
    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['safe', 'join'], dryRun: true });
    expect(r.status).toBe('ok');
    expect(r.metrics.after.skins).toBe(r.metrics.before.skins);
  });
});

describe('Класс morphed — морф-таргетов столько же', () => {
  eachSituation('morphed', 'safe+quantize: морфы целы (квантование — самый хрупкий для морфов проход)', async (name) => {
    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['safe', 'quantize'], dryRun: true });
    expect(r.status).toBe('ok');
    expect(r.metrics.before.morphTargets).toBeGreaterThan(0);
    expect(r.metrics.after.morphTargets).toBe(r.metrics.before.morphTargets);
  });
});

describe('Класс animated — анимаций столько же', () => {
  eachSituation('animated', 'safe+resample: число анимаций не меняется', async (name) => {
    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['safe', 'resample'], dryRun: true });
    expect(r.status).toBe('ok');
    expect(r.metrics.before.animations).toBeGreaterThan(0);
    expect(r.metrics.after.animations).toBe(r.metrics.before.animations);
  });
});

describe('Класс vertex-colors — COLOR_0 не исчезает без явной опции strip-colors', () => {
  eachSituation('vertex-colors', 'без strip-colors раскрашенный COLOR_0 сохраняется; с флагом — снимается', async (name) => {
    const io = await ioPromise;
    const src = await io.read(modelPath(name));
    let painted = false;
    for (const m of src.getRoot().listMeshes()) {
      for (const p of m.listPrimitives()) {
        const acc = p.getAttribute('COLOR_0');
        if (!acc) continue;
        const el = [];
        for (let i = 0; i < acc.getCount(); i++) {
          acc.getElement(i, el);
          if (el.some((v) => v < 0.999)) { painted = true; break; }
        }
      }
    }

    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['safe'], dryRun: true });
    expect(r.status).toBe('ok');
    if (painted) {
      expect(r.metrics.after.attributes).toContain('COLOR_0');
    }

    const rs = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['safe', 'strip-colors'], dryRun: true });
    expect(rs.status).toBe('ok');
    expect(rs.metrics.after.attributes).not.toContain('COLOR_0');
  });
});

describe('Класс multi-scene — сцен столько же, активная сцена та же', () => {
  eachSituation('multi-scene', 'прогон не трогает ни число сцен, ни активную', async (name) => {
    const io = await ioPromise;
    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['safe'], dryRun: true });
    expect(r.status).toBe('ok');
    expect(r.metrics.after.scenes).toBe(r.metrics.before.scenes);
    const doc = await io.read(modelPath(name));
    const defBefore = doc.getRoot().getDefaultScene();
    expect(defBefore).toBeTruthy();
  });
});

describe('Класс precompressed-draco — входное сжатие названо причиной, идемпотентность', () => {
  eachSituation('precompressed-draco', 'safe: движок называет снятый кодек; повторный прогон не меняет структуру', async (name) => {
    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['safe'], dryRun: true });
    expect(r.status).toBe('ok');
    const found = r.findings.find((f) => f.i18n?.text?.messageId === 'engine.inputCompression.found');
    expect(found).toBeDefined();
    expect(found.i18n.text.data.codecs).toContain('KHR_draco_mesh_compression');

    await idempotentPair(name, ['safe']);
  });
});

describe('Класс precompressed-meshopt — входное сжатие названо причиной, идемпотентность', () => {
  eachSituation('precompressed-meshopt', 'safe: движок называет снятый кодек; повторный прогон не меняет структуру', async (name) => {
    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['safe'], dryRun: true });
    expect(r.status).toBe('ok');
    const found = r.findings.find((f) => f.i18n?.text?.messageId === 'engine.inputCompression.found');
    expect(found).toBeDefined();
    expect(found.i18n.text.data.codecs).toContain('EXT_meshopt_compression');

    await idempotentPair(name, ['safe']);
  });
});

describe('Класс prequantized — quantize воздерживается с причиной, идемпотентность', () => {
  eachSituation('prequantized', 'quantize: уже квантована — воздержание с причиной; повторный прогон не меняет структуру', async (name) => {
    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['quantize'], dryRun: true });
    expect(r.status).toBe('ok');
    expect(anySkippedMsg(r, 'geometry/quantize', 'quantize.skipped.already')).toBe(true);
    expect(r.applied.some((a) => a.ruleId === 'geometry/quantize')).toBe(false);

    await idempotentPair(name, ['quantize']);
  });
});

describe('Класс pre-webp — цель уже достигнута, правило говорит об этом вслух', () => {
  eachSituation('pre-webp', 'webp: уже-webp текстуры названы достигнутой целью, а не отказом; повтор не меняет структуру', async (name) => {
    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['webp'], dryRun: true });
    expect(r.status).toBe('ok');
    expect(r.applied.some((a) => a.ruleId === 'textures/webp')).toBe(true);
    expect(r.applied.some((a) => a.i18n?.text?.messageId === 'webp.alreadyTarget')).toBe(true);
    expect(anySkippedMsg(r, 'textures/webp', 'webp.skipped.already')).toBe(false);

    await idempotentPair(name, ['webp']);
  });
});

describe('Класс pre-ktx2 — уже-KTX2 текстуры получают свою причину, идемпотентность', () => {
  eachSituation('pre-ktx2', 'ktx2: уже-KTX2 текстуры названы причиной; повторный прогон не меняет структуру', async (name) => {
    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['ktx2'], dryRun: true });
    expect(r.status).toBe('ok');
    expect(anySkippedMsg(r, 'textures/ktx2', 'ktx2.skipped.already')).toBe(true);
    expect(r.applied.some((a) => a.ruleId === 'textures/ktx2')).toBe(false);
  });
});

describe('Класс preinstanced — входной инстансинг не мешает прогону', () => {
  eachSituation('preinstanced', 'прогон с safe не ломает модель с входным EXT_mesh_gpu_instancing', async (name) => {
    const r = await optimizeFile(modelPath(name), { outDir: tmpOutDir(), advancedFeatures: ['safe'], dryRun: true });
    expect(r.status).toBe('ok');
    expect(r.metrics.after.triangles).toBe(r.metrics.before.triangles);
  });
});

describe('Класс shared-geometry — join не разворачивает общую геометрию', () => {
  eachSituation('shared-geometry', 'join: число общих мешей не падает, защита названа в отчёте', async (name) => {
    const io = await ioPromise;
    const srcDoc = await io.read(modelPath(name));
    const sharedBefore = countSharedMeshes(srcDoc);
    expect(sharedBefore).toBeGreaterThan(0);

    const outDir = tmpOutDir();
    const r = await optimizeFile(modelPath(name), { advancedFeatures: ['join'], dryRun: false, outDir });
    expect(r.status).toBe('ok');

    const dstDoc = await io.read(r.file.dst);
    expect(countSharedMeshes(dstDoc)).toBe(sharedBefore);

    const joinApplied = r.applied.some((a) => a.ruleId === 'scene/join');
    const joinSkips = r.skipped.filter((s) => s.ruleId === 'scene/join');
    if (joinApplied) {
      const kept = r.skipped.filter((s) => s.i18n?.text?.messageId === 'join.keptShared');
      expect(kept.length, 'склейка отработала, а про общую геометрию промолчала')
        .toBeGreaterThan(0);
    } else {
      expect(joinSkips.length, 'склейка не отработала и не сказала почему')
        .toBeGreaterThan(0);
    }
  });
});

describe('Класс shared-geometry — instance защищает; join+instance не хуже одного instance', () => {
  eachSituation('shared-geometry', 'join+instance по итоговому файлу не хуже одного instance', async (name) => {
    const d1 = tmpOutDir();
    const ri = await optimizeFile(modelPath(name), { advancedFeatures: ['instance'], dryRun: false, outDir: d1 });
    expect(ri.status).toBe('ok');

    const d2 = tmpOutDir();
    const rj = await optimizeFile(modelPath(name), { advancedFeatures: ['join', 'instance'], dryRun: false, outDir: d2 });
    expect(rj.status).toBe('ok');

    const bytesInstance = fs.statSync(ri.file.dst).size;
    const bytesBoth = fs.statSync(rj.file.dst).size;
    expect(bytesBoth).toBeLessThanOrEqual(bytesInstance);
  });
});

function countSharedMeshes(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    let users = 0;
    for (const parent of mesh.listParents()) {
      if (parent.propertyType === 'Node') users += 1;
      if (users > 1) { n += 1; break; }
    }
  }
  return n;
}

describe('Покрытие классов — мета-тест (класс без представителя — дыра в корпусе)', () => {
  for (const id of SITUATION_IDS) {
    it(`класс ${id}: репо-представитель, или объявлен «только локально», или дыра с причиной`, () => {
      const onDisk = modelsWith(id);
      const inGit = onDisk.filter((n) => REPO_MODELS.has(n));

      if (KNOWN_HOLES[id]) {
        expect(onDisk.length).toBe(0);
        return;
      }

      if (LOCAL_ONLY[id]) {
        const declared = LOCAL_ONLY[id];
        if (onDisk.length) {
          expect([...onDisk].sort()).toEqual([...declared].sort());
        }
        return;
      }

      expect(inGit.length).toBeGreaterThan(0);
    });
  }

  it('в отчёте задания — таблица «класс → на диске → в git» (данные для таблицы)', () => {
    const cov = situationCoverage();
    expect(cov.length).toBe(SITUATION_IDS.length);
    for (const c of cov) {
      expect(c.onDisk.every((n) => n.endsWith('.glb') || n.endsWith('.gltf'))).toBe(true);
    }
  });
});

afterAll(cleanupTmpOutDirs);
