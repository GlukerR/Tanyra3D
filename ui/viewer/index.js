// index.js — обвязка двух вьюпортов (оригинал ⇄ оптимизировано) поверх движка просмотра.
//
// Модуль НЕ знает про Three.js напрямую: он работает через узкий интерфейс, который даёт
// createViewer() (сейчас единственная реализация — Three.js, см. viewer.js). Это тот же
// приём «шва», что core/addon в ядре: завтра можно подменить движок просмотра или добавить
// режим (дизайнерский, показ пропавших точек), не трогая эту обвязку и app.js.
//
// Наружу отдаётся глобальный API window.OptiViewer — его дёргает классический app.js
// (который остаётся не-модульным скриптом), чтобы модульность просмотрщика не протекала
// в остальной UI.

import { Viewer } from "./viewer.js";

/**
 * Фабрика движка просмотра (шов под будущие движки/режимы: Unreal, Unity и т.д.).
 *
 * КОНТРАКТ движка просмотра — что обязана дать любая реализация:
 *   new Viewer(canvas)                  — рисует в переданное полотно
 *   load(url, { onProgress })           — загрузить модель, отдать управление после готовности
 *   getStats() → { … }                  — метрики модели для HUD
 *   getDetection() → { draco, meshopt, ktx2 } | null — что уже сжато в исходнике
 *   renderFrame()                       — отрисовать один кадр (цикл гонит DualViewport)
 *   frame()                             — навести камеру на модель
 *   getCameraState() / applyCameraState(state) — для связанных камер
 *   controls                            — источник события 'change' (камера двигалась)
 *   setAnimationTime(sec)               — поставить анимацию в абсолютное время
 *   playClip(index)                     — переключить клип
 *   getAnimationInfo() → { count, names, index, duration }
 *   dispose()                           — освободить СВОИ ресурсы
 *
 * Время анимации задаётся СНАРУЖИ и абсолютным значением, а не приращением. Это
 * обязательное требование к любой реализации: два вьюпорта показывают одну модель
 * до и после, и разъехавшаяся на полкадра поза делает сравнение бессмысленным.
 *
 * Движок отвечает только за свои ресурсы. Пустое состояние слота (очистка полотна при
 * сбросе) — забота обвязки, одинаковая для всех движков: см. ViewportSlot.reset().
 * Так смена движка при смене платформы не меняет поведение действий вокруг него —
 * загрузка, сброс, связанные камеры работают одинаково.
 */
// Реализации, которые приложение действительно везёт с собой. Ключ — то самое имя,
// которое движок называет полем `viewer` в engines/<id>.json (ARCHITECTURE.md §4g):
// «другой движок — другой вьюпорт» становится добавлением строки сюда и файла движка,
// а не правкой обвязки и app.js.
const VIEWERS = {
  threejs: (canvas) => new Viewer(canvas),
};

// Имя реализации, которую монтировать. Пустое значение — единственная сегодняшняя
// норма: движок мог не назвать вьюпорт, и это не повод остаться без картинки.
let wantedViewer = 'threejs';

/**
 * Сказать обвязке, какой вьюпорт монтировать дальше. Незнакомое имя НЕ подставляется
 * молча: мы бы нарисовали чужим движком и выдали это за верный предпросмотр — а
 * предпросмотр здесь главное, ради чего приложение существует. Поэтому остаёмся на
 * прежней реализации и говорим об этом в консоль.
 */
function useViewer(id) {
  if (!id || id === wantedViewer) return wantedViewer;
  if (!VIEWERS[id]) {
    console.warn(`[viewer] Движок просит вьюпорт «${id}», а приложение везёт только: ${Object.keys(VIEWERS).join(', ')}. Остаюсь на «${wantedViewer}».`);
    return wantedViewer;
  }
  wantedViewer = id;
  return wantedViewer;
}

function createViewer(canvas) {
  return VIEWERS[wantedViewer](canvas);
}

// Окно замера нагрузки на отрисовку: 60 кадров — примерно секунда на 60-герцовом
// мониторе. Короче — цифра дёргается и её невозможно читать; длиннее — реакция на
// смену модели становится заметно вялой. Подробности замера — у DualViewport._pushPerf.
const PERF_WINDOW = 60;

