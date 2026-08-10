// tests/engine-target-split.test.mjs — движок и площадка остаются разными осями.
//
// Решение Александра 2026-08-09, записано в docs/ARCHITECTURE.md §4g. Три вида фактов
// лежали в одном файле профиля:
//
//   budgets              — принадлежат ПЛОЩАДКЕ (лимиты Shopify — это лимиты Shopify,
//                          чем бы модель ни рисовали);
//   availableExtensions  — принадлежат ДВИЖКУ (читает ли он KTX2 без декодера);
//   reversible/dataLoss  — принадлежат САМОЙ ОПТИМИЗАЦИИ (join необратим всегда).
//
// Третье уже дублировалось: те же поля есть в addons/gltf/rules.mjs. Совпадали — но это
// ровно та форма, которая однажды уже разошлась (EXCLUSIVE_FEATURES против
// EXCLUSIVE_GROUPS, см. комментарий в addons/gltf/index.mjs). Второй список одной правды
// расходится молча, и замечают это по кривому экрану, а не по красному тесту.
//
// Сторожит три вещи, каждая из которых иначе тихо откатится:
//   1. профиль называет свой движок явно, а не прячет его в заголовке «Web (Three.js)»;
//   2. факты правил в профиль не вернулись;
//   3. API отдаёт движок и умеет принимать его в запросе.

import { describe, it, expect } from 'vitest';
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

const profileFiles = fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.json'));
const profiles = profileFiles.map((f) => ({
  file: f,
  data: JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8')),
}));

describe('Движок и площадка — разные оси (ARCHITECTURE.md §4g)', () => {
  it('профилей вообще нашлось — иначе тест проверяет пустоту', () => {
    expect(profiles.length).toBeGreaterThan(0);
  });

  it('каждая площадка называет свой движок явным полем', () => {
    const без = profiles.filter((p) => !p.data.engine).map((p) => p.file);
    expect(
      без,
      `нет поля "engine": ${без.join(', ')}. Пара «площадка + движок» обязана быть видна `
        + 'в данных, а не в заголовке вида «Web (Three.js)» — иначе второй движок '
        + 'потребует переписывать названия, а не добавлять файл.',
    ).toEqual([]);
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
    // Если однажды удалить их и ОТТУДА, профили окажутся правы задним числом,
    // а проверка выше — бессмысленной.
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
      expect(plan.engine, `${file}: движок плана разошёлся с профилем`).toBe(data.engine);
    }
  });

  it('движок площадки — существующий файл, а не случайная строка', () => {
    const нет = [...new Set(profiles.map((p) => p.data.engine))]
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
    // Площадка и движок сегодня совпали по имени только у одной записи (threejs) —
    // это наследство, а не правило. Тест фиксирует, что список платформ не подменили
    // списком движков: их должно быть столько же, сколько включённых профилей.
    const включённых = profiles.filter((p) => p.data.enabled !== false).length;
    expect(ids.length).toBe(включённых);
  });
});

