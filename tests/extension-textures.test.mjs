// tests/extension-textures.test.mjs — WebP и KTX2 лежат в расширении, а не в основном source.
//
// ДЕФЕКТ, найденный Александром 2026-09-03: «TEXTURE_INVALID_IMAGE_MIME_TYPE … /textures/6/source.
// Как мы могли создать новую ошибку при оптимизации? Это что вообще за ужас».
//
// Он прав: исходник валидатор проходил, наш файл — нет. Ядро спецификации знает у текстуры
// ровно два формата, PNG и JPEG; WebP и KTX2 подключаются расширением и ссылаются на
// картинку ИЗНУТРИ него. Наш файл оставил одну текстуру с `source` на WebP.
//
// ПРИЧИНА — В БИБЛИОТЕКЕ, а не в правиле. `EXT_texture_webp.write()` перекладывает ссылки
// по списку записей текстур, существующих НА ТОТ МОМЕНТ, а записи создаются лениво: кто
// первый сослался, тот и создал. Текстуру, на которую смотрит только другое расширение
// материала, создаёт это расширение — то есть ПОЗЖЕ, и перекладчик её уже не видит.
// Прослежено на `DiffuseTransmissionPlant` (`_work/webp-trace.mjs`): записей шесть,
// текстур семь.
//
// Задевает это весь современный PBR: diffuse_transmission, specular, sheen, clearcoat,
// transmission, volume, iridescence, anisotropy — у каждого свои текстурные слоты. Поэтому
// сторож смотрит не на одну модель, а на ЛЮБУЮ, где есть текстуры расширений.
//
// ПРОБА НА КРАСНОТУ (пройдена 2026-09-04): выключил `fixExtensionTextures` в
// `addons/gltf/index.mts` — тест назвал `textures/6` и модель поимённо.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { optimizeFile } from '../optimize2.mjs';
import addon from '../addons/gltf/index.mjs';

/** Форматы, которые ЯДРО спецификации допускает у `textures[].source`. */
const ЯДРО = ['image/png', 'image/jpeg'];

function разобрать(файл) {
  const buf = fs.readFileSync(файл);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + dv.getUint32(12, true))));
}

/**
 * Модель с текстурой, на которую ссылается ТОЛЬКО расширение материала.
 *
 * Ровно тот случай, что ломался. Модель из золотого корпуса — не выдумка: важно, что
 * такие файлы приходят от людей, а не собираются в тесте.
 */
const МОДЕЛЬ = 'fixtures/models/DiffuseTransmissionPlant.glb';
const естьМодель = fs.existsSync(МОДЕЛЬ);

describe.skipIf(!естьМодель)('текстуры расширений остаются валидными', () => {
  it('после сборки в WebP ни одна текстура не осталась в основном source', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-tex-'));
    try {
      const opts = addon.normalizeOpts({ advancedFeatures: ['webp'], webpQuality: 60, outDir });
      const r = await optimizeFile(МОДЕЛЬ, { ...opts, outDir, log: () => {} });
      expect(r.status, 'сборка не прошла — проверять нечего').toBe('ok');

      const json = разобрать(path.join(outDir, path.basename(МОДЕЛЬ)));
      // Сторож самому себе: если WebP не применился, «нарушений нет» ничего не значит.
      expect(
        (json.images || []).some((i) => i.mimeType === 'image/webp'),
        'в файле нет ни одной WebP-картинки: проверка вышла пустой',
      ).toBe(true);

      const нарушители = (json.textures || [])
        .map((t, i) => ({ i, mime: (json.images || [])[t.source]?.mimeType, есть: t.source !== undefined }))
        .filter((x) => x.есть && !ЯДРО.includes(x.mime))
        .map((x) => `textures/${x.i} → ${x.mime}`);
      expect(
        нарушители,
        'ядро спецификации знает у текстуры только PNG и JPEG; всё прочее обязано ссылаться '
        + 'на картинку изнутри своего расширения. Валидатор отвечает на это '
        + 'TEXTURE_INVALID_IMAGE_MIME_TYPE, то есть мы отдали человеку сломанный файл',
      ).toEqual([]);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 120000);

  it('расширение объявлено в extensionsUsed', async () => {
    // Ссылка изнутри расширения без объявления — такая же ложь, только с другой стороны.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-tex-used-'));
    try {
      const opts = addon.normalizeOpts({ advancedFeatures: ['webp'], webpQuality: 60, outDir });
      await optimizeFile(МОДЕЛЬ, { ...opts, outDir, log: () => {} });
      const json = разобрать(path.join(outDir, path.basename(МОДЕЛЬ)));
      const нужно = (json.textures || []).some((t) => t.extensions?.EXT_texture_webp);
      expect(нужно, 'ни одна текстура не пользуется расширением: проверка вышла пустой').toBe(true);
      expect(json.extensionsUsed || [], 'расширение используется, но не объявлено')
        .toContain('EXT_texture_webp');
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 120000);
});
