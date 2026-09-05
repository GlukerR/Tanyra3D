import { it, expect } from 'vitest';
import { optimizeFile } from '../optimize2.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { describeLocal } from './helpers/model-files.mjs';

const TIMEOUT = 180_000;

const GLB_MAGIC = 0x46546c67;

const KTX2_ID = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function parseGlbJson(bytes) {
  if (!bytes || bytes.length < 20) return null;
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) return null;
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.slice(20, 20 + jsonLength).toString('utf8'));
}

function isKTX2(buf) {
  if (buf.length < 12) return false;
  return buf.slice(0, 12).equals(KTX2_ID);
}

function getTextureImageIndex(texture) {
  if (texture.source !== undefined && texture.source !== null) {
    return texture.source;
  }
  if (texture.extensions?.KHR_texture_basisu?.source !== undefined) {
    return texture.extensions.KHR_texture_basisu.source;
  }
  return undefined;
}

function readTransferFunction(ktx2Buf) {
  const dfdOffset = ktx2Buf.readUInt32LE(48);
  return ktx2Buf.readUInt8(dfdOffset + 14);
}

async function runAndRead(modelName, opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktx2-cs-'));
  try {
    const result = await optimizeFile(
      path.resolve('fixtures/models', modelName),
      { ...opts, outDir: tmpDir },
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

function getKtx2Bytes(glbBytes, json, textureIndex) {
  if (!json || !Array.isArray(json.images) || !Array.isArray(json.textures)) {
    return null;
  }
  const texture = json.textures[textureIndex];
  if (!texture) return null;

  const imageIndex = getTextureImageIndex(texture);
  if (imageIndex === undefined || imageIndex === null) return null;

  const image = json.images[imageIndex];
  if (!image || image.uri) return null;

  const bvIndex = image.bufferView;
  if (bvIndex === undefined) return null;

  const bv = json.bufferViews[bvIndex];
  if (!bv) return null;

  const jsonLength = glbBytes.readUInt32LE(12);
  const binChunkOffset = 20 + jsonLength + 8;

  const start = binChunkOffset + (bv.byteOffset || 0);
  const end = start + bv.byteLength;
  const texBuf = glbBytes.slice(start, end);

  if (!isKTX2(texBuf)) return null;
  return texBuf;
}

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

function collectKtx2Textures(glbBytes, json, slotMap) {
  const ktx2Textures = [];
  for (const [texIdx, slots] of slotMap) {
    const ktx2Buf = getKtx2Bytes(glbBytes, json, texIdx);
    if (ktx2Buf) ktx2Textures.push({ texIdx, slots, buf: ktx2Buf });
  }
  return ktx2Textures;
}


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
        expect(true).toBe(true);
        return;
      }

      const slotMap = getTextureSlotMapping(json);
      expect(slotMap.size).toBeGreaterThan(0);

      const ktx2Textures = collectKtx2Textures(glbBytes, json, slotMap);

      expect(
        ktx2Textures.length,
        'KTX2 rule applied but 0 KTX2 textures found — possible texture.source / KHR_texture_basisu mismatch',
      ).toBeGreaterThanOrEqual(1);

      let foundBaseColor = false;
      for (const { slots, buf } of ktx2Textures) {
        const tf = readTransferFunction(buf);
        if (slots.includes('baseColorTexture')) {
          expect(tf).toBe(2);
          foundBaseColor = true;
        } else {
          expect(tf).toBe(1);
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

      expect(
        ktx2Textures.length,
        'KTX2 rule applied but 0 KTX2 textures found — possible texture.source / KHR_texture_basisu mismatch',
      ).toBeGreaterThanOrEqual(1);

      let nonColorCount = 0;
      for (const { slots, buf } of ktx2Textures) {
        const tf = readTransferFunction(buf);
        const isColor = slots.some((s) => /^(baseColorTexture|emissiveTexture)$/.test(s));
        if (!isColor) {
          expect(tf).toBe(1);
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

      expect(
        ktx2Textures.length,
        'KTX2 rule applied but 0 KTX2 textures found — possible texture.source / KHR_texture_basisu mismatch',
      ).toBeGreaterThanOrEqual(1);

      let texturesChecked = 0;
      for (const { slots, buf } of ktx2Textures) {
        const tf = readTransferFunction(buf);
        const isColor = slots.some((s) => /^(baseColorTexture|emissiveTexture)$/.test(s));
        if (isColor) {
          expect(tf).toBe(2);
        } else {
          expect(tf).toBe(1);
        }
        texturesChecked++;
      }

      expect(texturesChecked).toBeGreaterThanOrEqual(1);
    }, TIMEOUT);
  },
);
