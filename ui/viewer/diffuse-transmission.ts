// ui/viewer/diffuse-transmission.ts — просвет насквозь (KHR_materials_diffuse_transmission).
//
// ЧТО ЭТО ЗА КАРТА. Лист, бумажный абажур, тонкий фарфор: свет проходит сквозь стенку и
// рассеивается на выходе. Это НЕ преломление (`KHR_materials_transmission`, стекло) —
// там луч идёт насквозь почти прямо и за ним видно фон. Здесь за стенкой не видно
// ничего, стенка просто светится с той стороны, откуда падает свет.
//
// ЗАЧЕМ НАМ СВОЙ КОД. Замер 2026-08-27 по установленному three.js 0.185.1 (это САМАЯ
// свежая опубликованная версия — обновиться некуда): ни в `src/`, ни в `examples/jsm/`
// нет ни одного упоминания расширения. Загрузчик молча выбрасывает его целиком, и
// модель показывается как плотная непрозрачная. У `three-gltf-extensions`, который у нас
// уже есть, такого загрузчика тоже нет.
//
// При этом ОПТИМИЗАТОР расширение понимает: `gltf-transform` знает его как
// `KHRMaterialsDiffuseTransmission`, файл доезжает целым. Слеп был только просмотр —
// человек видел одно, а увозил другое. Именно это и чинится здесь.
//
// ФОРМУЛА. Спецификация задаёт рассеяние как СМЕСЬ, а не как добавку:
//
//     mix( diffuse_brdf( baseColor ), diffuse_btdf( diffuseTransmissionColor ), factor )
//
// Отсюда два действия и ни одного лишнего:
//   1. отражённое рассеяние гасим множителем `(1 - factor)`;
//   2. прошедшее — добавляем с ПЕРЕВЁРНУТОЙ нормалью и СВОИМ цветом.
//
// Цвет второй половины берётся только из `diffuseTransmissionColor`, базовый цвет в него
// не входит — в этом весь смысл отдельного поля: лист отражает тёмно-зелёный, а
// пропускает жёлто-зелёный, и это два разных изображения.
//
// ЧТО ЗДЕСЬ ПРИБЛИЖЕНИЕ, И ЭТО НАЗВАНО ЧЕСТНО:
//   · прошедший свет от окружения берётся как `getIBLIrradiance(-N)` — без поправки на
//     многократное рассеяние, которую three.js делает для отражённой половины
//     (`RE_IndirectSpecular_Physical`, множитель `1 - totalScatteringDielectric`);
//   · полусферические источники (`hemisphereLight`) отдают прошедшей половине ту же
//     освещённость, что и отражённой, — то есть считанную по ЛИЦЕВОЙ нормали;
//   · толщина стенки не учитывается вовсе: её задаёт `KHR_materials_volume`, отдельное
//     расширение, и притворяться, что мы его читаем, нельзя.
// Это просмотрщик, а не рендер-ферма: задача — показать, что модель не сломана, и
// показать её ТАК ЖЕ, как покажет площадка. Ни одно из трёх приближений не меняет ответа
// на вопрос «просвечивает или нет».
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ КЛАСС МАТЕРИАЛА, А НЕ ПОЛЯ НА `MeshPhysicalMaterial`.
// `Material.setValues` на незнакомый ключ пишет предупреждение в консоль и ЗАБЫВАЕТ
// значение (`node_modules/three/src/materials/Material.js`). Значит поля должны у класса
// быть. Свой наследник даёт заодно место под `onBeforeCompile` и под ключ кэша программ:
// без второго два материала — с картой и без — получили бы одну скомпилированную
// программу на двоих.

import * as THREE from 'three';
import type { GLTFParser } from 'three/addons/loaders/GLTFLoader.js';

/** Имя расширения в glTF. Одно место, откуда его берут и плагин, и проверки. */
const DIFFUSE_TRANSMISSION = 'KHR_materials_diffuse_transmission';

