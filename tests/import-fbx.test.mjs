// tests/import-fbx.test.mjs — FBX на вход, glTF на выход.
//
// ПОВОД (Александр, 2026-08-22): «мы можем сделать, что бы подгружать fbx и текстурки и
// после выгружалось всё глб. у меня слишком много в таком формате моделей. не хочу
// постоянно в блендер лезть». Он же задал и порядок: сперва FBX, который САМ называет свои
// текстуры — там нет ни одной догадки. FBX без материалов (папка карт отдельно) — второй
// заход, и он сложнее именно потому, что там мы угадываем.
//
// ПРО ЛИЦЕНЗИЮ (его же вопрос: «мы не можем никак принимать фбикс без какой-то лицензии?»).
// Не нужна: FBXLoader — часть three.js, а three.js у нас уже есть (MIT), оттуда же берутся
// STL и PLY. Кода Autodesk в загрузчике нет, он опирается на разбор формата от Blender.
// Разбор целиком — в шапке addons/gltf/import-fbx.mts.
//
// ЗАГОТОВКИ ЗДЕСЬ СИНТЕТИЧЕСКИЕ, и это не лень. Настоящий FBX — двоичный, весит мегабайты
// и приезжает с чужой лицензией; в публичный репозиторий такому не место. Текстовый FBX
// пишется руками и проверяет ровно то, что нужно: ссылку на текстуру, развёртку, материал.
// Двоичный разбор при этом не остаётся без проверки — он тот же самый код загрузчика, и
// измерен был на настоящей модели (CCR1072, 1 МБ, 21 меш, 28 795 треугольников, 0,09 с).

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

/**
 * Текстовый FBX: два треугольника, развёртка, материал и ССЫЛКА на текстуру.
 *
 * Развёртка задана намеренно узнаваемой: V пробегает 0 и 1, и по тому, что окажется в
 * собранном файле, видно, перевернули мы ось или нет.
 *
 * Картинку рядом кладёт putTexture — заготовка ВСЕГДА только ССЫЛАЕТСЯ на неё. Так и
 * проверяется главный случай: файл называет соседа, а есть он или нет — дело поставки.
 * @param opts.shift    сдвиг узла: проверяем, что иерархия и трансформации доезжают
 */
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

/** Положить рядом картинку, на которую ссылается заготовка. */
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

/** Прогнать через движок и вернуть отчёт вместе с собранным документом. */
async function run(file, features = ['safe']) {
  const outDir = fs.mkdtempSync(path.join(tmp, 'out-'));
  const result = await optimizeFile(file, { outDir, advancedFeatures: features, locale: 'ru' });
  let doc = null;
  const written = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((n) => n.toLowerCase().endsWith('.glb')) : [];
  if (written.length) doc = await new NodeIO().read(path.join(outDir, written[0]));
  return { result, doc, dst: written[0] || null };
}

const lineOf = (result, ruleId) => (result.findings || []).filter((f) => f.ruleId === ruleId);

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 1 · Файл принимается и становится glTF
// ═══════════════════════════════════════════════════════════════════════════

