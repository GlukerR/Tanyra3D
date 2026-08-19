// tests/skin-rules.test.mjs — три правила скиннинга (правила скиннинга, 2026-08-12).
//
// Почему модели здесь СИНТЕТИЧЕСКИЕ, а не из корпуса. Скиннутых моделей в публичном
// репозитории нет ни одной: все они чужие (Sketchfab, Khronos) и по лицензии не
// коммитятся. Тест на локальных моделях на чистом клоне пропустился бы целиком — то
// есть на CI эти правила не проверялись бы вовсе.
//
// Второе, и более важное: замер 2026-08-12 показал, что на настоящих моделях правило
// нормализации не срабатывает НИ РАЗУ (у chibi_zenitsu сумма долей оказалась единицей,
// а жалоба валидатора шла от повторной кости). Зелёный прогон по корпусу означал бы
// «правило не сломано», а не «правило работает». Здесь каждый дефект собран руками.
//
// Разделение проверок:
//   · fix() напрямую — точные числа до и после, без влияния сварки и чистки;
//   · через весь пайплайн — что коды валидатора действительно исчезают;
//   · плотность отчёта — одна строка на класс, а не на вершину (Правило 9).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';

import { runOptimize } from '../core/engine.mjs';
import gltfAddon from '../addons/gltf/index.mjs';

const validator = await import('gltf-validator');

const DEDUPE = 'skin/joints-dedupe';
const NORMALIZE = 'skin/weights-normalize';
const ZERO_JOINTS = 'skin/zero-weight-joints';

const ruleOf = (id) => {
  const rule = gltfAddon.rules.find((r) => r.meta.id === id);
  if (!rule) throw new Error(`правило ${id} не найдено в аддоне`);
  return rule;
};

/**
 * Скиннутая модель из четырёх вершин с заданными влияниями.
 *
 * @param joints  плоский список VEC4 индексов костей (4 числа на вершину)
 * @param weights плоский список VEC4 долей
 * @param opts.normalized — веса хранить нормализованными ushort вместо float
 */
function skinnedDoc(joints, weights, { normalized = false } = {}) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const count = joints.length / 4;

  const position = doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array(Array.from({ length: count }, (_, i) => [i, 0, 0]).flat()));

  const jointsAcc = doc.createAccessor().setType('VEC4').setBuffer(buffer)
    .setArray(new Uint16Array(joints));

  const weightsAcc = doc.createAccessor().setType('VEC4').setBuffer(buffer);
  if (normalized) {
    weightsAcc.setArray(new Uint16Array(weights.map((w) => Math.round(w * 65535)))).setNormalized(true);
  } else {
    weightsAcc.setArray(new Float32Array(weights));
  }

  const prim = doc.createPrimitive()
    .setAttribute('POSITION', position)
    .setAttribute('JOINTS_0', jointsAcc)
    .setAttribute('WEIGHTS_0', weightsAcc);
  const mesh = doc.createMesh('Skinned').addPrimitive(prim);

  // Три кости: индексы 0..2 в списке скина. Матрицы обратной привязки единичные —
  // для этих правил они не важны, но без них файл не пройдёт валидатор.
  const bones = [0, 1, 2].map((i) => doc.createNode(`Bone${i}`));
  const ibm = doc.createAccessor().setType('MAT4').setBuffer(buffer)
    .setArray(new Float32Array(bones.flatMap(() => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])));
  const skin = doc.createSkin('Skin').setInverseBindMatrices(ibm);
  for (const b of bones) skin.addJoint(b);

  const node = doc.createNode('SkinnedNode').setMesh(mesh).setSkin(skin);
  const scene = doc.createScene('Scene').addChild(node);
  for (const b of bones) scene.addChild(b);
  return { doc, prim };
}

/** Прогнать fix() одного правила по документу — без движка, без файла. */
function applyRule(id, doc) {
  const rule = ruleOf(id);
  return rule.fix({ messageId: 'pipeline', data: {} }, { document: doc, cache: new Map(), opts: {} });
}

/** Влияния вершины i одним плоским списком. */
function read(prim, sem, i) {
  const out = [];
  prim.getAttribute(sem).getElement(i, out);
  return out;
}

// ---------------------------------------------------------------------------
// skin/weights-normalize
// ---------------------------------------------------------------------------

