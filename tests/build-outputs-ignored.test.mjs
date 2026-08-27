// tests/build-outputs-ignored.test.mjs — вывод сборки не уезжает в репозиторий.
//
// ЗАВЕДЁН 2026-08-26, аудит Ф2. Повод — живая демонстрация: первый же новый модуль
// (`addons/gltf/media.mts`) дал `media.mjs` и `media.d.mts`, и оба ПОПАЛИ в `git add -A`.
// Заметил я это случайно, читая вывод `git status`.
//
// ПОЧЕМУ ПЕРЕЧЕНЬ В `.gitignore` ПОИМЁННЫЙ, А НЕ `core/*.mjs`. Причина настоящая и
// записана там же: рядом с собранными файлами лежат НАСТОЯЩИЕ исходники `.mjs`, ещё не
// переведённые на TypeScript. Маска выбросила бы и их.
//
// ПОЧЕМУ ЗДЕСЬ СТОРОЖ, А НЕ УДАЛЕНИЕ КОПИИ. Правило починки из плана аудита требует
// удалять копию, а не синхронизировать её. Здесь удалить нечем: `.gitignore` ничего не
// вычисляет, он читает строки. Значит единственный доступный инструмент — проверка, и
// это тот редкий случай, когда сторож законен как окончательное решение.
//
// ЧТО ИМЕННО СТЕРЕЖЁМ: у каждого `.mts` в дереве оба его вывода (`.mjs` и `.d.mts`)
// должны игнорироваться git. Забыл строку — красное здесь, а не мусор в репозитории.
//
// ПРОБА НА КРАСНОТУ пройдена: убрал `addons/gltf/media.mjs` из `.gitignore` — краснеет,
// и сообщение называет ровно тот файл, которого не хватает.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);

describe('вывод сборки не попадает в репозиторий', () => {
  // Исходники берём У GIT, а не обходом папки: `node_modules` и `dist-app` полны чужих
  // `.mts`, и обход дал бы тысячи проверок ни о чём.
  const sources = git('ls-files', '*.mts').filter((f) => !f.endsWith('.d.mts'));

  it('исходники на TypeScript вообще найдены', () => {
    expect(sources.length, 'ни одного .mts в индексе — проверка ниже выродилась')
      .toBeGreaterThan(10);
  });

  it('у каждого .mts оба вывода сборки игнорируются', () => {
    const outputs = sources.flatMap((src) => {
      const base = src.replace(/\.mts$/, '');
      return [`${base}.mjs`, `${base}.d.mts`];
    });
    // `check-ignore -n` вернёт непустую строку для тех, что игнорируются; спрашиваем все
    // разом — по одному вызову на файл это сотни процессов.
    let ignored = new Set();
    try {
      ignored = new Set(
        execFileSync('git', ['check-ignore', '--stdin'], {
          cwd: ROOT, encoding: 'utf8', input: outputs.join('\n'),
        }).split(/\r?\n/).filter(Boolean).map((p) => p.split(path.sep).join('/')),
      );
    } catch (e) {
      // check-ignore выходит с кодом 1, когда НИ ОДИН путь не игнорируется — это не сбой.
      if (e.stdout) {
        ignored = new Set(String(e.stdout).split(/\r?\n/).filter(Boolean)
          .map((p) => p.split(path.sep).join('/')));
      }
    }
    const забытые = outputs.filter((o) => !ignored.has(o));
    expect(забытые,
      'эти файлы создаёт `npm run build`, но git их не игнорирует — они уедут в '
      + 'репозиторий при первом же `git add -A`. Допиши их в .gitignore, в поимённый '
      + 'перечень выводов сборки')
      .toEqual([]);
  });
});
