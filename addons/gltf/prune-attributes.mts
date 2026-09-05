import {
  ExtensionProperty,
  Material,
  Primitive,
  Texture,
  TextureInfo,
} from '@gltf-transform/core';
import type { Document } from '@gltf-transform/core';

function required(
  document: Document,
  prim: Primitive,
  material: Material | ExtensionProperty,
  out = new Set<string>(),
): Set<string> {
  const edges = document.getGraph().listChildEdges(material);
  const сКартинкой = new Set<string>();
  for (const edge of edges) if (edge.getChild() instanceof Texture) сКартинкой.add(edge.getName());
  for (const edge of edges) {
    const name = edge.getName();
    const child = edge.getChild();
    if (child instanceof TextureInfo && сКартинкой.has(name.replace(/Info$/, ''))) {
      out.add(`TEXCOORD_${child.getTexCoord()}`);
    }
    if (child instanceof Texture && /normalTexture/i.test(name)) out.add('TANGENT');
    if (child instanceof ExtensionProperty) required(document, prim, child, out);
  }
  const светится = material instanceof Material && !material.getExtension('KHR_materials_unlit');
  if (светится && prim.getMode() !== Primitive.Mode.POINTS) out.add('NORMAL');
  return out;
}

function unusedOf(prim: Primitive, need: Set<string>): string[] {
  const out: string[] = [];
  for (const s of prim.listSemantics()) {
    if (s === 'NORMAL' && !need.has(s)) out.push(s);
    else if (s === 'TANGENT' && !need.has(s)) out.push(s);
    else if (s.startsWith('TEXCOORD_') && !need.has(s)) out.push(s);
    else if (s.startsWith('COLOR_') && s !== 'COLOR_0') out.push(s);
  }
  return out;
}

export function dropUnusedExceptUv(document: Document): string[] {
  const убрано: string[] = [];
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const material = prim.getMaterial();
      if (!material) continue;
      const лишние = unusedOf(prim, required(document, prim, material))
        .filter((s) => !s.startsWith('TEXCOORD_'));
      for (const s of лишние) {
        prim.setAttribute(s, null);
        убрано.push(s);
      }
      for (const target of prim.listTargets()) {
        for (const s of лишние) target.setAttribute(s, null);
      }
    }
  }
  return убрано;
}
