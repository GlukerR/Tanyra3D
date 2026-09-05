import { describe, it, expect, afterAll } from 'vitest';

import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';
import { optimizeFile } from '../optimize2.mjs';
import { localizeResult } from '../core/i18n.mjs';
import { RULES } from '../addons/gltf/rules.mjs';
import { modelPath, isPresent } from './helpers/model-files.mjs';

const RULE_ID = 'scene/morph-targets';
const STILL_MODEL = 'Morph Cube 01.glb';
const ANIMATED_MODEL = 'parkergirl.glb';
const PLAIN_MODEL = 'Dirty Cube 01.glb';

afterAll(cleanupTmpOutDirs);

const runOn = (model) => optimizeFile(modelPath(model), {
  advancedFeatures: ['safe'],
  outDir: tmpOutDir(),
});
const linesOf = (result, locale) =>
  (localizeResult(result, locale).findings || []).filter((e) => e.ruleId === RULE_ID);


describe('запасные формы — наблюдение в отчёте', () => {
  it('правило существует и НЕ умеет чинить', () => {
    const rule = RULES.find((r) => r.meta.id === RULE_ID);
    expect(rule, `правило ${RULE_ID} исчезло из списка`).toBeTruthy();
    expect(rule.canFix, 'у правила появилась починка — оно перестало быть наблюдением').toBeUndefined();
    expect(rule.fix, 'у правила появилась починка — оно перестало быть наблюдением').toBeUndefined();
    expect(rule.meta.severity).toBe('info');
    expect(rule.meta.dataLoss).toBe('none');
    expect(rule.meta.reversible).toBe(true);
  });

  it('правило не зависит ни от одной галочки', () => {
    const rule = RULES.find((r) => r.meta.id === RULE_ID);
    expect(rule.meta.enabled({}), 'без галочек правило молчит').toBe(true);
    expect(rule.meta.enabled({ safe: true })).toBe(true);
  });
});


describe.skipIf(!isPresent(STILL_MODEL))('модель с формами, которые никто не двигает', () => {
  it('строка ровно одна, и она говорит, что анимации нет', async () => {
    const r = await runOn(STILL_MODEL);
    expect(r.status).toBe('ok');

    for (const locale of ['ru', 'en']) {
      const lines = linesOf(r, locale);
      expect(lines.length, `[${locale}] строк не одна`).toBe(1);
      expect(lines[0].i18n?.text?.messageId,
        `[${locale}] выбрана не та строка: формы не анимированы`).toBe('morph.found.still');
    }

    const data = linesOf(r, 'ru')[0].i18n.text.data;
    expect(data.meshes).toBe(1);
    expect(data.forms).toBe(2);
  }, 120_000);

  it('строка переживает смену языка без пересборки (Правило 8)', async () => {
    const r = await runOn(STILL_MODEL);
    const ru = linesOf(r, 'ru')[0].text;
    const en = linesOf(r, 'en')[0].text;
    expect(ru).not.toBe(en);
    expect(ru).toMatch(/форм/i);
    expect(en).toMatch(/shape/i);
    for (const text of [ru, en]) {
      expect(text).not.toMatch(/morph target|POSITION|weights|primitive/i);
    }
  }, 120_000);
});

describe.skipIf(!isPresent(ANIMATED_MODEL))('модель с формами, которые двигает анимация', () => {
  it('строка одна на 456 целей и говорит про проигрывание', async () => {
    const r = await runOn(ANIMATED_MODEL);
    expect(r.status).toBe('ok');

    for (const locale of ['ru', 'en']) {
      const lines = linesOf(r, locale);
      expect(lines.length, `[${locale}] строк не одна`).toBe(1);
      expect(lines[0].i18n?.text?.messageId,
        `[${locale}] выбрана не та строка: формы анимированы`).toBe('morph.found.animated');
    }

    const data = linesOf(r, 'ru')[0].i18n.text.data;
    expect(data.meshes, 'частей с формами должно быть 8').toBe(8);
    expect(data.forms).toBeGreaterThan(1);
    expect(data.forms, 'в строку попала сумма по файлу, а не максимум').toBeLessThan(456);
  }, 180_000);
});