function median(arr) {
  const s = Array.from(arr).sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Один слот сравнения: панель `.vp-pane` с <canvas> и строкой статуса.
 * Лениво создаёт движок при первой загрузке (когда контейнер уже виден и имеет размер).
 */
class ViewportSlot {
  constructor(container) {
    this.container = container;
    this.canvas = container.querySelector(".viewer-canvas");
    this.statusEl = container.querySelector(".viewer-status");
    this.viewer = null;
    this._blobUrl = null;
  }

  _ensureViewer() {
    if (!this.viewer) this.viewer = createViewer(this.canvas);
    return this.viewer;
  }

  /**
   * Подпись посреди панели. Принимает КЛЮЧ каталога, а не готовую строку.
   *
   * Правило 8: ни одной пользовательской строки в логике. Раньше здесь стояли
   * английские литералы («Loading…», «Run optimization to compare»), и в русском
   * интерфейсе они такими и оставались.
   *
   * `I18n.setText` не просто переводит, а ПОМЕЧАЕТ элемент ключом. Поэтому смена
   * языка перерисовывает подпись сама, через общий apply() — без перезагрузки модели
   * и без пересчёта чего бы то ни было (Правило 8 §1). Без пометки подпись
   * «Загрузка…» осталась бы русской после переключения на английский.
   *
   * @param {string|null} key   ключ каталога; null или '' — убрать подпись
   * @param {object} [values]   подстановки одного сообщения (Правило 8 §3:
   *                            «Загрузка… 45 %» — ОДНО сообщение с подстановкой,
   *                            а не склейка слова и числа в коде)
   */
  _setStatus(key, values) {
    if (!this.statusEl) return;
    // Текст живёт в отдельном span, а не прямо в контейнере. Контейнер растянут на всю
    // панель (inset: 0) и служит только для центрирования — повесь фон на него, и
    // закрасится вся панель. Плашка обязана облегать буквы, а не занимать вьюпорт.
    // textContent контейнера при этом читается по-прежнему: он собирает текст потомков.
    this.statusEl.textContent = "";
    if (key) {
      const plate = document.createElement("span");
      plate.className = "viewer-status-plate";
      if (window.I18n) window.I18n.setText(plate, key, values);
      else plate.textContent = key;   // каталог не загрузился — лучше ключ, чем пустота
      this.statusEl.appendChild(plate);
    }
    this.statusEl.classList.toggle("hidden", !key);
  }

  _revokeBlob() {
    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
      this._blobUrl = null;
    }
  }

  /** Загрузить модель из URL (строка) или File (создаётся blob URL).
   *  opts.camera — ракурс, который надо сохранить вместо авто-кадрирования (сборка/ребилд). */
  async load(source, opts = {}) {
    const viewer = this._ensureViewer();
    this._setStatus("viewer.status.loading");

    let url = source;
    if (source instanceof File || source instanceof Blob) {
      this._revokeBlob();
      url = this._blobUrl = URL.createObjectURL(source);
    }

    try {
      await viewer.load(url, {
        camera: opts.camera || null,
        onProgress: (e) => {
          if (e && e.lengthComputable) {
            this._setStatus("viewer.status.loadingPct", { pct: Math.round((e.loaded / e.total) * 100) });
          }
        },
      });
      this._setStatus(null);
    } catch (err) {
      console.error("Viewer failed to load model:", err);
      this._setStatus("viewer.status.unavailable");
      this._revokeBlob();
      return null;
    }
    this._revokeBlob();
    return { stats: viewer.getStats(), detected: viewer.getDetection() };
  }

  renderFrame() {
    if (this.viewer) this.viewer.renderFrame();
  }

  /** Подсказка в пустой панели. Аргумент — КЛЮЧ каталога, не готовая строка. */
  showHint(key, values) {
    this._setStatus(key, values);
  }

  /**
   * Опустошить слот: снять модель, разобрать движок и ГАРАНТИРОВАННО очистить полотно.
   *
   * Очистка живёт здесь, а не внутри движка: движок освобождает свои ресурсы, но canvas
   * хранит последний отрисованный кадр сам по себе, а пустой слот больше не перерисовывается —
   * иначе в нём висит «замороженная» картинка прошлой модели.
   *
   * Сбрасываем РАЗМЕР буфера отрисовки: это единственный способ очистки, не требующий знать
   * графический API (подойдёт и WebGL, и WebGPU, и 2D) — значит сброс одинаков для ЛЮБОГО
   * движка просмотра и не зависит от того, помнит ли новый движок про очистку (см. контракт
   * у createViewer()). Важно ставить ИМЕННО другой размер: присваивание того же значения
   * буфер не пересоздаёт и содержимое не стирает (проверено в Chrome). 1×1 прозрачного
   * полотна не видно, а следующий движок при создании сам развернёт canvas по панели.
   */
  reset() {
    this._revokeBlob();
    if (this.viewer) {
      this.viewer.dispose();
      this.viewer = null;
    }
    if (this.canvas) {
      this.canvas.width = 1;
      this.canvas.height = 1;
    }
    this._setStatus(null);
  }
}

