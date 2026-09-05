import { describe, it, expect } from 'vitest';

import { readSource } from './helpers/source-files.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planFor, listPlatforms, listEngines, getAvailableExtensions,
  enginesForPlatform, platformsForEngine, narrowToPlatform, explainResult,
} from '../assistant.mjs';
import { listRules } from '../optimize2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES_DIR = path.join(ROOT, 'profiles');
const ENGINES_DIR = path.join(ROOT, 'engines');

const profileFiles = fs.readdirSync(PROFILES_DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'));
const profiles = profileFiles.map((f) => ({
  file: f,
  data: JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8')),
}));

describe('Движок и площадка — разные оси (ARCHITECTURE.md §4g)', () => {
  it('профилей вообще нашлось — иначе тест проверяет пустоту', () => {
    expect(profiles.length).toBeGreaterThan(0);
  });

  it('движок площадки — либо названный явно, либо не названный вовсе; выдумок нет', () => {
    const выдуманные = [];
    for (const { file, data } of profiles) {
      if (data.engine === undefined || data.engine === null) continue;
      if (typeof data.engine !== 'string' || !data.engine.trim()) {
        выдуманные.push(`${file}: поле "engine" есть, но пустое — это ни то ни сё`);
      }
    }
    expect(выдуманные, выдуманные.join('\n')).toEqual([]);
  });

  it('хотя бы одна площадка движок ВСЁ ЖЕ называет — иначе ось выродилась', () => {
    const называют = profiles.filter((p) => p.data.engine).map((p) => p.file);
    expect(
      называют.length,
      'ни одна площадка не называет движок. Хотя бы одна витрина с фиксированным '
        + 'просмотрщиком должна оставаться, иначе ось «движок» ни к чему не привязана.',
    ).toBeGreaterThan(0);
  });

  it('факты правил не вернулись в профили', () => {
    const нарушения = [];
    for (const { file, data } of profiles) {
      for (const ext of data.availableExtensions || []) {
        for (const поле of ['reversible', 'dataLoss']) {
          if (поле in ext) нарушения.push(`${file} → ${ext.id}.${поле}`);
        }
      }
    }
    expect(
      нарушения,
      `эти факты принадлежат правилу, а не площадке: ${нарушения.join(', ')}. `
        + 'Они уже есть в addons/gltf/rules.mjs; вторая копия разойдётся молча.',
    ).toEqual([]);
  });

  it('правила по-прежнему остаются единственным источником этих фактов', () => {
    const rules = listRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(typeof rule.reversible, `${rule.id}: нет reversible`).toBe('boolean');
      expect(['none', 'minor', 'significant'], `${rule.id}: странный dataLoss`).toContain(rule.dataLoss);
    }
  });

  it('план отдаёт движок вместе с площадкой', () => {
    for (const { file, data } of profiles) {
      const plan = planFor(data.id);
      expect(plan.engine, `${file}: planFor() не назвал движок`).toBeTruthy();
      if (data.engine) {
        expect(plan.engine, `${file}: движок плана разошёлся с профилем`).toBe(data.engine);
      }
    }
  });

  it('без своего движка план идёт за выбором человека, с движком — за собой', () => {
    for (const { data: eng } of engineData) {
      expect(planFor('', 'ru', eng.id).engine, `прочерк не пошёл за движком ${eng.id}`).toBe(eng.id);
    }

    for (const { file, data } of profiles.filter((p) => p.data.engine)) {
      const чужой = engineData.map((e) => e.data.id).find((id) => id !== data.engine);
      if (!чужой) continue;
      expect(planFor(data.id, 'ru', чужой).engine, `${file}: витрина уступила чужому движку`)
        .toBe(data.engine);
    }

    for (const { file, data } of profiles.filter((p) => !p.data.engine)) {
      for (const { data: eng } of engineData) {
        expect(planFor(data.id, 'ru', eng.id).engine, `${file}: не пошла за ${eng.id}`).toBe(eng.id);
      }
    }
  });

  it('движок площадки — существующий файл, а не случайная строка', () => {
    const нет = [...new Set(profiles.map((p) => p.data.engine).filter(Boolean))]
      .filter((id) => !fs.existsSync(path.join(ENGINES_DIR, `${id}.json`)));
    expect(
      нет,
      `площадки называют движки, которых нет в engines/: ${нет.join(', ')}. `
        + 'Ненайденный движок означает пустой список расширений и вьюпорт по умолчанию — '
        + 'молча и незаметно.',
    ).toEqual([]);
  });

  it('listPlatforms по-прежнему отдаёт площадки, а не движки', () => {
    const ids = listPlatforms().map((p) => p.id);
    expect(ids.length).toBeGreaterThan(0);
    const включённых = profiles.filter((p) => p.data.enabled !== false).length;
    expect(ids.length).toBe(включённых);
  });
});