/** Атрибут развёртки по номеру набора: `texCoord` из glTF → имя attribute в three.js. */
const UV_ATTRIBUTE = ['uv', 'uv1', 'uv2', 'uv3'] as const;

/** Определение, которым three.js объявляет соответствующий attribute (у нулевого его нет). */
const UV_DEFINE = [null, 'USE_UV1', 'USE_UV2', 'USE_UV3'] as const;

type Uniform<T> = { value: T };

/**
 * Разбор одного набора карт материала.
 *
 * Держится ОДНИМ объектом, а не полями врассыпную, потому что ровно этот объект кладётся
 * в `shader.uniforms`: тогда правка `material.diffuseTransmission = 0.5` доезжает до
 * видеокарты сама, без пересборки шейдера и без ручного обновления.
 */
type DtUniforms = {
  diffuseTransmission: Uniform<number>;
  diffuseTransmissionColor: Uniform<THREE.Color>;
  diffuseTransmissionMap: Uniform<THREE.Texture | null>;
  diffuseTransmissionMapTransform: Uniform<THREE.Matrix3>;
  diffuseTransmissionColorMap: Uniform<THREE.Texture | null>;
  diffuseTransmissionColorMapTransform: Uniform<THREE.Matrix3>;
};

function freshUniforms(): DtUniforms {
  return {
    diffuseTransmission: { value: 0 },
    diffuseTransmissionColor: { value: new THREE.Color(1, 1, 1) },
    diffuseTransmissionMap: { value: null },
    diffuseTransmissionMapTransform: { value: new THREE.Matrix3() },
    diffuseTransmissionColorMap: { value: null },
    diffuseTransmissionColorMapTransform: { value: new THREE.Matrix3() },
  };
}

/** Номер набора развёртки у текстуры, приведённый к тем, что умеет объявить three.js. */
function channelOf(texture: THREE.Texture | null): number {
  const ch = texture ? (texture.channel | 0) : 0;
  if (ch >= 0 && ch < UV_ATTRIBUTE.length) return ch;
  // Наборов развёртки больше четырёх glTF не запрещает, но three.js объявляет ровно
  // четыре attribute. Молча взять нулевой — показать не ту картинку, поэтому говорим.
  console.warn(`${DIFFUSE_TRANSMISSION}: TEXCOORD_${ch} three.js не объявляет, взят TEXCOORD_0`);
  return 0;
}

/**
 * Материал с просветом насквозь.
 *
 * Наследник `MeshPhysicalMaterial`: всё остальное — базовый цвет, нормали, шероховатость,
 * прозрачность — работает ровно как раньше, добавлена одна доля отражения.
 */
class MeshDiffuseTransmissionMaterial extends THREE.MeshPhysicalMaterial {
  readonly isMeshDiffuseTransmissionMaterial = true;

  /** @internal Набор для шейдера; сюда же смотрят все свойства ниже. */
  _dt: DtUniforms = freshUniforms();

  constructor(params?: THREE.MeshPhysicalMaterialParameters) {
    // `super()` СПЕЦИАЛЬНО без параметров: базовый конструктор кончается вызовом
    // `setValues(params)`, а тот пошёл бы в наши свойства раньше, чем создан `_dt`.
    super();
    // `type` НЕ подменяем, и это не небрежность. По нему рендерер находит и сам шейдер
    // (`ShaderLib.physical`), и его набор uniform-ов: `WebGLPrograms.getUniforms` берёт
    // `shaderIDs[material.type]`, а на незнакомом имени уходит в ветку для
    // `ShaderMaterial` и возвращает `undefined`. Проверено падением 2026-08-27 —
    // "Cannot set properties of undefined" в первой же врезке. Кто мы такие, говорит
    // `isMeshDiffuseTransmissionMaterial`.
    if (params) this.setValues(params);
  }