describe('FBX принимается наравне со своими', () => {
  it('расширение объявлено аддоном', () => {
    expect(gltfAddon.formats, 'fbx не объявлен в списке форматов').toContain('fbx');
  });

  it('на выходе .glb, а не .fbx с двоичным glTF внутри', () => {
    // Дефект 2026-08-22: список расширений для переименования был ПЯТОЙ копией того же
    // перечня и разошёлся с остальными четырьмя. Файл выходил с именем «модель.fbx»,
    // внутри которого лежал glTF, — имя, которое врёт про содержимое.
    expect(gltfAddon.outputName('модель.fbx')).toBe('модель.glb');
    expect(gltfAddon.outputName('архив.v2.fbx')).toBe('архив.v2.glb');
  });

  it('геометрия доезжает, статус ok', async () => {
    const { file } = makeFbx('plain');
    const { result, doc, dst } = await run(file);
    expect(result.status).toBe('ok');
    expect(dst, 'файл записан не с расширением .glb').toBe('panel.glb');
    const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
    // Два треугольника из четырёхугольника: FBX хранит многоугольники, разбивает их
    // загрузчик. Сварка совпадающих вершин на этой заготовке ничего не теряет.
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

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 2 · Текстуры: файл называет, человек кладёт рядом
// ═══════════════════════════════════════════════════════════════════════════

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

    // Раз всё нашлось — жаловаться не на что.
    expect(lineOf(result, 'import/not-carried'), 'правило пожаловалось на полной поставке').toEqual([]);
  });

  it('названная, но не положенная — НАЗЫВАЕТСЯ вслух, а не проглатывается', async () => {
    // Молчание здесь — худший вид вранья: модель откроется, валидатор будет доволен,
    // а серый материал человек припишет нашей работе, хотя это правда о поставке.
    const { file } = makeFbx('no-tex');
    const { result, doc } = await run(file);
    expect(result.status).toBe('ok');

    const said = lineOf(result, 'import/not-carried');
    expect(said.length, 'о недостающей текстуре не сказано ни слова').toBe(1);
    expect(said[0].text).toContain('marker.png');
    expect(said[0].i18n?.text?.messageId).toBe('import.textureMissing');

    // И ничего не выдумано взамен.
    expect(doc.getRoot().listTextures().length, 'текстура появилась из ниоткуда').toBe(0);
    expect(doc.getRoot().listMaterials()[0].getBaseColorTexture()).toBeNull();
  });

  it('ось V перевёрнута — иначе карта ложится не по развёртке', async () => {
    // Замер 2026-08-22 на настоящей модели: без переворота текстуры вставали мимо, и
    // Александр это увидел первым («точно не на юви карту получилось»). В glTF ось V
    // отсчитывается СВЕРХУ, в FBX — снизу; three компенсирует это флагом flipY на самой
    // текстуре, а при сборке glTF напрямую компенсация теряется.
    const { dir, file } = makeFbx('flip');
    await putTexture(dir);
    const { doc } = await run(file);
    const uv = doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('TEXCOORD_0');
    const vs = Array.from(uv.getArray()).filter((_, i) => i % 2 === 1);
    // Развёртка в заготовке НЕСИММЕТРИЧНА намеренно: V пробегает 0 и 0.25, после
    // переворота обязан пробегать 1 и 0.75. Первая редакция этого сторожа брала 0 и 1 —
    // и проба на красноту показала, что он не краснеет ВОВСЕ: у симметричной развёртки
    // переворот не меняет набора значений, и отличить сделанное от несделанного нечем.
    expect(Math.min(...vs), 'минимум V не 0.75 — переворот не применён').toBeCloseTo(0.75, 5);
    expect(Math.max(...vs), 'максимум V не 1').toBeCloseTo(1, 5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 3 · Материал переносится, но не выдумывается
// ═══════════════════════════════════════════════════════════════════════════

describe('материал: переносим то, что есть, и не придумываем, чего нет', () => {
  it('цвет доезжает, а шероховатость и металличность НЕ выдуманы', async () => {
    // FBX хранит материал по Фонгу: там есть блик и его резкость, но нет ни
    // шероховатости, ни металличности — величин, на которых стоит glTF. Пересчитать
    // одно в другое нельзя, можно только придумать. Металличность 0 и шероховатость 1 —
    // это «просто поверхность», то же самое, чем показался бы материал без домыслов.
    const { file } = makeFbx('mat');
    const { doc } = await run(file);
    const m = doc.getRoot().listMaterials()[0];
    expect(m, 'материала нет вовсе').toBeTruthy();
    expect(m.getMetallicFactor(), 'металличность выдумана').toBe(0);
    expect(m.getRoughnessFactor(), 'шероховатость выдумана').toBe(1);

    // Цвет 0.25/0.5/0.75 задан в FBX как sRGB; glTF хранит baseColorFactor линейным, и
    // загрузчик three переводит его сам. Проверяем ПОРЯДОК величин и монотонность, а не
    // точные числа: привязываться к формуле пересчёта чужой библиотеки незачем.
    const [r, g, b, a] = m.getBaseColorFactor();
    expect(a).toBe(1);
    expect(r).toBeLessThan(g);
    expect(g).toBeLessThan(b);
    expect(b).toBeLessThan(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 4 · Отказы человеческие
// ═══════════════════════════════════════════════════════════════════════════

describe('нечитаемый файл объясняется словами', () => {
  it('обрывок FBX не отдаёт наружу строку из библиотеки', async () => {
    // Спецификация формата закрыта, разбор восстановлен со стороны — значит экзотика
    // будет попадаться. Отказ обязан быть про файл, а не про DataView.
    const dir = fs.mkdtempSync(path.join(tmp, 'broken-'));
    const file = path.join(dir, 'broken.fbx');
    fs.writeFileSync(file, Buffer.from('Kaydara FBX Binary  \0\0\0\0\0\0'));
    const { result } = await run(file);
    expect(result.status).toBe('fail');
    expect(result.error, 'наружу уехала внутренняя ошибка разборщика').not.toMatch(/DataView|undefined|TypeError/i);
    expect(result.error.length, 'отказ пустой').toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 5 · Развёртка живёт ровно столько, сколько нужна
// ═══════════════════════════════════════════════════════════════════════════

describe('развёртка: убираем без карт, храним с картами', () => {
  // ЗДЕСЬ БЫЛ МОЙ НЕВЕРНЫЙ ВЫВОД, и он стоит того, чтобы остаться записанным.
  //
  // 2026-08-22 я увидел, что у FBX Александра пропадает TEXCOORD_0, и счёл это потерей
  // авторской работы: развёртку делали руками, а мы её выбрасываем. Написал защиту и
  // сторож, который её закреплял.
  //
  // Александр поправил: «если загружается модель с юви, но нет текстур и мы прогоняем
  // через оптимизацию, так и должно быть, что удаляется юви канал. вот если мы загрузили
  // хоть одну текстуру после этого то юви должен оставаться».
  //
  // Он прав, и защита была лишней. Развёртка без единой карты ничего не показывает —
  // это байты, которые возят просто так. А случай «карты приложены» закрывается сам и
  // раньше: подбор соседних карт идёт на ВВОЗЕ, до правил; к чистке текстура уже
  // привязана к материалу, материал ссылается на развёртку, и трогать её никто не будет.
  //
  // То есть верное поведение получается БЕЗ единой строчки особого случая — надо было
  // просто посмотреть на порядок, а не спешить защищать.

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
