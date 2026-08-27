// tests/single-declaration.test.mjs — сторожа принципа «объявлено один раз».
//
// Два дефекта одного рода, закрытых 2026-08-04:
//
//   1. Текст опций лежал в profiles/*.json — четыре площадки держали четыре копии
//      одного и того же (13 065 знаков, из них ~10 000 дубли). Новая площадка
//      означала повторный перевод всех десяти опций, а три из четырёх профилей были
//      к тому же одноязычными: включение любого показало бы английский текст в
//      русском интерфейсе.
//   2. Взаимоисключающие группы объявлялись ДВАЖДЫ: EXCLUSIVE_FEATURES в аддоне и
//      EXCLUSIVE_GROUPS в ui/app.js. Списки были разные (пара кодеков против пары
//      текстур) и никто их не сверял — интерфейс мог погасить одну галочку, а
//      движок выбрать другую.
//
// Оба лечатся одинаково: объявление одно, остальные читают. Эти тесты сторожат,
// что копия не вернётся.
//
// Слой 1 карты тестов (tests/TEST-MAP.md): движка просмотра не знают, площадки
// перебираются данными — второй профиль и второй аддон подхватятся сами.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSource } from './helpers/source-files.mjs';

import { exclusiveGroups } from '../optimize2.mjs';
import gltfAddon from '../addons/gltf/index.mjs';
import { getAvailableExtensions } from '../assistant.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILES_DIR = path.join(ROOT, 'profiles');

const profileNames = fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.json'));
const profiles = profileNames.map((f) => ({
  name: f,
  json: JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8')),
}));

const catalogs = {
  ru: (await import('../messages/ru.mjs')).default,
  en: (await import('../messages/en.mjs')).default,
};

// Опции, у которых описания нет НАМЕРЕННО: вся их подпись — само число.
//
// Слово Александра 2026-08-12: «книжечка тут не нужна вообще, просто изменение размера
// текстуры, ничего писать не нужно — вся информация, которая там была, бессмысленная».
// Четыре абзаца про то, «для чего годится модель после», человек читать не станет.
//
// Список поимённый, а не общее послабление вида «описание необязательно»: у остальных
// опций пропавший текст обязан оставаться красным. Появится у размеров описание, которое
// стоит читать, — строка отсюда убирается, и книжечка возвращается в интерфейс сама
// (он рисует значок по наличию описания).
const БЕЗ_ОПИСАНИЯ = new Set(['resize-512', 'resize-1024', 'resize-2048', 'resize-4096']);

// ============================================================================
// 1. Текст опций объявлен один раз — в каталоге, не в профиле
// ============================================================================

describe('Единственное объявление — текст опций живёт в каталоге', () => {
  it('профили не несут title/description/impact у опций (копия не вернулась)', () => {
    const offenders = [];
    for (const { name, json } of profiles) {
      for (const e of json.availableExtensions || []) {
        for (const field of ['title', 'description', 'impact']) {
          if (field in e) offenders.push(`${name}: опция ${e.id} снова несёт ${field}`);
        }
      }
    }
    expect(offenders, offenders.join('\n  ')).toEqual([]);
  });

  it('у каждой опции каждого профиля есть ключи текста в ОБОИХ каталогах', () => {
    const missing = [];
    for (const { name, json } of profiles) {
      for (const e of json.availableExtensions || []) {
        for (const field of ['title', 'description', 'impact']) {
          for (const lang of ['ru', 'en']) {
            const key = `option.${e.id}.${field}`;
            if (!(key in catalogs[lang])) missing.push(`${name}: ${key} нет в ${lang}`);
          }
        }
      }
    }
    expect(missing, missing.join('\n  ')).toEqual([]);
  });

  it('ассистент отдаёт непустой текст на обоих языках для всех площадок', () => {
    const empty = [];
    for (const { name, json } of profiles) {
      for (const lang of ['ru', 'en']) {
        for (const e of getAvailableExtensions(json.id, lang)) {
          // Подпись обязана быть у ВСЕХ и всегда: опция без имени — это пустая строка
          // в панели, и никакое решение о текстах этого не отменяет.
          if (!e.title) empty.push(`${name} [${lang}]: у ${e.id} пустой title`);
          if (!e.description && !БЕЗ_ОПИСАНИЯ.has(e.id)) {
            empty.push(`${name} [${lang}]: у ${e.id} пустое description`);
          }
        }
      }
    }
    expect(empty, empty.join('\n  ')).toEqual([]);
  });

  it('русский текст опции отличается от английского (перевод есть, а не копия)', () => {
    // Ловит подстановку английской строки вместо перевода: до правки три профиля
    // из четырёх были одноязычными и именно так себя и вели.
    // Берём список без площадки (прочерк) на ведущем движке: площадки threejs больше
    // нет — «просто веб» и «без площадки» слиты в один выбор 2026-08-10
    // (ARCHITECTURE.md §4g). Полный список опций даёт именно прочерк: площадка может
    // из него вычитать, и проверять перевод стоит на полном.
    const список = (lang) => getAvailableExtensions('', lang, 'threejs');
    const same = [];
    for (const e of список('ru')) {
      const en = список('en').find((x) => x.id === e.id);
      if (e.description && en && e.description === en.description) same.push(e.id);
    }
    expect(список('ru').length, 'список опций пуст — тест проверяет пустоту').toBeGreaterThan(0);
    expect(same, `описание не переведено: ${same.join(', ')}`).toEqual([]);
  });
});