  /** Доля света, уходящая насквозь: 0 — обычный материал, 1 — только просвет. */
  get diffuseTransmission(): number { return this._dt.diffuseTransmission.value; }
  set diffuseTransmission(v: number) { this._dt.diffuseTransmission.value = v; }

  /** Цвет прошедшего света. К базовому цвету отношения не имеет — см. шапку файла. */
  get diffuseTransmissionColor(): THREE.Color { return this._dt.diffuseTransmissionColor.value; }
  set diffuseTransmissionColor(v: THREE.Color) { this._dt.diffuseTransmissionColor.value = v; }

  /** Карта доли: спецификация держит её в КАНАЛЕ ПРОЗРАЧНОСТИ (A), а не в яркости. */
  get diffuseTransmissionMap(): THREE.Texture | null { return this._dt.diffuseTransmissionMap.value; }
  set diffuseTransmissionMap(v: THREE.Texture | null) {
    if (!!v !== !!this._dt.diffuseTransmissionMap.value) this.needsUpdate = true;
    this._dt.diffuseTransmissionMap.value = v;
    this._syncUvDefines();
  }

  /** Карта цвета прошедшего света (RGB, в пространстве sRGB). */
  get diffuseTransmissionColorMap(): THREE.Texture | null { return this._dt.diffuseTransmissionColorMap.value; }
  set diffuseTransmissionColorMap(v: THREE.Texture | null) {
    if (!!v !== !!this._dt.diffuseTransmissionColorMap.value) this.needsUpdate = true;
    this._dt.diffuseTransmissionColorMap.value = v;
    this._syncUvDefines();
  }

  /**
   * Объявить attribute развёртки, если карта просит не нулевой набор.
   *
   * three.js объявляет `uv1`/`uv2`/`uv3` только под своим определением, и вставляет его
   * ПЕРЕД телом шейдера — то есть до всего, что делает `onBeforeCompile`. Значит написать
   * `#define USE_UV1` из обработчика уже поздно, и место ему здесь.
   */
  _syncUvDefines() {
    const defines = (this.defines ??= {});
    for (const texture of [this.diffuseTransmissionMap, this.diffuseTransmissionColorMap]) {
      if (!texture) continue;
      const key = UV_DEFINE[channelOf(texture)];
      if (key) defines[key] = '';
    }
  }

  /**
   * Обновить матрицы развёрток перед кадром.
   *
   * `KHR_texture_transform` живёт в `texture.matrix`, а three.js пересчитывает эту матрицу
   * сам только для СВОИХ карт. Наша — не своя, поэтому синхронизируем здесь: тогда
   * поворот развёртки, в том числе анимированный по `KHR_animation_pointer`, доезжает.
   */
  override onBeforeRender() {
    syncTransform(this._dt.diffuseTransmissionMap.value, this._dt.diffuseTransmissionMapTransform);
    syncTransform(this._dt.diffuseTransmissionColorMap.value, this._dt.diffuseTransmissionColorMapTransform);
  }

  override customProgramCacheKey(): string {
    const map = this.diffuseTransmissionMap;
    const colorMap = this.diffuseTransmissionColorMap;
    return [
      'diffuse-transmission',
      map ? channelOf(map) : 'x',
      colorMap ? channelOf(colorMap) : 'x',
    ].join(':');
  }

  override onBeforeCompile(shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> }) {
    injectDiffuseTransmission(shader, this);
  }

  override copy(source: this): this {
    super.copy(source);
    // Свои значения — своими объектами: общий `_dt` означал бы, что копия и оригинал
    // делят одну долю просвета, и правка одной меняет обе.
    this._dt = freshUniforms();
    this.diffuseTransmission = source.diffuseTransmission;
    this.diffuseTransmissionColor = source.diffuseTransmissionColor.clone();
    this.diffuseTransmissionMap = source.diffuseTransmissionMap;
    this.diffuseTransmissionColorMap = source.diffuseTransmissionColorMap;
    return this;
  }
}

