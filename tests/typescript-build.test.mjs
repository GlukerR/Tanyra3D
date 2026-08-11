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
  for (const dir of ['core']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (f.endsWith('.mts') && !f.endsWith('.d.mts')) out.push(`${dir}/${f.slice(0, -4)}`);
    }
  }
  return out;
}

const MODULES = migratedModules();

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

  it('в установщик едет собранное, а не исходники', () => {
    const files = JSON.parse(read('package.json')).build.files;
    expect(files, 'core больше не кладётся в пакет').toContain('core/**/*');
    expect(files, 'исходники .mts едут в установщик — они там не нужны').toContain('!core/**/*.mts');
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
