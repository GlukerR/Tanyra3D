import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';

import { optimizeFile } from '../optimize2.mjs';
import gltfAddon from '../addons/gltf/index.mjs';

let tmp;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-fbx-')); });
afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

function makeFbx(name, { shift = 0 } = {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'textures'), { recursive: true });

  const model = shift
    ? `	Model: 150000000, "Model::Panel", "Mesh" {
		Version: 232
		Properties70:  {
			P: "Lcl Translation", "Lcl Translation", "", "A",${shift},0,0
		}
	}`
    : `	Model: 150000000, "Model::Panel", "Mesh" {
		Version: 232
	}`;

  const fbx = `; FBX 7.3.0 project file
FBXHeaderExtension:  {
	FBXHeaderVersion: 1003
	FBXVersion: 7300
}
Objects:  {
	Geometry: 140000000, "Geometry::", "Mesh" {
		Vertices: *12 {
			a: 0,0,0,1,0,0,0,1,0,1,1,0
		}
		PolygonVertexIndex: *6 {
			a: 0,1,-3,1,3,-3
		}
		GeometryVersion: 124
		LayerElementUV: 0 {
			Version: 101
			Name: "UVMap"
			MappingInformationType: "ByPolygonVertex"
			ReferenceInformationType: "Direct"
			UV: *12 {
				a: 0,0,1,0,0,0.25,1,0,1,0.25,0,0.25
			}
		}
		Layer: 0 {
			Version: 100
			LayerElement:  {
				Type: "LayerElementUV"
				TypedIndex: 0
			}
		}
	}
${model}
	Material: 160000000, "Material::Painted", "" {
		Version: 102
		ShadingModel: "phong"
		Properties70:  {
			P: "DiffuseColor", "Color", "", "A",0.25,0.5,0.75
		}
	}
	Texture: 170000000, "Texture::Diffuse", "" {
		Type: "TextureVideoClip"
		Version: 202
		FileName: "C:/nowhere/marker.png"
		RelativeFilename: "textures/marker.png"
	}
	Video: 180000000, "Video::Diffuse", "Clip" {
		Type: "Clip"
		FileName: "C:/nowhere/marker.png"
		RelativeFilename: "textures/marker.png"
	}
}
Connections:  {
	C: "OO",140000000,150000000
	C: "OO",160000000,150000000
	C: "OO",180000000,170000000
	C: "OP",170000000,160000000, "DiffuseColor"
	C: "OO",150000000,0
}
`;
  const file = path.join(dir, 'panel.fbx');
  fs.writeFileSync(file, fbx, 'utf8');
  return { dir, file };
}

async function putTexture(dir) {
  const w = 8, h = 8;
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (y < h / 2) rgb[i] = 255; else rgb[i + 2] = 255;
    }
  }
  await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png()
    .toFile(path.join(dir, 'textures', 'marker.png'));
}

async function run(file, features = ['safe']) {
  const outDir = fs.mkdtempSync(path.join(tmp, 'out-'));
  const result = await optimizeFile(file, { outDir, advancedFeatures: features, locale: 'ru' });
  let doc = null;
  const written = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((n) => n.toLowerCase().endsWith('.glb')) : [];
  if (written.length) doc = await new NodeIO().read(path.join(outDir, written[0]));
  return { result, doc, dst: written[0] || null };
}

const lineOf = (result, ruleId) => (result.findings || []).filter((f) => f.ruleId === ruleId);

describe('FBX принимается наравне со своими', () => {
  it('расширение объявлено аддоном', () => {
    expect(gltfAddon.formats, 'fbx не объявлен в списке форматов').toContain('fbx');
  });

  it('на выходе .glb, а не .fbx с двоичным glTF внутри', () => {
    expect(gltfAddon.outputName('модель.fbx')).toBe('модель.glb');
    expect(gltfAddon.outputName('архив.v2.fbx')).toBe('архив.v2.glb');
  });

  it('геометрия доезжает, статус ok', async () => {
    const { file } = makeFbx('plain');
    const { result, doc, dst } = await run(file);
    expect(result.status).toBe('ok');
    expect(dst, 'файл записан не с расширением .glb').toBe('panel.glb');
    const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
    expect(prim.getIndices().getCount() / 3).toBe(2);
  });

  it('иерархия и сдвиг узла сохраняются', async () => {
    const { file } = makeFbx('shifted', { shift: 7 });
    const { doc } = await run(file);
    const node = doc.getRoot().listNodes().find((n) => n.getMesh());
    expect(node, 'узла с мешем нет').toBeTruthy();
    expect(node.getTranslation()[0], 'сдвиг узла потерян').toBeCloseTo(7, 5);
  });
});