describe('skin/weights-normalize — доли костей приводятся к единице', () => {
  it('сумма 0.8 становится единицей, а соотношение между костями сохраняется', () => {
    const { doc, prim } = skinnedDoc(
      [0, 1, 0, 0],
      [0.6, 0.2, 0, 0],
    );
    const res = applyRule(NORMALIZE, doc);

    const w = read(prim, 'WEIGHTS_0', 0);
    expect(w[0] + w[1] + w[2] + w[3]).toBeCloseTo(1, 6);
    // было 0.6 к 0.2, то есть три к одному — деление на сумму это соотношение не трогает
    expect(w[0] / w[1]).toBeCloseTo(3, 6);
    expect(res.found.length, 'правило обязано сказать, что нашло').toBe(1);
  });

  it('вершину без единого влияния не трогает, а объясняет', () => {
    const { doc, prim } = skinnedDoc(
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    );
    const res = applyRule(NORMALIZE, doc);

    expect(read(prim, 'WEIGHTS_0', 0)).toEqual([0, 0, 0, 0]);
    expect(res.found.length, 'чинить тут нечего').toBe(0);
    expect(res.skipped.map((m) => m.messageId)).toContain('skinWeights.skipped.zeroSum');
  });

  it('уже нормализованную вершину не переписывает', () => {
    const { doc } = skinnedDoc([0, 1, 0, 0], [0.75, 0.25, 0, 0]);
    const res = applyRule(NORMALIZE, doc);
    expect(res.found.length).toBe(0);
  });

  // Главная ловушка нормализованных целых: деления на сумму мало. 0.7 и 0.3 запишутся
  // как 45875 + 19661 = 65536, то есть на шаг больше потолка, и валидатор пожалуется
  // снова — уже на нашу работу.
  it('у весов в нормализованных ushort сумма сходится В ЦЕЛЫХ, а не «примерно»', () => {
    const { doc, prim } = skinnedDoc(
      [0, 1, 0, 0],
      [0.56, 0.24, 0, 0], // сумма 0.8, доли 0.7 и 0.3 после нормализации
      { normalized: true },
    );
    applyRule(NORMALIZE, doc);

    const raw = prim.getAttribute('WEIGHTS_0').getArray();
    const sum = raw[0] + raw[1] + raw[2] + raw[3];
    expect(sum, `сумма целых ${sum} вместо 65535 — файл останется невалидным`).toBe(65535);
  });
});

// ---------------------------------------------------------------------------
// skin/joints-dedupe
// ---------------------------------------------------------------------------

describe('skin/joints-dedupe — повторная кость сводится в одну', () => {
  it('доли повтора складываются в первое вхождение, место освобождается', () => {
    const { doc, prim } = skinnedDoc(
      [1, 1, 0, 0],
      [0.5, 0.3, 0, 0],
    );
    const res = applyRule(DEDUPE, doc);

    expect(read(prim, 'JOINTS_0', 0)).toEqual([1, 0, 0, 0]);
    const w = read(prim, 'WEIGHTS_0', 0);
    expect(w[0]).toBeCloseTo(0.8, 6); // 0.5 + 0.3 — суммарное влияние не изменилось
    expect(w[1]).toBe(0);

    // Что именно уедет в отчёт. Без этой проверки правило могло бы вернуть любые числа
    // в data — тест бы этого не заметил (находка ревью 2026-08-12).
    expect(res.found).toEqual([
      { messageId: 'skinJoints.found.duplicate', data: { n: 1, joints: 1 } },
    ]);
  });

  // Дефект, найденный на замере 2026-08-12: набивка нулями считалась повтором, и
  // правило отчитывалось о 49 124 «повторах» там, где валидатор видит два.
  it('набивку нулями повтором НЕ считает', () => {
    const { doc, prim } = skinnedDoc(
      [3, 0, 0, 0], // три нуля — это пустые места, а не три ссылки на кость 0
      [1, 0, 0, 0],
    );
    const res = applyRule(DEDUPE, doc);

    expect(res.found.length, 'повторов тут нет').toBe(0);
    expect(read(prim, 'JOINTS_0', 0)).toEqual([3, 0, 0, 0]);
  });

  it('разные кости не трогает', () => {
    const { doc, prim } = skinnedDoc([0, 1, 2, 0], [0.4, 0.3, 0.3, 0]);
    const res = applyRule(DEDUPE, doc);
    expect(res.found.length).toBe(0);
    expect(read(prim, 'JOINTS_0', 0)).toEqual([0, 1, 2, 0]);
  });
});

// ---------------------------------------------------------------------------
// skin/zero-weight-joints
// ---------------------------------------------------------------------------