function syncTransform(texture: THREE.Texture | null, uniform: Uniform<THREE.Matrix3>) {
  if (!texture) return;
  if (texture.matrixAutoUpdate) texture.updateMatrix();
  uniform.value.copy(texture.matrix);
}

// ── Шейдер ───────────────────────────────────────────────────────────────────
//
// Врезка идёт в четыре точки, и все четыре выбраны не наугад (порядок включений —
// `node_modules/three/src/renderers/shaders/ShaderLib/meshphysical.glsl.js`):
//
//   1. `uv_pars_vertex`            — объявить свою varying;
//   2. `uv_vertex`                 — посчитать её;
//   3. `lights_physical_pars_fragment` — подменить `RE_Direct` (ПРЯМОЙ свет);
//   4. `lights_physical_fragment`  — прочитать карты и погасить отражённую долю;
//   5. `lights_fragment_end`       — добавить прошедший свет от окружения.
//
// Подмена `RE_Direct` — единственный способ попасть ВНУТРЬ цикла по источникам: цикл
// развёрнут препроцессором в `lights_fragment_begin` и снаружи его переменных нет.
// Своя функция сначала зовёт исходную (`RE_Direct_Physical`), поэтому ничего из обычного
// освещения не теряется — добавляется только вторая доля.

function varyingName(which: 'Map' | 'ColorMap') {
  return `vDiffuseTransmission${which}Uv`;
}

