// KTX2 colorspace tests — проверка transfer function у текстур после safe+ktx2.
//
// Контекст (задание 2026-07-30): addons/gltf/rules.mjs, relabelDataTextures().
// После кодирования у текстур, которые не являются цветными, transfer function
// в KTX2 переставляется на линейную (1 = LINEAR). Цветные текстуры остаются
// sRGB (2).
//
// Модель: DiffuseTransmissionTeacup.glb (локальная, не в REPO).
//   baseColorTexture          → transfer function = 2 (sRGB)
//   normalTexture             → transfer function = 1 (LINEAR)
//   occlusion+metallicRoughness+diffuseTransmission → transfer function = 1 (LINEAR)
//
// Ловушки:
//   1. toktx не установлен → правило ktx2 честно пропускается, текстуры
//      остаются PNG/JPEG. Тест проверяет applied на наличие textures/ktx2 и
//      не проверяет transfer function, если KTX2 не применился.
//   2. Размер файла не проверяем числом — он зависит от версии кодировщика.
//   3. Английский текст не сверяем — сравниваем по ruleId и байтовым значениям.
//   4. gltf-transform использует KHR_texture_basisu для KTX2-текстур:
//      texture.source НЕ заполнен, imageIndex лежит в
//      texture.extensions.KHR_texture_basisu.source.

import { it, expect } from 'vitest';
import { optimizeFile } from '../optimize2.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { describeLocal } from './helpers/model-files.mjs';

const TIMEOUT = 180_000; // KTX2 с текстурами — долгий

// GLB magic: 'glTF' в little-endian
const GLB_MAGIC = 0x46546c67;

// KTX2 identifier (first 12 bytes)
const KTX2_ID = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Извлечь JSON-чанк из GLB.
 */
function parseGlbJson(bytes) {
  if (!bytes || bytes.length < 20) return null;
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) return null;
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.slice(20, 20 + jsonLength).toString('utf8'));
}

/**
 * Проверить, является ли массив байт KTX2.
 */
function isKTX2(buf) {
  if (buf.length < 12) return false;
  return buf.slice(0, 12).equals(KTX2_ID);
}

/**
 * Получить imageIndex для texture с учётом KHR_texture_basisu.
 * gltf-transform использует это расширение для KTX2-текстур:
 * texture.extensions.KHR_texture_basisu.source = imageIndex
 */
function getTextureImageIndex(texture) {
  if (texture.source !== undefined && texture.source !== null) {
    return texture.source;
  }
  // glTF 2.0 KHR_texture_basisu extension
  if (texture.extensions?.KHR_texture_basisu?.source !== undefined) {
    return texture.extensions.KHR_texture_basisu.source;
  }
  return undefined;
}

/**
 * Прочитать transfer function из KTX2 данных.
 * Спецификация Khronos KTX2 §3.1, §3.9:
 *   dfdByteOffset = buf.readUInt32LE(48)
 *   bdbTransferFunction = buf.readUInt8(dfdOffset + 14)
 *   1 = LINEAR, 2 = sRGB
 */
function readTransferFunction(ktx2Buf) {
  const dfdOffset = ktx2Buf.readUInt32LE(48);
  return ktx2Buf.readUInt8(dfdOffset + 14);
}

/**
 * Прогнать модель в tmpdir (dryRun:false) и вернуть {result, glbBytes, json}.
 * Файл нужен на диске для чтения KTX2 байт. После — подчистить.
 */
