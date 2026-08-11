// tests/typescript-build.test.mjs — сторож слоя TypeScript.
//
// Переход начат 2026-08-10 по решению Александра: новые модули на TS, рабочий JS не
// переписывать, поведение не менять. Первыми переведены core/types и core/contract.
//
// Устройство, за которым тут следят: источник живёт в `.mts`, компилятор кладёт рядом
// `.mjs` под тем же именем, поэтому ни один потребитель (импорты по всему дереву написаны
// с расширением `.mjs`) не меняется. Собранное в git не идёт.
//
// Что ломается тихо и потому проверяется:
//   1. собранный .mjs попал в git — источников стало два, и разойдутся они не сразу;
//   2. у нового .mts забыли закрыть собранную пару — то же самое, но в будущем;
//   3. strict выключили, чтобы «быстро починить» — и типы перестали ловить что-либо;
//   4. CI перестал проверять типы либо сборка перестала висеть на prepare (тогда на
//      чистом клоне приложение не запустится: файла модуля просто нет);
//   5. в установщик уехали исходники .mts или, наоборот, не уехало собранное.
//
// Плюс одна не статическая проверка: собранный контракт действительно импортируется и
// отдаёт то же, что отдавал до перевода. Без неё весь список выше стережёт форму, не
// проверив ни разу, что оно работает.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/** tsconfig.json — это JSONC: комментарии в нём разрешены и здесь используются. */
function readTsconfig() {
  const raw = read('tsconfig.json');
  const noComments = raw.replace(/^\s*\/\/[^\n]*$/gm, '');
  return JSON.parse(noComments);
}

/** Все переведённые модули: core/x.mts → 'core/x'. */
function migratedModules() {
  const out = [];
  for (const dir of ['core', 'addons/gltf']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (f.endsWith('.mts') && !f.endsWith('.d.mts')) out.push(`${dir}/${f.slice(0, -4)}`);
    }
  }
  return out;
}

const MODULES = migratedModules();

/** Рукописные объявления рядом с JS-файлами: они В git и собранными не являются. */
const HANDWRITTEN_DECLARATIONS = ['core/messages/en.d.mts', 'core/messages/ru.d.mts'];

describe('слой TypeScript', () => {
  it('переведён хотя бы один модуль — иначе проверки ниже пусты', () => {
    expect(MODULES.length, 'в core нет ни одного .mts').toBeGreaterThan(0);
  });

  it('собранное не лежит в git — источник один', () => {
    // git ls-files отвечает про ИНДЕКС, а не про диск: собранные файлы на диске есть
    // всегда (без них приложение не запустится), и проверять надо именно учёт.
    const tracked = new Set(
      execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n'),
    );
    const лишние = [];
    for (const m of MODULES) {
      for (const ext of ['.mjs', '.d.mts']) {
        if (tracked.has(`${m}${ext}`)) лишние.push(`${m}${ext}`);
      }
      expect(tracked.has(`${m}.mts`), `${m}.mts не в git — источник потеряется`).toBe(true);
    }
    expect(
      лишние,
      `в git попало собранное: ${лишние.join(', ')}. Источник — .mts; закрыть пару в .gitignore.`,
    ).toEqual([]);
  });

  it('у каждого переведённого модуля собранная пара закрыта в .gitignore', () => {
    const ignore = read('.gitignore');
    const забыли = [];
    for (const m of MODULES) {
      for (const ext of ['.mjs', '.d.mts']) {
        if (!ignore.includes(`${m}${ext}`)) забыли.push(`${m}${ext}`);
      }
    }
    expect(забыли, `не закрыто в .gitignore: ${забыли.join(', ')}`).toEqual([]);
  });

  it('собранное лежит на диске — иначе приложение не запустится', () => {
    for (const m of MODULES) {
      expect(fs.existsSync(path.join(ROOT, `${m}.mjs`)), `нет ${m}.mjs — не выполнен npm run build`).toBe(true);
    }
  });

  it('строгость включена и не ослаблена', () => {
    const { compilerOptions: o } = readTsconfig();
    expect(o.strict, 'strict выключен — типы перестали что-либо доказывать').toBe(true);
    // Ошибка типов не должна оставлять на диске половину модуля: приложение поднялось бы
    // на старом или битом файле, и причина отказа была бы не та.
    expect(o.noEmitOnError, 'noEmitOnError выключен').toBe(true);
    // Импорт типа обязан выглядеть как импорт типа — иначе после стирания остаётся
    // импорт несуществующего значения, и это отказ во время работы.
    expect(o.verbatimModuleSyntax, 'verbatimModuleSyntax выключен').toBe(true);
  });

  it('сборка привязана к установке, а типы проверяются в CI', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts.build, 'нет команды build').toBeTruthy();
    expect(pkg.scripts.typecheck, 'нет команды typecheck').toBeTruthy();
    // prepare — то, что делает чистый клон работоспособным: npm ci соберёт .mts сам,
    // без отдельной команды, которую забудут.
    expect(pkg.scripts.prepare, 'сборка не висит на prepare — после npm ci модулей не будет').toMatch(/tsc/);

    const test = read('.github', 'workflows', 'test.yml');
    expect(test, 'CI не проверяет типы').toMatch(/npm run typecheck/);
  });

  // Каталоги сообщений правит переводчик (assistants/translate/TRANSLATOR_PROMPT.md).
  // Сделать их собранными из .mts — значит подставить его: правка попадёт в файл, который
  // затрёт следующая сборка, и пропажу заметят не сразу. Форма каталога описана рядом
  // рукописным .d.mts; он в git, потому что не генерируется.
  it('каталоги сообщений остаются на JavaScript, а их объявления лежат в git', () => {
    const tracked = new Set(
      execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n'),
    );
    for (const dir of ['core/messages', 'addons/gltf/messages']) {
      for (const f of fs.readdirSync(path.join(ROOT, dir))) {
        expect(
          f.endsWith('.mts') && !f.endsWith('.d.mts'),
          `${dir}/${f} переведён на TypeScript — правка переводчика будет затёрта сборкой`,
        ).toBe(false);
      }
    }
    for (const d of HANDWRITTEN_DECLARATIONS) {
      expect(tracked.has(d), `${d} не в git — сборка сломается на чистом клоне`).toBe(true);
    }
  });

  it('в установщик едет собранное, а не исходники', () => {
    const files = JSON.parse(read('package.json')).build.files;
    expect(files, 'core больше не кладётся в пакет').toContain('core/**/*');
    expect(files, 'исходники .mts едут в установщик — они там не нужны').toContain('!core/**/*.mts');
    // То же для аддона: у каждой папки с переведёнными модулями должно быть своё
    // исключение, иначе исходники поедут в установщик молча.
    for (const dir of new Set(MODULES.map((m) => m.split('/')[0]))) {
      expect(files, `нет исключения !${dir}/**/*.mts`).toContain(`!${dir}/**/*.mts`);
    }
  });
});

