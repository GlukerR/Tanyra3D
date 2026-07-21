// addons/gltf/rules.mjs — десять правил пайплайна glTF, перенесённые из optimize2.mjs
// без изменения логики. Каждое действие пайплайна — объект формы (см. core/types.mjs):
//   meta { id, category, title, severity, fixSafety, tier, runAfter, touches, enabled, ... }
//   analyze(ctx)          — фаза 1, только чтение
//   canFix(finding, ctx)  — доказательство безопасности, причина идёт в отчёт
//   fix(finding, ctx)     — фаза 3, меняет ctx.document (рабочую копию)
//
// fix возвращает { found, skipped, details } — строки для секций отчёта
// «Найдено» / «Пропущено» / «Применено» (любое поле опционально).
//
// ВАЖНО (эквивалентность v2): бОльшая часть находок в glTF считается только
// по факту применения (diff до/после prune, вырожденные треугольники появляются
// ПОСЛЕ weld и т.д. — см. ARCHITECTURE.md §2.1). Поэтому analyze здесь возвращает
// «задание» ({ messageId: 'pipeline' }), а конкретика с цифрами приходит из fix.

import fs from 'node:fs';
import path from 'node:path';

import * as fns from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

import { collectMetrics, countTriangles, effectiveSkins, listSemantics } from './metrics.mjs';
import { GLTF_CLI, TOKTX, runCli } from './tools.mjs';