// ============================================================================
// 2. Взаимоисключающие группы объявлены один раз — в аддоне
// ============================================================================

describe('Единственное объявление — взаимоисключающие группы', () => {
  it('ядро отдаёт группы аддона наружу', () => {
    const groups = exclusiveGroups();
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(typeof g.id).toBe('string');
      expect(Array.isArray(g.members)).toBe(true);
      expect(g.members.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('каждый член группы — существующая фича аддона', () => {
    const known = new Set(Object.keys(gltfAddon.ADVANCED_FEATURES));
    const unknown = [];
    for (const g of exclusiveGroups()) {
      for (const m of g.members) if (!known.has(m)) unknown.push(`${g.id}: ${m}`);
    }
    expect(unknown, unknown.join('\n  ')).toEqual([]);
  });

  it('группы не пересекаются: фича принадлежит одной группе', () => {
    const seen = new Map();
    const dupes = [];
    for (const g of exclusiveGroups()) {
      for (const m of g.members) {
        if (seen.has(m)) dupes.push(`${m}: ${seen.get(m)} и ${g.id}`);
        seen.set(m, g.id);
      }
    }
    expect(dupes, dupes.join('\n  ')).toEqual([]);
  });

  it('в интерфейсе нет своего списка взаимоисключений (копия не вернулась)', () => {
    const src = readSource('ui/app');
    // Комментарии вырезаем: в них про старый список рассказывает история правки.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code, 'ui/app.js снова объявляет группы сам — их объявляет аддон')
      .not.toMatch(/EXCLUSIVE_GROUPS\s*=/);
  });

  it('копия отдаётся наружу, а не внутренний объект аддона', () => {
    const first = exclusiveGroups();
    first[0].members.push('подделка');
    expect(exclusiveGroups()[0].members).not.toContain('подделка');
  });
});

// ============================================================================
// 3. Режим KTX2 назначается один раз — в аддоне
// ============================================================================
//
// Третий дефект того же рода, закрытый 2026-08-07. На вопрос «какой режим KTX2,
// если человек не выбирал» отвечали ЧЕТЫРЕ места, и отвечали по-разному:
//
//   addons/gltf/index.mjs  uastc
//   optimize2.mjs          mixed   ← CLI без флагов
//   server.mjs             uastc   ← и подставлял это ПОСЛЕ профиля
//   ui/app.js              uastc
//
// Наружу это выходило так: одна и та же модель с одной и той же галочкой KTX2
// давала из терминала ETC1S, а из браузера UASTC — разный вес, разное качество,
// разная видеопамять, и ни слова об этом в документации. А профиль, объявлявший
// `texMode` и объяснявший человеку почему, не мог на результат повлиять вовсе:
// сервер ставил своё значение последним.
//
// Теперь отвечает аддон, поверх него — профиль площадки, поверх него — явный
// выбор человека. Три уровня, каждый следующий бьёт предыдущий; умолчание одно.

describe('Единственное объявление — режим KTX2', () => {
  const MODES = ['uastc', 'mixed'];

  it('умолчание даёт аддон, а не тот, кто его вызвал', () => {
    const bare = gltfAddon.normalizeOpts({});
    expect(MODES).toContain(bare.texMode);
    // «Не сказали ничего» и «попросили KTX2, но режим не назвали» — один ответ.
    expect(gltfAddon.normalizeOpts({ advancedFeatures: ['ktx2'] }).texMode).toBe(bare.texMode);
    expect(gltfAddon.normalizeOpts({ texMode: undefined }).texMode).toBe(bare.texMode);
  });

  it('режим, объявленный профилем площадки, доживает до опций движка', () => {
    const lost = [];
    for (const { name, json } of profiles) {
      const wanted = (json.baselineOpts || {}).texMode;
      if (!wanted) continue;
      const got = gltfAddon.normalizeOpts({ ...json.baselineOpts, advancedFeatures: ['ktx2'] }).texMode;
      if (got !== wanted) lost.push(`${name}: просит ${wanted}, получает ${got}`);
    }
    expect(lost, lost.join('\n  ')).toEqual([]);
  });

  it('сервер не ставит свой режим поверх профиля', () => {
    const src = readSource('server');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // Сборка опций обязана заканчиваться РАСКРЫТИЕМ явного выбора (пусто, если человек
    // не выбирал), а не безусловным `texMode: <что-то>` — именно эта форма и затирала
    // профиль. Проверяем саму форму строки: поведение тут не воспроизвести, не подняв
    // сервер, а сломать её можно одним символом.
    const merge = code.match(/const engineOpts = \{[^;]*\};/);
    expect(merge, 'в server.mjs больше нет сборки engineOpts — тест устарел, обновить').toBeTruthy();
    expect(merge[0], 'сервер снова назначает texMode безусловно — профиль до движка не дойдёт')
      .not.toMatch(/texMode\s*:/);
  });

  it('интерфейс берёт режим у площадки, а не назначает сам', () => {
    const src = readSource('ui/app');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // Сторожим МЕХАНИЗМ, а не написание. Первая версия этого теста искала литерал
    // `ktx2Mode = 'uastc'` — она ловила ровно ту форму, что была до правки, и
    // пропускала регрессию, написанную новым идиомом (через именованную константу).
    // Зелёный тест не означал, что свойство держится.
    //
    // Держится оно тогда, когда обе функции, решающие «что показать, если человек не
    // выбирал», спрашивают площадку. Их две, и обе обязаны звать defaultKtx2Mode().
    const bodyOf = (name) => {
      const at = code.indexOf(`function ${name}(`);
      if (at === -1) return null;
      let depth = 0;
      for (let i = code.indexOf('{', at); i < code.length; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}' && --depth === 0) return code.slice(at, i + 1);
      }
      return null;
    };

    // `applyDefaultSelection` переименована в `seedSelection` 2026-08-26, когда флажки
    // перестали принадлежать модели: она теперь зовётся ровно один раз, при первой
    // загрузке в пустой список. Обязанность спрашивать площадку о режиме KTX2 у неё та
    // же — сменилось имя, а не механизм.
    for (const fn of ['seedSelection', 'restoreSelection']) {
      const body = bodyOf(fn);
      expect(body, `в ui/app.js больше нет ${fn}() — тест устарел, обновить`).toBeTruthy();
      expect(body, `${fn}() перестала спрашивать площадку о режиме KTX2`).toMatch(/defaultKtx2Mode\(\)/);
    }

    // И сам совет должен приходить с сервера, а не выдумываться на месте.
    expect(code, 'ui/app.js должен читать defaults с /api/extensions').toMatch(/platformDefaults\s*=/);
  });
});

describe('состав группы геометрии объявлен один раз (аудит Ф3-2)', () => {
  // Заведено 2026-08-26. Первоисточник — EXCLUSIVE_FEATURES.geometry.members в аддоне,
  // и он был объявлен таковым ещё в 2026-08-04 (см. шапку файла). Тем не менее список
  // ['meshopt','draco','quantize'] к августу 2026 оказался переписан руками ещё трижды:
  // в server.mts и дважды в ui/app.ts.
  //
  // Самый показательный случай — server.mts: `exclusiveGroups` там ИМПОРТИРОВАН и
  // вызывается семью строками ниже рукописной копии. Первоисточник был в области
  // видимости, и это не помешало.
  //
  // ПРОБА НА КРАСНОТУ пройдена: вернул литерал в server.mts — краснеет; вернул
  // `c === 'meshopt' || c === 'draco'` в ui/app.ts — краснеет.

  const members = exclusiveGroups().find((g) => g.id === 'geometry').members;

  it('первоисточник на месте и непуст', () => {
    expect(members.length, 'группа geometry исчезла — сторож ниже потерял смысл')
      .toBeGreaterThan(1);
  });

  for (const file of ['server.mts', 'ui/app.ts']) {
    it(`${file} не держит своей копии списка кодеков`, () => {
      // Ищем ПЕРЕЧИСЛЕНИЕ: два и более члена группы подряд в одном выражении. Одиночное
      // упоминание не ловим намеренно — `opts.codec === 'draco'` это ветка поведения,
      // а не копия списка, и краснеть на неё значило бы мешать работать.
      const src = readSource(file);
      const код = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      const имена = members.map((m) => `'${m}'`);
      const перечисления = [];
      for (const line of код.split(/\r?\n/)) {
        const сколько = имена.filter((n) => line.includes(n)).length;
        if (сколько >= 2) перечисления.push(line.trim().slice(0, 90));
      }
      expect(перечисления,
        `${file}: список кодеков переписан руками. Первоисточник — exclusiveGroups(), `
        + 'группа geometry; читать надо его, а не синхронизировать копию')
        .toEqual([]);
    });
  }
});
