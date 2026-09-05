import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const КОРЕНЬ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const читать = (относительный) => fs.readFileSync(path.join(КОРЕНЬ, относительный), 'utf8');

const ОБВЯЗКА = 'ui/viewer/index.ts';
const КОНТРАКТ = 'ui/viewer/contract.ts';
const ЗАГЛУШКА = 'tests/contract/stub-viewer.ts';
const РЕАЛИЗАЦИЯ = 'ui/viewer/viewer.ts';

function членыКонтракта(текст) {
  const начало = текст.indexOf('export interface ViewerLike {');
  expect(начало, 'в контракте нет интерфейса ViewerLike').toBeGreaterThan(-1);
  const тело = текст.slice(начало, текст.indexOf('\n}', начало));
  const имена = [];
  for (const строка of тело.split('\n')) {
    const m = /^ {2}([A-Za-z_$][\w$]*)\??\s*[(:]/.exec(строка);
    if (m) имена.push(m[1]);
  }
  return имена;
}

describe('шов между обвязкой и движком', () => {
  it('обвязка не приводит вьюер к объектному типу', () => {
    const текст = читать(ОБВЯЗКА);
    const виноватые = текст
      .split('\n')
      .map((строка, i) => [i + 1, строка])
      .filter(([, строка]) => /\bas\s*\{/.test(строка));
    expect(
      виноватые.map(([n, s]) => `${ОБВЯЗКА}:${n}: ${s.trim()}`),
      'приведение к объектному типу обходит контракт: подпись нужно завести в contract.ts',
    ).toEqual([]);
  });

  it('обвязка знает движок только по контракту', () => {
    const текст = читать(ОБВЯЗКА);
    expect(текст).toMatch(/declare viewer: ViewerLike \| null/);
    expect(текст.match(/new Viewer\(/g) ?? [], 'движок создаётся только в таблице VIEWERS')
      .toHaveLength(1);
    expect(текст, 'обвязка не должна зависеть от три.js').not.toMatch(/from ['"]three/);
  });

  it('заглушка объявляет контракт целиком', () => {
    const заглушка = читать(ЗАГЛУШКА);
    expect(заглушка).toMatch(/class StubViewer implements ViewerLike/);
    const объявлен = (имя) =>
      new RegExp(`^ {2}(?:readonly |private |async |override )*${имя}[(:?\\s=]`, 'm').test(заглушка);
    const пропущены = членыКонтракта(читать(КОНТРАКТ)).filter((имя) => !объявлен(имя));
    expect(пропущены, 'заглушка отстала от контракта — эти члены никем не проверены').toEqual([]);
  });

  it('всё, что зовёт обвязка, есть и в контракте, и в настоящем движке', () => {
    const контракт = читать(КОНТРАКТ);
    const движок = читать(РЕАЛИЗАЦИЯ);
    const семь = [
      'setOnBusy', 'densityRange', 'setDensityScale',
      'textureRefs', 'setDiffReference', 'useDiffStore', 'diffScale',
    ];
    const вКонтракте = членыКонтракта(контракт);
    expect(семь.filter((имя) => !вКонтракте.includes(имя))).toEqual([]);
    expect(семь.filter((имя) => !new RegExp(`^ {2}${имя}\\(`, 'm').test(движок))).toEqual([]);
  });

  it('шов проверяется компилятором на каждом typecheck', () => {
    const пакет = JSON.parse(читать('package.json'));
    expect(пакет.scripts.typecheck, 'без этого проекта заглушка не собирается никем')
      .toContain('tsconfig.contract.json');
    const проект = читать('tsconfig.contract.json');
    expect(проект).toContain('"noEmit": true');
    expect(проект).toContain('tests/contract/*.ts');
  });
});