// Порядок пайплайна ЖЁСТКИЙ и выверен в v2 (кодируется через runAfter):
// dedup → prune → vertex-colors → weld → degenerate → orphan → (flatten+join)
// → prune → ktx2 → geometry-compress. Не менять.
export const RULES = [
  {
    meta: {
      id: 'structure/dedup', category: 'materials', title: 'Дубли ресурсов (dedup)',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: [], touches: ['texture', 'material', 'accessor'],
      reversible: false, dataLoss: 'none', // склеиваются только байт-в-байт идентичные копии — терять нечего
      enabled: () => true,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, reason: 'склейка идентичных ресурсов структурно безопасна' }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const b = { tex: root.listTextures().length, mat: root.listMaterials().length, acc: root.listAccessors().length };
      await ctx.document.transform(fns.dedup());
      const a = { tex: root.listTextures().length, mat: root.listMaterials().length, acc: root.listAccessors().length };
      const out = { found: [], details: [] };
      if (b.tex > a.tex) { out.found.push(`дубли текстур: ${b.tex - a.tex}`); out.details.push(`Склеены дубли текстур (${b.tex - a.tex})`); }
      if (b.mat > a.mat) { out.found.push(`дубли материалов: ${b.mat - a.mat}`); out.details.push(`Склеены дубли материалов (${b.mat - a.mat})`); }
      if (b.acc > a.acc) { out.found.push(`дубли аксессоров: ${b.acc - a.acc}`); out.details.push(`Склеены дубли аксессоров (${b.acc - a.acc})`); }
      return out;
    },
  },

  {
    meta: {
      id: 'structure/prune-unused', category: 'scene', title: 'Неиспользуемые ресурсы (prune)',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['structure/dedup'], touches: ['texture', 'material', 'accessor', 'node'],
      reversible: false, dataLoss: 'none', // удаляется только то, на что нет ни одной ссылки
      enabled: () => true,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, reason: 'удаляется только то, на что нет ни одной ссылки' }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const semBefore = listSemantics(ctx.document);
      const b = { tex: root.listTextures().length, mat: root.listMaterials().length, skins: root.listSkins().length, effSkins: effectiveSkins(ctx.document) };
      await ctx.document.transform(fns.prune({ keepAttributes: false, keepLeaves: false }));
      const semAfter = listSemantics(ctx.document);
      const a = { tex: root.listTextures().length, mat: root.listMaterials().length, skins: root.listSkins().length, effSkins: effectiveSkins(ctx.document) };
      const out = { found: [], details: [] };
      for (const s of semBefore) {
        if (!semAfter.has(s)) {
          out.found.push(`атрибут ${s} не используется ни одним материалом`);
          out.details.push(`Атрибут ${s}: не используется ни одним материалом — удалён (prune)`);
        }
      }
      if (b.tex > a.tex) { out.found.push(`неиспользуемые текстуры: ${b.tex - a.tex}`); out.details.push(`Текстуры: удалено ${b.tex - a.tex} неиспользуемых`); }
      if (b.mat > a.mat) { out.found.push(`неиспользуемые материалы: ${b.mat - a.mat}`); out.details.push(`Материалы: удалено ${b.mat - a.mat} неиспользуемых`); }
      if (b.skins > a.skins && b.effSkins === a.effSkins) {
        // удалены только пустышки: действующих скинов не убыло (иначе инвариант остановит запись)
        out.found.push(`скины-пустышки (у мешей нет JOINTS/WEIGHTS): ${b.skins - a.skins}`);
        out.details.push(`Удалено ${b.skins - a.skins} скинов-пустышек — деформаций не было, анимация работает через иерархию узлов`);
      }
      return out;
    },
  },

  {
    meta: {
      // tier basic: базовое действие — удаление БЕЛЫХ каналов (provable, вид не меняется).
      // Lossy-ветка (удалить раскрашенные) — расширение 'strip-colors': включается только
      // через advancedFeatures:['strip-colors'] или флаг --strip-vertex-colors (→ opts.stripColors).
      id: 'attributes/vertex-colors', category: 'attributes', title: 'Вершинные цвета (COLOR_n)',
      severity: 'warn', fixSafety: 'provable', tier: 'basic', runAfter: ['structure/prune-unused'], touches: ['accessor'],
      // базовая ветка (белые каналы) — потери нет; strip-ветка помечает свои строки
      // через res.irreversible → dataLoss 'significant' на уровне applied-записи
      reversible: false, dataLoss: 'none',
      enabled: () => true,
    },
    // Детекция при применении, а не в analyze: COLOR-каналы, которые снесёт prune
    // (например неиспользуемый COLOR_1), не должны попадать в находки — v2 сканировал
    // ПОСЛЕ prune, сохраняем то же окно измерения.
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix(finding, ctx) {
      // белый (все значения 1.0) → provable: множитель baseColor равен единице.
      // раскрашенный → lossy: убирается только явным флагом (решение внутри fix).
      return { safe: true, reason: 'белые каналы удаляются доказуемо безопасно; раскрашенные — только по флагу' };
    },
    fix(finding, ctx) {
      const out = { found: [], skipped: [], details: [] };
      const el = [];
      for (const mesh of ctx.document.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          for (const sem of prim.listSemantics()) {
            if (!sem.startsWith('COLOR_')) continue;
            const acc = prim.getAttribute(sem);
            let allWhite = true;
            const n = acc.getCount();
            for (let i = 0; i < n; i++) {
              acc.getElement(i, el); // нормализованные float-значения
              if (el.some((v) => v < 0.999)) { allWhite = false; break; }
            }
            const where = `${sem} (меш «${mesh.getName() || '—'}»)`;
            if (allWhite) {
              prim.setAttribute(sem, null);
              out.found.push(`${where}: все значения белые — на вид не влияет`);
              out.details.push(`${where}: все значения белые — удалён, вид не меняется`);
            } else if (ctx.opts.stripColors) {
              prim.setAttribute(sem, null); // lossy, но пользователь явно форсировал флагом
              out.found.push(`${where}: реальная покраска вершин`);
              (out.irreversible ??= []).push(`${where}: РАСКРАШЕН, удалён по флагу --strip-vertex-colors — вид может измениться`);
            } else {
              out.found.push(`${where}: реальная покраска вершин`);
              out.skipped.push(`${where}: реальная покраска — НЕ удалён, влияет на вид. Форсировать: --strip-vertex-colors`);
            }
          }
        }
      }
      return out;
    },
  },

  {
    meta: {
      id: 'geometry/weld', category: 'geometry', title: 'Сварка вершин (weld)',
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['attributes/vertex-colors'], touches: ['geometry', 'accessor'],
      reversible: false, dataLoss: 'none', // свариваются только идентичные вершины
      enabled: () => true,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, reason: 'свариваются только идентичные вершины' }; },
    async fix(finding, ctx) {
      // точка отсчёта для инварианта «треугольники не изменились» — как в v2:
      // после prune/цветов, до сварки (weld порождает вырожденные треугольники)
      ctx.cache.set('trianglesBeforeWeld', countTriangles(ctx.document));
      let vb = 0, va = 0;
      for (const m of ctx.document.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const pos = p.getAttribute('POSITION'); if (pos) vb += pos.getCount(); }
      await ctx.document.transform(fns.weld());
      for (const m of ctx.document.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const pos = p.getAttribute('POSITION'); if (pos) va += pos.getCount(); }
      if (vb > va) {
        return { found: [`идентичные вершины: ${vb - va}`], details: [`Сварка вершин (weld): ${vb} → ${va}`] };
      }
      return {};
    },
  },

  {
    meta: {
      id: 'geometry/degenerate-triangles', category: 'geometry', title: 'Вырожденные треугольники',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['geometry/weld'], touches: ['geometry'],
      reversible: false, dataLoss: 'none', // нулевая площадь — не рисовались
      enabled: () => true,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, reason: 'треугольник с повторным индексом имеет нулевую площадь и не рисуется' }; },
    fix(finding, ctx) {
      // два/три одинаковых индекса = нулевая площадь; считаем ПОСЛЕ weld (он их порождает).
      // Итог меряем дельтой по сцене: правка общего аксессора действует на все его инстансы.
      const trisBefore = countTriangles(ctx.document);
      const patched = new Set();
      for (const mesh of ctx.document.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          if (prim.getMode() !== 4) continue; // только TRIANGLES
          const indices = prim.getIndices();
          if (!indices || patched.has(indices)) continue;
          const arr = indices.getArray();
          const out = [];
          for (let i = 0; i + 2 < arr.length; i += 3) {
            const a = arr[i], b = arr[i + 1], c = arr[i + 2];
            if (a !== b && b !== c && a !== c) out.push(a, b, c);
          }
          if (out.length < arr.length) indices.setArray(new arr.constructor(out));
          patched.add(indices); // общий аксессор не обрабатываем дважды
        }
      }
      const sceneRemoved = trisBefore - countTriangles(ctx.document);
      ctx.cache.set('degenerateRemoved', sceneRemoved); // для инварианта по треугольникам
      if (sceneRemoved > 0) {
        return {
          found: [`вырожденные треугольники (нулевая площадь): ${sceneRemoved}`],
          details: [`Вырожденные треугольники: удалено ${sceneRemoved} (нулевая площадь, на рендер не влияли)`],
        };
      }
      return {};
    },
  },

  {
    meta: {
      id: 'geometry/orphan-vertices', category: 'geometry', title: 'Висящие вершины',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['geometry/degenerate-triangles'], touches: ['geometry', 'accessor'],
      reversible: false, dataLoss: 'none', // не адресованы индексами — не рисовались
      enabled: () => true,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() {
      if (typeof fns.compactPrimitive !== 'function') {
        return { safe: false, reason: 'compactPrimitive недоступен в этой версии @gltf-transform/functions — проход пропущен' };
      }
      return { safe: true, reason: 'вершины не адресованы ни одним индексом и не рисуются' };
    },
    fix(finding, ctx) {
      let before = 0;
      let after = 0;
      for (const mesh of ctx.document.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          const pos = prim.getAttribute('POSITION');
          if (!pos || !prim.getIndices()) continue;
          before += pos.getCount();
          fns.compactPrimitive(prim);
          after += prim.getAttribute('POSITION').getCount();
        }
      }
      if (before > after) {
        return {
          found: [`висящие вершины: ${before - after}`],
          details: [`Висящие вершины: удалено ${before - after} (не адресованы индексами, не рисовались)`],
        };
      }
      return {};
    },
  },

  {
    meta: {
      id: 'scene/join', category: 'scene', title: 'Объединение мешей (flatten + join)',
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['geometry/orphan-vertices'], touches: ['geometry', 'node'],
      reversible: false, dataLoss: 'significant', // §4d: структура узлов и имена частей теряются безвозвратно
      reversalNote: 'Иерархия узлов и отдельные части объединены — из результата их не восстановить. Чтобы сохранить части, используйте --keep-parts.',
      enabled: (opts) => !opts.keepParts,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, reason: 'модель статичная, отдельные части не нужны (иначе --keep-parts)' }; },
    async fix(finding, ctx) {
      const m = () => { const r = collectMetrics(ctx.document, 0); return { drawCalls: r.drawCalls, nodes: r.nodes, meshes: r.meshes }; };
      const b = m();
      await ctx.document.transform(fns.flatten(), fns.join());
      const a = m();
      if (b.drawCalls > a.drawCalls || b.nodes > a.nodes || b.meshes > a.meshes) {
        return {
          found: [`лишние draw calls / узлы: draw calls ${b.drawCalls}, узлов ${b.nodes}`],
          details: [`Меши объединены (flatten+join): draw calls ${b.drawCalls} → ${a.drawCalls}, узлы ${b.nodes} → ${a.nodes}`],
        };
      }
      return {};
    },
  },

  {
    meta: {
      id: 'structure/prune-final', category: 'scene', title: 'Подчистка осиротевших ресурсов',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['scene/join', 'geometry/orphan-vertices'], touches: ['accessor', 'node'],
      reversible: false, dataLoss: 'none', // только осиротевшие после предыдущих фиксов ресурсы
      enabled: () => true,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, reason: 'удаляются только осиротевшие после предыдущих фиксов ресурсы' }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const b = root.listAccessors().length;
      await ctx.document.transform(fns.prune()); // как в v2: подчистка после всех проходов
      const a = root.listAccessors().length;
      if (b > a) return { details: [`Подчистка (prune): удалено ${b - a} осиротевших аксессоров`] };
      return {};
    },
  },

  {
    meta: {
      // ADVANCED: KTX2 требует KTX2Loader (Three.js) / поддержку basisu в движке —
      // работает не «везде», поэтому только явный opt-in (advancedFeatures:['ktx2'] / --ktx2).
      // normalizeOpts переводит выбор фичи в noKtx:false — enabled смотрит на итоговую опцию.
      id: 'textures/ktx2', category: 'textures', title: 'Текстуры → KTX2/UASTC',
      severity: 'warn', fixSafety: 'perceptual', tier: 'advanced', feature: 'ktx2',
      runAfter: ['structure/prune-final'], touches: ['texture'],
      reversible: true, dataLoss: 'minor', // §4d: KTX2 ↔ PNG/WebP, потеря от BASIS-U распаковки
      reversalNote: 'KTX2 можно распаковать обратно в PNG/WebP с небольшой потерей качества (BASIS-декодирование).',
      enabled: (opts) => !opts.noKtx,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() {
      if (!TOKTX || !GLTF_CLI) {
        return { safe: false, reason: 'toktx или gltf-transform CLI не найдены — текстуры оставлены в исходном формате' };
      }
      return { safe: true, reason: 'UASTC --level 2 --zstd 18 без RDO — near-lossless, выбор пользователя' };
    },
    async fix(finding, ctx) {
      const out = { found: [], skipped: [], details: [] };
      // data-текстуры (нормали/occlusion/roughness) — UASTC: ETC1S мылит нормали и даёт
      // ступеньки на roughness. Цветовые (baseColor/emissive/прочее) — ETC1S: в разы
      // легче в файле при той же экономии VRAM. Regex и glob должны совпадать по смыслу.
      const DATA_SLOT_RE = /normal|occlusion|roughness/i;
      const DATA_SLOT_GLOB = '*{normal,Normal,occlusion,Occlusion,metallicRoughness,Roughness}*';
      const dataTex = [];
      const colorTex = [];
      for (const tex of ctx.document.getRoot().listTextures()) {
        const mime = tex.getMimeType();
        const name = tex.getName() || '—';
        if (mime === 'image/ktx2') {
          out.skipped.push(`Текстура «${name}»: уже KTX2 — повторно не кодируем (без лишней потери)`);
          continue;
        }
        if (mime === 'image/webp' || mime === 'image/jpeg') {
          const sharp = (await import('sharp')).default; // ленивый импорт: нужен только для WebP/JPEG
          const png = await sharp(Buffer.from(tex.getImage())).png().toBuffer();
          tex.setImage(png);
          tex.setMimeType('image/png');
          out.details.push(`Текстура «${name}»: ${mime} → PNG (без потерь, для toktx)`);
        }
        const slots = fns.listTextureSlots(tex).join(' ');
        if (DATA_SLOT_RE.test(slots)) dataTex.push(name);
        else colorTex.push(name);
      }
      const needKtx = dataTex.length + colorTex.length;
      if (needKtx === 0) {
        ctx.log('        все текстуры уже KTX2 или их нет — кодирование пропущено');
        return out;
      }
      out.found.push(`текстуры не в KTX2: ${needKtx}`);
      const mixed = ctx.opts.texMode === 'mixed';
      ctx.log(`        кодирование KTX2 (${needKtx} шт., режим ${mixed ? 'mixed: ETC1S+UASTC' : 'uastc'})`);
      const tmpA = path.join(ctx.outDir, `_tmp_${ctx.dstName}`);
      const tmpB = path.join(ctx.outDir, `_tmp2_${ctx.dstName}`);
      const tmpC = path.join(ctx.outDir, `_tmp3_${ctx.dstName}`);
      try {
        await ctx.io.write(tmpA, ctx.document);
        let cur = tmpA;
        if (mixed) {
          if (dataTex.length) { runCli(['uastc', cur, tmpB, '--slots', DATA_SLOT_GLOB, '--level', '2', '--zstd', '18']); cur = tmpB; }
          if (colorTex.length) { runCli(['etc1s', cur, tmpC, '--slots', `!(${DATA_SLOT_GLOB})`, '--quality', '255']); cur = tmpC; }
        } else {
          runCli(['uastc', cur, tmpB, '--level', '2', '--zstd', '18']);
          cur = tmpB;
        }
        ctx.document = await ctx.io.read(cur); // дальше пайплайн работает с KTX2-версией
      } finally {
        // временные файлы не должны оставаться в output даже при ошибке
        for (const t of [tmpA, tmpB, tmpC]) {
          try { if (fs.existsSync(t)) fs.rmSync(t); } catch { /* занят — уберётся при следующем запуске */ }
        }
      }
      if (mixed) {
        if (colorTex.length) out.details.push(`Цветовые текстуры → KTX2/ETC1S, quality 255 (${colorTex.length} шт.: ${colorTex.join(', ')}) — компактны в файле и в VRAM`);
        if (dataTex.length) out.details.push(`Data-текстуры → KTX2/UASTC --level 2 --zstd 18 (${dataTex.length} шт.: ${dataTex.join(', ')}) — нормали/ORM без артефактов ETC1S`);
      } else {
        out.details.push(`Текстуры → KTX2/UASTC: ${needKtx} шт. (--level 2 --zstd 18, без RDO; режим --uastc)`);
      }
      return out;
    },
  },

  {
    meta: {
      // tier basic: сжатие как таковое базовое (Meshopt работает везде и всегда полезно).
      // Advanced-часть — ВЫБОР кодека Draco: advancedFeatures:['draco'] / --draco
      // переключает opts.codec в normalizeOpts; само правило остаётся в базовом плане.
      id: 'geometry/compress', category: 'geometry', title: 'Сжатие геометрии',
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['textures/ktx2', 'structure/prune-final'], touches: ['geometry', 'accessor'],
      reversible: true, dataLoss: 'none', // §4d: Draco/Meshopt ↔ стандартный формат в пределах точности float32
      reversalNote: 'Сжатая геометрия распаковывается обратно в стандартный формат без потери данных.',
      enabled: () => true,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, reason: 'сжатие пакует данные вершин, число полигонов не меняется' }; },
    async fix(finding, ctx) {
      if (ctx.opts.codec === 'draco') {
        await ctx.document.transform(fns.draco());
      } else {
        await ctx.document.transform(fns.meshopt({ encoder: MeshoptEncoder }));
      }
      return { details: [`Геометрия сжата (${ctx.opts.codec}) — число полигонов не изменилось`] };
    },
  },
];
