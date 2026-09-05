import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);

describe('вывод сборки не попадает в репозиторий', () => {
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
    let ignored = new Set();
    try {
      ignored = new Set(
        execFileSync('git', ['check-ignore', '--stdin'], {
          cwd: ROOT, encoding: 'utf8', input: outputs.join('\n'),
        }).split(/\r?\n/).filter(Boolean).map((p) => p.split(path.sep).join('/')),
      );
    } catch (e) {
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
