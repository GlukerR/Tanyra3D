import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { optimizeFile } from '../optimize2.mjs';
import addon from '../addons/gltf/index.mjs';

const ЯДРО = ['image/png', 'image/jpeg'];

function разобрать(файл) {
  const buf = fs.readFileSync(файл);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + dv.getUint32(12, true))));
}

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