class DualViewport {
  constructor() {
    this.left = null; // оригинал
    this.right = null; // оптимизировано
    this.linked = true; // связанные камеры: крутишь один — синхронно второй
    this._syncing = false;
    this._rafId = null;
    // Анимация проигрывается сразу: модель, у которой она есть, должна двигаться
    // без нажатий. Пауза нужна, чтобы РАССМОТРЕТЬ конкретный кадр, а не чтобы
    // включить движение.
    this._animPlaying = true;
    this._animTime = 0;
    this._animClipIndex = 0; // выбранный клип переживает загрузку новой модели
    this._exposure = 1;      // 1.0 — как отдаёт three.js без поправки
    // Кольцевые буферы замера отрисовки; заполняются в _pushPerf каждый кадр.
    this._perf = {
      left: new Float64Array(PERF_WINDOW),
      right: new Float64Array(PERF_WINDOW),
      frame: new Float64Array(PERF_WINDOW),
      i: 0,
    };
  }

  /** Сбросить окно замера — после загрузки новой модели прежние кадры уже не про неё. */
  _resetPerf() {
    this._perf.i = 0;
  }

  _init() {
    if (this.left && this.right) return true;
    const leftEl = document.getElementById("preview-original");
    const rightEl = document.getElementById("preview-optimized");
    if (!leftEl || !rightEl) return false;
    this.left = new ViewportSlot(leftEl);
    this.right = new ViewportSlot(rightEl);
    return true;
  }

  /**
   * Подписывает контролы двух вьюпортов друг на друга. Снимает предыдущую подписку перед
   * новой — иначе повторный show() без reset() между ними копил бы 'change'-слушатели на
   * тех же экземплярах Viewer (they persist across show() calls; см. ViewportSlot._ensureViewer).
   */
  _linkCameras() {
    this._unlinkCameras();
    if (!this.left.viewer || !this.right.viewer) return;

    const sync = (from, to) => {
      if (this._syncing || !this.linked) return;
      this._syncing = true;
      to.applyCameraState(from.getCameraState());
      this._syncing = false;
    };
    const onLeftChange = () => sync(this.left.viewer, this.right.viewer);
    const onRightChange = () => sync(this.right.viewer, this.left.viewer);

    this.left.viewer.controls.addEventListener("change", onLeftChange);
    this.right.viewer.controls.addEventListener("change", onRightChange);
    this._unlink = () => {
      this.left.viewer?.controls.removeEventListener("change", onLeftChange);
      this.right.viewer?.controls.removeEventListener("change", onRightChange);
    };
  }

  _unlinkCameras() {
    if (this._unlink) {
      this._unlink();
      this._unlink = null;
    }
  }

  _startLoop() {
    if (this._rafId != null) return;
    let prev = performance.now();
    const tick = (now) => {
      const dt = Math.min((now - prev) / 1000, 0.1); // клип времени: вкладка была свёрнута
      prev = now;
      this._advanceAnimation(dt);
      // Время каждого вьюпорта меряется отдельно, время кадра — общее.
      // Почему именно так — см. комментарий у _perf ниже.
      const t0 = performance.now();
      this.left.renderFrame();
      const t1 = performance.now();
      this.right.renderFrame();
      const t2 = performance.now();
      this._pushPerf(t0, t1, t2, dt);
      this._rafId = requestAnimationFrame(tick);
    };
    prev = performance.now();
    this._rafId = requestAnimationFrame(tick);
  }