// ---------------------------------------------------------------------------
// Слой движков: engines/<id>.json стал отдельной таблицей (§4g, вторая правка)
//
// Список расширений раньше лежал в КАЖДОМ профиле — четырьмя побайтно одинаковыми
// копиями. Это и было доказательством, что он принадлежит движку: свойство площадки
// не может совпасть у сайта, телефона, шлема и витрины до последнего символа.
// ---------------------------------------------------------------------------

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
      const движок = engineData.find((e) => e.data.id === data.engine);
      expect(движок, `${file}: движок ${data.engine} не найден`).toBeTruthy();
      const ожидание = narrowToPlatform(движок.data.availableExtensions, data).map((e) => e.id);
      const факт = getAvailableExtensions(data.id).map((e) => e.id);
      expect(факт, `${file}: состав разошёлся с движком ${data.engine}`).toEqual(ожидание);
    }
  });

  it('площадка вычитает из списка движка, но не задаёт его', () => {
    // Механизм на живых данных пока не применён: ни у одной площадки нет проверенного
    // основания что-то вычесть (для Shopify + Meshopt основание не найдено — см.
    // profiles/shopify.json). Поэтому проверяется сама функция, а не её следы в файлах:
    // иначе код лежал бы непроверенным до первого настоящего применения.
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

    // Площадка НЕ может добавить: список задаёт движок. Иначе вернутся четыре копии.
    expect(
      narrowToPlatform(список, { availableExtensions: [{ id: 'выдуманное' }] }).map((e) => e.id),
      'профиль не вправе расширять список движка',
    ).toEqual(['safe', 'meshopt', 'draco']);
  });

  it('значок «нужен декодер» приходит от движка, а не зашит в интерфейсе', () => {
    // До 2026-08-10 список лежал в ui/app.js константой NEEDS_DECODER — верной ровно для
    // одного движка. Сторож ловит возврат к зашитому списку.
    const src = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
    expect(
      /const\s+NEEDS_DECODER\s*=\s*new\s+Set\(\s*\[/.test(src),
      'в ui/app.js снова зашит список NEEDS_DECODER — он принадлежит engines/<id>.json',
    ).toBe(false);

    const помеченные = engineData.flatMap((e) => (e.data.availableExtensions || [])
      .filter((x) => x.needsDecoder).map((x) => x.id));
    expect(помеченные.length, 'ни один движок не помечает needsDecoder — значки исчезнут').toBeGreaterThan(0);
  });

  it('расширения приходят со словами, а не голыми id', () => {
    // Состав задаёт движок, слова — core/messages/ (Правило 8). Если связь порвётся,
    // человек увидит в панели «ktx2» вместо «Сжатие текстур KTX2».
    const без = getAvailableExtensions('threejs', 'ru').filter((e) => !e.title).map((e) => e.id);
    expect(без, `без названия: ${без.join(', ')}`).toEqual([]);
  });

  it('план несёт движок вместе с его именем и вьюпортом', () => {
    const plan = planFor('threejs', 'ru');
    expect(plan.engineInfo, 'planFor() не вернул engineInfo').toBeTruthy();
    expect(plan.engineInfo.id).toBe(plan.engine);
    expect(plan.engineInfo.title, 'движок без имени — в поле интерфейса покажется id').toBeTruthy();
    expect(plan.engineInfo.viewer, 'движок без вьюпорта — нечем рисовать').toBeTruthy();
  });

  it('вьюпорт, который называет движок, приложение действительно везёт', () => {
    // Самая ценная проверка слоя: «другой движок — другой вьюпорт» имеет смысл, только
    // если названный вьюпорт существует. Иначе движок добавят файлом, а картинка молча
    // останется от прежнего — ровно тот класс отказа, из-за которого в 0.1.0 уехала
    // сборка с мёртвым предпросмотром.
    const src = fs.readFileSync(path.join(ROOT, 'ui', 'viewer', 'index.js'), 'utf8');
    const блок = src.match(/const VIEWERS = \{([\s\S]*?)\n\};/);
    expect(блок, 'в ui/viewer/index.js не найден реестр VIEWERS — проверка ослепла').toBeTruthy();
    const везём = [...блок[1].matchAll(/^\s{2}([a-z0-9_-]+):/gim)].map((m) => m[1]);
    expect(везём.length, 'реестр вьюпортов пуст').toBeGreaterThan(0);
    const нет = engineData.map((e) => e.data.viewer).filter((v) => !везём.includes(v));
    expect(
      нет,
      `движки просят вьюпорты, которых нет в приложении: ${нет.join(', ')}. Везём: ${везём.join(', ')}.`,
    ).toEqual([]);
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
    // Прочерк — законный выбор (решение Александра, 2026-08-10): человек берёт движок и
    // видит всё, что тот умеет, ничего не обещая ни одной витрине.
    for (const { data } of engineData) {
      const plan = planFor('', 'ru', data.id);
      expect(plan.engine, `движок не доехал до плана: ${data.id}`).toBe(data.id);
      expect(plan.engineOpts, `${data.id}: базовый план пуст — сборка пошла бы без умолчаний`)
        .toEqual(data.baselineOpts);
      expect(plan.availableExtensions.length, `${data.id}: без площадки список опций пуст`)
        .toBe(data.availableExtensions.length);
    }
    // Ни одной бюджетной строки: требования предъявлять некому.
    //
    // Результат нужен ПОЛНЫЙ — с before и after. С одним after explainResult() выходит
    // раньше по «нет метрик» и отдаёт пустой budgetChecks всегда: тест проходил бы, даже
    // если бы прочерк тянул чужие бюджеты (поймано мутацией 2026-08-10).
    const metric = {
      fileBytes: 50 * 1024 * 1024, gpuBytes: 20 * 1024 * 1024,
      triangles: 9999999, materials: 99, drawCalls: 999,
    };
    const rr = { status: 'ok', metrics: { before: metric, after: metric } };

    expect(
      explainResult(rr, '', 'ru').budgetChecks,
      'без площадки не должно быть ни одной проверки бюджета — иначе мы предъявляем '
        + 'требования от имени площадки, которую человек не выбирал',
    ).toEqual([]);

    // Контроль осмысленности: у настоящей площадки на тех же числах проверки ЕСТЬ.
    // Без этой строки предыдущая ничего не значит — пустой ответ бывает и от поломки.
    const реальные = explainResult(rr, 'threejs', 'ru').budgetChecks;
    expect(реальные.length, 'у площадки бюджеты пропали — сравнивать не с чем').toBeGreaterThan(0);
  });

  it('жёсткий предел красный, рекомендация жёлтая', () => {
    // Разница видна человеку цветом (ui/style.css: .budget-row.over → --error,
    // .budget-row.warn → --warning). Решение Александра 2026-08-10: числа-советы имеют
    // право быть, пока их нельзя спутать с настоящим отказом площадки.
    const metric = {
      fileBytes: 50 * 1024 * 1024, gpuBytes: 20 * 1024 * 1024,
      triangles: 9999999, materials: 99, drawCalls: 999,
    };
    const rr = { status: 'ok', metrics: { before: metric, after: metric } };

    const уровень = (platform, id) => (explainResult(rr, platform, 'ru').budgetChecks
      .find((c) => c.id === id) || {}).level;

    // Shopify объявляет жёсткие 15 МБ — 50 МБ обязаны стать красными.
    expect(уровень('shopify', 'fileMB'), 'жёсткий предел площадки не покраснел').toBe('over');
    // У веба предела нет и быть не может: это не витрина, файл никто не отклонит.
    expect(уровень('threejs', 'fileMB'), 'рекомендация выдана за отказ').toBe('warn');
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