function injectDiffuseTransmission(
  shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> },
  material: MeshDiffuseTransmissionMaterial,
) {
  const map = material.diffuseTransmissionMap;
  const colorMap = material.diffuseTransmissionColorMap;

  for (const [key, uniform] of Object.entries(material._dt)) shader.uniforms[key] = uniform;

  const vertexPars: string[] = [];
  const vertexBody: string[] = [];
  const fragmentPars: string[] = [
    'uniform float diffuseTransmission;',
    'uniform vec3 diffuseTransmissionColor;',
  ];
  const setup: string[] = [
    'float dtFactor = diffuseTransmission;',
    'vec3 dtTint = diffuseTransmissionColor;',
  ];

  for (const [which, texture] of [['Map', map], ['ColorMap', colorMap]] as const) {
    if (!texture) continue;
    const uniformName = `diffuseTransmission${which}`;
    const v = varyingName(which);
    vertexPars.push(`uniform mat3 ${uniformName}Transform;`, `varying vec2 ${v};`);
    vertexBody.push(`${v} = ( ${uniformName}Transform * vec3( ${UV_ATTRIBUTE[channelOf(texture)]}, 1 ) ).xy;`);
    fragmentPars.push(`uniform sampler2D ${uniformName};`, `varying vec2 ${v};`);
    // Доля лежит в канале прозрачности, цвет — в RGB. Так велит спецификация, и это не
    // мелочь: у чайной пары карта доли — та же картинка, что и «шероховатость+затенение»,
    // у неё в RGB совсем другие числа.
    setup.push(which === 'Map'
      ? `dtFactor *= texture2D( ${uniformName}, ${v} ).a;`
      : `dtTint *= texture2D( ${uniformName}, ${v} ).rgb;`);
  }

  // Смесь, а не добавка: сколько ушло насквозь — столько же не отразилось.
  setup.push(
    'dtScatter = dtFactor * dtTint;',
    'material.diffuseContribution *= ( 1.0 - dtFactor );',
  );

  const parsBlock = [
    ...fragmentPars,
    // Глобальные: их заполняет врезка 4, а читает подменённая `RE_Direct` и врезка 5.
    'vec3 dtScatter = vec3( 0.0 );',
    'void RE_Direct_DiffuseTransmission( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {',
    '\tRE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );',
    // Перевёрнутая нормаль — это и есть «свет с той стороны». У двусторонних материалов
    // three.js уже развернул нормаль по видимой грани, поэтому лист светится с той
    // стороны, с которой на него смотрят, а не всегда с одной.
    '\tfloat dtDotNL = saturate( dot( -geometryNormal, directLight.direction ) );',
    '\treflectedLight.directDiffuse += dtDotNL * directLight.color * BRDF_Lambert( dtScatter );',
    '}',
    '#undef RE_Direct',
    '#define RE_Direct RE_Direct_DiffuseTransmission',
  ].join('\n');

  const indirectBlock = [
    '#if defined( RE_IndirectDiffuse )',
    // Рассеянный свет сцены прошедшая доля получает тот же, что и отражённая.
    '\treflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( dtScatter );',
    '#endif',
    '#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )',
    '\treflectedLight.indirectDiffuse += getIBLIrradiance( -geometryNormal ) * RECIPROCAL_PI * dtScatter;',
    '#endif',
  ].join('\n');

  shader.vertexShader = shader.vertexShader
    .replace('#include <uv_pars_vertex>', `#include <uv_pars_vertex>\n${vertexPars.join('\n')}`)
    .replace('#include <uv_vertex>', `#include <uv_vertex>\n${vertexBody.join('\n')}`);

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${parsBlock}`)
    .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${setup.join('\n')}`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${indirectBlock}`);
}

// ── Загрузчик ────────────────────────────────────────────────────────────────

/**
 * Плагин GLTFLoader: читает расширение и отдаёт материал, который умеет его показать.
 *
 * Контракт плагина — тот же, что у встроенных расширений three.js (`getMaterialType` +
 * `extendMaterialParams`, см. `GLTFMaterialsSheenExtension` в `GLTFLoader.js`).
 */
export class GLTFDiffuseTransmissionExtension {
  readonly name = DIFFUSE_TRANSMISSION;
  parser: GLTFParser;

  constructor(parser: GLTFParser) {
    this.parser = parser;
  }

  _extension(materialIndex: number): Record<string, unknown> | null {
    const def = (this.parser.json.materials || [])[materialIndex];
    const ext = def?.extensions?.[this.name];
    return ext ? (ext as Record<string, unknown>) : null;
  }

  getMaterialType(materialIndex: number) {
    return this._extension(materialIndex) ? MeshDiffuseTransmissionMaterial : null;
  }

  extendMaterialParams(materialIndex: number, materialParams: Record<string, unknown>): Promise<unknown> {
    const ext = this._extension(materialIndex);
    if (!ext) return Promise.resolve();

    // Умолчания спецификации: без просвета и с белым цветом. Пишем их явно, потому что
    // материал может достаться и от `KHR_materials_*`-соседа, где значения другие.
    materialParams.diffuseTransmission = typeof ext.diffuseTransmissionFactor === 'number'
      ? ext.diffuseTransmissionFactor
      : 0;

    const color = ext.diffuseTransmissionColorFactor;
    materialParams.diffuseTransmissionColor = Array.isArray(color)
      // Множители спецификации живут в ЛИНЕЙНОМ пространстве — не в sRGB. Перепутать
      // значит показать заметно более светлый просвет, чем задумал автор.
      ? new THREE.Color().setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace)
      : new THREE.Color(1, 1, 1);

    const pending: Promise<unknown>[] = [];
    if (ext.diffuseTransmissionTexture) {
      // Доля — не цвет: пространство не назначаем, иначе канал прозрачности приедет
      // разогнутым гаммой.
      pending.push(this.parser.assignTexture(
        materialParams, 'diffuseTransmissionMap', ext.diffuseTransmissionTexture as never,
      ));
    }
    if (ext.diffuseTransmissionColorTexture) {
      pending.push(this.parser.assignTexture(
        materialParams, 'diffuseTransmissionColorMap', ext.diffuseTransmissionColorTexture as never,
        THREE.SRGBColorSpace,
      ));
    }
    return Promise.all(pending);
  }
}