  // -----------------------------------------------------------------------
  // Замер нагрузки на отрисовку.
  //
  // ВАЖНО, почему здесь НЕ «FPS слева» и «FPS справа». Оба вьюпорта рисуются
  // в ОДНОМ кадре одного requestAnimationFrame (см. tick выше) — кадр у них
  // общий физически. Считать кадры отдельно по вьюпортам значит получить два
  // одинаковых числа по построению: они всегда совпадут, что бы ни показала
  // оптимизация. А само число почти всегда упрётся в частоту монитора: rAF
  // не даёт рисовать чаще, и на настольной видеокарте обе сцены успевают в
  // бюджет кадра. Пользователь увидел бы «60 и 60» и прочитал бы это как
  // «оптимизация ничего не дала».
  //
  // Различается — время, которое занимает renderFrame() каждого вьюпорта.
  // Оно растёт с числом вызовов отрисовки и переключений состояния, то есть
  // ровно с тем, что и правит оптимизация. Мерится в одном кадре, на одной
  // машине, в одну и ту же секунду — это честное сравнение «до/после».
  //
  // Чего это число НЕ значит: это время работы CPU по подготовке и отправке
  // кадра, а не время самой видеокарты (WebGL асинхронен, дожидаться его
  // пришлось бы принудительной синхронизацией, которая исказит замер).
  // И это машина автора, а не телефон посетителя сайта. Показатель
  // относительный: во сколько раз легче стало, а не «столько будет у людей».
  //
  // Медиана по окну в 60 кадров, а не среднее: одиночная задержка от сборщика
  // мусора или переключения вкладки не должна дёргать цифру.
  // -----------------------------------------------------------------------

  _pushPerf(t0, t1, t2, dt) {
    const p = this._perf;
    p.left[p.i % PERF_WINDOW] = t1 - t0;
    p.right[p.i % PERF_WINDOW] = t2 - t1;
    p.frame[p.i % PERF_WINDOW] = dt * 1000;
    p.i++;
  }

  /**
   * Нагрузка на отрисовку за последние PERF_WINDOW кадров.
   * `null`, пока окно не набралось — показывать половину замера хуже, чем ничего.
   */
  getPerf() {
    const p = this._perf;
    if (p.i < PERF_WINDOW) return null;
    return {
      leftMs: median(p.left),
      rightMs: median(p.right),
      fps: 1000 / Math.max(median(p.frame), 0.001), // общий на оба вьюпорта
    };
  }

  // -----------------------------------------------------------------------
  // Анимация: одно время на оба вьюпорта.
  //
  // Часы живут здесь, а не внутри вьюпортов. Оба получают ОДНО И ТО ЖЕ абсолютное
  // время каждый кадр — поэтому оригинал и результат всегда в одной позе. Если бы
  // каждый вьюпорт тикал сам, они разъехались бы по фазе за первые секунды: правый
  // грузится позже, кадры пропускаются неравномерно. Сравнивать «до и после» стало
  // бы нельзя — глаз ловил бы разницу поз, а не разницу оптимизации.
  // -----------------------------------------------------------------------

  // Слоты создаются лениво, в _init() при первой загрузке модели: до неё
  // this.left и this.right — null. app.js опрашивает getAnimation() с первого
  // кадра страницы, поэтому все методы ниже обязаны переживать пустое состояние.
  _advanceAnimation(dt) {
    if (this._animPlaying) this._animTime = (this._animTime || 0) + dt;
    const t = this._animTime || 0;
    this.left?.viewer?.setAnimationTime(t);
    this.right?.viewer?.setAnimationTime(t);
  }

  /** Есть ли что проигрывать и что именно — для панели управления в app.js. */
  getAnimation() {
    const info = this.left?.viewer?.getAnimationInfo?.() || { count: 0, names: [], index: -1, duration: 0 };
    return {
      ...info,
      playing: !!this._animPlaying,
      time: this._animTime || 0,
      // Индекс клипа по сторонам — чтобы рассинхрон был видимой величиной, а не
      // ощущением «дёргается не в такт». Именно он и был дефектом: правый вьюпорт
      // после сборки оставался на клипе 0, пока не переключишь вручную.
      leftIndex: this.left?.viewer?.getAnimationInfo?.().index ?? -1,
      rightIndex: this.right?.viewer?.getAnimationInfo?.().index ?? -1,
    };
  }