describe('текстуры берутся у соседей, как у .gltf', () => {
  it('названная и положенная рядом — доезжает в файл', async () => {
    const { dir, file } = makeFbx('with-tex');
    await putTexture(dir);
    const { result, doc } = await run(file);
    expect(result.status).toBe('ok');

    const textures = doc.getRoot().listTextures();
    expect(textures.length, 'текстура не доехала').toBe(1);
    expect(textures[0].getMimeType()).toBe('image/png');
    expect(doc.getRoot().listMaterials()[0].getBaseColorTexture(), 'карта не привязана к материалу').toBeTruthy();

    expect(lineOf(result, 'import/not-carried'), 'правило пожаловалось на полной поставке').toEqual([]);
  });

  it('названная, но не положенная — НАЗЫВАЕТСЯ вслух, а не проглатывается', async () => {
    const { file } = makeFbx('no-tex');
    const { result, doc } = await run(file);
    expect(result.status).toBe('ok');

    const said = lineOf(result, 'import/not-carried');
    expect(said.length, 'о недостающей текстуре не сказано ни слова').toBe(1);
    expect(said[0].text).toContain('marker.png');
    expect(said[0].i18n?.text?.messageId).toBe('import.textureMissing');

    expect(doc.getRoot().listTextures().length, 'текстура появилась из ниоткуда').toBe(0);
    expect(doc.getRoot().listMaterials()[0].getBaseColorTexture()).toBeNull();
  });

  it('ось V перевёрнута — иначе карта ложится не по развёртке', async () => {
    const { dir, file } = makeFbx('flip');
    await putTexture(dir);
    const { doc } = await run(file);
    const uv = doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('TEXCOORD_0');
    const vs = Array.from(uv.getArray()).filter((_, i) => i % 2 === 1);
    expect(Math.min(...vs), 'минимум V не 0.75 — переворот не применён').toBeCloseTo(0.75, 5);
    expect(Math.max(...vs), 'максимум V не 1').toBeCloseTo(1, 5);
  });
});

describe('материал: переносим то, что есть, и не придумываем, чего нет', () => {
  it('цвет доезжает, а шероховатость и металличность НЕ выдуманы', async () => {
    const { file } = makeFbx('mat');
    const { doc } = await run(file);
    const m = doc.getRoot().listMaterials()[0];
    expect(m, 'материала нет вовсе').toBeTruthy();
    expect(m.getMetallicFactor(), 'металличность выдумана').toBe(0);
    expect(m.getRoughnessFactor(), 'шероховатость выдумана').toBe(1);

    const [r, g, b, a] = m.getBaseColorFactor();
    expect(a).toBe(1);
    expect(r).toBeLessThan(g);
    expect(g).toBeLessThan(b);
    expect(b).toBeLessThan(1);
  });
});

describe('нечитаемый файл объясняется словами', () => {
  it('обрывок FBX не отдаёт наружу строку из библиотеки', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'broken-'));
    const file = path.join(dir, 'broken.fbx');
    fs.writeFileSync(file, Buffer.from('Kaydara FBX Binary  \0\0\0\0\0\0'));
    const { result } = await run(file);
    expect(result.status).toBe('fail');
    expect(result.error, 'наружу уехала внутренняя ошибка разборщика').not.toMatch(/DataView|undefined|TypeError/i);
    expect(result.error.length, 'отказ пустой').toBeGreaterThan(0);
  });
});

describe('развёртка: убираем без карт, храним с картами', () => {
  it('без карт развёртка убирается — она ничего не показывает', async () => {
    const { file } = makeFbx('uv-no-tex');
    const { doc } = await run(file);
    expect(doc.getRoot().listTextures().length, 'заготовка неверна: текстур быть не должно').toBe(0);
    const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
    expect(prim.getAttribute('TEXCOORD_0'), 'развёртка без карт осталась мёртвым грузом').toBeNull();
  });

  it('стоит появиться одной карте — развёртка остаётся', async () => {
    const { dir, file } = makeFbx('uv-with-tex');
    await putTexture(dir);
    const { doc } = await run(file);
    expect(doc.getRoot().listTextures().length, 'текстура не доехала — тест ничего не проверяет').toBe(1);
    const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
    expect(prim.getAttribute('TEXCOORD_0'), 'развёртку убрали вместе с картой — модель стала серой').toBeTruthy();
  });
});
