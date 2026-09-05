import * as THREE from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

const SLOT_TO_THREE: Record<string, string[]> = {
  baseColorTexture: ['map'],
  metallicRoughnessTexture: ['metalnessMap', 'roughnessMap'],
  normalTexture: ['normalMap'],
  occlusionTexture: ['aoMap'],
  emissiveTexture: ['emissiveMap'],
  thicknessTexture: ['thicknessMap'],
  clearcoatTexture: ['clearcoatMap'],
  clearcoatRoughnessTexture: ['clearcoatRoughnessMap'],
  clearcoatNormalTexture: ['clearcoatNormalMap'],
  sheenColorTexture: ['sheenColorMap'],
  sheenRoughnessTexture: ['sheenRoughnessMap'],
  specularTexture: ['specularIntensityMap'],
  specularColorTexture: ['specularColorMap'],
  transmissionTexture: ['transmissionMap'],
  iridescenceTexture: ['iridescenceMap'],
  iridescenceThicknessTexture: ['iridescenceThicknessMap'],
  anisotropyTexture: ['anisotropyMap'],
  diffuseTransmissionTexture: ['diffuseTransmissionMap'],
  diffuseTransmissionColorTexture: ['diffuseTransmissionColorMap'],
};

const TRANSFORM_PROPS: Record<string, 'offset' | 'rotation' | 'repeat'> = {
  offset: 'offset',
  rotation: 'rotation',
  scale: 'repeat',
};

const POINTER_RE = /^\/materials\/(\d+)\/(.+)\/extensions\/KHR_texture_transform\/(offset|rotation|scale)$/;

interface Entry {
  texture: THREE.Texture;
  prop: 'offset' | 'rotation' | 'repeat';
  times: ArrayLike<number>;
  values: ArrayLike<number>;
  stride: number;
  step: boolean;
}

export interface UvPointerDriver {
  count: number;
  duration: number;
  apply(t: number): void;
}

function materialsByIndex(gltf: GLTF): Map<number, THREE.Material[]> {
  const out = new Map<number, THREE.Material[]>();
  const assoc = gltf.parser.associations as Map<object, { materials?: number }> | undefined;
  if (!assoc) return out;
  for (const [key, value] of assoc) {
    const idx = value && value.materials;
    if (idx == null) continue;
    const mat = key as THREE.Material;
    if (!(mat as { isMaterial?: boolean }).isMaterial) continue;
    const list = out.get(idx) || [];
    list.push(mat);
    out.set(idx, list);
  }
  return out;
}

export async function buildUvPointerDriver(gltf: GLTF): Promise<UvPointerDriver | null> {
  try {
    const parser = gltf.parser;
    const json = parser.json as {
      animations?: Array<{
        samplers?: Array<{ input: number; output: number; interpolation?: string }>;
        channels?: Array<{ sampler: number; target?: { path?: string; extensions?: Record<string, { pointer?: string }> } }>;
      }>;
    };
    const animations = json.animations || [];
    if (!animations.length) return null;

    const byIndex = materialsByIndex(gltf);
    const entries: Entry[] = [];
    let duration = 0;

    for (const anim of animations) {
      for (const channel of anim.channels || []) {
        const target = channel.target;
        if (!target || target.path !== 'pointer') continue;
        const pointer = target.extensions?.['KHR_animation_pointer']?.pointer;
        if (!pointer) continue;

        const m = POINTER_RE.exec(pointer);
        if (!m) continue;
        const matIndex = Number(m[1]);
        const slot = (m[2] || '').split('/').filter((s) => s.endsWith('Texture')).pop();
        const prop = TRANSFORM_PROPS[m[3] || ''];
        if (!slot || !prop) continue;
        const threeProps = SLOT_TO_THREE[slot];
        if (!threeProps) continue;

        const sampler = anim.samplers?.[channel.sampler];
        if (!sampler) continue;
        const input = await parser.getDependency('accessor', sampler.input) as THREE.BufferAttribute;
        const output = await parser.getDependency('accessor', sampler.output) as THREE.BufferAttribute;
        if (!input || !output) continue;

        const times = input.array as ArrayLike<number>;
        const values = output.array as ArrayLike<number>;
        const stride = prop === 'rotation' ? 1 : 2;
        const last = times[times.length - 1];
        if (typeof last === 'number' && last > duration) duration = last;

        for (const mat of byIndex.get(matIndex) || []) {
          for (const name of threeProps) {
            const texture = (mat as unknown as Record<string, unknown>)[name] as THREE.Texture | undefined;
            if (!texture || !texture.isTexture) continue;
            entries.push({
              texture, prop, times, values, stride,
              step: sampler.interpolation === 'STEP',
            });
          }
        }
      }
    }

    if (!entries.length) return null;

    const apply = (t: number) => {
      for (const e of entries) {
        const { times, values, stride } = e;
        const n = times.length;
        if (!n) continue;

        let i = 0;
        while (i < n - 1 && (times[i + 1] as number) <= t) i++;
        const t0 = times[i] as number;
        const t1 = (times[Math.min(i + 1, n - 1)] as number);
        const span = t1 - t0;
        const a = e.step || span <= 0 ? 0 : Math.max(0, Math.min(1, (t - t0) / span));

        const o0 = i * stride;
        const o1 = Math.min(i + 1, n - 1) * stride;
        if (stride === 1) {
          const v0 = values[o0] as number;
          const v1 = values[o1] as number;
          e.texture.rotation = v0 + (v1 - v0) * a;
        } else {
          const x0 = values[o0] as number, y0 = values[o0 + 1] as number;
          const x1 = values[o1] as number, y1 = values[o1 + 1] as number;
          const vec = e.prop === 'offset' ? e.texture.offset : e.texture.repeat;
          vec.set(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a);
        }
      }
    };

    return { count: entries.length, duration, apply };
  } catch (err) {
    console.warn('KHR_animation_pointer: развёртки текстур анимировать не удалось, модель показана без этого', err);
    return null;
  }
}

export function stripUvTransformTracks(clips: THREE.AnimationClip[]) {
  for (const clip of clips) {
    const before = clip.duration;
    const kept = clip.tracks.filter((tr) => !tr.name.includes('KHR_texture_transform'));
    if (kept.length === clip.tracks.length) continue;
    clip.tracks = kept;
    clip.duration = before;
  }
}
