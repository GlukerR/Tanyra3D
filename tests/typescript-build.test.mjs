import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function readTsconfig() {
  const raw = read('tsconfig.json');
  const noComments = raw.replace(/^\s*\/\/[^\n]*$/gm, '');
  return JSON.parse(noComments);
}

function migratedModules() {
  const out = [];
  for (const dir of ['.', 'core', 'addons/gltf']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (!f.endsWith('.mts') || f.endsWith('.d.mts')) continue;
      const base = f.slice(0, -4);
      out.push(dir === '.' ? base : `${dir}/${base}`);
    }
  }
  return out;
}

function migratedUiModules() {
  const out = [];
  for (const dir of ['ui', 'ui/viewer']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (!f.endsWith('.ts') || f.endsWith('.d.ts')) continue;
      out.push(`${dir}/${f.slice(0, -3)}`);
    }
  }
  return out;
}

const UI_MODULES = migratedUiModules();

const MODULES = migratedModules();

const HANDWRITTEN_DECLARATIONS = [
  'core/messages/en.d.mts',
  'core/messages/ru.d.mts',
  'addons/gltf/messages/en.d.mts',
  'addons/gltf/messages/ru.d.mts',
  'messages/en.d.mts',
  'messages/ru.d.mts',
  'types/externals.d.mts',
  'ui/globals.d.ts',
  'ui/dto.d.ts',
];

