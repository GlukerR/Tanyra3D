import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSource } from './helpers/source-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const SCHEME = path.join(ROOT, 'node_modules', 'app-builder-lib', 'scheme.json');
const scheme = fs.existsSync(SCHEME) ? JSON.parse(fs.readFileSync(SCHEME, 'utf8')) : null;

function allowedKeys(defName) {
  const def = scheme && scheme.definitions && scheme.definitions[defName];
  if (!def) return null;
  const out = new Set(Object.keys(def.properties || {}));
  for (const branch of def.allOf || def.anyOf || []) {
    const ref = branch.$ref && branch.$ref.split('/').pop();
    const target = ref && scheme.definitions[ref];
    for (const k of Object.keys((target && target.properties) || branch.properties || {})) out.add(k);
  }
  return out.size ? out : null;
}

describe('Настройка сборки приложения', () => {
  it('внутри build нет посторонних ключей — комментарии живут в корне', () => {
    const strays = Object.keys(pkg.build || {}).filter((k) => k.startsWith('_'));
    expect(strays, `в build попали ключи-комментарии: ${strays.join(', ')}. `
      + 'Корень package.json их терпит, объект build — нет: сборка падает на проверке схемы.')
      .toEqual([]);
  });

  it('ключи build.linux, build.win и build.mac существуют в схеме electron-builder', () => {
    if (!scheme) return;
    const sections = [
      ['linux', 'LinuxConfiguration'],
      ['win', 'WindowsConfiguration'],
      ['mac', 'MacConfiguration'],
    ];
    const unknown = [];
    for (const [key, defName] of sections) {
      const section = (pkg.build || {})[key];
      const allowed = allowedKeys(defName);
      if (!section || !allowed) continue;
      for (const k of Object.keys(section)) {
        if (!allowed.has(k)) unknown.push(`build.${key}.${k}`);
      }
    }
    expect(unknown, `таких ключей у electron-builder нет: ${unknown.join(', ')}. `
      + 'Проверьте, не корневое ли это поле package.json (как desktopName).')
      .toEqual([]);
  });

  it('оболочка и иконка на месте — без них собирать нечего', () => {
    expect(pkg.main, 'package.json.main должен указывать на оболочку').toBe('desktop/main.cjs');
    for (const rel of ['desktop/main.cjs', 'desktop/build/icon.png']) {
      expect(fs.existsSync(path.join(ROOT, rel)), `нет ${rel}`).toBe(true);
    }
  });

  it('у пакета .deb есть сопровождающий с почтой — иначе он не соберётся', () => {
    const who = pkg.build?.linux?.maintainer || pkg.author;
    expect(who, 'ни build.linux.maintainer, ни author не заданы').toBeTruthy();
    expect(String(who), `«${who}» — Debian требует адрес в угловых скобках`).toMatch(/<[^@\s]+@[^>\s]+>/);
  });

  describe('рабочая папка — не внутри программы', () => {
    const serverSrc = readSource('server');
    const shellSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');

    it('сервер берёт адрес рабочей папки из TANYRA_DATA_DIR', () => {
      expect(
        serverSrc,
        'server.mjs больше не спрашивает TANYRA_DATA_DIR — установленная программа снова '
          + 'будет писать рядом с собой и падать с EPERM там, где запись запрещена.',
      ).toMatch(/process\.env\.TANYRA_DATA_DIR/);
    });

    it('загрузки и результаты лежат внутри этой папки, а не рядом с сервером', () => {
      for (const name of ['UPLOADS_DIR', 'RESULTS_DIR']) {
        const line = serverSrc.split('\n').find((l) => l.includes(`const ${name} =`)) || '';
        expect(line, `в server.mjs пропал ${name} — тест устарел, обновить`).toBeTruthy();
        expect(
          line,
          `${name} строится от __dirname: «${line.trim()}». Это папка программы, в установленной `
            + 'сборке она недоступна на запись.',
        ).not.toMatch(/__dirname/);
      }
    });

    it('оболочка эту папку называет — иначе движок вернётся к прежнему поведению', () => {
      expect(
        shellSrc,
        'desktop/main.cjs не задаёт TANYRA_DATA_DIR: сервер откатится на _web рядом с собой.',
      ).toMatch(/TANYRA_DATA_DIR/);
      expect(
        shellSrc,
        'папку данных надо брать у системы (app.getPath(\'userData\')) — на всех трёх системах '
          + 'она своя, и угадывать её путь нельзя.',
      ).toMatch(/getPath\(\s*['"]userData['"]\s*\)/);
    });
  });

  describe('файлы вьюера доезжают до пакета', () => {
    const STRIPPED = /(^|\/)(example|examples|test|tests|__tests__|powered-test|doc|docs)(\/|$)/;

    const vendorRefs = () => {
      const sources = [
        () => fs.readFileSync(path.join(ROOT, 'ui/index.html'), 'utf8'),
        () => readSource('ui/viewer/viewer'),
      ];
      const refs = new Set();
      for (const read of sources) {
        const src = read();
        for (const m of src.matchAll(/\/vendor\/three\/([A-Za-z0-9_./-]*)/g)) {
          if (m[1]) refs.add(m[1].replace(/\/$/, ''));
        }
      }
      return [...refs];
    };

    const copiedByExtraResources = (rel) =>
      (pkg.build?.extraResources || []).some((e) => {
        if (!e || typeof e.from !== 'string' || typeof e.to !== 'string') return false;
        const from = e.from.replace(/\\/g, '/');
        if (rel !== from && !rel.startsWith(from + '/')) return false;
        return e.to.replace(/\\/g, '/') + rel.slice(from.length) === 'app/' + rel;
      });

    it('каждый путь из /vendor/three/ существует в node_modules', () => {
      const refs = vendorRefs();
      expect(refs.length, 'в ui/ не нашлось ни одной ссылки на /vendor/three/ — тест устарел').toBeGreaterThan(0);
      const missing = refs.filter((r) => !fs.existsSync(path.join(ROOT, 'node_modules', 'three', r)));
      expect(missing, `нет в node_modules/three: ${missing.join(', ')}`).toEqual([]);
    });

    it('ни одно правило исключения не режет то, что просит вьюер', async () => {
      const { minimatch } = await import('minimatch');
      const excludes = (pkg.build?.files || [])
        .filter((p) => typeof p === 'string' && p.startsWith('!'))
        .map((p) => p.slice(1));

      const cut = [];
      for (const ref of vendorRefs()) {
        const rel = 'node_modules/three/' + ref;
        if (STRIPPED.test(ref)) continue;
        for (const pattern of excludes) {
          if (minimatch(rel, pattern, { dot: true })) cut.push(`${rel} ← «!${pattern}»`);
        }
      }
      expect(cut, `эти правила вырезают файлы, которые грузит вьюер:\n  ${cut.join('\n  ')}`).toEqual([]);
    });

    it('правила исключения three.js действительно что-то находят', async () => {
      const { minimatch } = await import('minimatch');
      const three = path.join(ROOT, 'node_modules', 'three');
      if (!fs.existsSync(three)) return;

      const all = [];
      const walk = (dir, prefix) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix + e.name;
          if (e.isDirectory()) walk(path.join(dir, e.name), rel + '/');
          else all.push('node_modules/three/' + rel);
        }
      };
      walk(three, '');

      const idle = (pkg.build?.files || [])
        .filter((p) => typeof p === 'string' && p.startsWith('!node_modules/three/'))
        .map((p) => p.slice(1))
        .filter((pattern) => !all.some((f) => minimatch(f, pattern, { dot: true })));

      expect(idle, `эти правила не совпали ни с одним файлом three — опечатка? ${idle.join(', ')}`).toEqual([]);
    });

    it('каждая папка данных, которую читает движок, попадает в пакет', async () => {
      const { minimatch } = await import('minimatch');
      const src = readSource('assistant');
      const dirs = [...src.matchAll(/path\.join\(BASE_DIR,\s*'([^']+)'\)/g)].map((m) => m[1]);
      expect(dirs.length, 'в assistant.mjs не нашлось ни одной папки данных — сторож ослеп').toBeGreaterThan(0);

      const files = (pkg.build?.files || []).filter((p) => typeof p === 'string' && !p.startsWith('!'));
      const забыты = [...new Set(dirs)].filter((d) => {
        if (!fs.existsSync(path.join(ROOT, d))) return false;
        return !files.some((pattern) => minimatch(`${d}/x.json`, pattern, { dot: true }));
      });
      expect(
        забыты,
        `эти папки движок читает, а в пакет они не попадут: ${забыты.join(', ')}. `
          + 'Добавить «<папка>/**/*» в build.files. Локально отказ незаметен — папка лежит рядом с кодом.',
      ).toEqual([]);
    });

    it('lock-файл говорит о версии и Node то же, что манифест', () => {
      const lockPath = path.join(ROOT, 'package-lock.json');
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const root = lock.packages && lock.packages[''];
      expect(root, 'в lock-файле нет корневой записи packages[""]').toBeTruthy();

      expect(lock.version, 'lock.version разошлась с package.json').toBe(pkg.version);
      expect(root.version, 'packages[""].version разошлась с package.json').toBe(pkg.version);
      expect(root.name).toBe(pkg.name);
      expect(root.engines, 'engines в lock-файле разошлись с package.json').toEqual(pkg.engines);
    });

    it('пути из выбрасываемых папок возвращены через extraResources', () => {
      const unpackaged = vendorRefs()
        .filter((r) => STRIPPED.test(r))
        .filter((r) => !copiedByExtraResources('node_modules/three/' + r));
      expect(
        unpackaged,
        `electron-builder вырежет это из пакета, а вьюер без них не запустится: ${unpackaged.join(', ')}. `
          + 'Добавить в build.extraResources копию с адресом «app/<тот же путь>» — в files добавлять бесполезно, '
          + 'правило-умолчание выбрасывает саму папку, и обход внутрь неё не заходит.',
      ).toEqual([]);
    });
  });
});