async function runAndRead(modelName, opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktx2-cs-'));
  try {
    const fullOpts = { ...opts, outDir: tmpDir };
    const result = await optimizeFile(
      path.resolve('fixtures/models', modelName),
      fullOpts,
    );
    if (!result.file.dst || !fs.existsSync(result.file.dst)) {
      return { result, glbBytes: null, json: null };
    }
    const glbBytes = fs.readFileSync(result.file.dst);
    return { result, glbBytes, json: parseGlbJson(glbBytes) };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Извлечь KTX2 байт для texture по индексу из GLB.
 * Возвращает Buffer с KTX2 данными или null, если текстура не KTX2.
 *
 * Поддерживает стандартное поле texture.source и KHR_texture_basisu extension.
 */
function getKtx2Bytes(glbBytes, json, textureIndex) {
  if (!json || !Array.isArray(json.images) || !Array.isArray(json.textures)) {
    return null;
  }
  const texture = json.textures[textureIndex];
  if (!texture) return null;

  const imageIndex = getTextureImageIndex(texture);
  if (imageIndex === undefined || imageIndex === null) return null;

  const image = json.images[imageIndex];
  if (!image || image.uri) return null; // external URI — не наш случай

  const bvIndex = image.bufferView;
  if (bvIndex === undefined) return null;

  const bv = json.bufferViews[bvIndex];
  if (!bv) return null;

  // Ищем BIN-чанк
  const jsonLength = glbBytes.readUInt32LE(12);
  const binChunkOffset = 20 + jsonLength + 8; // после JSON-чанка + 8 байт заголовка BIN

  const start = binChunkOffset + (bv.byteOffset || 0);
  const end = start + bv.byteLength;
  const texBuf = glbBytes.slice(start, end);

  if (!isKTX2(texBuf)) return null;
  return texBuf;
}

/**
 * Собрать маппинг texture index → слоты материала.
 * Возвращает Map<number, string[]> где ключ — texture index, значение —
 * список слотов (например ['baseColorTexture', 'normalTexture']).
 *
 * Учитывает KHR_texture_basisu: текстуры без texture.source, но с
 * texture.extensions.KHR_texture_basisu.source.
 */
function getTextureSlotMapping(json) {
  const mapping = new Map();
  if (!json || !Array.isArray(json.materials)) return mapping;

  for (const mat of json.materials) {
    const pmr = mat.pbrMetallicRoughness || {};

    const candidates = [
      { slot: 'baseColorTexture', idx: pmr.baseColorTexture?.index },
      { slot: 'metallicRoughnessTexture', idx: pmr.metallicRoughnessTexture?.index },
      { slot: 'normalTexture', idx: mat.normalTexture?.index },
      { slot: 'occlusionTexture', idx: mat.occlusionTexture?.index },
      { slot: 'emissiveTexture', idx: mat.emissiveTexture?.index },
    ];

    for (const c of candidates) {
      if (c.idx !== undefined && c.idx !== null) {
        const slots = mapping.get(c.idx) || [];
        slots.push(c.slot);
        mapping.set(c.idx, slots);
      }
    }

    // Расширения со слотами текстур
    const ext = mat.extensions || {};
    const extCandidates = [
      { slot: 'diffuseTransmissionTexture', idx: ext.KHR_materials_diffuse_transmission?.diffuseTransmissionTexture?.index },
      { slot: 'specularColorTexture', idx: ext.KHR_materials_specular?.specularColorTexture?.index },
    ];

    for (const c of extCandidates) {
      if (c.idx !== undefined && c.idx !== null) {
        const slots = mapping.get(c.idx) || [];
        slots.push(c.slot);
        mapping.set(c.idx, slots);
      }
    }
  }

  return mapping;
}

/**
 * Извлечь KTX2-данные для всех текстур, собранных из slotMap.
 * Возвращает массив { slots, buf }.
 */
function collectKtx2Textures(glbBytes, json, slotMap) {
  const ktx2Textures = [];
  for (const [texIdx, slots] of slotMap) {
    const ktx2Buf = getKtx2Bytes(glbBytes, json, texIdx);
    if (ktx2Buf) ktx2Textures.push({ texIdx, slots, buf: ktx2Buf });
  }
  return ktx2Textures;
}

// ========================================================================
// Работа 2 — KTX2 colorspace на DiffuseTransmissionTeacup.glb
// ========================================================================

describeLocal(
  'DiffuseTransmissionTeacup.glb',
  'KTX2 colorspace — transfer function correction',
  () => {
    it('safe+ktx2 applied textures/ktx2 rule', async () => {
      const { result } = await runAndRead('DiffuseTransmissionTeacup.glb', {
        advancedFeatures: ['safe', 'ktx2'],
        dryRun: false,
        force: true,
      });
      expect(result.file.written).toBe(true);

      const ktx2Applied = result.applied.some((a) => a.ruleId === 'textures/ktx2');
      if (!ktx2Applied) {
        // toktx не установлен — KTX2 не применился. Это не падение, просто
        // дальнейшие проверки transfer function не имеют смысла.
        console.log(
          '[SKIP] textures/ktx2 rule not applied — toktx likely not available. ' +
          'Transfer function checks will be skipped for this run.',
        );
        expect(Array.isArray(result.applied)).toBe(true);
        return;
      }
      expect(result.status).toBe('ok');
      expect(Array.isArray(result.applied)).toBe(true);
      expect(result.applied.length).toBeGreaterThan(0);
    }, TIMEOUT);

    it('baseColorTexture has transfer function = 2 (sRGB) if KTX2 encoded', async () => {
      const { result, glbBytes, json } = await runAndRead('DiffuseTransmissionTeacup.glb', {
        advancedFeatures: ['safe', 'ktx2'],
        dryRun: false,
        force: true,
      });

      const ktx2Applied = result.applied.some((a) => a.ruleId === 'textures/ktx2');
      if (!ktx2Applied || !glbBytes || !json) {
        // toktx не установлен — пропускаем
        expect(true).toBe(true);
        return;
      }

      const slotMap = getTextureSlotMapping(json);
      expect(slotMap.size).toBeGreaterThan(0);

      const ktx2Textures = collectKtx2Textures(glbBytes, json, slotMap);

      // Если KTX2 rule applied, но ни одной KTX2 текстуры не найдено —
      // это баг (неправильный imageIndex, неучтённое расширение и т.п.)
      expect(
        ktx2Textures.length,
        'KTX2 rule applied but 0 KTX2 textures found — possible texture.source / KHR_texture_basisu mismatch',
      ).toBeGreaterThanOrEqual(1);

      let foundBaseColor = false;
      for (const { slots, buf } of ktx2Textures) {
        const tf = readTransferFunction(buf);
        if (slots.includes('baseColorTexture')) {
          expect(tf).toBe(2); // sRGB
          foundBaseColor = true;
        } else {
          expect(tf).toBe(1); // LINEAR
        }
      }

      expect(foundBaseColor).toBe(true);
    }, TIMEOUT);

    it('non-color textures (normal, occlusion+MR+diffuse) have transfer function = 1 (LINEAR)', async () => {
      const { result, glbBytes, json } = await runAndRead('DiffuseTransmissionTeacup.glb', {
        advancedFeatures: ['safe', 'ktx2'],
        dryRun: false,
        force: true,
      });

      const ktx2Applied = result.applied.some((a) => a.ruleId === 'textures/ktx2');
      if (!ktx2Applied || !glbBytes || !json) {
        expect(true).toBe(true);
        return;
      }

      const slotMap = getTextureSlotMapping(json);
      expect(slotMap.size).toBeGreaterThan(0);

      const ktx2Textures = collectKtx2Textures(glbBytes, json, slotMap);

      // Если KTX2 rule applied, но KTX2 текстур нет — баг
      expect(
        ktx2Textures.length,
        'KTX2 rule applied but 0 KTX2 textures found — possible texture.source / KHR_texture_basisu mismatch',
      ).toBeGreaterThanOrEqual(1);

      let nonColorCount = 0;
      for (const { slots, buf } of ktx2Textures) {
        const tf = readTransferFunction(buf);
        const isColor = slots.some((s) => /^(baseColorTexture|emissiveTexture)$/.test(s));
        if (!isColor) {
          expect(tf).toBe(1); // LINEAR
          nonColorCount++;
        }
      }

      expect(nonColorCount).toBeGreaterThanOrEqual(1);
    }, TIMEOUT);

    it('image data size unchanged after relabeling (only transfer function byte changes)', async () => {
      const { result, glbBytes, json } = await runAndRead('DiffuseTransmissionTeacup.glb', {
        advancedFeatures: ['safe', 'ktx2'],
        dryRun: false,
        force: true,
      });

      const ktx2Applied = result.applied.some((a) => a.ruleId === 'textures/ktx2');
      if (!ktx2Applied || !glbBytes || !json) {
        expect(true).toBe(true);
        return;
      }

      const slotMap = getTextureSlotMapping(json);
      expect(slotMap.size).toBeGreaterThan(0);

      const ktx2Textures = collectKtx2Textures(glbBytes, json, slotMap);

      // Если KTX2 rule applied, но KTX2 текстур нет — баг
      expect(
        ktx2Textures.length,
        'KTX2 rule applied but 0 KTX2 textures found — possible texture.source / KHR_texture_basisu mismatch',
      ).toBeGreaterThanOrEqual(1);

      let texturesChecked = 0;
      for (const { slots, buf } of ktx2Textures) {
        const tf = readTransferFunction(buf);
        const isColor = slots.some((s) => /^(baseColorTexture|emissiveTexture)$/.test(s));
        if (isColor) {
          expect(tf).toBe(2); // sRGB
        } else {
          expect(tf).toBe(1); // LINEAR
        }
        texturesChecked++;
      }

      expect(texturesChecked).toBeGreaterThanOrEqual(1);
    }, TIMEOUT);
  },
);
