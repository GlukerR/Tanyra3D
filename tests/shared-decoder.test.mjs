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
