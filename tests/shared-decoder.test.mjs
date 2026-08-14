// tests/shared-decoder.test.mjs — сторож общего декодера Draco.
//
// Вопрос Александра 2026-08-14: «у нас будет два декодера драко и все остальные будут
// складываться для байбилона?» Ответ — нет: тяжёлый WASM у Draco один и тот же, и это
// проверено побайтно (SHA-256), а не на глаз. Здесь стоит сторож этого факта.
//
// Что именно сторожим. Файл внутри пакета three.js совпадает с тем, что Babylon.js
// просит у своего CDN под другим именем. Пока совпадает — второй копии в поставке не
// нужно. Разойдутся (каждый движок обновляет вложенные декодеры по своему расписанию) —
// общий файл начнёт молча отдавать одному из движков не тот декодер, а такие поломки
// выясняются на чужой машине и выглядят как «модель не открывается».
//
// В сеть тест НЕ ходит: набор обязан проходить без интернета. Сверка с чужим CDN —
// работа человека при обновлении зависимости; здесь проверяется, что файл на диске
// остался тем самым.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'scripts', 'shared-decoders.json'), 'utf8'),
);

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('общие декодеры: один файл на два движка', () => {
  it('в таблице есть хотя бы одна запись — иначе сторож ничего не сторожит', () => {
    expect(Array.isArray(manifest.decoders)).toBe(true);
    expect(manifest.decoders.length).toBeGreaterThan(0);
  });

  for (const dec of manifest.decoders) {
    describe(dec.id, () => {
      const file = path.join(ROOT, dec.ours);

      it('файл на месте', () => {
        expect(fs.existsSync(file), `${dec.ours} пропал — переустановить зависимости`).toBe(true);
      });

      it('размер тот же', () => {
        expect(fs.statSync(file).size).toBe(dec.bytes);
      });

      it('хеш тот же — значит его по-прежнему можно отдавать обоим движкам', () => {
        // Покраснело — НЕ подгонять число под новое. Скачать у второго движка то, что он
        // просит сегодня (`sourceCheckedAgainst`), сравнить с этим файлом и решить заново:
        // разошлись — везти обе копии; совпали — обновить запись и дату проверки.
        expect(
          sha256(file),
          `${dec.ours} изменился. Он отдаётся и как «${dec.alsoServedAs}» — прежде чем ` +
          `править хеш, сверить с ${dec.sourceCheckedAgainst} и решить, общий ли файл ещё.`,
        ).toBe(dec.sha256);
      });
    });
  }

  it('у таблицы есть дата проверки — запись без даты выдаёт себя за вечную', () => {
    expect(manifest.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
