/**
 * addons/gltf/instance.mts — GPU-инстансинг, который не пасует перед анимацией.
 *
 * ПОВОД (Александр, 2026-08-23): «EXT_mesh_gpu_instancing но ведь анимируются не детали
 * на которых инстансинги. тогда почему отказывается делать инстанс? исправляй».
 *
 * Он прав, и отказ был не наш. `fns.instance()` из @gltf-transform/functions начинается
 * так:
 *
 *     if (root.listAnimations().length) { logger.warn('not currently supported…'); return; }
 *
 * То есть ОДНА анимация где угодно в файле отключает инстансинг ЦЕЛИКОМ — даже если она
 * крутит вентилятор, а инстансить надо полки, которые стоят неподвижно. На
 * `CommercialRefrigerator` это и происходило: движок молчал, а наше правило вдобавок
 * называло неверную причину — «повторяющихся мешей нет».
 *
 * ЧЕГО БОИТСЯ БИБЛИОТЕКА, и это опасение настоящее. Инстансинг ЗАПЕКАЕТ мировое
 * преобразование каждого узла в атрибуты партии и убирает меш с самого узла. Если узел
 * анимирован, запечённое преобразование замораживает его: движение прекратится, а числа
 * останутся верными. Заметить это можно только глазом — ровно тот класс дефектов, из-за
 * которого библиотека и предпочла отказать всем.
 *
 * НАША ГРАНИЦА ТОЧНЕЕ, И ОНА ПОУЗЛОВАЯ. Узел непригоден, если движется он сам ИЛИ любой
 * его предок: у предка меняется преобразование — значит меняется и мировое положение
 * потомка. Всё остальное инстансится как обычно.
 *
 * Дети анимированного узла нас не смущают: убрав меш с узла, мы оставляем сам узел, если
 * у него есть потомки, — они продолжают жить относительно него, как жили.
 *
 * ОСТАЛЬНЫЕ ЗАПРЕТЫ БИБЛИОТЕКИ СОХРАНЕНЫ ДОСЛОВНО: узлы со скином не инстансим (у них
 * своё преобразование), объёмные материалы при неединичном масштабе — тоже
 * (KHR_materials_volume не переживает разный масштаб внутри партии).
 */

import { MathUtils, type Document, type Mesh, type Node, type Primitive, type vec3, type vec4 } from '@gltf-transform/core';
import { EXTMeshGPUInstancing } from '@gltf-transform/extensions';

/** Сколько узлов должны делить меш, чтобы партию имело смысл заводить. */
export interface InstanceStaticOptions { min: number }

/** Что вышло: сколько партий собрано и сколько узлов в них вошло. */
export interface InstanceStaticResult {
  batches: number;
  instances: number;
  /** Узлов, пропущенных ИМЕННО из-за анимации — их движение важнее экономии. */
  animatedSkipped: number;
}

/**
 * Узлы, чьё преобразование меняет анимация: сами цели каналов и всё, что под ними.
 *
 * Канал `weights` тоже считается: он анимирует веса запасных форм у МЕША этого узла, а
 * `EXT_mesh_gpu_instancing` весов не несёт — инстансированная копия потеряла бы их.
 */
function movingNodes(doc: Document): Set<Node> {
  const targets = new Set<Node>();
  for (const anim of doc.getRoot().listAnimations()) {
    for (const ch of anim.listChannels()) {
      const node = ch.getTargetNode();
      if (node) targets.add(node);
    }
  }
  if (!targets.size) return targets;

  // Разворачиваем вниз по дереву: под анимированным узлом движется всё.
  const moving = new Set<Node>();
  const walk = (node: Node) => {
    moving.add(node);
    for (const child of node.listChildren()) walk(child);
  };
  for (const node of targets) walk(node);
  return moving;
}

const hasVolume = (prim: Primitive) => !!prim.getMaterial()?.getExtension('KHR_materials_volume');
const hasScale = (node: Node) => !MathUtils.eq(node.getWorldScale(), [1, 1, 1]);