describe('контракт пережил перевод на TypeScript', () => {
  it('собранный модуль отдаёт то же, что и раньше', async () => {
    const c = await import('../core/contract.mjs');
    expect(c.TIER_RANK).toEqual({ provable: 0, numeric: 1, perceptual: 2, lossy: 3 });
    expect(c.AUTOFIX_MAX_TIER).toBe('perceptual');
    expect(c.isKnownTier('numeric')).toBe(true);
    // Ровно то, ради чего isKnownTier заведён: опечатка и пустота не проходят.
    expect(c.isKnownTier('perceptal')).toBe(false);
    expect(c.isKnownTier(undefined)).toBe(false);
    // Наследственные имена не должны считаться уровнями (hasOwnProperty, а не `in`).
    expect(c.isKnownTier('toString')).toBe(false);
    expect(c.ENGINE_META.inputValidation.id).toBe('engine/input-validation');
  });

  // Движок и шов языка переехали 2026-08-11. Здесь — не повторение engine-contract и
  // i18n-discipline (они гоняют весь пайплайн на моделях), а точечная проверка того, что
  // ИМЕННО перевод не съел: ошибки топологической сортировки и откат языка. Обе ветки
  // при переносе получили приведения типов, и обе легко было испортить молча.
  it('движок и шов языка отдают то же, что и раньше', async () => {
    const { orderRules } = await import('../core/engine.mjs');
    const rule = (id, runAfter = []) => ({ meta: { id, runAfter }, analyze: () => [] });

    // Порядок устойчивый: при равенстве зависимостей — порядок массива.
    expect(orderRules([rule('b', ['a']), rule('a')]).map((r) => r.meta.id)).toEqual(['a', 'b']);
    // Опечатка в runAfter — исключение, а не тихо другой порядок (ревью P0.4).
    expect(() => orderRules([rule('a', ['опечатка'])])).toThrow(/unknown runAfter/);
    expect(() => orderRules([rule('a', ['a'])])).toThrow(/depends on itself/);
    expect(() => orderRules([rule('a', ['b']), rule('b', ['a'])])).toThrow(/cycle in runAfter/);

    const { register, render, localizeResult } = await import('../core/i18n.mjs');
    register('en', { 'tst.plain': 'plain {who}', 'tst.fn': ({ who }) => `fn ${who}` });
    register('xx', { 'tst.fn': ({ who }) => `хх ${who}` });
    expect(render('tst.plain', { who: 'A' })).toBe('plain A');
    expect(render('tst.fn', { who: 'A' })).toBe('fn A');
    // Неполный каталог откатывается на английский, а не падает.
    expect(render('tst.plain', { who: 'A' }, 'xx')).toBe('plain A');
    // Вложенная подстановка разворачивается сама (Правило 8: не склеивать в коде).
    expect(render('tst.fn', { who: { messageId: 'tst.plain', data: { who: 'B' } } })).toBe('fn plain B');
    // Ключа нет нигде — это ошибка разработчика, и она громкая.
    expect(() => render('tst.нет')).toThrow(/i18n/);

    // Готовый результат пересобирается на другом языке БЕЗ повторной обработки.
    const result = { applied: [{ text: 'fn A', i18n: { text: { messageId: 'tst.fn', data: { who: 'Б' } } } }] };
    const localized = localizeResult(result, 'xx');
    expect(localized.applied[0].text).toBe('хх Б');
    expect(result.applied[0].text, 'localizeResult обязана быть чистой').toBe('fn A');
  });

  it('сверка baseline ведёт себя как прежде', async () => {
    const { compareBaseline } = await import('../core/contract.mjs');
    const same = compareBaseline({ t: 1 }, { t: 1 }, ['t']);
    expect(same).toEqual([{ level: 'pass', messageId: 'check.baselineMatch', data: { keys: 't' } }]);

    const hard = compareBaseline({ t: 1 }, { t: 2 }, ['t']);
    expect(hard[0].level).toBe('fail');
    expect(hard[0].messageId).toBe('check.baselineHardMismatch');
    // Причина — вложенное сообщение, а не склеенная строка (Правило 8).
    expect(hard[0].data.cause.messageId).toBe('check.cause.writeOnly');

    const soft = compareBaseline({ v: 1 }, { v: 2 }, ['v'], { soft: new Set(['v']) });
    expect(soft[0].level).toBe('info');
    expect(soft[0].messageId).toBe('check.baselineSoftMismatch');
  });
});
