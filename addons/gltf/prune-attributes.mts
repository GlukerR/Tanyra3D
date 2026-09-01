// addons/gltf/prune-attributes.mts — убрать лишние данные вершин, НЕ трогая развёртку.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ ВООБЩЕ ПОЯВИЛСЯ. Человек просит «оставь развёртку, покрытие выберут на
// сайте» (конфигуратор). Библиотека `gltf-transform` даёт на это одну ручку —
// `prune({ keepAttributes })`, и она ОБЩАЯ на все данные вершин сразу: попросив оставить
// развёртку, получаешь заодно нормали, которые никто не читает, касательные без карты
// нормалей и лишние цветовые каналы. Замер 2026-09-01 по корпусу:
//
//   parkergirl           развёртка     2 КБ,  прочее   210 КБ
//   Lilith Character 01  развёртка     0 КБ,  прочее   586 КБ
//   AnimationPointerUVs  развёртка     0 КБ,  прочее  1626 КБ
//   MagicBall            развёртка  1345 КБ,  прочее  2690 КБ
//
// То есть надбавка, которую человек платил за просьбу, в основном НЕ развёртка, а всё
// остальное. Александр, 2026-09-01: «мы ранее когда просто сейф оптимизацию делали всё
// лишнее сносили. мы не можем сделать так же, но оставлять юви неиспользуемую?» Можем —
// вот здесь.
//
// ЧЕМ ЗА ЭТО ПЛАТИМ, И ЧТО СТОРОЖИТ. Правила «что материал действительно читает»
// библиотека наружу не отдаёт (`listRequiredSemantics`/`listUnusedSemantics` не
// экспортированы), поэтому они повторены здесь. Своя копия чужого счёта опасна ровно
// одним: она может разойтись с оригиналом МОЛЧА, и мы начнём сносить нужное или хранить
// лишнее. Против этого стоит сторож `tests/keep-unused-uv.test.mjs`, раздел «согласие с
// библиотекой»: он гоняет по каждой модели корпуса библиотечную чистку и нашу и требует,
// чтобы список убранного совпал с точностью до развёртки. Разойдётся — покраснеет здесь,
// а не у человека в файле.
//
// ЧЕГО ЗДЕСЬ НЕТ. Перенумерации каналов развёртки (`shiftTexCoords` у библиотеки). Она
// нужна, когда часть каналов убрали и в нумерации появились дыры; мы не убираем НИ
// ОДНОГО канала, поэтому нумерация остаётся ровно авторской и материал по-прежнему
// показывает на свой номер.

import {
  ExtensionProperty,
  Material,
  Primitive,
  Texture,
  TextureInfo,
} from '@gltf-transform/core';
// Тип, а не значение: `instanceof Document` нам не нужен, и обычный импорт tsc оставил бы
// в собранном файле мёртвой строкой.
import type { Document } from '@gltf-transform/core';

/**
 * Семантики, которые материал действительно читает.
 *
 * Повтор `listRequiredSemantics` библиотеки. POSITION и прочее безусловное сюда не
 * входит — оно и не рассматривается к удалению.
 */
function required(
  document: Document,
  prim: Primitive,
  material: Material | ExtensionProperty,
  out = new Set<string>(),
): Set<string> {
  const edges = document.getGraph().listChildEdges(material);
  // Гнездо `…Info` считается только при живой картинке: у пустого слота texCoord тоже
  // есть, и без этой проверки мы бы объявили нужным канал, который никто не читает.
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

/**
 * Что снесла бы обычная чистка. Повтор `listUnusedSemantics` библиотеки.
 *
 * Развёртка в список ВХОДИТ — отбор «кроме развёртки» делает вызывающий, и делает его в
 * одном месте. Так сторож может сравнить наш список с библиотечным один к одному.
 */
function unusedOf(prim: Primitive, need: Set<string>): string[] {
  const out: string[] = [];
  for (const s of prim.listSemantics()) {
    if (s === 'NORMAL' && !need.has(s)) out.push(s);
    else if (s === 'TANGENT' && !need.has(s)) out.push(s);
    else if (s.startsWith('TEXCOORD_') && !need.has(s)) out.push(s);
    // COLOR_0 не трогаем никогда: это раскраска вершин, замысел автора (Правило 11), и
    // за неё отвечает отдельная галочка `strip-colors`. Каналы со второго — след
    // экспорта, их не читает ни один материал glTF.
    else if (s.startsWith('COLOR_') && s !== 'COLOR_0') out.push(s);
  }
  return out;
}

/**
 * Снять с примитивов данные вершин, которых не читает ни один материал, — КРОМЕ развёртки.
 *
 * Аксессоры сами по себе отсюда не исчезают: их подберёт следующий за нами
 * `prune({ keepAttributes: true })`, который обходит осиротевшее. Разделение намеренное —
 * мы отвечаем за «что отцепить», библиотека за «что после этого выбросить».
 *
 * Возвращает список убранных семантик, по одной записи на каждое снятие: считать их
 * — дело вызывающего, у него для этого есть свой замер до и после.
 */
export function dropUnusedExceptUv(document: Document): string[] {
  const убрано: string[] = [];
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const material = prim.getMaterial();
      // Примитив без материала библиотека тоже пропускает: читать его данные некому, но и
      // судить о нужности не по чему.
      if (!material) continue;
      const лишние = unusedOf(prim, required(document, prim, material))
        .filter((s) => !s.startsWith('TEXCOORD_'));
      for (const s of лишние) {
        prim.setAttribute(s, null);
        убрано.push(s);
      }
      // Цели морфинга держат те же семантики и должны терять их вместе с примитивом,
      // иначе останется цель, двигающая атрибут, которого больше нет.
      for (const target of prim.listTargets()) {
        for (const s of лишние) target.setAttribute(s, null);
      }
    }
  }
  return убрано;
}