describe('skin/zero-weight-joints — ссылка на кость с нулевой долей стирается', () => {
  it('индекс обнуляется, доли остаются нетронутыми', () => {
    const { doc, prim } = skinnedDoc(
      [1, 2, 0, 0],
      [1, 0, 0, 0], // кость 2 записана, но не влияет
    );
    applyRule(ZERO_JOINTS, doc);

    expect(read(prim, 'JOINTS_0', 0)).toEqual([1, 0, 0, 0]);
    expect(read(prim, 'WEIGHTS_0', 0)).toEqual([1, 0, 0, 0]);
  });

  it('кость с ненулевой долей не трогает', () => {
    const { doc, prim } = skinnedDoc([1, 2, 0, 0], [0.5, 0.5, 0, 0]);
    const res = applyRule(ZERO_JOINTS, doc);
    expect(res.found.length).toBe(0);
    expect(read(prim, 'JOINTS_0', 0)).toEqual([1, 2, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// scene/skinned-mesh-root
// ---------------------------------------------------------------------------

const SKINNED_ROOT = 'scene/skinned-mesh-root';

/** Спрятать узел под обёртку (или две), как это делают экспортёры. */
function nest(doc, node, transforms) {
  const scene = doc.getRoot().listScenes()[0];
  scene.removeChild(node);
  let child = node;
  for (const t of transforms) {
    const wrapper = doc.createNode(`Wrapper${transforms.indexOf(t)}`);
    if (t.translation) wrapper.setTranslation(t.translation);
    if (t.rotation) wrapper.setRotation(t.rotation);
    if (t.scale) wrapper.setScale(t.scale);
    wrapper.addChild(child);
    child = wrapper;
  }
  scene.addChild(child);
  return child;
}

describe('scene/skinned-mesh-root — переносится только доказуемое', () => {
  it('под единичными обёртками узел уезжает в корень сцены', () => {
    const { doc } = skinnedDoc([0, 1, 0, 0], [0.5, 0.5, 0, 0]);
    const node = doc.getRoot().listNodes().find((n) => n.getSkin());
    nest(doc, node, [{}, {}]); // две обёртки без собственных преобразований

    const res = applyRule(SKINNED_ROOT, doc);

    expect(node.getParentNode(), 'узел остался под обёрткой').toBe(null);
    expect(doc.getRoot().listScenes()[0].listChildren()).toContain(node);
    expect(res.found.map((m) => m.messageId)).toEqual(['skinnedRoot.found']);
  });

  // Настоящий случай, а не выдуманный: замер 2026-08-12 на chibi_zenitsu показал
  // цепочку Object_4[единичный] → RootNode[единичный] → Object_2[единичный] →
  // …fbx[СВОЁ ПРЕОБРАЗОВАНИЕ] → Sketchfab_model[СВОЁ ПРЕОБРАЗОВАНИЕ]. Ближайший
  // родитель единичный, а выше — поворот Z-up и масштаб экспортёра.
  it('обёртка с поворотом выше по цепочке останавливает перенос', () => {
    const { doc } = skinnedDoc([0, 1, 0, 0], [0.5, 0.5, 0, 0]);
    const node = doc.getRoot().listNodes().find((n) => n.getSkin());
    const top = nest(doc, node, [{}, { rotation: [0.7071068, 0, 0, 0.7071068] }]);

    const res = applyRule(SKINNED_ROOT, doc);

    expect(node.getParentNode(), 'узел утащили из-под преобразования').not.toBe(null);
    expect(doc.getRoot().listScenes()[0].listChildren()).toContain(top);
    expect(res.found.length).toBe(0);
    expect(res.skipped.map((m) => m.messageId)).toEqual(['skinnedRoot.skipped.notProvable']);
  });

  it('узел с детьми не трогается — дети уехали бы вместе с ним', () => {
    const { doc } = skinnedDoc([0, 1, 0, 0], [0.5, 0.5, 0, 0]);
    const node = doc.getRoot().listNodes().find((n) => n.getSkin());
    node.addChild(doc.createNode('Attachment').setTranslation([1, 0, 0]));
    nest(doc, node, [{}]);

    const res = applyRule(SKINNED_ROOT, doc);

    expect(node.getParentNode()).not.toBe(null);
    expect(res.skipped.map((m) => m.messageId)).toEqual(['skinnedRoot.skipped.notProvable']);
  });

  it('анимированный родитель останавливает перенос, даже если он единичный в позе покоя', () => {
    const { doc } = skinnedDoc([0, 1, 0, 0], [0.5, 0.5, 0, 0]);
    const node = doc.getRoot().listNodes().find((n) => n.getSkin());
    const wrapper = nest(doc, node, [{}]);

    const buffer = doc.getRoot().listBuffers()[0];
    const input = doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(new Float32Array([0, 1]));
    const output = doc.createAccessor().setType('VEC3').setBuffer(buffer)
      .setArray(new Float32Array([0, 0, 0, 0, 5, 0]));
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
    const channel = doc.createAnimationChannel().setTargetNode(wrapper).setTargetPath('translation').setSampler(sampler);
    doc.createAnimation('Move').addSampler(sampler).addChannel(channel);

    const res = applyRule(SKINNED_ROOT, doc);

    expect(node.getParentNode(), 'узел уехал из-под анимированной обёртки').not.toBe(null);
    expect(res.skipped.map((m) => m.messageId)).toEqual(['skinnedRoot.skipped.notProvable']);
  });
});

// ---------------------------------------------------------------------------
// Правило 9: одна строка на класс, а не на вершину
// ---------------------------------------------------------------------------

describe('плотность отчёта у правил скиннинга', () => {
  it('тысяча битых вершин даёт по одной строке на правило, а не тысячу', () => {
    const N = 1000;
    const joints = [];
    const weights = [];
    for (let i = 0; i < N; i++) {
      // Все три дефекта разом, иначе проверка вырождается: на вершине без повтора
      // правило дублей вернёт ноль строк и «не больше трёх» пройдёт тривиально —
      // даже если у него сломана вся сборка находок (находка ревью 2026-08-12).
      joints.push(1, 1, 2, 0); // кость 1 дважды; кость 2 — с нулевой долей
      weights.push(0.4, 0.2, 0, 0); // и сумма 0.6, а не единица
    }
    const { doc } = skinnedDoc(joints, weights);

    for (const id of [DEDUPE, NORMALIZE, ZERO_JOINTS]) {
      const res = applyRule(id, doc);
      const lines = [...res.found, ...res.details, ...res.skipped];
      expect(lines.length, `${id} не нашло на ${N} битых вершинах ничего — проверять нечего`)
        .toBeGreaterThan(0);
      expect(lines.length, `${id} вернуло ${lines.length} строк на ${N} вершин`).toBeLessThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// Через весь пайплайн: коды валидатора действительно исчезают
// ---------------------------------------------------------------------------

describe('признак готовности §5b1 — код исчезает, модель цела', () => {
  it('safe убирает все три кода и не добавляет новых', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-rules-'));
    try {
      const src = path.join(tmp, 'broken-skin.glb');
      const { doc } = skinnedDoc(
        [
          1, 1, 0, 0, // повторная кость
          0, 1, 0, 0, // сумма долей 0.8
          1, 2, 0, 0, // кость с нулевой долей
          2, 0, 0, 0, // здоровая вершина
        ],
        [
          0.5, 0.3, 0, 0,
          0.6, 0.2, 0, 0,
          1, 0, 0, 0,
          1, 0, 0, 0,
        ],
      );
      await new NodeIO().write(src, doc);

      const codes = async (file) => {
        const res = await validator.validateBytes(new Uint8Array(fs.readFileSync(file)));
        const out = new Map();
        for (const m of res.issues.messages || []) out.set(m.code, (out.get(m.code) || 0) + 1);
        return out;
      };

      const before = await codes(src);
      // Модель обязана быть сломанной ДО прогона — иначе тест ничего не проверяет.
      expect([...before.keys()], 'синтетическая модель не содержит дефектов').toEqual(
        expect.arrayContaining([
          'ACCESSOR_JOINTS_INDEX_DUPLICATE',
          'ACCESSOR_WEIGHTS_NON_NORMALIZED',
          'ACCESSOR_JOINTS_USED_ZERO_WEIGHT',
        ]),
      );

      const r = await runOptimize(gltfAddon, src, { outDir: path.join(tmp, 'out'), force: true, safe: true });
      expect(r.file.written, 'файл не записан — сравнивать не с чем').toBe(true);

      const after = await codes(r.file.dst);
      for (const code of [
        'ACCESSOR_JOINTS_INDEX_DUPLICATE',
        'ACCESSOR_WEIGHTS_NON_NORMALIZED',
        'ACCESSOR_JOINTS_USED_ZERO_WEIGHT',
      ]) {
        expect(after.get(code) || 0, `${code} остался в результате`).toBe(0);
      }

      const born = [...after.keys()].filter((c) => !before.has(c));
      expect(born, `появились коды, которых во входном файле не было: ${born.join(', ')}`).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
