import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINES = path.join(ROOT, 'engines');

const СЖАТИЯ = ['draco', 'ktx2', 'meshopt'];

const ЗАМЕРЕНО = {
  threejs: { draco: true, ktx2: true, meshopt: true },
  'model-viewer': { draco: false, ktx2: false, meshopt: true },
  aframe: { draco: false, ktx2: true, meshopt: true },
};

function движок(id) {
  const файл = path.join(ENGINES, `${id}.json`);
  expect(fs.existsSync(файл), `нет engines/${id}.json`).toBe(true);
  return JSON.parse(fs.readFileSync(файл, 'utf8'));
}

describe('знак «нужен декодер» замерен у каждого движка отдельно', () => {
  for (const [id, ожидание] of Object.entries(ЗАМЕРЕНО)) {
    it(`${id} — пометки стоят там, где замерено`, () => {
      const список = движок(id).availableExtensions || [];
      for (const имя of СЖАТИЯ) {
        const запись = список.find((e) => e.id === имя);
        expect(запись, `${id}: в списке нет ${имя}`).toBeTruthy();
        expect(
          запись.needsDecoder === true,
          ожидание[имя]
            ? `${id}: у ${имя} пропала пометка «нужен декодер» — а он молчит, пока сайт не подключит расшифровщик`
            : `${id}: у ${имя} появилась пометка «нужен декодер» — а он работает сам, и знак отпугнёт зря`,
        ).toBe(ожидание[имя]);
      }
    });
  }

  it('три движка дают три РАЗНЫЕ строки, а не одну втройне', () => {
    const строки = Object.keys(ЗАМЕРЕНО).map((id) => {
      const список = движок(id).availableExtensions || [];
      return СЖАТИЯ.map((имя) => (list(список, имя) ? '1' : '0')).join('');
    });
    expect(new Set(строки).size, `строки совпали: ${строки.join(' / ')} — значит замер потерян`)
      .toBe(строки.length);
    function list(список, имя) {
      const e = список.find((x) => x.id === имя);
      return e && e.needsDecoder === true;
    }
  });

  it('состав расширений у них ОДИНАКОВ — различие только в пометках', () => {
    const составы = Object.keys(ЗАМЕРЕНО).map((id) =>
      (движок(id).availableExtensions || []).map((e) => e.id).join(','));
    expect(new Set(составы).size, `составы разошлись:\n${составы.join('\n')}`).toBe(1);
  });
});