const engineFiles = fs.existsSync(ENGINES_DIR)
  ? fs.readdirSync(ENGINES_DIR).filter((f) => f.endsWith('.json'))
  : [];
const engineData = engineFiles.map((f) => ({
  file: f,
  data: JSON.parse(fs.readFileSync(path.join(ENGINES_DIR, f), 'utf8')),
}));

describe('Движки — отдельная таблица (ARCHITECTURE.md §4g)', () => {
  it('папка движков существует и не пуста', () => {
    expect(engineData.length, 'engines/ пуста: список расширений брать неоткуда').toBeGreaterThan(0);
  });

  it('каждый движок называет id, имя, вьюпорт и состав расширений', () => {
    const беды = [];
    for (const { file, data } of engineData) {
      if (!data.id) беды.push(`${file}: нет id`);
      if (!data.title) беды.push(`${file}: нет title`);
      if (!data.viewer) беды.push(`${file}: нет viewer — нечем рисовать`);
      if (!Array.isArray(data.availableExtensions) || !data.availableExtensions.length) {
        беды.push(`${file}: пустой availableExtensions`);
      }
    }
    expect(беды, беды.join('\n')).toEqual([]);
  });

  it('состав расширений ушёл из профилей и не вернулся', () => {
    const сдубль = profiles.filter((p) => p.data.availableExtensions !== undefined).map((p) => p.file);
    expect(
      сдубль,
      `availableExtensions снова в профилях: ${сдубль.join(', ')}. Список принадлежит `
        + 'движку; в профилях он лежал четырьмя одинаковыми копиями — именно поэтому и переехал.',
    ).toEqual([]);
  });

  it('площадка получает список СВОЕГО движка, а не выдуманный', () => {
    for (const { file, data } of profiles) {
      const идти = data.engine ? [data.engine] : engineData.map((e) => e.data.id);
      for (const id of идти) {
        const движок = engineData.find((e) => e.data.id === id);
        expect(движок, `${file}: движок ${id} не найден`).toBeTruthy();
        const ожидание = narrowToPlatform(движок.data.availableExtensions, data).map((e) => e.id);
        const факт = getAvailableExtensions(data.id, 'ru', data.engine ? undefined : id).map((e) => e.id);
        expect(факт, `${file}: состав разошёлся с движком ${id}`).toEqual(ожидание);
      }
    }
  });

  it('площадка вычитает из списка движка, но не задаёт его', () => {
    const список = [{ id: 'safe' }, { id: 'meshopt' }, { id: 'draco' }];

    expect(narrowToPlatform(список, {}).map((e) => e.id))
      .toEqual(['safe', 'meshopt', 'draco']);

    expect(
      narrowToPlatform(список, { excludeExtensions: ['meshopt'] }).map((e) => e.id),
      'вычтенное обязано исчезнуть из списка, а не остаться серым: список опций — не '
        + 'поле выбора, искать в нём нечего (решение Александра 2026-08-10)',
    ).toEqual(['safe', 'draco']);

    expect(
      narrowToPlatform(список, { excludeExtensions: ['нетакого'] }).map((e) => e.id),
      'вычитание несуществующего не должно ничего ломать — опечатка в профиле не повод падать',
    ).toEqual(['safe', 'meshopt', 'draco']);

    expect(
      narrowToPlatform(список, { availableExtensions: [{ id: 'выдуманное' }] }).map((e) => e.id),
      'профиль не вправе расширять список движка',
    ).toEqual(['safe', 'meshopt', 'draco']);
  });

  it('значок «нужен декодер» приходит от движка, а не зашит в интерфейсе', () => {
    const src = readSource('ui/app');
    expect(
      /const\s+NEEDS_DECODER\s*=\s*new\s+Set\(\s*\[/.test(src),
      'в ui/app.js снова зашит список NEEDS_DECODER — он принадлежит engines/<id>.json',
    ).toBe(false);

    const помеченные = engineData.flatMap((e) => (e.data.availableExtensions || [])
      .filter((x) => x.needsDecoder).map((x) => x.id));
    expect(помеченные.length, 'ни один движок не помечает needsDecoder — значки исчезнут').toBeGreaterThan(0);
  });

  it('расширения приходят со словами, а не голыми id', () => {
    const без = getAvailableExtensions('', 'ru', 'threejs').filter((e) => !e.title).map((e) => e.id);
    expect(без, `без названия: ${без.join(', ')}`).toEqual([]);
  });

  it('план несёт движок вместе с его именем и вьюпортом', () => {
    const plan = planFor('', 'ru', 'threejs');
    expect(plan.engineInfo, 'planFor() не вернул engineInfo').toBeTruthy();
    expect(plan.engineInfo.id).toBe(plan.engine);
    expect(plan.engineInfo.title, 'движок без имени — в поле интерфейса покажется id').toBeTruthy();
    expect(plan.engineInfo.viewer, 'движок без вьюпорта — нечем рисовать').toBeTruthy();
  });

  it('вьюпорт, который называет движок, приложение действительно везёт', () => {
    const src = readSource('ui/viewer/index.js');
    const блок = src.match(/const VIEWERS[^\n]*= \{([\s\S]*?)\n\};/);
    expect(блок, 'в ui/viewer/index не найден реестр VIEWERS — проверка ослепла').toBeTruthy();
    const везём = [...блок[1].matchAll(/^\s{2}([a-z0-9_-]+):/gim)].map((m) => m[1]);
    expect(везём.length, 'реестр вьюпортов пуст').toBeGreaterThan(0);
    const нет = engineData.map((e) => e.data.viewer).filter((v) => !везём.includes(v));
    expect(
      нет,
      `движки просят вьюпорты, которых нет в приложении: ${нет.join(', ')}. Везём: ${везём.join(', ')}.`,
    ).toEqual([]);
  });

  it('слова опции одни и те же при любой площадке и любом движке', () => {
    const наборы = [
      ['прочерк + threejs', getAvailableExtensions('', 'ru', 'threejs')],
      ['прочерк + model-viewer', getAvailableExtensions('', 'ru', 'model-viewer')],
      ...listPlatforms().map((p) => [p.id, getAvailableExtensions(p.id, 'ru')]),
    ];
    const эталон = new Map();
    const расхождения = [];
    for (const [где, список] of наборы) {
      for (const e of список) {
        const слова = JSON.stringify([e.title, e.description, e.impact]);
        const было = эталон.get(e.id);
        if (было === undefined) эталон.set(e.id, { слова, где });
        else if (было.слова !== слова) {
          расхождения.push(`${e.id}: у «${где}» текст не тот, что у «${было.где}»`);
        }
      }
    }
    expect(расхождения, расхождения.join('; ')).toEqual([]);
  });

  it('смена языка перерисовывает опции и при прочерке тоже', () => {
    const src = readSource('ui/app');
    const начало = src.indexOf('async function relabelExtensions')
    expect(начало, 'в ui/app.js не нашлось relabelExtensions — проверка ослепла').toBeGreaterThan(-1);
    const тело = src.slice(начало, src.indexOf('\n  }', начало));
    expect(
      /if\s*\(\s*!\s*platformSelect\.value\s*\)\s*return/.test(тело),
      'relabelExtensions снова выходит по пустой площадке — при прочерке опции '
        + 'останутся на прежнем языке (Правило 8: смена языка перерисовывает всё)',
    ).toBe(false);
    expect(тело, 'relabelExtensions больше не перезагружает список опций').toMatch(/loadExtensions\(/);

    const onChange = src.slice(src.indexOf('window.I18n.onChange'));
    expect(onChange, 'relabelExtensions не зовётся при смене языка').toMatch(/relabelExtensions\(/);
  });

  it('две оси симметричны: движок ↔ площадка сходятся с обеих сторон', () => {
    for (const p of listPlatforms()) {
      const движки = enginesForPlatform(p.id).map((e) => e.id);
      expect(движки, `${p.id}: ни одного годного движка`).toContain(p.engine);
      const площадки = platformsForEngine(p.engine).map((x) => x.id);
      expect(площадки, `${p.engine}: площадка ${p.id} потерялась на обратном пути`).toContain(p.id);
    }
  });

  it('без площадки план строится по движку, а бюджетов нет', () => {
    for (const { data } of engineData) {
      const plan = planFor('', 'ru', data.id);
      expect(plan.engine, `движок не доехал до плана: ${data.id}`).toBe(data.id);
      expect(plan.engineOpts, `${data.id}: базовый план пуст — сборка пошла бы без умолчаний`)
        .toEqual(data.baselineOpts);
      expect(plan.availableExtensions.length, `${data.id}: без площадки список опций пуст`)
        .toBe(data.availableExtensions.length);
    }
    const metric = {
      fileBytes: 50 * 1024 * 1024, gpuBytes: 20 * 1024 * 1024,
      triangles: 9999999, materials: 99, drawCalls: 999,
    };
    const rr = { status: 'ok', metrics: { before: metric, after: metric } };

    const свои = explainResult(rr, '', 'ru').budgetChecks;
    expect(свои.length, 'советы прочерка пропали').toBeGreaterThan(0);
    expect(
      свои.every((c) => c.level !== 'over'),
      'прочерк предъявил жёсткий предел от имени площадки, которую не выбирали',
    ).toBe(true);
  });

  it('у прочерка есть советы, но никогда не бывает жёстких пределов', () => {
    const none = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, '_none.json'), 'utf8'));
    expect(none.enabled, '_none обязан быть скрыт из списка площадок').toBe(false);
    const сПределом = Object.entries(none.budgets || {})
      .filter(([, v]) => v && typeof v === 'object' && v.limit != null).map(([k]) => k);
    expect(
      сПределом,
      `у прочерка появился жёсткий предел: ${сПределом.join(', ')}. Красный означает `
        + '«площадка не примет файл», а площадки здесь нет.',
    ).toEqual([]);

    const metric = {
      fileBytes: 50 * 1024 * 1024, gpuBytes: 20 * 1024 * 1024,
      triangles: 9999999, materials: 99, drawCalls: 999,
    };
    const уровни = explainResult({ status: 'ok', metrics: { before: metric, after: metric } }, '', 'ru')
      .budgetChecks.map((c) => c.level);
    expect(уровни.length, 'советы прочерка пропали — левая панель ничего не подсветит').toBeGreaterThan(0);
    expect(уровни, 'прочерк выдал красный уровень').not.toContain('over');
  });

  it('«Веб» больше не отдельная площадка', () => {
    const ids = listPlatforms().map((p) => p.id);
    expect(
      ids.includes('threejs'),
      'площадка threejs вернулась: площадка, названная именем движка, — то самое смешение '
        + 'двух осей, ради разделения которых всё делалось',
    ).toBe(false);
  });

  it('жёсткий предел красный, рекомендация жёлтая', () => {
    const весом = (mb) => {
      const m = { fileBytes: mb * 1024 * 1024, gpuBytes: 1024, triangles: 10, materials: 1, drawCalls: 1 };
      return { status: 'ok', metrics: { before: m, after: m } };
    };
    const уровень = (platform, mb) => (explainResult(весом(mb), platform, 'ru').budgetChecks
      .find((c) => c.id === 'fileMB') || {}).level;

    expect(уровень('shopify', 3), 'уложились, а тревога есть').toBe('ok');
    expect(уровень('shopify', 20), 'молчаливое пережатие выдано за отказ').toBe('warn');
    expect(уровень('shopify', 600), 'настоящий отказ площадки не покраснел').toBe('over');
    expect(уровень('', 600), 'совет выдан за отказ').toBe('warn');
  });

  it('ведущий движок назван в данных, а не в коде интерфейса', () => {
    const primary = engineData.filter((e) => e.data.primary === true).map((e) => e.data.id);
    expect(
      primary.length,
      `движков с primary: ${primary.join(', ') || '—'}. Ровно один обязан вести список: `
        + 'когда площадка не выбрана, выбирать движок больше не по чему, и без признака '
        + 'решал бы алфавит.',
    ).toBe(1);
    expect(listEngines()[0].id, 'ведущий движок не первый в списке').toBe(primary[0]);
  });

  it('listEngines отдаёт движки, а не площадки', () => {
    const ids = listEngines().map((e) => e.id);
    expect([...ids].sort()).toEqual(engineData.filter((e) => e.data.enabled !== false).map((e) => e.data.id).sort());
  });
});

describe('Пометка декодера различает движки, а не копирует список', () => {
  const engineById = Object.fromEntries(engineData.map(({ data }) => [data.id, data]));
  const optsById = (id) =>
    Object.fromEntries((engineById[id]?.availableExtensions || []).map((e) => [e.id, e]));

  it('оба движка на месте — иначе проверки ниже ничего не значат', () => {
    expect(Object.keys(engineById)).toEqual(expect.arrayContaining(['threejs', 'model-viewer']));
  });

  it('model-viewer: Draco и KTX2 без пометки — он везёт их с собой', () => {
    const mv = optsById('model-viewer');
    for (const id of ['draco', 'ktx2']) {
      expect(
        !!mv[id]?.needsDecoder,
        `${id}: model-viewer подключает декодер сам (адрес по умолчанию на gstatic) — ` +
        'пометка пугает препятствием, которого нет',
      ).toBe(false);
    }
  });

  it('model-viewer: Meshopt С пометкой — его подключает сайт, а не движок', () => {
    expect(
      !!optsById('model-viewer').meshopt?.needsDecoder,
      'meshopt: адреса по умолчанию у model-viewer нет, декодер до загрузчика не доходит ' +
      'без setMeshoptDecoderLocation() на стороне сайта',
    ).toBe(true);
  });

  it('three.js: все три с пометкой — там декодер подключает программист', () => {
    const three = optsById('threejs');
    for (const id of ['draco', 'ktx2', 'meshopt']) {
      expect(!!three[id]?.needsDecoder, `${id}: на голом сайте three.js декодера нет`).toBe(true);
    }
  });
});

describe('VNTANA и Google Store — факты, ради которых профили заведены', () => {
  const профиль = (id) => (profiles.find((p) => p.data.id === id) || {}).data;

  it('VNTANA вычитает Draco — она не принимает его НА ВХОДЕ', () => {
    const p = профиль('vntana');
    expect(p, 'профиль vntana исчез').toBeTruthy();
    expect(
      p.excludeExtensions,
      'Draco вернулся в список VNTANA. Их документация прямо говорит, что файл с Draco '
        + 'не даст выходов; показывать эту галочку значит обещать работу, которой не будет.',
    ).toContain('draco');

    const выдаётся = getAvailableExtensions('vntana').map((e) => e.id);
    expect(выдаётся, 'вычитание объявлено, но до панели не доехало').not.toContain('draco');
    expect(getAvailableExtensions('', 'ru', 'threejs').map((e) => e.id)).toContain('draco');
  });

  it('Google Store несёт бюджет 2 МБ и только его', () => {
    const p = профиль('google-store');
    expect(p, 'профиль google-store исчез').toBeTruthy();
    expect(p.budgets.fileMB.warn, 'бюджет 2 МБ потерян').toBe(2);
    expect(p.budgets.fileMB.limit, 'у Google Store не может быть жёсткого предела: '
      + 'посторонний туда ничего не загружает, это совет, а не отказ').toBeUndefined();
    expect(p.budgets.fileMB.source, 'число без источника — то же, что выдуманное').toBeTruthy();

    const счисламии = Object.entries(p.budgets)
      .filter(([, v]) => v && (v.warn != null || v.limit != null))
      .map(([k]) => k);
    expect(счисламии, 'у Google Store появились числа помимо веса — проверить источник')
      .toEqual(['fileMB']);
  });

  it('Google Store просит Draco базовым — это свойство движка, а не вкус', () => {
    expect(planFor('google-store').engineOpts.codec).toBe('draco');
    expect(планДвижка('google-store')).toBe('model-viewer');
  });

  function планДвижка(id) { return planFor(id).engine; }
});