describe('слой TypeScript', () => {
  it('переведён хотя бы один модуль — иначе проверки ниже пусты', () => {
    expect(MODULES.length, 'в core нет ни одного .mts').toBeGreaterThan(0);
  });

  it('собранное не лежит в git — источник один', () => {
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
    expect(o.noEmitOnError, 'noEmitOnError выключен').toBe(true);
    expect(o.verbatimModuleSyntax, 'verbatimModuleSyntax выключен').toBe(true);
  });

  it('сборка привязана к установке, а типы проверяются в CI', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts.build, 'нет команды build').toBeTruthy();
    expect(pkg.scripts.typecheck, 'нет команды typecheck').toBeTruthy();
    expect(pkg.scripts.prepare, 'сборка не висит на prepare — после npm ci модулей не будет').toMatch(/tsc/);

    const test = read('.github', 'workflows', 'test.yml');
    expect(test, 'CI не проверяет типы').toMatch(/npm run typecheck/);
  });

  it('каталоги сообщений остаются на JavaScript, а их объявления лежат в git', () => {
    const tracked = new Set(
      execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n'),
    );
    for (const dir of ['core/messages', 'addons/gltf/messages', 'messages']) {
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

  it('браузерный слой собирается своим проектом и по тем же правилам', () => {
    expect(UI_MODULES.length, 'в ui нет ни одного .ts').toBeGreaterThan(0);

    const tracked = new Set(
      execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n'),
    );
    const ignore = read('.gitignore');
    for (const m of UI_MODULES) {
      expect(tracked.has(`${m}.ts`), `${m}.ts не в git — источник потеряется`).toBe(true);
      expect(tracked.has(`${m}.js`), `${m}.js в git — собранное учитывать не надо`).toBe(false);
      expect(ignore.includes(`${m}.js`), `${m}.js не закрыт в .gitignore`).toBe(true);
      expect(fs.existsSync(path.join(ROOT, `${m}.js`)), `нет ${m}.js — не выполнен npm run build`).toBe(true);
    }

    const rawUi = read('tsconfig.ui.json').replace(/^\s*\/\/[^\n]*$/gm, '');
    const ui = JSON.parse(rawUi);
    expect(ui.compilerOptions.strict, 'strict выключен в браузерном проекте').toBe(true);
    expect(ui.compilerOptions.noEmitOnError, 'noEmitOnError выключен в браузерном проекте').toBe(true);
    expect(ui.compilerOptions.lib.join(','), 'без DOM браузерный слой не соберётся').toMatch(/dom/i);
    expect(ui.compilerOptions.types, 'в браузерный проект подключены типы Node').toEqual([]);

    const files = JSON.parse(read('package.json')).build.files;
    expect(files, 'исходники интерфейса едут в установщик').toContain('!ui/**/*.ts');

    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts.build, 'npm run build не собирает браузерный слой').toMatch(/tsconfig\.ui\.json/);
    expect(pkg.scripts.typecheck, 'npm run typecheck не проверяет браузерный слой').toMatch(/tsconfig\.ui\.json/);
  });

  it('в установщик едет собранное, а не исходники', () => {
    const files = JSON.parse(read('package.json')).build.files;
    expect(files, 'core больше не кладётся в пакет').toContain('core/**/*');
    expect(files, 'исходники .mts едут в установщик — они там не нужны').toContain('!core/**/*.mts');
    expect(files, 'объявления типов каталогов едут в установщик').toContain('!messages/**/*.mts');
    for (const m of MODULES) {
      if (!m.includes('/')) {
        expect(files, `корневой ${m}.mjs не кладётся в пакет`).toContain(`${m}.mjs`);
        expect(files, `в пакет попадёт исходник ${m}.mts`).not.toContain(`${m}.mts`);
        continue;
      }
      const dir = m.split('/')[0];
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
    expect(c.isKnownTier('perceptal')).toBe(false);
    expect(c.isKnownTier(undefined)).toBe(false);
    expect(c.isKnownTier('toString')).toBe(false);
    expect(c.ENGINE_META.inputValidation.id).toBe('engine/input-validation');
  });

  it('движок и шов языка отдают то же, что и раньше', async () => {
    const { orderRules } = await import('../core/engine.mjs');
    const rule = (id, runAfter = []) => ({ meta: { id, runAfter }, analyze: () => [] });

    expect(orderRules([rule('b', ['a']), rule('a')]).map((r) => r.meta.id)).toEqual(['a', 'b']);
    expect(() => orderRules([rule('a', ['опечатка'])])).toThrow(/unknown runAfter/);
    expect(() => orderRules([rule('a', ['a'])])).toThrow(/depends on itself/);
    expect(() => orderRules([rule('a', ['b']), rule('b', ['a'])])).toThrow(/cycle in runAfter/);

    const { register, render, localizeResult } = await import('../core/i18n.mjs');
    register('en', { 'tst.plain': 'plain {who}', 'tst.fn': ({ who }) => `fn ${who}` });
    register('xx', { 'tst.fn': ({ who }) => `хх ${who}` });
    expect(render('tst.plain', { who: 'A' })).toBe('plain A');
    expect(render('tst.fn', { who: 'A' })).toBe('fn A');
    expect(render('tst.plain', { who: 'A' }, 'xx')).toBe('plain A');
    expect(render('tst.fn', { who: { messageId: 'tst.plain', data: { who: 'B' } } })).toBe('fn plain B');
    expect(() => render('tst.нет')).toThrow(/i18n/);

    const result = { applied: [{ text: 'fn A', i18n: { text: { messageId: 'tst.fn', data: { who: 'Б' } } } }] };
    const localized = localizeResult(result, 'xx');
    expect(localized.applied[0].text).toBe('хх Б');
    expect(result.applied[0].text, 'localizeResult обязана быть чистой').toBe('fn A');
  });

  it('сверка baseline ведёт себя как прежде', async () => {
    const { compareBaseline } = await import('../core/contract.mjs');
    const same = compareBaseline({ t: 1 }, { t: 1 }, ['t']);
    expect(same).toEqual([{ level: 'pass', messageId: 'check.baselineMatch', data: {} }]);

    const logged = [];
    const hard = compareBaseline({ t: 1 }, { t: 2 }, ['t'], { log: (m) => logged.push(m) });
    expect(hard[0].level).toBe('fail');
    expect(hard[0].messageId).toBe('check.baselineHardMismatch');
    expect(hard[0].data.cause, 'причина вернулась в отчёт').toBeUndefined();
    expect(
      logged.some((m) => m.includes('HARD MISMATCH') && m.includes('likely cause')),
      'разбор не попал ни в отчёт, ни в журнал — он исчез',
    ).toBe(true);

    const soft = compareBaseline({ vertices: 1 }, { vertices: 2 }, ['vertices'], { soft: new Set(['vertices']) });
    expect(soft[0].level).toBe('info');
    expect(soft[0].messageId).toBe('check.baselineSoftMismatch');
    expect(soft[0].data.k, 'имя метрики снова подставляется как есть').toEqual({
      messageId: 'metric.vertices', data: {},
    });
    const odd = compareBaseline({ zzz: 1 }, { zzz: 2 }, ['zzz'], { soft: new Set(['zzz']) });
    expect(odd[0].data.k).toBe('zzz');
  });
});