/**
 * Собрать повторяющиеся меши в партии, не трогая то, что движется.
 *
 * Возвращает счёт сделанного — правило превращает его в человеческие строки отчёта.
 */
export function instanceStatic(doc: Document, { min }: InstanceStaticOptions): InstanceStaticResult {
  const root = doc.getRoot();
  const moving = movingNodes(doc);
  const ext = doc.createExtension(EXTMeshGPUInstancing);

  const out: InstanceStaticResult = { batches: 0, instances: 0, animatedSkipped: 0 };

  for (const scene of root.listScenes()) {
    const byMesh = new Map<Mesh, Node[]>();
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh) return;
      if (node.getExtension('EXT_mesh_gpu_instancing')) return;   // уже партия
      if (node.getSkin()) return;                                 // своё преобразование
      if (moving.has(node)) { out.animatedSkipped++; return; }    // движется — не замораживаем
      const list = byMesh.get(mesh) || [];
      list.push(node);
      byMesh.set(mesh, list);
    });

    const emptied: Node[] = [];
    for (const [mesh, nodes] of byMesh) {
      if (nodes.length < min) continue;
      // Объём + разный масштаб внутри партии не сохранить (запрет из библиотеки).
      if (mesh.listPrimitives().some(hasVolume) && nodes.some(hasScale)) continue;

      const buffer = mesh.listPrimitives()[0]!.getAttribute('POSITION')!.getBuffer();
      const acc = (type: 'VEC3' | 'VEC4', size: number) => doc.createAccessor()
        .setType(type).setArray(new Float32Array(size * nodes.length)).setBuffer(buffer);
      const translation = acc('VEC3', 3);
      const rotation = acc('VEC4', 4);
      const scale = acc('VEC3', 3);
      const batch = ext.createInstancedMesh()
        .setAttribute('TRANSLATION', translation)
        .setAttribute('ROTATION', rotation)
        .setAttribute('SCALE', scale);

      let needT = false, needR = false, needS = false;
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        let t: vec3, r: vec4, s: vec3;
        translation.setElement(i, (t = node.getWorldTranslation()));
        rotation.setElement(i, (r = node.getWorldRotation()));
        scale.setElement(i, (s = node.getWorldScale()));
        if (!MathUtils.eq(t, [0, 0, 0])) needT = true;
        if (!MathUtils.eq(r, [0, 0, 0, 1])) needR = true;
        if (!MathUtils.eq(s, [1, 1, 1])) needS = true;
      }
      if (!needT) translation.dispose();
      if (!needR) rotation.dispose();
      if (!needS) scale.dispose();

      const batchNode = doc.createNode().setMesh(mesh).setExtension('EXT_mesh_gpu_instancing', batch);
      scene.addChild(batchNode);

      // Все копии стоят в одном месте — партия ничего не даёт, а узел добавила бы.
      if (!needT && !needR && !needS) {
        batchNode.dispose();
        batch.dispose();
        continue;
      }

      for (const node of nodes) { node.setMesh(null); emptied.push(node); }
      out.batches++;
      out.instances += nodes.length;
    }

    pruneEmptied(emptied);
  }

  if (!ext.listProperties().length) ext.dispose();
  return out;
}

/**
 * Убрать узлы, которые остались ни с чем после переноса меша в партию.
 *
 * Узел с детьми, камерой, скином или своим расширением НЕ трогаем: он всё ещё несёт
 * смысл. Опустевший родитель проверяется следом — цепочка пустых обёрток уходит целиком.
 */
function pruneEmptied(nodes: Node[]): void {
  let node: Node | undefined;
  while ((node = nodes.pop())) {
    if (node.listChildren().length || node.getCamera() || node.getMesh()
      || node.getSkin() || node.listExtensions().length) continue;
    const parent = node.getParentNode();
    if (parent) nodes.push(parent);
    node.dispose();
  }
}