  setAnimationPlaying(playing) {
    this._animPlaying = !!playing;
  }

  /** Перемотка в абсолютное время (секунды). */
  seekAnimation(seconds) {
    this._animTime = Math.max(0, Number(seconds) || 0);
    this._advanceAnimation(0);
  }

  /** Переключить клип в обоих вьюпортах и начать с нуля. */
  selectAnimationClip(index) {
    // Запоминаем выбор: следующая загруженная модель должна прийти на этот же
    // клип, иначе она начнёт с нулевого и разойдётся со второй (см. _applyAnimSelection).
    this._animClipIndex = Math.max(0, Number(index) || 0);
    this.left?.viewer?.playClip?.(this._animClipIndex);
    this.right?.viewer?.playClip?.(this._animClipIndex);
    this._animTime = 0;
    this._advanceAnimation(0);
  }

  // -----------------------------------------------------------------------
  // Экспозиция
  //
  // Одна на оба вьюпорта — иначе сравнение «до и после» врёт: разная яркость
  // читается глазом как разница обработки. Пересвеченные модели встречаются
  // часто (материалы под другое окружение), и без этого регулятора они
  // выглядят испорченными ещё до всякой оптимизации.
  // -----------------------------------------------------------------------

  setExposure(value) {
    const v = Number(value);
    this._exposure = Number.isFinite(v) ? Math.max(0.05, Math.min(v, 4)) : 1;
    this._applyExposure();
  }

  getExposure() {
    return this._exposure ?? 1;
  }

  _applyExposure() {
    const v = this._exposure ?? 1;
    this.left?.viewer?.setExposure?.(v);
    this.right?.viewer?.setExposure?.(v);
  }