describe.skipIf(!isPresent(PLAIN_MODEL))('модель без запасных форм', () => {
  it('строки нет вовсе — не выдумываем находку на пустом месте', async () => {
    const r = await runOn(PLAIN_MODEL);
    expect(r.status).toBe('ok');
    expect(linesOf(r, 'ru').length).toBe(0);
    expect(linesOf(r, 'en').length).toBe(0);
  }, 120_000);
});


const STILL_ANIMATED_MODEL = 'Still Morphs 01.glb';
const ANIMATED_FIXTURE = 'Animated Morphs 01.glb';

describe.skipIf(!isPresent(STILL_ANIMATED_MODEL))('модель: клип есть, формы стоят', () => {
  it('отчёт говорит, что формы не двигаются, хотя анимация в файле есть', async () => {
    const r = await runOn(STILL_ANIMATED_MODEL);
    expect(r.status).toBe('ok');
    for (const locale of ['ru', 'en']) {
      const lines = linesOf(r, locale);
      expect(lines.length, `[${locale}] строк не одна`).toBe(1);
      expect(lines[0].i18n?.text?.messageId,
        `[${locale}] клип на узле принят за анимацию форм`).toBe('morph.found.still');
    }
  }, 120_000);
});

describe.skipIf(!isPresent(ANIMATED_FIXTURE))('модель: клип двигает веса форм', () => {
  it('отчёт зовёт включить проигрывание', async () => {
    const r = await runOn(ANIMATED_FIXTURE);
    expect(r.status).toBe('ok');
    for (const locale of ['ru', 'en']) {
      const lines = linesOf(r, locale);
      expect(lines.length, `[${locale}] строк не одна`).toBe(1);
      expect(lines[0].i18n?.text?.messageId).toBe('morph.found.animated');
    }
  }, 120_000);
});

describe('запасные формы — анимация есть, но не про формы', () => {
  async function docWith(targetPath) {
    const { Document } = await import('@gltf-transform/core');
    const doc = new Document();
    const buf = doc.createBuffer();

    const position = doc.createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
      .setBuffer(buf);
    const shifted = doc.createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0]))
      .setBuffer(buf);

    const target = doc.createPrimitiveTarget().setAttribute('POSITION', shifted);
    const prim = doc.createPrimitive().setAttribute('POSITION', position).addTarget(target);
    const mesh = doc.createMesh('Face').addPrimitive(prim);
    const node = doc.createNode('FaceNode').setMesh(mesh);
    doc.createScene().addChild(node);

    const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array([0, 1])).setBuffer(buf);
    const output = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 0, 1, 0])).setBuffer(buf);
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output);
    const channel = doc.createAnimationChannel().setTargetNode(node).setTargetPath(targetPath).setSampler(sampler);
    doc.createAnimation('Move').addSampler(sampler).addChannel(channel);

    return doc;
  }

  const analyze = (document) => {
    const rule = RULES.find((r) => r.meta.id === RULE_ID);
    return rule.analyze({ document });
  };

  it('клип двигает УЗЕЛ, а не формы — говорим, что формы стоят', async () => {
    const out = analyze(await docWith('translation'));
    expect(out.length).toBe(1);
    expect(out[0].messageId, 'клип на узле принят за анимацию форм').toBe('morph.found.still');
  });

  it('клип двигает ВЕСА — говорим, что формы анимированы', async () => {
    const out = analyze(await docWith('weights'));
    expect(out.length).toBe(1);
    expect(out[0].messageId).toBe('morph.found.animated');
    expect(out[0].data).toEqual({ meshes: 1, forms: 1 });
  });
});
