// tests/engine-decoder-marks.test.mjs — знак «нужен декодер» у каждого движка СВОЙ.
//
// Пометка `needsDecoder` в `engines/<id>.json` отвечает на один вопрос: заработает ли эта
// оптимизация на голом сайте, или человеку придётся сначала подключить расшифровщик. Ответ
// у каждого движка свой, и он ЗАМЕРЕН по исходникам, а не взят из документации — по
// документации Meshopt у model-viewer «поддержан», а по коду молчит, пока сайт не задал
// адрес декодера.
//
// Три движка — три разные строки, и ни одна не повторяет другую:
//
//                   Draco          KTX2           Meshopt
//   three.js        нужен          нужен          нужен
//   model-viewer    сразу          сразу          нужен
//   A-Frame         сразу          нужен          нужен
//
// ЗАЧЕМ СТОРОЖ. Списки расширений у трёх движков совпадают по составу до последней строки —
// различаются ТОЛЬКО эти пометки. Такой файл соблазнительно «привести к общему виду»
// копированием, и разница исчезнет молча: человек увидит вопросительный знак у Draco в
// A-Frame (где он работает сам) или не увидит у KTX2 (где он молчит). Ни один другой тест
// этого не заметит — состав-то совпадёт.
//
// Источники замеров, по одному на движок:
//   three.js     — декодеры подключает программист сайта руками, умолчаний нет вовсе;
//   model-viewer — `engines/model-viewer.json`, _comment_decoders (проверено 2026-08-14);
//   A-Frame      — `engines/aframe.json`, _comment_decoders (проверено 2026-09-05):
//                  `src/systems/gltf-model.js`, умолчания адресов и создание загрузчика
//                  только при непустом адресе.
//
// ПРОБА НА КРАСНОТУ (пройдена 2026-09-05): снял пометку с `ktx2` в aframe.json — тест
// назвал движок и расширение.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINES = path.join(ROOT, 'engines');

/** Расширения, про которые вопрос «нужен ли декодер» вообще имеет смысл. */
const СЖАТИЯ = ['draco', 'ktx2', 'meshopt'];

/** Что замерено. Движок, которого здесь нет, тест не трогает — он про эти три. */
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
    // Это и есть причина завести A-Frame отдельным движком, а не переиспользовать
    // three.js: читает он то же самое, а подключает иначе. Разойдись состав — вывод был бы
    // другой, и файл пришлось бы пересматривать целиком.
    const составы = Object.keys(ЗАМЕРЕНО).map((id) =>
      (движок(id).availableExtensions || []).map((e) => e.id).join(','));
    expect(new Set(составы).size, `составы разошлись:\n${составы.join('\n')}`).toBe(1);
  });
});