  _stopLoop() {
    if (this._rafId != null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /** Загрузить оригинал (File) в левый вьюпорт. Правый сбрасывается — прежний
   *  оптимизированный результат больше не соответствует новой исходной модели. */
  async loadOriginal(originalFile) {
    if (!this._init()) return null;
    this._unlinkCameras();
    this.right.reset();
    this.right.showHint("viewer.hint.compare");
    let info = null;
    if (originalFile) info = await this.left.load(originalFile);
    this._afterLoad();
    return info; // { stats, detected } — метрики модели + что уже сжато в исходнике
  }

  /** Загрузить оптимизированную модель (URL) в правый вьюпорт.
   *  Ракурс НЕ сбрасывается: берём текущую камеру левого вьюпорта (камеры связаны, bbox
   *  тот же) и применяем к результату — приближённая деталь остаётся на месте после
   *  любой сборки/ребилда. Левый (оригинал) не трогаем. */
  async loadOptimized(optimizedUrl) {
    if (!this._init()) return;
    if (optimizedUrl) {
      const camera = this.left.viewer ? this.left.viewer.getCameraState() : null;
      await this.right.load(optimizedUrl, { camera });
    } else {
      this.right.showHint("viewer.hint.noOutput");
    }
    this._afterLoad();
  }

  _afterLoad() {
    this._resetPerf(); // сцена сменилась — прежние кадры мерили другую модель
    if (this.left.viewer && this.right.viewer) this._linkCameras();
    this._applyAnimSelection();
    this._applyExposure();
    this._startLoop();
    // Состав модели изменился — панели управления надо перестроить СЕЙЧАС, а не
    // когда до них дойдёт очередь кадра. Сначала это делалось опросом в цикле
    // отрисовки, и в фоновой вкладке (где requestAnimationFrame заморожен)
    // панель анимации не появлялась вовсе.
    this._notifyLoaded();
  }

  /** Подписка UI на «модель загружена/сменилась». Один слушатель — больше не нужно. */
  setOnLoaded(fn) {
    this._onLoaded = typeof fn === 'function' ? fn : null;
  }

  /**
   * Уведомить UI. Запасной путь через глобальную функцию — не украшение:
   * app.js подключён обычным скриптом, а этот модуль — type="module", то есть
   * отложен и выполняется ПОСЛЕ него. На момент своего запуска app.js ещё не
   * видит window.OptiViewer и подписаться не может. Глобальную функцию он
   * объявляет заранее, и порядок перестаёт иметь значение.
   */
  _notifyLoaded() {
    const fn = this._onLoaded || window.onOptiViewerModelLoaded;
    if (typeof fn === 'function') fn();
  }

  /**
   * Привести только что загруженную модель к тому, что уже выбрано на панели.
   *
   * Без этого свежезагруженный вьюпорт начинал с клипа №0, а второй продолжал
   * играть выбранный пользователем. Симптом: собрал модель, смотря второй клип —
   * результат справа дёргается не в такт, и «чинится» только переключением клипа
   * (оно единственное задавало индекс обоим сразу).
   */
  _applyAnimSelection() {
    const idx = this._animClipIndex || 0;
    if (idx > 0) {
      this.left?.viewer?.playClip?.(idx);
      this.right?.viewer?.playClip?.(idx);
    }
    this._advanceAnimation(0);
  }

  /**
   * Заново навести камеры на модели (кнопка «сбросить ракурс»).
   *
   * Кадрируем ОДИН вьюпорт и копируем результат во второй, а не наводим каждый
   * по своей модели. Оптимизация может едва заметно менять габарит (сварка вершин,
   * удаление вырожденных треугольников), и раздельное кадрирование давало двум
   * окнам разные дистанцию, near/far и пределы приближения — то есть ровно тот
   * рассинхрон, ради отсутствия которого сравнение и делается.
   */
  resetView() {
    const source = this.left?.viewer || this.right?.viewer;
    if (!source) return;
    source.frame();
    const state = source.getCameraState();
    if (this.left?.viewer && this.left.viewer !== source) this.left.viewer.applyCameraState(state);
    if (this.right?.viewer && this.right.viewer !== source) this.right.viewer.applyCameraState(state);
  }

  /** Текущее состояние камер обоих вьюпортов (read-only): позиция + target. */
  cameraStates() {
    return {
      left: this.left && this.left.viewer ? this.left.viewer.getCameraState() : null,
      right: this.right && this.right.viewer ? this.right.viewer.getCameraState() : null,
    };
  }

  setLinked(on) {
    this.linked = !!on;
  }

  reset() {
    this._stopLoop();
    this._resetPerf();
    this._unlinkCameras();
    if (this.left) this.left.reset();
    if (this.right) this.right.reset();
    // Моделей больше нет — панель анимации обязана убраться вместе с ними.
    this._notifyLoaded();
  }
}

const dual = new DualViewport();

// Глобальный API для классического app.js.
window.OptiViewer = {
  // Какие вьюпорты приложение умеет монтировать и какой выбран. Через это поле
  // движок из engines/<id>.json дотягивается до картинки — см. VIEWERS выше.
  implementations: () => Object.keys(VIEWERS),
  useViewer: (id) => useViewer(id),
  currentViewer: () => wantedViewer,
  loadOriginal: (file) => dual.loadOriginal(file),
  loadOptimized: (url) => dual.loadOptimized(url),
  resetView: () => dual.resetView(),
  setLinked: (on) => dual.setLinked(on),
  reset: () => dual.reset(),
  cameraStates: () => dual.cameraStates(),
  // Анимация. Одно время на оба вьюпорта — см. _advanceAnimation.
  getAnimation: () => dual.getAnimation(),
  setAnimationPlaying: (on) => dual.setAnimationPlaying(on),
  seekAnimation: (sec) => dual.seekAnimation(sec),
  selectAnimationClip: (i) => dual.selectAnimationClip(i),
  // Экспозиция — одна на оба вьюпорта, см. _applyExposure.
  setExposure: (v) => dual.setExposure(v),
  getExposure: () => dual.getExposure(),
  // Нагрузка на отрисовку: { leftMs, rightMs, fps } либо null, пока окно замера
  // не набралось. Почему не «FPS слева / FPS справа» — см. DualViewport._pushPerf.
  getPerf: () => dual.getPerf(),
  // Уведомление «модель загрузилась/сменилась/сброшена» — по нему UI перестраивает
  // панели, вместо того чтобы опрашивать состав модели каждый кадр.
  setOnLoaded: (fn) => dual.setOnLoaded(fn),
};
