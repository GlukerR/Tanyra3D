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

// Файлы с подчёркиванием — НЕ площадки: сегодня это _none.json, числа прочерка (см.
// комментарий внутри файла). Проверки площадок к ним неприменимы: у прочерка нет своего
// движка, потому что он годится любому.
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
    // ПЕРЕПИСАН 2026-08-18 по решению Александра («убери движок у mobile и quest»).
    //
    // Было: «каждая площадка называет свой движок явным полем». Требование выглядело
    // строгим, а на деле заставляло ВЫДУМЫВАТЬ ответ там, где его нет. Движок называет
    // та площадка, которая и есть витрина с конкретным просмотрщиком: Shopify рисует
    // карточку через model-viewer, и другой пары не существует. «Смартфоны» и «Meta
    // Quest» — классы устройств: браузер телефона и браузер шлема запустят что угодно,
    // движок выбирает сайт. Стоявшее там "engine": "threejs" было утверждением,
    // которого никто не делал, и оно ВРЕДИЛО: по §4g площадка перебивает выбор движка,
    // поэтому «Мобильные» молча навязывали палитру three.js.
    //
    // Стало: поле необязательно, но если оно есть — обязано указывать на существующий
    // движок. Сторож от опечатки сохранён целиком, ослаблено только требование наличия.
    const выдуманные = [];
    for (const { file, data } of profiles) {
      if (data.engine === undefined || data.engine === null) continue; // не диктует — законно
      if (typeof data.engine !== 'string' || !data.engine.trim()) {
        выдуманные.push(`${file}: поле "engine" есть, но пустое — это ни то ни сё`);
      }
    }
    expect(выдуманные, выдуманные.join('\n')).toEqual([]);
  });

  it('хотя бы одна площадка движок ВСЁ ЖЕ называет — иначе ось выродилась', () => {
    // Обратная страховка к предыдущему тесту. Если «необязательно» однажды прочтут как
    // «не нужно» и поле исчезнет отовсюду, связь площадки с движком перестанет
    // существовать, а §4g — описывать реальность. Сегодня такая площадка одна: Shopify.
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
      // Площадка, которая движок ДИКТУЕТ, обязана совпасть с планом. Площадка, которая
      // его не диктует, получает движок по умолчанию (планы строятся и без выбора
      // человека) — совпадения с профилем требовать не с чего, там пусто.
      if (data.engine) {
        expect(plan.engine, `${file}: движок плана разошёлся с профилем`).toBe(data.engine);
      }
    }
  });

  it('площадка без движка следует за выбором человека, а с движком — за собой', () => {
    // Суть правки 2026-08-18 в одном тесте. Проверяется наблюдаемое поведение, а не поле.
    const свободные = profiles.filter((p) => !p.data.engine);
    const диктующие = profiles.filter((p) => p.data.engine);
    expect(свободные.length, 'нет ни одной площадки без движка — проверять нечего').toBeGreaterThan(0);

    for (const { file, data } of свободные) {
      for (const { data: eng } of engineData) {
        const plan = planFor(data.id, 'ru', eng.id);
        expect(plan.engine, `${file}: не пошла за выбранным движком ${eng.id}`).toBe(eng.id);
      }
    }
    for (const { file, data } of диктующие) {
      // Чужой движок ей передать можно, но она обязана остаться при своём.
      const plan = planFor(data.id, 'ru', 'threejs');
      expect(plan.engine, `${file}: витрина уступила чужому движку`).toBe(data.engine);
    }
  });

  it('движок площадки — существующий файл, а не случайная строка', () => {
    // Пустое поле пропускаем: «не диктует движок» — законное состояние (правка
    // 2026-08-18). Сторож от ОПЕЧАТКИ при этом цел: если имя названо, файл обязан быть.
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
      // Площадка без движка спрашивается ВМЕСТЕ с движком: своего у неё нет, и список
      // обязан прийти от выбранного. Витрина со своим движком спрашивается как раньше.
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
    // Состав задаёт движок, слова — core/messages/ (Правило 8). Если связь порвётся,
    // человек увидит в панели «ktx2» вместо «Сжатие текстур KTX2».
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
    // Самая ценная проверка слоя: «другой движок — другой вьюпорт» имеет смысл, только
    // если названный вьюпорт существует. Иначе движок добавят файлом, а картинка молча
    // останется от прежнего — ровно тот класс отказа, из-за которого в 0.1.0 уехала
    // сборка с мёртвым предпросмотром.
    // Читаем ИСХОДНИК (сейчас .ts), а не собранный рядом .js: на чистом клоне до
    // сборки его нет, и сторож упал бы на пустом месте. Объявление типа между именем
    // и «=» — часть перевода на TypeScript, поэтому в образце оно необязательно.
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
    // Правило 10б. Состав списка зависит от движка и площадки, ТЕКСТ — никогда:
    // он один на язык и лежит в messages/. До 2026-08-04 четыре профиля держали
    // четыре побайтно одинаковые копии, и каждая новая площадка означала повторный
    // перевод всех десяти опций.
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
    // Дефект 2026-08-10, нашёл Александр: «когда выбираю Shopify — всё на русском,
    // а Three.js без площадки — доп. опции на английском». Причина — ранний выход
    // relabelExtensions() по пустому значению поля площадки. Пустое значение это
    // ПРОЧЕРК, законное состояние: панель показана, и перерисовать её обязаны.
    // Проверка статическая: поведение живёт в браузере, а сюда смотрит сторож
    // за той единственной строкой, возврат которой воспроизводит беду.
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

    // И сама перерисовка обязана вызываться из обработчика смены языка.
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

    // Изначально здесь стояло «бюджетов быть не должно вовсе». 2026-08-10 Александр
    // решил иначе: советы для веба у прочерка остаются и подсвечиваются жёлтым, нет
    // только жёстких пределов. Что именно запрещено — в отдельной проверке ниже.
    const свои = explainResult(rr, '', 'ru').budgetChecks;
    expect(свои.length, 'советы прочерка пропали').toBeGreaterThan(0);
    expect(
      свои.every((c) => c.level !== 'over'),
      'прочерк предъявил жёсткий предел от имени площадки, которую не выбирали',
    ).toBe(true);
  });

  it('у прочерка есть советы, но никогда не бывает жёстких пределов', () => {
    // Слито 2026-08-10: площадка «Веб (Three.js)» и выбор без площадки — одно и то же.
    // Числа Khronos переехали в profiles/_none.json и остались СОВЕТАМИ. Жёсткий предел
    // тут невозможен по смыслу: отказать в файле может площадка, а её не выбрали.
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
    // Разница видна человеку цветом (ui/style.css: .budget-row.over → --error,
    // .budget-row.warn → --warning). Решение Александра 2026-08-10: числа-советы имеют
    // право быть, пока их нельзя спутать с настоящим отказом площадки.
    const весом = (mb) => {
      const m = { fileBytes: mb * 1024 * 1024, gpuBytes: 1024, triangles: 10, materials: 1, drawCalls: 1 };
      return { status: 'ok', metrics: { before: m, after: m } };
    };
    const уровень = (platform, mb) => (explainResult(весом(mb), platform, 'ru').budgetChecks
      .find((c) => c.id === 'fileMB') || {}).level;

    // Три полосы Shopify, все три по первоисточнику (см. profiles/shopify.json):
    // «about 4 MB» — совет; свыше 15 МБ файл ПЕРЕПИШУТ; свыше 500 МБ не примут вовсе.
    expect(уровень('shopify', 3), 'уложились, а тревога есть').toBe('ok');
    expect(уровень('shopify', 20), 'молчаливое пережатие выдано за отказ').toBe('warn');
    expect(уровень('shopify', 600), 'настоящий отказ площадки не покраснел').toBe('over');
    // У прочерка предела нет и быть не может: отказать может площадка, а её не выбрали.
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

// Пометка «нужен декодер» — свойство ДВИЖКА, а не расширения. Одинаковый список у двух
// движков выглядит опрятно и врёт: у model-viewer Draco и KTX2 работают из коробки, а
// Meshopt — нет.
//
// Разбор с ссылками на исходники — в engines/model-viewer.json (_comment_decoders).
// Коротко: DRACOLoader и KTX2Loader model-viewer заводит сам, адреса по умолчанию ведут
// на www.gstatic.com; у Meshopt адреса по умолчанию НЕТ — декодер создаётся только
// внутри setMeshoptDecoderLocation(), и без вызова со стороны сайта до загрузчика не
// доходит вовсе.
//
// Сторож стоит потому, что ошибиться здесь легко и хочется: «привести движки к одному
// виду» ломает ровно это. Один раз уже сломали в одну сторону (пугали декодером там, где
// он не нужен), при починке 2026-08-14 чуть не сломали в другую — сняли пометку и у
// Meshopt заодно, хотя рядом в файле лежала записанная 2026-08-10 оговорка про него.
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

// ---------------------------------------------------------------------------
// Площадки, заведённые 2026-08-18: VNTANA и Google Store
//
// У обеих есть по одному факту, ради которого профиль и существует, и оба взяты из
// первоисточника, а не из обзоров. Факт, живущий только в JSON, теряется молча при
// первой же перетасовке файла — поэтому здесь сторож.
// ---------------------------------------------------------------------------
describe('VNTANA и Google Store — факты, ради которых профили заведены', () => {
  const профиль = (id) => (profiles.find((p) => p.data.id === id) || {}).data;

  it('VNTANA вычитает Draco — она не принимает его НА ВХОДЕ', () => {
    // «We do not support Draco Compression on input for any file»: файл с уже
    // применённым Draco не даёт выходов ВООБЩЕ. Это единственный законный по Правилу 12
    // случай спрятать опцию — действие физически невозможно, а не «нам не нравится».
    const p = профиль('vntana');
    expect(p, 'профиль vntana исчез').toBeTruthy();
    expect(
      p.excludeExtensions,
      'Draco вернулся в список VNTANA. Их документация прямо говорит, что файл с Draco '
        + 'не даст выходов; показывать эту галочку значит обещать работу, которой не будет.',
    ).toContain('draco');

    const выдаётся = getAvailableExtensions('vntana').map((e) => e.id);
    expect(выдаётся, 'вычитание объявлено, но до панели не доехало').not.toContain('draco');
    // А у соседей по тому же движку Draco остаётся: вычитает ПЛОЩАДКА, не движок.
    expect(getAvailableExtensions('', 'ru', 'threejs').map((e) => e.id)).toContain('draco');
  });

  it('Google Store несёт бюджет 2 МБ и только его', () => {
    // Ценность профиля именно в том, что его единственное число настоящее. Дописать
    // «для симметрии» треугольники и отрисовки, которых Google не публиковала, значило бы
    // выдать выдумку за источник — ровно то, за что мы правили Shopify.
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
    // model-viewer читает Draco и KTX2 без настройки сайта, а Meshopt — только если сайт
    // вызвал setMeshoptDecoderLocation. Базовый план обязан работать у того, кто ничего
    // не настраивал. Если однажды поставят meshopt «как у всех» — тест напомнит почему.
    expect(planFor('google-store').engineOpts.codec).toBe('draco');
    expect(планДвижка('google-store')).toBe('model-viewer');
  });

  function планДвижка(id) { return planFor(id).engine; }
});
