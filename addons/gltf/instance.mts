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

/**
 * КОПИИ, РАЗЪЕХАВШИЕСЯ ПО ВЕРШИНАМ: узнать их и свести к одному мешу.
 *
 * ПОВОД (Александр, 2026-08-23): «это одинаковые кубы. мы никак не можем начать их тоже
 * инстансить? если человек пришлёт такую же модель мы не сможем понять что это одинаковые
 * модели никак?»
 *
 * Можем. Это самый обычный экспорт: модификатор Array в Blender ЗАПЕКАЕТ смещение каждой
 * копии прямо в координаты вершин. На выходе получается не «один меш и 625 узлов», а 625
 * отдельных мешей, у которых узлы стоят в одной точке. Склейка одинаковых (`dedup`) их не
 * видит — данные и правда разные; инстансинг не видит тем более.
 *
 * Замер на `Instance Grid 01`: 625 мешей, из них **623 — одна и та же форма**, отличие
 * только в сдвиге. Оставшиеся два отличаются порядком вершин, и их мы не трогаем.
 *
 * КАК ЭТО ДЕЛАЕТСЯ БЕЗ ЕДИНОЙ ПРАВКИ ГЕОМЕТРИИ. Вершины не переписываются вовсе — это
 * важно, потому что переписанная геометрия автора требует другого разговора (Правило 11).
 * Мы меняем только УЗЕЛ: он начинает ссылаться на общий меш, а разницу берёт на себя его
 * собственное преобразование. Матрица узла в glTF есть T·R·S, и чтобы вершина осталась на
 * прежнем месте при сдвиге меша на `o`, достаточно T' = T + R·S·o. Картинка не меняется
 * ни на пиксель, а лишние меши после этого убирает обычная чистка.
 *
 * ЧЕГО НЕ ТРОГАЕМ, и каждый запрет закрывает настоящую беду:
 *   · узлы С ДЕТЬМИ — правка их преобразования утащила бы за собой всё поддерево;
 *   · скиннутые меши — там своё преобразование и свои обратные матрицы;
 *   · меши с запасными формами — их дельты сравнивать сложнее, чем они того стоят;
 *   · узлы, чей меш делят другие узлы, — такой меш уже общий, сводить нечего.
 */
export interface UnbakeResult {
  /** Сколько групп «одна форма, разные места» найдено. */
  groups: number;
  /** Сколько мешей перестали быть отдельными. */
  merged: number;
}

/**
 * Подпись формы: координаты ОТНОСИТЕЛЬНО первой вершины плюс всё остальное как есть.
 *
 * Сдвиг не меняет ни нормалей, ни развёртки, ни индексов — поэтому они входят в подпись
 * без изменений, а положение приводится к общему началу.
 *
 * Сравнение ТОЧНОЕ, без допуска. Допуск здесь означал бы «две почти одинаковые детали
 * считаем одной», то есть правку модели по нашему усмотрению; на замере он и не нужен —
 * 623 куба совпали побитово.
 */
function shapeKey(mesh: Mesh): string | null {
  const prims = mesh.listPrimitives();
  if (prims.length !== 1) return null;              // составной меш — не наш случай
  const prim = prims[0]!;
  if (prim.listTargets().length) return null;       // запасные формы
  if (prim.getAttribute('JOINTS_0')) return null;   // скин

  const pos = prim.getAttribute('POSITION');
  if (!pos || !pos.getCount()) return null;
  const o = pos.getElement(0, []);
  const parts: string[] = [String(prim.getMode()), prim.getMaterial()?.getName() ?? ''];
  const rel = new Float32Array(pos.getCount() * 3);
  for (let i = 0; i < pos.getCount(); i++) {
    const v = pos.getElement(i, []);
    rel[i * 3] = v[0]! - o[0]!;
    rel[i * 3 + 1] = v[1]! - o[1]!;
    rel[i * 3 + 2] = v[2]! - o[2]!;
  }
  parts.push(Buffer.from(rel.buffer, rel.byteOffset, rel.byteLength).toString('base64'));

  for (const name of prim.listSemantics().filter((n) => n !== 'POSITION').sort()) {
    const a = prim.getAttribute(name)!;
    const arr = a.getArray();
    parts.push(name, Buffer.from(arr!.buffer, arr!.byteOffset, arr!.byteLength).toString('base64'));
  }
  const idx = prim.getIndices();
  if (idx) {
    const arr = idx.getArray()!;
    parts.push('I', Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64'));
  }
  return parts.join('|');
}

/** Первая вершина меша — точка, относительно которой считается сдвиг. */
function anchor(mesh: Mesh): vec3 {
  const v: number[] = [];
  mesh.listPrimitives()[0]!.getAttribute('POSITION')!.getElement(0, v);
  return [v[0]!, v[1]!, v[2]!];
}

/** Повернуть и растянуть вектор преобразованием самого узла: R·S·o. */
function applyRS(node: Node, o: vec3): vec3 {
  const [x, y, z] = o;
  const s = node.getScale();
  const [qx, qy, qz, qw] = node.getRotation();
  const sx = x * s[0], sy = y * s[1], sz = z * s[2];
  // Поворот кватернионом: v + 2q_v × (q_v × v + q_w·v)
  const tx = 2 * (qy * sz - qz * sy);
  const ty = 2 * (qz * sx - qx * sz);
  const tz = 2 * (qx * sy - qy * sx);
  return [
    sx + qw * tx + (qy * tz - qz * ty),
    sy + qw * ty + (qz * tx - qx * tz),
    sz + qw * tz + (qx * ty - qy * tx),
  ];
}

/**
 * Свести меши одной формы к одному, перенеся разницу в преобразования узлов.
 *
 * Геометрия не переписывается: меняются только ссылки узлов и их сдвиг.
 */
export function unbakeCopies(doc: Document): UnbakeResult {
  const root = doc.getRoot();
  const out: UnbakeResult = { groups: 0, merged: 0 };

  // Меш → узлы, которые на него ссылаются. Меш с несколькими хозяевами уже общий.
  const owners = new Map<Mesh, Node[]>();
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const list = owners.get(mesh) || [];
    list.push(node);
    owners.set(mesh, list);
  }

  const byShape = new Map<string, Mesh[]>();
  for (const [mesh, nodes] of owners) {
    if (nodes.length !== 1) continue;               // меш уже делят — не наш случай
    if (nodes[0]!.listChildren().length) continue;  // правка узла утащит поддерево
    if (nodes[0]!.getSkin()) continue;
    const key = shapeKey(mesh);
    if (!key) continue;
    const list = byShape.get(key) || [];
    list.push(mesh);
    byShape.set(key, list);
  }

  for (const meshes of byShape.values()) {
    if (meshes.length < 2) continue;
    const canon = meshes[0]!;
    const base = anchor(canon);
    out.groups++;
    for (let i = 1; i < meshes.length; i++) {
      const mesh = meshes[i]!;
      const node = owners.get(mesh)![0]!;
      const a = anchor(mesh);
      const o: vec3 = [a[0] - base[0], a[1] - base[1], a[2] - base[2]];
      const shift = applyRS(node, o);
      const t = node.getTranslation();
      node.setTranslation([t[0] + shift[0], t[1] + shift[1], t[2] + shift[2]]);
      node.setMesh(canon);
      mesh.dispose();
      out.merged++;
    }
  }
  return out;
}
