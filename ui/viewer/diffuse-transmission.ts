import * as THREE from 'three';
import type { GLTFParser } from 'three/addons/loaders/GLTFLoader.js';

const DIFFUSE_TRANSMISSION = 'KHR_materials_diffuse_transmission';

const UV_ATTRIBUTE = ['uv', 'uv1', 'uv2', 'uv3'] as const;

const UV_DEFINE = [null, 'USE_UV1', 'USE_UV2', 'USE_UV3'] as const;

type Uniform<T> = { value: T };

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

function channelOf(texture: THREE.Texture | null): number {
  const ch = texture ? (texture.channel | 0) : 0;
  if (ch >= 0 && ch < UV_ATTRIBUTE.length) return ch;
  console.warn(`${DIFFUSE_TRANSMISSION}: TEXCOORD_${ch} three.js не объявляет, взят TEXCOORD_0`);
  return 0;
}

class MeshDiffuseTransmissionMaterial extends THREE.MeshPhysicalMaterial {
  readonly isMeshDiffuseTransmissionMaterial = true;

  _dt: DtUniforms = freshUniforms();

  constructor(params?: THREE.MeshPhysicalMaterialParameters) {
    super();
    if (params) this.setValues(params);
  }

  get diffuseTransmission(): number { return this._dt.diffuseTransmission.value; }
  set diffuseTransmission(v: number) { this._dt.diffuseTransmission.value = v; }

  get diffuseTransmissionColor(): THREE.Color { return this._dt.diffuseTransmissionColor.value; }
  set diffuseTransmissionColor(v: THREE.Color) { this._dt.diffuseTransmissionColor.value = v; }

  get diffuseTransmissionMap(): THREE.Texture | null { return this._dt.diffuseTransmissionMap.value; }
  set diffuseTransmissionMap(v: THREE.Texture | null) {
    if (!!v !== !!this._dt.diffuseTransmissionMap.value) this.needsUpdate = true;
    this._dt.diffuseTransmissionMap.value = v;
    this._syncUvDefines();
  }

  get diffuseTransmissionColorMap(): THREE.Texture | null { return this._dt.diffuseTransmissionColorMap.value; }
  set diffuseTransmissionColorMap(v: THREE.Texture | null) {
    if (!!v !== !!this._dt.diffuseTransmissionColorMap.value) this.needsUpdate = true;
    this._dt.diffuseTransmissionColorMap.value = v;
    this._syncUvDefines();
  }

  _syncUvDefines() {
    const defines = (this.defines ??= {});
    for (const texture of [this.diffuseTransmissionMap, this.diffuseTransmissionColorMap]) {
      if (!texture) continue;
      const key = UV_DEFINE[channelOf(texture)];
      if (key) defines[key] = '';
    }
  }

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
    setup.push(which === 'Map'
      ? `dtFactor *= texture2D( ${uniformName}, ${v} ).a;`
      : `dtTint *= texture2D( ${uniformName}, ${v} ).rgb;`);
  }

  setup.push(
    'dtScatter = dtFactor * dtTint;',
    'material.diffuseContribution *= ( 1.0 - dtFactor );',
  );

  const parsBlock = [
    ...fragmentPars,
    'vec3 dtScatter = vec3( 0.0 );',
    'void RE_Direct_DiffuseTransmission( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {',
    '\tRE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );',
    '\tfloat dtDotNL = saturate( dot( -geometryNormal, directLight.direction ) );',
    '\treflectedLight.directDiffuse += dtDotNL * directLight.color * BRDF_Lambert( dtScatter );',
    '}',
    '#undef RE_Direct',
    '#define RE_Direct RE_Direct_DiffuseTransmission',
  ].join('\n');

  const indirectBlock = [
    '#if defined( RE_IndirectDiffuse )',
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

    materialParams.diffuseTransmission = typeof ext.diffuseTransmissionFactor === 'number'
      ? ext.diffuseTransmissionFactor
      : 0;

    const color = ext.diffuseTransmissionColorFactor;
    materialParams.diffuseTransmissionColor = Array.isArray(color)
      ? new THREE.Color().setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace)
      : new THREE.Color(1, 1, 1);

    const pending: Promise<unknown>[] = [];
    if (ext.diffuseTransmissionTexture) {
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
