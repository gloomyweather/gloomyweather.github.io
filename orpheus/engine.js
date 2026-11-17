/* engine.js — генеративный эмбиент-движок на Web Audio.
   Classic script, без модулей и библиотек. Читает window.AMBIENT_SCHEMA, определяет window.Ambient.

   Структура:
     1. утилиты (маппинги, генерация волн / шума / импульса / зерна)
     2. гармония (лады, выбор аккордов, голосоведение)
     3. createCore(ctx, P) — строит весь граф на любом BaseAudioContext (в т.ч. OfflineAudioContext),
        возвращает объект с apply()/applyMany()/tick()/fade()… — без таймеров внутри, кроме debounce реверба
     4. обёртка window.Ambient: хранение значений, AudioContext, планировщик setInterval, start/stop

   Граф (стерео):
     pad ──┐                       ┌→ musDry → tape ─→ dryBus ─────────────────────┐
     shim ─┤ (level-gain каждого) ─┼→ musRev → tape ─→ revSend → HP 140 / LP 6.5k → convolver → wet ┤
     sub  ─┤                       └→ musDel → tape ─→ delaySend → ping-pong ──────┤
     notes─┘ (ноты: провал 2–5 кГц по тембру/высоте)                                 │
     noise / grain / rain ───────────→ dryBus / revSend (без «плёнки») ────────────┤
                                                                                   ↓
        preMaster → warmth (clean ⨁ tanh) → high-shelf → HPF 28 Гц → volume → fader → comp → lim → sleep → softclip → analyser
                                                                        ↑
                                              binaural (L/R синусы) ────┘  (мимо реверба, дилея, плёнки и тепла)

   API: start / stop / fadeOut(sec) (таймер сна: равные шаги в дБ до тишины, затем как stop) / cancelFade / fading,
   set / setMany / get / getAll / running / analyser,
   onEvent(fn) / offEvent(fn) (события планировщика: chord / note / sub — только для визуализации), now(), chord().
   Глобальные правила звучания (research/brief.md): медленная гармония (смена аккорда ≥ 20 с), открытый низ
   (ниже C3 — без секунд и терций), приглушённые 2–5 кГц у нот, тёмный хвост реверба, модуляции < 0.3 Гц
   (кроме flutter плёнки), «погода» на масштабе минут, паузы как материал, шум без слышимой петли.

   Плавные переходы. P — целевые значения (то, что вернёт get()). E — «эффективные» значения, которые
   экспоненциально догоняют P со своей постоянной времени на каждый параметр (обновляются в tick()).
   Всё, что читается планировщиками (плотность, длина, тембр нот, дрейф, фразы, зерно, мерцание, размер
   реверба), берётся из E, поэтому setMany(…, 120) плавно меняет и их. AudioParam-ы ведутся
   setTargetAtTime(P, tau); каждый AudioParam пишет ровно один параметр, поэтому перекрывающиеся
   глайды разных параметров не отменяют друг друга, а новый глайд того же параметра продолжает с текущего значения.
*/
(function () {
  'use strict';

  var SCHEMA = window.AMBIENT_SCHEMA || { params: [] };

  // ---------------------------------------------------------------- константы

  var LOOKAHEAD = 2.0;      // с; ≥ 1.5 чтобы фоновые вкладки (setInterval ≥ 1 с) не заикались
  var TICK_MS = 100;        // период планировщика
  var SET_TAU = 0.06;       // постоянная времени для одиночного set()
  var MAX_NOTES = 28;       // потолок одновременно живых нот
  var MAX_DROPS = 140;      // потолок запланированных капель
  var MAX_SHIM = 6;         // потолок голосов мерцания
  var MAX_GRAINS = 90;      // потолок запланированных щелчков зерна
  var SLOTS = 5;            // голосов в аккорде пэда
  var HARM_MAX = 20;        // макс. длительность кроссфейда смены тоники/лада в setMany

  // калибровка уровней (подобрана по измерениям RMS в OfflineAudioContext)
  var CAL = {
    padVoice: 0.34,   // амплитуда одного осциллятора пэда (до фильтра)
    pad: 1.0,
    organ: 0.9,       // доля «органного» осциллятора на padTone = 1
    sub: 0.55,
    notes: 1.05,      // было 2.35: ноты на 7 дБ тише → пик ноты на ~6–8 дБ ниже пэда при равных слайдерах
    shimmer: 0.5,
    noise: 2.3,
    rumble: 3.15, wind: 3.24, hiss: 1.62, shell: 7.0,  // выравнивание громкости окрасок шума
    grain: 0.8,
    rain: 5.4, rainBed: 0.11, drop: 0.22,
    bin: 0.05,        // пик одного бинаурального синуса при binaural = 1
    wet: 0.8,         // уровень возврата реверба
    delayRet: 0.55,
    master: 1.0
  };

  // лады — порядок как в schema.options
  var SCALES = [
    [0, 2, 4, 7, 9],          // мажорная пентатоника
    [0, 3, 5, 7, 10],         // минорная пентатоника
    [0, 2, 4, 6, 7, 9, 11],   // лидийский
    [0, 2, 3, 5, 7, 9, 10],   // дорийский
    [0, 2, 3, 5, 7, 8, 10],   // эолийский
    [0, 1, 3, 5, 7, 8, 10]    // фригийский
  ];

  // ---------------------------------------------------------------- утилиты

  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function lvl(x) { return Math.pow(x, 1.5); }              // кривая уровня слоя
  function vol(x) { return x * x; }                          // кривая общей громкости
  function expRand(rate) { return -Math.log(1 - Math.random() * 0.999999) / rate; } // пуассоновский интервал
  function lerp(a, b, u) { return a + (b - a) * u; }
  // частота биений, Гц: степенная кривая 1 + 15·x^1.34 → 0 → 1, 0.3 → 4.0, 0.6 → 8.6, 1 → 16
  function beatHz(x) { return 1 + 15 * Math.pow(clamp(x, 0, 1), 1.34); }

  // плавно увести параметр к v (без щелчков, без накопления событий)
  function glideTo(param, v, t, tau) {
    if (!isFinite(v)) return;
    if (param.cancelAndHoldAtTime) {
      param.cancelAndHoldAtTime(t);
    } else {
      var cur = param.value;
      param.cancelScheduledValues(t);
      param.setValueAtTime(cur, t);
    }
    param.setTargetAtTime(v, t, Math.max(0.005, tau));
  }
  function safeDisconnect(n) { try { n.disconnect(); } catch (e) { /* уже отключён */ } }
  function safeStop(n, t) { try { n.stop(t); } catch (e) { /* уже остановлен */ } }

  // ---------------------------------------------------------------- гармония
  // H — объект с полями root/scale (в ядре это «звучащая» гармония, которая может отставать от P при долгом глайде)

  function scaleOf(H) { return SCALES[H.scale % SCALES.length] || SCALES[0]; }
  // базовая нота пэда: D2 (38) … C#3 (49)
  function baseMidi(H) { return 38 + ((H.root - 2 + 12) % 12); }
  // несущая бинауральных биений: G#2 (104 Гц) … G3 (196 Гц), класс высоты = тоника
  function binMidi(H) { return 44 + ((H.root - 8 + 12) % 12); }
  // ступень (может быть отрицательной / > длины) → midi
  function degMidi(base, sc, deg) {
    var L = sc.length, o = Math.floor(deg / L);
    return base + 12 * o + sc[deg - o * L];
  }

  // ступени, от которых строится консонантный аккорд (чистая квинта + терция)
  function chordRoots(sc) {
    var L = sc.length, out = [];
    for (var d = 0; d < L; d++) {
      var r = degMidi(0, sc, d);
      if (L === 7) {
        var third = degMidi(0, sc, d + 2) - r, fifth = degMidi(0, sc, d + 4) - r;
        if (fifth === 7 && (third === 3 || third === 4)) out.push(d);
      } else {
        if (degMidi(0, sc, d + 3) - r === 7) out.push(d);
      }
    }
    return out.length ? out : [0];
  }

  // варианты раскладки (в шагах лада от корня аккорда), ~2 октавы.
  // w: вес как функция drift — основные раскладки (как раньше) доминируют, остальные — редкие оттенки
  function wBase() { return 1; }
  function wOpen(d) { return 0.8 * (1 - d) + 0.05; }      // пустые квинты — чаще при статичном звучании
  function wInv(d) { return 0.45 * d; }                   // обращения — чаще при сильном дрейфе
  function wRich(d) { return 0.5 * d; }
  var VOICINGS7 = [
    { s: [0, 4, 7, 9, 11], w: wBase }, { s: [0, 4, 8, 9, 11], w: wBase }, { s: [0, 4, 9, 11, 13], w: wBase }, { s: [0, 4, 8, 11, 14], w: wBase },
    { s: [0, 4, 7, 11, 14], w: wOpen },               // открытые квинты/октавы
    { s: [2, 4, 7, 9, 11], w: wInv },                 // терция в басу
    { s: [-3, 0, 4, 7, 9], w: wInv },                 // квинта в басу
    { s: [0, 4, 8, 11, 12], w: wRich }                // add9 + 13
  ];
  var VOICINGS5 = [
    { s: [0, 3, 5, 6, 7], w: wBase }, { s: [0, 3, 5, 7, 8], w: wBase }, { s: [0, 3, 6, 8, 10], w: wBase }, { s: [0, 2, 3, 6, 8], w: wBase },
    { s: [0, 3, 5, 8, 10], w: wOpen },
    { s: [-2, 0, 3, 5, 7], w: wInv }
  ];

  function clashes(notes) {
    for (var i = 0; i < notes.length; i++) {
      for (var j = i + 1; j < notes.length; j++) {
        var iv = Math.abs(notes[i] - notes[j]) % 12;
        if (iv === 1 || iv === 11 || iv === 6) return true; // полутон / тритон
      }
    }
    return false;
  }

  // правило регистра (Plomp–Levelt: ниже ~C3 критическая полоса шире интервала → терции/секунды «гудят»):
  // два звучащих тона на расстоянии 1…4 полутона, если нижний ниже LOW_MIDI, — недопустимы
  var LOW_MIDI = 48;   // C3 ≈ 130.8 Гц
  function lowRough(a, b) { var d = Math.abs(a - b); return d >= 1 && d <= 4 && Math.min(a, b) < LOW_MIDI; }
  // поднять «тесные» нижние тона на октаву (верхний из пары; педаль суба не двигается) → открытая раскладка
  function openLow(notes, pedal) {
    notes = notes.slice().sort(function (a, b) { return a - b; });
    for (var guard = 0; guard < 12; guard++) {
      var moved = false, i, j;
      for (i = 0; i < notes.length && !moved; i++) {
        for (j = 0; j < pedal.length; j++) if (lowRough(notes[i], pedal[j])) { notes[i] += 12; moved = true; break; }
        for (j = i + 1; j < notes.length && !moved; j++) if (lowRough(notes[i], notes[j])) { notes[j] += 12; moved = true; }
      }
      if (!moved) break;
      notes.sort(function (a, b) { return a - b; });
    }
    return notes;
  }
  // нижняя нота суба (основной тон педали) — всегда звучит под пэдом
  function subMidi(H) { return baseMidi(H) - 12; }

  // аккорд для ступени d → отсортированный массив midi из SLOTS нот
  function buildChord(H, d, drift) {
    drift = drift == null ? 0.4 : drift;
    var sc = scaleOf(H), base = baseMidi(H);
    var bass = degMidi(base, sc, d), shift = bass > 52 ? -12 : 0;
    // взвешенный случайный порядок без повторов
    var pool = (sc.length === 7 ? VOICINGS7 : VOICINGS5).map(function (v) { return { s: v.s, w: v.w(drift) }; });
    while (pool.length) {
      var sum = 0, i;
      for (i = 0; i < pool.length; i++) sum += pool[i].w;
      var x = Math.random() * sum, k = 0;
      for (i = 0; i < pool.length; i++) { x -= pool[i].w; if (x <= 0) { k = i; break; } }
      var v = pool.splice(k, 1)[0];
      var notes = v.s.map(function (s) { var m = degMidi(base, sc, d + s) + shift; return m < 34 ? m + 12 : m; });
      notes = openLow(notes, [subMidi(H)]);
      var dup = false;
      for (i = 1; i < notes.length; i++) if (notes[i] === notes[i - 1]) dup = true;
      if (!dup && !clashes(notes)) return notes;
    }
    // запасной вариант: только корни и квинты
    var f = sc.length === 7 ? 4 : 3, L = sc.length;
    return openLow([0, f, L, L + f, 2 * L].map(function (s) { return degMidi(base, sc, d + s) + shift; }), [subMidi(H)]);
  }
  // верхний тон суба (тоника, −13 дБ к основному) тесно встаёт рядом с басом аккорда на II/III ступени → его приглушаем
  function subUpperClashes(H, notes) {
    var b = baseMidi(H);
    for (var i = 0; i < notes.length; i++) if (lowRough(notes[i], b)) return true;
    return false;
  }

  // следующий аккорд: тоника чаще, без повторов
  function pickChordDeg(H, prev) {
    var roots = chordRoots(scaleOf(H));
    if (prev !== 0 && Math.random() < 0.5) return 0;
    var pool = [];
    roots.forEach(function (d) { if (d !== prev || roots.length === 1) { pool.push(d); if (d === 0) pool.push(d, d); } });
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ---------------------------------------------------------------- генерация буферов и волн

  // волны пэда (PeriodicWave): «тёплая пила», «полая» (нечётные сильнее) и «органно-стеклянная» (регистры + верх)
  function makePadWaves(ctx) {
    var N = 28, r1 = new Float32Array(N), i1 = new Float32Array(N), r2 = new Float32Array(N), i2 = new Float32Array(N);
    for (var n = 1; n < N; n++) {
      i1[n] = 1 / Math.pow(n, 1.45);
      i2[n] = (n % 2 ? 1 : 0.25) / Math.pow(n, 1.7);
    }
    var M = 33, r3 = new Float32Array(M), i3 = new Float32Array(M);
    var org = { 1: 1, 2: 0.75, 3: 0.45, 4: 0.55, 5: 0.1, 6: 0.32, 8: 0.4, 10: 0.12, 12: 0.24, 16: 0.2, 20: 0.06, 24: 0.08, 32: 0.05 };
    for (var h in org) i3[h] = org[h];
    return [ctx.createPeriodicWave(r1, i1), ctx.createPeriodicWave(r2, i2), ctx.createPeriodicWave(r3, i3)];
  }
  // синус-LFO со случайной начальной фазой
  function lfoWave(ctx, phase) {
    return ctx.createPeriodicWave(new Float32Array([0, Math.sin(phase)]), new Float32Array([0, Math.cos(phase)]));
  }
  // форма «наката»: медленный подъём, более быстрый спад
  function surfWave(ctx) {
    var re = new Float32Array([0, 0, -0.18, 0]), im = new Float32Array([0, 1, 0.22, 0.06]);
    return ctx.createPeriodicWave(re, im);
  }

  // розовый шум (Paul Kellet) с бесшовной петлёй, mono
  function makePinkBuffer(ctx, secs) {
    var sr = ctx.sampleRate, N = Math.floor(sr * secs), F = Math.floor(sr * 0.25);
    var tmp = new Float32Array(N + F), b0 = 0, b1 = 0, b2 = 0, sum = 0;
    for (var i = 0; i < N + F; i++) {
      var w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      tmp[i] = b0 + b1 + b2 + w * 0.1848;
    }
    var buf = ctx.createBuffer(1, N, sr), d = buf.getChannelData(0);
    for (i = 0; i < N; i++) {
      if (i < F) { var x = i / F; d[i] = tmp[i] * Math.sqrt(x) + tmp[N + i] * Math.sqrt(1 - x); }
      else d[i] = tmp[i];
      sum += d[i] * d[i];
    }
    var g = 0.25 / Math.sqrt(sum / N);        // RMS ≈ 0.25
    for (i = 0; i < N; i++) d[i] *= g;
    return buf;
  }

  // короткая «капля»: падающий тон + щелчок шума
  function makeDropBuffer(ctx) {
    var sr = ctx.sampleRate, N = Math.floor(sr * 0.06), buf = ctx.createBuffer(1, N, sr), d = buf.getChannelData(0);
    var f0 = rand(1100, 2800), ph = 0, tau = rand(0.004, 0.012), peak = 0, lp = 0;
    for (var i = 0; i < N; i++) {
      var t = i / sr, f = f0 * (1 - 0.35 * Math.min(1, t / 0.03));
      ph += 2 * Math.PI * f / sr;
      var env = Math.exp(-t / tau) * Math.min(1, t / 0.0006);
      var click = t < 0.003 ? (Math.random() * 2 - 1) * (1 - t / 0.003) * 0.22 : 0;
      lp += 0.2 * (click - lp);                  // смягчённый щелчок
      d[i] = Math.sin(ph) * env * 0.8 + lp;
      peak = Math.max(peak, Math.abs(d[i]));
    }
    for (i = 0; i < N; i++) d[i] /= peak;
    return buf;
  }

  // «зерно»: крошечный импульс — сглаженный шумовой всплеск + иногда затухающий резонанс (поп)
  function makeGrainBuffer(ctx) {
    var sr = ctx.sampleRate, N = Math.floor(sr * rand(0.008, 0.024)), buf = ctx.createBuffer(1, N, sr), d = buf.getChannelData(0);
    var tauN = rand(0.0002, 0.0014), a = rand(0.15, 0.7), fr = rand(700, 4200), tauR = rand(0.0006, 0.004);
    var res = Math.random() < 0.6 ? rand(0.1, 0.8) : 0, lp = 0, peak = 1e-9;
    for (var i = 0; i < N; i++) {
      var t = i / sr;
      lp += a * ((Math.random() * 2 - 1) * Math.exp(-t / tauN) - lp);
      d[i] = lp + res * Math.sin(2 * Math.PI * fr * t) * Math.exp(-t / tauR) * Math.min(1, t / 0.0004);
      peak = Math.max(peak, Math.abs(d[i]));
    }
    var F = Math.floor(N * 0.25);
    for (i = 0; i < N; i++) { d[i] /= peak; if (i > N - F) d[i] *= (N - i) / F; }
    return buf;
  }

  // импульс реверба: стерео шум с экспоненциальным спадом (−60 дБ за secs) и темнеющим хвостом.
  // size (0..1): маленькие комнаты получают ранние отражения, большие — более тёмный хвост и больший пре-дилей.
  function makeImpulse(ctx, secs, size) {
    size = size == null ? 0.6 : size;
    var dark = Math.max(0, size - 0.5) * 2, er = Math.max(0, 0.5 - size) * 2;
    var sr = ctx.sampleRate, N = Math.floor(sr * secs), buf = ctx.createBuffer(2, N, sr);
    var pre = Math.floor(sr * (0.012 + 0.014 * dark));
    var fTop = 9000 * (1 - 0.3 * dark), fFloor = 900 * (1 - 0.25 * dark), damp = secs * (0.35 - 0.1 * dark);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch), y = 0, a = 0;
      for (var i = 0; i < N; i++) {
        if ((i & 63) === 0) {
          var t = i / sr, fc = fTop * Math.exp(-t / damp) + fFloor;  // демпфирование ВЧ со временем
          a = Math.exp(-2 * Math.PI * fc / sr);
        }
        y += (1 - a) * ((Math.random() * 2 - 1) - y);
        var tt = i / sr;
        var env = i < pre ? 0 : Math.exp(-6.9 * tt / secs) * Math.min(1, (i - pre) / (sr * 0.02));
        d[i] = y * env;
      }
      if (er > 0) {           // ранние отражения: несколько размытых «стенок» в первые ~60 мс
        var taps = 7 + Math.floor(Math.random() * 5);
        for (var k = 0; k < taps; k++) {
          var tk = rand(0.003, 0.012) + 0.05 * Math.pow(Math.random(), 1.4), p = Math.floor(tk * sr);
          var amp = er * 0.55 * Math.exp(-tk / 0.035) * rand(0.4, 1) * (Math.random() < 0.5 ? -1 : 1);
          for (var q = 0; q < 24 && p + q < N; q++) d[p + q] += amp * Math.exp(-q / 5) * (q < 2 ? q / 2 : 1);
        }
      }
    }
    return buf;
  }

  // кривая «тёплого» насыщения: асимметричный tanh, единичный наклон в нуле, вход −1..1 ↔ сигнал −4..4
  var WARM_K = 4;
  function makeWarmCurve() {
    var n = 2048, c = new Float32Array(n), b = 0.18, sech2 = 1 - Math.pow(Math.tanh(b), 2);
    for (var i = 0; i < n; i++) {
      var z = (i / (n - 1) * 2 - 1) * WARM_K;
      c[i] = (Math.tanh(z + b) - Math.tanh(b)) / sech2;
    }
    return c;
  }

  // ---------------------------------------------------------------- тембр нот: опорные точки морфинга
  // r/ra: отношение модулятора (основное / альтернативное, 25 %); ix: масштаб FM-индекса;
  // ixCap/ixK/ixC: время спада индекса = min(cap, decay·k) + c; pr/pl: частота/уровень доп. партиала,
  // pK/pC: его спад; dm: множитель длины; att: атака; pk: громкость
  var NOTE_TONES = [
    { t: 0.00, r: 1, ra: 3, ix: 0.3, ixCap: 0.04, ixK: 0.02, ixC: 0.012, pr: 3.93, pl: 0.2, pK: 0.01, pC: 0.02, dm: 0.42, att: 0.0025, pk: 1.6 },  // дерево / маримба
    { t: 0.32, r: 1, ra: 1, ix: 0.95, ixCap: 0.45, ixK: 0.15, ixC: 0.05, pr: 14, pl: 0.07, pK: 0, pC: 0.015, dm: 0.8, att: 0.004, pk: 1.25 },      // электропиано
    { t: 0.47, r: 2, ra: 3, ix: 1.0, ixCap: 0.25, ixK: 0.12, ixC: 0.02, pr: 2.76, pl: 0.06, pK: 0.08, pC: 0.01, dm: 1.0, att: 0.008, pk: 1.0 },    // колокольчик (как было)
    { t: 0.64, r: 2, ra: 3, ix: 1.0, ixCap: 0.25, ixK: 0.12, ixC: 0.02, pr: 2.76, pl: 0.06, pK: 0.08, pC: 0.01, dm: 1.0, att: 0.008, pk: 1.0 },
    { t: 1.00, r: 3.53, ra: 4.79, ix: 1.9, ixCap: 0.8, ixK: 0.3, ixC: 0.05, pr: 5.4, pl: 0.13, pK: 0.3, pC: 0.05, dm: 1.25, att: 0.003, pk: 0.95 } // стекло / металл
  ];
  var LOG_KEYS = { r: 1, ra: 1, pr: 1 };
  function noteTone(x) {
    x = clamp(x, 0, 1);
    var A = NOTE_TONES, k = 0;
    while (k < A.length - 2 && x > A[k + 1].t) k++;
    var a = A[k], b = A[k + 1], u = clamp((x - a.t) / (b.t - a.t), 0, 1), o = {};
    u = u * u * (3 - 2 * u);   // плавно у опорных точек
    for (var key in a) {
      if (key === 't') continue;
      o[key] = LOG_KEYS[key] ? Math.exp(lerp(Math.log(a[key]), Math.log(b[key]), u)) : lerp(a[key], b[key], u);
    }
    return o;
  }

  // ---------------------------------------------------------------- ядро (граф + планирование)

  function createCore(ctx, P, opts) {
    opts = opts || {};
    // события для визуализации (только чтение, без Math.random и без влияния на звук):
    // EV.on === false → ни одного лишнего объекта; EV.fn — внешний диспетчер (window.Ambient)
    var EV = opts.events || { on: false, fn: null };
    var t0 = ctx.currentTime, sr = ctx.sampleRate, nyq = sr / 2;

    // на случай старой схемы без новых параметров
    var FALLBACK = { padTone: 0.45, padShimmer: 0, notesTone: 0.55, notesPhrase: 0, noiseGrain: 0, tape: 0, warmth: 0, binaural: 0, beatRate: 0.3 };
    for (var kf in FALLBACK) if (typeof P[kf] !== 'number') P[kf] = FALLBACK[kf];
    // эффективные значения (см. шапку) и звучащая гармония
    var E = {}, Etau = {}, k0;
    for (k0 in P) E[k0] = P[k0];
    var H = { root: P.root, scale: P.scale }, pendingHarm = null;
    var lastTickT = t0;
    // «погода»: раз в 3–10 мин плотность нот и яркость пэда медленно (20–60 с) смещаются на ±0.07
    // вокруг настроек пользователя. Внутреннее смещение — P (и слайдеры) не меняются.
    var WEATHER_AMP = 0.07;
    var W = { den: { v: 0, from: 0, to: 0, at: t0, dur: 1 }, bri: { v: 0, from: 0, to: 0, at: t0, dur: 1 }, next: t0 + rand(180, 600) };
    function weatherStep(now) {
      if (now >= W.next) {
        ['den', 'bri'].forEach(function (k) {
          var w = W[k], to = rand(-WEATHER_AMP, WEATHER_AMP);
          if (Math.abs(to - w.v) < WEATHER_AMP * 0.5) to = w.v > 0 ? -Math.abs(to) : Math.abs(to);   // заметно в другую сторону
          w.from = w.v; w.to = to; w.at = now + rand(0, 20); w.dur = rand(20, 60);
        });
        W.next = now + rand(180, 600);
      }
      ['den', 'bri'].forEach(function (k) {
        var w = W[k], u = clamp((now - w.at) / w.dur, 0, 1);
        w.v = w.from + (w.to - w.from) * u * u * (3 - 2 * u);
      });
    }

    function G(v) { var g = ctx.createGain(); g.gain.value = v; return g; }
    function F(type, f, q) { var b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
    function makePan(p) {
      if (ctx.createStereoPanner) { var s = ctx.createStereoPanner(); s.pan.value = p; return s; }
      var pn = ctx.createPanner(); pn.panningModel = 'equalpower';
      pn.setPosition(Math.sin(p * Math.PI / 2), 0, -Math.cos(p * Math.PI / 2)); return pn;
    }
    function osc(type, f, wave) {
      var o = ctx.createOscillator();
      if (wave) o.setPeriodicWave(wave); else o.type = type;
      o.frequency.value = f; return o;
    }
    function constSrc(v) {
      if (!ctx.createConstantSource) return null;
      var c = ctx.createConstantSource(); c.offset.value = v; return c;
    }
    function lfo(rate, phase) { return osc(null, rate, lfoWave(ctx, phase == null ? rand(0, 6.28) : phase)); }
    var continuous = [];  // все постоянные источники (стартуют один раз)

    // ---- мастер
    var preMaster = G(1);
    // тепло: чистый путь ⨁ насыщенный путь (pre → tanh → post), затем high-shelf
    var warmClean = G(1), warmPre = G(1 / WARM_K), warmShaper = ctx.createWaveShaper(), warmWet = G(0), warmSum = G(1);
    warmShaper.curve = makeWarmCurve(); warmShaper.oversample = 'none';   // без латентности → кроссфейд без гребёнки
    var warmShelf = F('highshelf', 7000, 0.7); warmShelf.gain.value = 0;
    preMaster.connect(warmClean); warmClean.connect(warmSum);
    preMaster.connect(warmPre); warmPre.connect(warmShaper); warmShaper.connect(warmWet); warmWet.connect(warmSum);
    var hpf = F('highpass', 28, 0.7);
    var volume = G(0);
    var fader = G(opts.fader == null ? 0 : opts.fader);
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 8;
    comp.attack.value = 0.005; comp.release.value = 0.35;
    // быстрый лимитер (Chrome добавляет авто-makeup, поэтому после него — компенсирующий gain)
    var lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -6; lim.knee.value = 0; lim.ratio.value = 20;
    lim.attack.value = 0.001; lim.release.value = 0.12;
    var post = G(0.7);
    var sleepG = G(1), sleepLow = false;    // гейн «таймера сна» (не параметр volume), см. sleepFade()
    var clip = ctx.createWaveShaper();   // мягкий потолок: линейно до 0.7, далее плавно к 0.98
    (function () {
      var n = 4096, c = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        var x = i / (n - 1) * 2 - 1, ax = Math.abs(x), y = ax < 0.7 ? ax : 0.7 + 0.28 * Math.tanh((ax - 0.7) / 0.28);
        c[i] = x < 0 ? -y : y;
      }
      clip.curve = c;
    })();
    var analyser = ctx.createAnalyser();
    analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.8;
    warmSum.connect(warmShelf); warmShelf.connect(hpf); hpf.connect(volume); volume.connect(fader); fader.connect(comp);
    comp.connect(lim); lim.connect(post); post.connect(sleepG); sleepG.connect(clip); clip.connect(analyser); analyser.connect(ctx.destination);

    // ---- шины: сухая, реверб, дилей
    var dryBus = G(1); dryBus.connect(preMaster);
    // посыл реверба отфильтрован с обеих сторон (Abbey Road): ВЧ 140 Гц убирает гул, НЧ 6.5 кГц — шипение хвоста
    var revSend = G(1), revHP = F('highpass', 140, 0.6), revLP = F('lowpass', 6500, 0.5), revOut = G(0);
    revSend.connect(revHP); revHP.connect(revLP); revOut.connect(preMaster);
    var revSlot = null;          // { conv, gain }
    var revTimer = null, revSecs = 0, revLastT = -1e9;

    function revSecsOf(x) { return 1.5 * Math.pow(8, x); }      // 1.5 … 12 с
    function regenReverb(xfade, size) {
      size = size == null ? P.reverbSize : size;
      var secs = revSecsOf(size);
      if (Math.abs(secs - revSecs) < 0.05 && revSlot) return;
      revSecs = secs;
      var t = ctx.currentTime, conv = ctx.createConvolver(), g = G(0);
      revLastT = t;
      conv.normalize = true;
      conv.buffer = makeImpulse(ctx, secs, size);
      revLP.connect(conv); conv.connect(g); g.connect(revOut);
      var old = revSlot;
      xfade = Math.max(0.05, xfade == null ? 1.2 : xfade);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + xfade);
      if (old) {
        glideTo(old.gain.gain, old.gain.gain.value, t, 0.01);
        old.gain.gain.linearRampToValueAtTime(0, t + xfade);
        // старый свёрточник отключаем после кроссфейда (освобождает CPU и память)
        setTimeout(function () { safeDisconnect(old.conv); safeDisconnect(old.gain); old.conv.buffer = null; }, (xfade + 0.5) * 1000);
      }
      revSlot = { conv: conv, gain: g };
    }
    function scheduleReverb(xfade) {   // debounce ~250 мс
      if (revTimer) clearTimeout(revTimer);
      revTimer = setTimeout(function () { revTimer = null; regenReverb(xfade); }, 250);
    }

    // дилей: моно-вход → A (влево) → B (вправо) → фильтры → обратная связь → A
    var delaySend = G(1);
    delaySend.channelCount = 1; delaySend.channelCountMode = 'explicit'; delaySend.channelInterpretation = 'speakers';
    var dA = ctx.createDelay(2), dB = ctx.createDelay(2);
    dA.delayTime.value = 0.46; dB.delayTime.value = 0.46;
    var fbLP = F('lowpass', 2600, 0.5), fbHP = F('highpass', 220, 0.5), fb = G(0.3);
    var dMerge = ctx.createChannelMerger(2), delayOut = G(CAL.delayRet), delayRev = G(0.35);
    delaySend.connect(dA); dA.connect(dB); dB.connect(fbLP); fbLP.connect(fbHP); fbHP.connect(fb); fb.connect(dA);
    dA.connect(dMerge, 0, 0); dB.connect(dMerge, 0, 1);
    dMerge.connect(delayOut); delayOut.connect(preMaster); delayOut.connect(delayRev); delayRev.connect(revSend);

    // ---- «плёнка»: музыкальные шины → короткие модулируемые задержки (целое число сэмплов → при 0 прозрачно)
    var tapeBase = Math.round(0.009 * sr) / sr;
    var musDry = G(1), musRev = G(1), musDel = G(1), tapeMod = G(1), tapeDelays = [];
    [[musDry, dryBus], [musRev, revSend], [musDel, delaySend]].forEach(function (pr) {
      var dl = ctx.createDelay(0.05); dl.delayTime.value = tapeBase;
      pr[0].connect(dl); dl.connect(pr[1]); tapeMod.connect(dl.delayTime); tapeDelays.push(dl);
    });
    // wow: две несоизмеримые медленные синусоиды (нерегулярный рисунок) + flutter ~6 Гц
    var TAPE = [{ f: 0.37, dev: 0.0034 }, { f: 0.61, dev: 0.0022 }, { f: 6.1, dev: 0.0007 }];
    // LFO создаются только при tape > 0 (задержки остаются всегда → при 0 прозрачно и без смены латентности)
    var tapeOn = false, tapeLowSince = -1;
    TAPE.forEach(function (w) { w.osc = null; w.depth = G(0); w.depth.connect(tapeMod); });
    function tapeEnsure(t) {
      if (tapeOn) return;
      tapeOn = true;
      TAPE.forEach(function (w) { w.osc = lfo(w.f); w.osc.connect(w.depth); w.osc.start(t); });
    }
    function tapeRelease() {
      if (!tapeOn) return;
      tapeOn = false;
      TAPE.forEach(function (w) { safeStop(w.osc, 0); safeDisconnect(w.osc); w.osc = null; });
    }

    // ---- пэд
    var waves = makePadWaves(ctx);
    var padIn = G(CAL.padVoice);
    var padF1 = F('lowpass', 800, 0.55), padF2 = F('lowpass', 1000, 0.5);
    var padSplit = ctx.createChannelSplitter(2), padMerge = ctx.createChannelMerger(2);
    var wLL = G(1), wRR = G(1), wLR = G(0), wRL = G(0);  // матрица ширины
    var padLevel = G(0), padDelay = G(0), padRev = G(0.9);
    padIn.connect(padF1); padF1.connect(padF2); padF2.connect(padSplit);
    padSplit.connect(wLL, 0); padSplit.connect(wLR, 0); padSplit.connect(wRR, 1); padSplit.connect(wRL, 1);
    wLL.connect(padMerge, 0, 0); wRL.connect(padMerge, 0, 0); wRR.connect(padMerge, 0, 1); wLR.connect(padMerge, 0, 1);
    padMerge.connect(padLevel);
    padLevel.connect(musDry); padLevel.connect(padRev); padRev.connect(musRev); padLevel.connect(padDelay); padDelay.connect(musDel);
    // медленная модуляция среза (в центах через detune)
    var padFLfo = lfo(0.021), padFDepth = G(0);
    padFLfo.connect(padFDepth); padFDepth.connect(padF1.detune); padFDepth.connect(padF2.detune);
    continuous.push(padFLfo);
    // подъём среза для «органного» края padTone (отдельный источник → не конфликтует с padBright/wander)
    // (создаётся вместе с органными осцилляторами, см. organEnsure)
    var toneLift = null;

    // padTone: 0 — фильтр, следящий за нотой слота (≈синус/флейта); 0.42…0.5 — как было; >0.5 — + органная волна
    function toneRatio(x) {
      return x >= 0.42 ? 1.25 * Math.pow(2, 4.6) * (1 + (x - 0.42) * 20) : 1.25 * Math.pow(2, x / 0.42 * 4.6);
    }
    function toneCut(midi, ratio) { return Math.min(nyq * 0.9, mtof(midi) * ratio); }
    function organAmt(x) { return x <= 0.5 ? 0 : Math.pow((x - 0.5) / 0.5, 1.2); }

    var AMP_RATES = [0.031, 0.047, 0.059, 0.073, 0.089];
    var slots = [], chordDeg = 0;
    var chord = buildChord(H, 0, P.drift);
    for (var i = 0; i < SLOTS; i++) {
      var slotAmp = G(1), aL = lfo(AMP_RATES[i] * rand(0.9, 1.1)), aD = G(0);
      var tf1 = F('lowpass', 20000, -3.01), tf2 = F('lowpass', 20000, -3.01), bal = G(1);   // Q в дБ: −3 = Баттерворт, без горба
      aL.connect(aD); aD.connect(slotAmp.gain);
      slotAmp.connect(tf1); tf1.connect(tf2); tf2.connect(bal); bal.connect(padIn);
      continuous.push(aL);
      var subs = [];
      for (var k = 0; k < 2; k++) {
        var m = ctx.createChannelMerger(2), x = G(k === 0 ? 1 : 0), f = mtof(chord[i]);
        var o1 = osc(null, f, waves[0]), o2 = osc(null, f, waves[1]), og = G(0);
        o1.connect(m, 0, i % 2); o2.connect(m, 0, 1 - (i % 2));
        m.connect(x); og.connect(x); x.connect(slotAmp);
        continuous.push(o1, o2);
        subs.push({ oscs: [o1, o2], org: null, og: og, x: x, midi: chord[i], off: [rand(-2, 2), rand(-2, 2)] });
      }
      slots.push({ amp: slotAmp, depth: aD, tf: [tf1, tf2], bal: bal, subs: subs, active: 0, midi: chord[i], busyUntil: 0 });
    }

    // органные осцилляторы (padTone > 0.5) — создаются лениво; og-гейны постоянны и стоят на 0, пока слой не нужен
    var organOn = false, organLowSince = -1;
    function orgDetune(i, sv) { return (i % 2 ? -0.35 : 0.35) * (2 + P.padWidth * 13) + sv.off[0]; }
    function organEnsure(t) {
      if (organOn) return;
      organOn = true;
      for (var i = 0; i < SLOTS; i++) for (var k = 0; k < 2; k++) {
        var sv = slots[i].subs[k], target = mtof(sv.midi), cur = sv.oscs[0].frequency.value;
        var o = osc(null, isFinite(cur) && cur > 0 ? cur : target, waves[2]);
        o.detune.value = orgDetune(i, sv);
        // если подголос ещё в глайде — догнать цель; иначе это просто текущая нота
        if (Math.abs(cur - target) > 0.01) glideTo(o.frequency, target, t, 0.4);
        o.connect(sv.og); o.start(t);
        sv.org = o;
      }
      toneLift = constSrc(0);
      if (toneLift) { toneLift.connect(padF1.detune); toneLift.connect(padF2.detune); toneLift.start(t); }
    }
    function organRelease() {
      if (!organOn) return;
      organOn = false;
      for (var i = 0; i < SLOTS; i++) for (var k = 0; k < 2; k++) {
        var sv = slots[i].subs[k];
        if (sv.org) { safeStop(sv.org, 0); safeDisconnect(sv.org); sv.org = null; }
      }
      if (toneLift) { safeStop(toneLift, 0); safeDisconnect(toneLift); toneLift = null; }
    }

    var toneApplied = -1;
    function toneUpdate(t, tau) {
      var x = E.padTone, r = toneRatio(x), org = organAmt(x);
      toneApplied = x;
      for (var i = 0; i < SLOTS; i++) {
        var s = slots[i], c = toneCut(s.midi, r);
        glideTo(s.tf[0].frequency, c, t, tau); glideTo(s.tf[1].frequency, c, t, tau);
        for (var k = 0; k < 2; k++) glideTo(s.subs[k].og.gain, org * CAL.organ, t, tau);
      }
      var lowComp = Math.pow(10, 3 * Math.pow(Math.max(0, 1 - x / 0.25), 1.5) / 20);   // у «флейты» срезаны гармоники → +≤3 дБ
      glideTo(padIn.gain, CAL.padVoice * lowComp / Math.sqrt(1 + 0.9 * org * org), t, tau);
      if (toneLift) glideTo(toneLift.offset, org * 1300, t, tau);
    }

    // смена ноты в слоте: кроссфейд между двумя подголосами (или глайд, если кроссфейд ещё идёт)
    function slotTo(s, midi, t, dur) {
      if (s.midi === midi) return;
      var f = mtof(midi), j;
      s.midi = midi;
      var c = toneCut(midi, toneRatio(E.padTone));
      glideTo(s.tf[0].frequency, c, t, dur / 3); glideTo(s.tf[1].frequency, c, t, dur / 3);
      if (t < s.busyUntil) {
        var inc = s.subs[s.active];
        for (j = 0; j < 2; j++) glideTo(inc.oscs[j].frequency, f, t, dur / 4);
        if (inc.org) glideTo(inc.org.frequency, f, t, dur / 4);
        inc.midi = midi;
        return;
      }
      var out = s.subs[s.active], inn = s.subs[1 - s.active], n = 24;
      var up = new Float32Array(n), dn = new Float32Array(n);
      for (j = 0; j < n; j++) { var p = j / (n - 1); up[j] = Math.sin(p * Math.PI / 2); dn[j] = Math.cos(p * Math.PI / 2); }
      var all = [inn.oscs[0], inn.oscs[1]];
      if (inn.org) all.push(inn.org);
      for (j = 0; j < all.length; j++) {
        all[j].frequency.cancelScheduledValues(t);
        all[j].frequency.setValueAtTime(f, t);   // подголос сейчас молчит — прыжок неслышен
      }
      inn.midi = midi;
      inn.x.gain.cancelScheduledValues(t); out.x.gain.cancelScheduledValues(t);
      inn.x.gain.setValueCurveAtTime(up, t, dur);
      out.x.gain.setValueCurveAtTime(dn, t, dur);
      s.active = 1 - s.active;
      s.busyUntil = t + dur + 0.05;
    }
    function applyChord(notes, t, dur, stagger) {
      prevChord = chord; prevChordUntil = t + dur + (stagger || 0); chordT = t;
      chord = notes.slice();
      if (EV.on) EV.fn({ type: 'chord', t: t, midis: notes.slice(), fade: dur + (stagger || 0) });
      glideTo(subO2g.gain, subUpperClashes(H, notes) ? 0 : SUB2, t, dur / 3);
      for (var i = 0; i < SLOTS; i++) slotTo(slots[i], notes[i], t + (stagger ? rand(0, stagger) : 0), dur);
    }

    // ---- мерцание: редкие воздушные голоса на 1–2 октавы выше тонов аккорда
    var shimWave = ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0]), new Float32Array([0, 1, 0.06, 0.025]));
    var shimBus = G(1), shimLevel = G(0), shimDry = G(0.4), shimRev = G(1.3), shimDel = G(0.15);
    shimBus.connect(shimLevel);
    shimLevel.connect(shimDry); shimDry.connect(musDry);
    shimLevel.connect(shimRev); shimRev.connect(musRev);
    shimLevel.connect(shimDel); shimDel.connect(musDel);
    var shims = [], nextShimT = t0 + rand(1, 4);

    function shimmerVoice(t) {
      var top = chord.slice(-3), m = top[Math.floor(Math.random() * top.length)] + (Math.random() < 0.6 ? 12 : 24);
      while (m > 98) m -= 12;
      while (m < 66) m += 12;
      var f = mtof(m), att = rand(2.5, 5.5), hold = rand(0.5, 4), rel = rand(3, 6.5), pk = rand(0.45, 1);
      // расстройка задаётся в Гц, а не в центах: биения 0.05–0.16 Гц (медленное «дыхание»),
      // а не 1–14 Гц тремоло, как было при ±2…5 центах на 400–2300 Гц
      var beat = rand(0.05, 0.16);
      var a = osc(null, f + beat / 2, shimWave), b = osc(null, f - beat / 2, shimWave), env = G(0), pan = makePan(rand(-0.7, 0.7));
      env.gain.setValueAtTime(0, t);
      env.gain.setTargetAtTime(pk * 0.5, t, att / 3);
      env.gain.setTargetAtTime(0, t + att + hold, rel / 5);
      var end = t + att + hold + rel + 0.2;
      a.connect(env); b.connect(env); env.connect(pan); pan.connect(shimBus);
      var v = { nodes: [a, b, env, pan], end: end, freed: false, list: shims };
      a.onended = function () { freeVoice(v); };
      a.start(t); b.start(t + Math.random() / f); a.stop(end); b.stop(end);   // случайная фаза биений
      shims.push(v);
    }
    function scheduleShimmer(now, horizon) {
      var x = E.padShimmer;
      if (x <= 0.001) { if (nextShimT < now) nextShimT = now + rand(0.5, 2); return; }
      var rate = 0.05 + 0.25 * x;               // голосов в секунду
      if (nextShimT < now + 0.02) nextShimT = now + 0.05 + rand(0, 1.5);
      while (nextShimT < horizon) {
        if (shims.length < MAX_SHIM) shimmerVoice(nextShimT);
        nextShimT += Math.max(0.8, expRand(rate));
      }
    }

    // ---- суб
    var subO = osc('sine', mtof(baseMidi(H) - 12)), subO2 = osc('sine', mtof(baseMidi(H)));
    var SUB2 = 0.22, subO2g = G(subUpperClashes(H, chord) ? 0 : SUB2), subAmp = G(0.88), subL = lfo(0.017), subD = G(0.1), subLevel = G(0), subRev = G(0.12);
    subO.connect(subAmp); subO2.connect(subO2g); subO2g.connect(subAmp);
    subL.connect(subD); subD.connect(subAmp.gain);
    subAmp.connect(subLevel); subLevel.connect(musDry); subLevel.connect(subRev); subRev.connect(musRev);
    continuous.push(subO, subO2, subL);

    // ---- бинауральные биения (создаются лениво, только когда binaural > 0)
    var binLevel = G(0), bin = null;
    binLevel.connect(volume);
    function binEnsure(t) {
      if (bin) return;
      var c = mtof(binMidi(H)), half = beatHz(P.beatRate) / 2;
      var oL = osc('sine', c), oR = osc('sine', c), merge = ctx.createChannelMerger(2), hs = constSrc(half), neg = G(-1);
      if (hs) { hs.connect(oR.frequency); hs.connect(neg); neg.connect(oL.frequency); }
      else { oL.frequency.value = c - half; oR.frequency.value = c + half; }
      oL.connect(merge, 0, 0); oR.connect(merge, 0, 1); merge.connect(binLevel);
      bin = { oL: oL, oR: oR, hs: hs, nodes: [oL, oR, merge, neg].concat(hs ? [hs] : []) };
      oL.start(t); oR.start(t); if (hs) hs.start(t);
    }
    function binRelease() {
      if (!bin) return;
      bin.nodes.forEach(function (n) { if (n.stop) safeStop(n, 0); safeDisconnect(n); });
      bin = null;
    }
    function binCarrier(t, tau) {
      if (!bin) return;
      var c = mtof(binMidi(H));
      if (bin.hs) { glideTo(bin.oL.frequency, c, t, tau); glideTo(bin.oR.frequency, c, t, tau); }
      else { var h = beatHz(P.beatRate) / 2; glideTo(bin.oL.frequency, c - h, t, tau); glideTo(bin.oR.frequency, c + h, t, tau); }
    }

    // ---- ноты
    var notesLevel = G(0), notesDelay = G(0);
    // «приручение» 2–5 кГц (зона наибольшей чувствительности слуха): статичный провал + полка,
    // глубина растёт с яркостью тембра и высотой регистра; на мягких тембрах — почти 0 дБ
    var nDip = F('peaking', 3300, 0.8), nShelf = F('highshelf', 6000, 0.7);
    nDip.gain.value = 0; nShelf.gain.value = 0;
    notesLevel.connect(nDip); nDip.connect(nShelf);
    nShelf.connect(musDry); nShelf.connect(musRev); nShelf.connect(notesDelay); notesDelay.connect(musDel);
    function notesEQ(t, tau) {
      var sv = clamp(0.55 * P.notesTone + 0.45 * P.notesHeight, 0, 1), u = Math.pow(clamp((sv - 0.3) / 0.7, 0, 1), 1.3);
      glideTo(nDip.gain, -9 * u, t, tau); glideTo(nShelf.gain, -5 * u, t, tau);
      glideTo(nDip.frequency, 3300 * Math.pow(2, -0.3 * u), t, tau);    // ниже вместе с регистром (~2.7 кГц на максимуме)
    }
    var live = [];  // { nodes, end, freed, list }
    var nextNoteT = t0 + 1.0, lastDeg = null, rateDrawn = 0, phraseQ = [];
    var ringing = [], noteLog = [];   // недавние ноты {m, end} для правила регистра; журнал для тестов

    // правило регистра для нот: ниже C3 нота не встаёт в секунду/терцию к аккорду, педали суба
    // или ещё звучащей ноте — такая нота уходит на октаву вверх
    var prevChord = [], prevChordUntil = -1, lastPlayed = -1, chordT = t0;
    function safeMidi(m, t) {
      var m0 = m, others = chord.concat([subMidi(H), baseMidi(H)]), i;
      if (t < prevChordUntil) others = others.concat(prevChord);       // во время кроссфейда звучат оба аккорда
      for (i = ringing.length - 1; i >= 0; i--) { if (ringing[i].end < t) ringing.splice(i, 1); else others.push(ringing[i].m); }
      for (var guard = 0; guard < 4 && m < LOW_MIDI + 4; guard++) {
        var ok = true;
        for (i = 0; i < others.length; i++) if (lowRough(m, others[i])) { ok = false; break; }
        if (ok) break;
        m += 12;
      }
      if (m !== m0 && m === lastPlayed) m += 12;                       // перенос не должен дать повтор той же ноты
      return m;
    }

    function freeVoice(v) {
      if (v.freed) return;
      v.freed = true;
      for (var i = 0; i < v.nodes.length; i++) safeDisconnect(v.nodes[i]);
      var list = v.list || live, idx = list.indexOf(v); if (idx >= 0) list.splice(idx, 1);
    }

    // o: { dm: множитель длины, jit: разброс тембра }
    function playNote(t, midi, vel, o) {
      o = o || {};
      midi = safeMidi(midi, t);
      if (midi === lastPlayed) midi += midi < 84 ? 12 : -12;           // без повтора той же ноты (после переноса регистра)
      lastPlayed = midi;
      var T = noteTone(E.notesTone + (o.jit == null ? rand(-0.025, 0.025) : o.jit));
      var decay = 0.3 * Math.pow(8 / 0.3, E.notesDecay) * T.dm * (o.dm || 1);   // 0.3 … 8 с (× тембр)
      var f = mtof(midi) * Math.pow(2, rand(-3, 3) / 1200), att = T.att * rand(0.75, 1.25);
      var end = t + att + decay * 1.4 + 0.05;
      if (midi < LOW_MIDI + 4) ringing.push({ m: midi, end: t + att + decay * 0.6 });
      noteLog.push([+t.toFixed(2), midi]); if (noteLog.length > 400) noteLog.shift();
      if (EV.on) EV.fn({ type: 'note', t: t, midi: midi, vel: vel, decay: decay, tone: E.notesTone });
      var ratio = Math.random() < 0.75 ? T.r : T.ra;
      var car = osc('sine', f), mod = osc('sine', f * ratio), modG = G(0);
      var pr = T.pr, pl = T.pl;
      while (f * pr > nyq * 0.8 && pr > 2) pr /= 2;           // без алиасинга на высоких нотах
      var par = osc('sine', f * pr), parG = G(0), env = G(0), pan = makePan(rand(-0.65, 0.65));
      // FM-индекс быстро затухает → мягкий «щипок»
      var idx = f * (0.6 + 0.8 * vel) * T.ix * (midi > 84 ? 0.5 : 1);
      modG.gain.setValueAtTime(idx, t);
      modG.gain.setTargetAtTime(0, t, Math.min(T.ixCap, decay * T.ixK) + T.ixC);
      parG.gain.setValueAtTime(pl * vel, t);
      parG.gain.setTargetAtTime(0, t, decay * T.pK + T.pC);
      var peak = vel * T.pk * (midi > 80 ? 0.75 : 1);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(peak, t + att);
      env.gain.setTargetAtTime(0, t + att, decay / 5);       // −60 дБ примерно к концу
      mod.connect(modG); modG.connect(car.frequency);
      car.connect(env); par.connect(parG); parG.connect(env); env.connect(pan); pan.connect(notesLevel);
      var v = { nodes: [car, mod, modG, par, parG, env, pan], end: end, freed: false, list: live };
      car.onended = function () { freeVoice(v); };
      car.start(t); mod.start(t); par.start(t);
      car.stop(end); mod.stop(end); par.stop(end);
      live.push(v);
    }

    function noteCenter() {
      var sc = scaleOf(H), L = sc.length, base = baseMidi(H);
      var centerMidi = base + 14 + E.notesHeight * 34;           // ~E3 … ~C6
      return Math.round((centerMidi - base) / 12 * L);
    }
    function chordPCs() { var base = baseMidi(H); return chord.map(function (m) { return (m - base + 120) % 12; }); }

    // выбор ноты: консонантно, с повторами и шагами к соседней ступени
    function nextNoteMidi() {
      var sc = scaleOf(H), L = sc.length, base = baseMidi(H);
      var center = noteCenter(), lo = center - L, hi = center + L;
      var deg = lastDeg == null ? center : lastDeg, r = Math.random();
      if (lastDeg != null && r < 0.44) {          // шаг к соседней ступени (повторов той же ноты нет)
        deg += (Math.random() < 0.5 ? -1 : 1) * (Math.random() < 0.75 ? 1 : 2);
      } else {
        // взвешенный выбор: тоника, квинта, тоны текущего аккорда
        var fifth = L === 7 ? 4 : 3, chordPC = chordPCs();
        var pool = [], wsum = 0;
        for (var d = lo; d <= hi; d++) {
          var cls = ((d % L) + L) % L, pc = sc[cls], w = 1;
          if (cls === 0) w = 4; else if (cls === fifth) w = 3; else if (chordPC.indexOf(pc) >= 0) w = 2;
          if (lastDeg != null && Math.abs(d - lastDeg) > L) w *= 0.3;   // без больших скачков
          if (d === lastDeg) w = 0;                                      // без повтора той же ноты
          pool.push([d, w]); wsum += w;
        }
        var x = Math.random() * wsum;
        for (var q = 0; q < pool.length; q++) { x -= pool[q][1]; if (x <= 0) { deg = pool[q][0]; break; } }
      }
      if (deg < lo) deg = lo + (lo - deg); if (deg > hi) deg = hi - (deg - hi);
      deg = clamp(deg, lo, hi);
      if (deg === lastDeg) deg += deg < hi ? 1 : -1;
      lastDeg = deg;
      return { midi: degMidi(base, sc, deg), deg: deg };
    }

    function densEff() { return clamp(E.notesDensity + W.den.v, 0, 1); }      // с «погодой»
    function noteRate() { return (1 / 20) * Math.pow(60, densEff()); }   // 0.05 … 3 нот/с
    // «тишина — тоже материал»: при малой плотности изредка 15–40 с только пэда
    function longRest() {
      var p = 0.12 * Math.pow(Math.max(0, 1 - densEff() / 0.6), 2);   // 12 % при 0, 3 % при 0.3, 0 от 0.6
      return Math.random() < p ? rand(15, 40) : 0;
    }
    // редкий «цветной» тон вне лада (≈3 % одиночных нот): мягкое модальное смешение, как C♮ в ре мажоре у Eno
    var COLOUR = [11, 2, 10, 8, 9, 2];
    function colourTone(m) {
      var base = baseMidi(H), pc = COLOUR[H.scale % COLOUR.length], best = null;
      for (var o = -1; o <= 1; o++) {
        var c = base + 12 * Math.round((m - base - pc) / 12 + o) + pc, ok = c >= 57;
        for (var i = 0; i < chord.length && ok; i++) if (Math.abs(c - chord[i]) <= 2) ok = false;
        if (ok && (best == null || Math.abs(c - m) < Math.abs(best - m))) best = c;
      }
      return best;
    }

    // фраза: 3–7 нот (арпеджио по тонам аккорда, гамма, мотив), рыхлая сетка, «человеческие» время и сила
    function buildPhrase(tStart) {
      var x = E.notesPhrase, rate = noteRate(), sc = scaleOf(H), L = sc.length;
      var n = 3 + Math.floor(Math.random() * (1 + Math.round(x * 4)));
      var step = clamp(0.32 * Math.pow(rate, -0.25), 0.16, 0.55) * rand(0.85, 1.2);
      var center = noteCenter(), lo = center - L - 1, hi = center + L + 1;
      var start = lastDeg == null ? center + Math.round(rand(-2, 2)) : lastDeg + Math.round(rand(-2, 2));
      start = clamp(start, lo + 1, hi - 1);
      var pcs = chordPCs(), ct = [], d;
      for (d = lo; d <= hi; d++) if (pcs.indexOf(sc[((d % L) + L) % L]) >= 0) ct.push(d);
      if (ct.length < 3) for (d = lo; d <= hi; d++) if ((((d % L) + L) % L) % 2 === 0) ct.push(d);
      var degs = [], dir = start > center ? -1 : 1, kind = Math.random(), j;
      if (kind < 0.45) {                             // арпеджио (иногда с разворотом)
        var ci = 0, best = 1e9;
        for (j = 0; j < ct.length; j++) if (Math.abs(ct[j] - start) < best) { best = Math.abs(ct[j] - start); ci = j; }
        var turn = Math.random() < 0.4 ? Math.ceil(n / 2) : -1;
        for (j = 0; j < n; j++) {
          degs.push(ct[ci]);
          if (j === turn) dir = -dir;
          if (ci + dir < 0 || ci + dir >= ct.length) dir = -dir;
          ci += dir;
        }
      } else if (kind < 0.8) {                       // поступенно по ладу, изредка скачок/разворот
        var dg = start;
        for (j = 0; j < n; j++) {
          degs.push(dg);
          if (Math.random() < 0.15) dir = -dir;
          dg += dir * (Math.random() < 0.18 ? 2 : 1);
          if (dg < lo || dg > hi) { dir = -dir; dg += 2 * dir; }
        }
      } else {                                       // мотив вокруг опорной ступени
        var MOT = [[0, 1, 0, -1, 0, 2, 1], [0, 2, 1, 3, 2, 4, 3], [0, -1, 0, 2, 4, 2, 0], [4, 2, 0, 1, 0, -1, 0], [0, 0, 2, 1, 0, 1, 4]];
        var mo = MOT[Math.floor(Math.random() * MOT.length)];
        for (j = 0; j < n; j++) degs.push(clamp(start + mo[j % mo.length], lo, hi));
      }
      // последняя нота — на ближайший тон аккорда
      var last = degs[n - 1], bc = last, bd = 1e9;
      for (j = 0; j < ct.length; j++) if (Math.abs(ct[j] - last) < bd && (n < 2 || ct[j] !== degs[n - 2])) { bd = Math.abs(ct[j] - last); bc = ct[j]; }
      degs[n - 1] = bc;
      if (lastDeg != null && degs[0] === lastDeg) degs[0] += degs[0] < hi ? 1 : -1;
      for (j = 1; j < n; j++) if (degs[j] === degs[j - 1]) degs[j] += (j === n - 1 ? (degs[j] > lo ? -1 : 1) : (degs[j] < hi ? 1 : -1));
      var tt = tStart, prevT = tStart - 1, out = [];
      for (j = 0; j < n; j++) {
        var p = n > 1 ? j / (n - 1) : 0;
        var vel = clamp((0.55 + 0.3 * Math.sin(Math.PI * p) + (j === 0 ? 0.12 : 0)) * rand(0.82, 1.12), 0.3, 1);
        var at = Math.max(prevT + 0.09, tt + rand(-0.07, 0.07) * step);
        out.push({ t: at, deg: degs[j], vel: vel, dm: j === n - 1 ? rand(1.0, 1.3) : rand(0.75, 1.0) });
        prevT = at;
        var len = Math.random() < 0.18 ? 2 : 1;
        if (j === n - 2) len *= rand(1.1, 1.5);      // лёгкое замедление к концу
        tt += step * len;
      }
      lastDeg = degs[n - 1];
      phraseQ = out;
      // пауза так, чтобы средняя плотность ≈ noteRate()
      var T = tt - tStart;
      // настоящая пауза после фразы (≥ 2 с), при малой плотности — иногда длинная тишина
      nextNoteT = tt + Math.max(step * 4, 2.0, n / rate * rand(0.7, 1.3) - T) + longRest();
      rateDrawn = rate;
    }

    function scheduleNotes(now, horizon) {
      if (E.notesLevel <= 0.001 && P.notesLevel <= 0) { phraseQ = []; if (nextNoteT < now) nextNoteT = now; return; }
      if (!phraseQ.length && nextNoteT < now + 0.02) nextNoteT = now + 0.03 + Math.random() * 0.2;  // после простоя — без «пачки»
      var sc, base;
      for (var guard = 0; guard < 400; guard++) {
        if (phraseQ.length) {
          var ev = phraseQ[0];
          if (ev.t >= horizon) break;
          phraseQ.shift();
          if (ev.t < now) continue;
          if (live.length < MAX_NOTES) {
            sc = scaleOf(H); base = baseMidi(H);
            playNote(ev.t, degMidi(base, sc, ev.deg), ev.vel, { dm: ev.dm });
          }
          continue;
        }
        if (nextNoteT >= horizon) break;
        var rate = noteRate();
        if (Math.random() < 0.85 * Math.pow(E.notesPhrase, 1.3)) { buildPhrase(nextNoteT); continue; }
        if (live.length < MAX_NOTES) {
          var n = nextNoteMidi(), vel = rand(0.45, 1), tt = nextNoteT;
          sc = scaleOf(H);
          if (Math.random() < 0.03) { var ctn = colourTone(n.midi); if (ctn != null) { n = { midi: ctn, deg: n.deg }; vel *= 0.75; } }
          // изредка — форшлаг: тихая соседняя ступень чуть раньше (не в низком регистре)
          if (Math.random() < 0.04 && n.midi >= LOW_MIDI + 7) {
            playNote(tt, degMidi(baseMidi(H), sc, n.deg + (Math.random() < 0.6 ? 1 : -1)), vel * 0.45, { dm: 0.5 });
            tt += rand(0.07, 0.12);
          }
          playNote(tt, n.midi, vel);
          // изредка — тихая вторая нота (квинта/октава) рядом
          if (Math.random() < 0.1 && live.length < MAX_NOTES) {
            var d2 = n.deg + (Math.random() < 0.5 ? (sc.length === 7 ? 4 : 3) : sc.length);
            playNote(tt + rand(0.04, 0.25), degMidi(baseMidi(H), sc, d2), vel * 0.5);
          }
        }
        nextNoteT += Math.max(0.12, expRand(rate)) + longRest();
        rateDrawn = rate;
      }
    }

    // ---- шум: в каждом канале сумма двух независимых петель несоизмеримой длины (приём Eno из Discreet Music):
    // L = 9.7 + 11.3 с, R = 10.3 + 12.7 с → суммарный рисунок повторяется раз в ~18 / ~22 мин (было 7.3 / 8.9 с)
    var NOISE_LOOPS = [[9.7, 11.3], [10.3, 12.7]];
    var noiseIn = ctx.createChannelMerger(2), nSrc = [];
    for (i = 0; i < 2; i++) {
      var nMix = G(Math.SQRT1_2);
      for (var q = 0; q < 2; q++) {
        var bs = ctx.createBufferSource(); bs.buffer = makePinkBuffer(ctx, NOISE_LOOPS[i][q]); bs.loop = true;
        bs.connect(nMix); nSrc.push(bs);
      }
      nMix.connect(noiseIn, 0, i);
    }
    var rumLP1 = F('lowpass', 150, 0.5), rumLP2 = F('lowpass', 150, 0.5), gRum = G(0);
    var windBP = F('bandpass', 600, 1.1), windLP = F('lowpass', 3000, 0.5), gWind = G(0);
    var hissHP = F('highpass', 3000, 0.6), hissLP = F('lowpass', 7000, 0.5), gHiss = G(0);
    var shellBP = F('bandpass', 1000, 4), gShell = G(0);     // «ракушка»: резонансный воздух около noiseColor 0.75
    var nSum = G(1), nSweep = F('lowpass', 7500, 0.5), nAmp = G(1), noiseLevel = G(0), noiseRev = G(0.4);
    noiseIn.connect(rumLP1); rumLP1.connect(rumLP2); rumLP2.connect(gRum); gRum.connect(nSum);
    noiseIn.connect(windBP); windBP.connect(windLP); windLP.connect(gWind); gWind.connect(nSum);
    noiseIn.connect(hissHP); hissHP.connect(hissLP); hissLP.connect(gHiss); gHiss.connect(nSum);
    noiseIn.connect(shellBP); shellBP.connect(gShell); gShell.connect(nSum);
    nSum.connect(nSweep); nSweep.connect(nAmp); nAmp.connect(noiseLevel);
    noiseLevel.connect(dryBus); noiseLevel.connect(noiseRev); noiseRev.connect(revSend);
    // ветер: полоса медленно гуляет (LFO + случайное блуждание в tick)
    var windL = lfo(0.043), windD = G(500);
    windL.connect(windD); windD.connect(windBP.detune); windD.connect(shellBP.detune);
    // волны: один «прибойный» LFO → амплитуда и срез
    // частота наката: 0 → 0.13 Гц, 0.5 → 0.10 Гц (≈ 6 вдохов/мин), 1 → 0.076 Гц (большие медленные волны)
    function waveRate(x) { return 0.1 * Math.pow(2, -0.8 * (x - 0.5)); }
    var waveL = osc(null, waveRate(P.noiseWaves), surfWave(ctx)), waveAmpD = G(0), waveFiltD = G(0);
    waveL.connect(waveAmpD); waveAmpD.connect(nAmp.gain);
    waveL.connect(waveFiltD); waveFiltD.connect(nSweep.detune);
    continuous.push(windL, waveL);

    // ---- зерно: редкие мягкие щелчки (винил / далёкий костёр)
    var grainBufs = []; for (i = 0; i < 10; i++) grainBufs.push(makeGrainBuffer(ctx));
    var grainLP = F('lowpass', 3500, 0.5), grainLevel = G(0), grainRev = G(0.25), grainPans = [];
    [-0.55, -0.2, 0.15, 0.5].forEach(function (p) { var pn = makePan(p); pn.connect(grainLP); grainPans.push(pn); });
    grainLP.connect(grainLevel); grainLevel.connect(dryBus); grainLevel.connect(grainRev); grainRev.connect(revSend);
    var grains = [], nextGrainT = t0 + 0.3;

    function grainAt(t, amp) {
      var s = ctx.createBufferSource(), g = G(amp);
      s.buffer = grainBufs[Math.floor(Math.random() * grainBufs.length)];
      s.playbackRate.value = rand(0.5, 1.8);
      s.connect(g); g.connect(grainPans[Math.floor(Math.random() * grainPans.length)]);
      var d = { nodes: [s, g], end: t + 0.1, freed: false, list: grains };
      s.onended = function () { freeVoice(d); };
      s.start(t);
      grains.push(d);
    }
    function scheduleGrain(now, horizon) {
      var x = E.noiseGrain;
      if (x <= 0.001) { nextGrainT = now; return; }       // при 0 — ничего не планируем
      var rate = 0.6 + 14 * x * x;                          // щелчков в секунду
      if (nextGrainT < now + 0.02) nextGrainT = now + 0.02 + Math.random() * 0.2;
      while (nextGrainT < horizon) {
        if (grains.length < MAX_GRAINS) {
          var amp = Math.random() < 0.05 ? rand(0.35, 0.6) : 0.35 * Math.pow(Math.random(), 2.2) + 0.03;
          grainAt(nextGrainT, amp);
          if (Math.random() < 0.25) {                       // мелкие «гроздья»
            var c = 1 + Math.floor(Math.random() * 3), tc = nextGrainT;
            for (var j = 0; j < c && grains.length < MAX_GRAINS; j++) { tc += rand(0.004, 0.03); grainAt(tc, amp * rand(0.2, 0.6)); }
          }
        }
        nextGrainT += expRand(rate);
      }
    }

    // ---- дождь: ровная ВЧ-подложка + капли
    var rainHP = F('highpass', 1100, 0.5), rainPk = F('peaking', 4200, 0.7), rainLP = F('lowpass', 5500, 0.5), rainBed = G(CAL.rainBed);
    var rainLevel = G(0), rainRev = G(0.3), dropBus = F('highpass', 900, 0.5), dropLP = F('lowpass', 4500, 0.5);
    rainPk.gain.value = -3;                       // мягче: без «присутствия» 4–6 кГц
    noiseIn.connect(rainHP); rainHP.connect(rainPk); rainPk.connect(rainLP); rainLP.connect(rainBed); rainBed.connect(rainLevel);
    dropBus.connect(dropLP); dropLP.connect(rainLevel);
    rainLevel.connect(dryBus); rainLevel.connect(rainRev); rainRev.connect(revSend);
    var dropBufs = []; for (i = 0; i < 6; i++) dropBufs.push(makeDropBuffer(ctx));
    var drops = [], nextDropT = t0 + 0.5;

    function scheduleRain(now, horizon) {
      var x = E.rainLevel;
      if (x <= 0.001) { nextDropT = now; return; }       // при 0 — ничего не планируем
      var rate = 1.5 + 38 * x * x;                    // капель в секунду
      if (nextDropT < now + 0.02) nextDropT = now + 0.02 + Math.random() * 0.1;
      while (nextDropT < horizon) {
        if (drops.length < MAX_DROPS) {
          var s = ctx.createBufferSource(), g = G(CAL.drop * Math.pow(Math.random(), 1.6)), p = makePan(rand(-0.9, 0.9));
          s.buffer = dropBufs[Math.floor(Math.random() * dropBufs.length)];
          s.playbackRate.value = rand(0.6, 1.5);
          s.connect(g); g.connect(p); p.connect(dropBus);
          var d = { nodes: [s, g, p], end: nextDropT + 0.15, freed: false, list: drops };
          (function (d) { s.onended = function () { freeVoice(d); }; })(d);
          s.start(nextDropT);
          drops.push(d);
        }
        nextDropT += expRand(rate);
      }
    }

    // ---- применение параметров к узлам
    function apply(id, tau, t) {
      t = t == null ? ctx.currentTime : t;
      var x = P[id], i, j, k;
      if (id !== 'root' && id !== 'scale' && typeof x === 'number') Etau[id] = Math.max(0.02, tau);
      switch (id) {
        case 'padLevel': glideTo(padLevel.gain, lvl(x) * CAL.pad, t, tau); break;
        case 'padBright':
          var fc = 120 * Math.pow(2, x * 6);    // 120 … 7680 Гц
          glideTo(padF1.frequency, fc, t, tau); glideTo(padF2.frequency, Math.min(fc * 1.35, 16000), t, tau); break;
        case 'padMotion':
          var dpt = x * 0.36;
          for (i = 0; i < SLOTS; i++) { glideTo(slots[i].depth.gain, dpt, t, tau); glideTo(slots[i].amp.gain, 1 - dpt, t, tau); }
          glideTo(padFDepth.gain, x * 1100, t, tau); break;
        case 'padWidth':
          var cents = 2 + x * 13, a = (1 + x) / 2, b = (1 - x) / 2;
          for (i = 0; i < SLOTS; i++) for (k = 0; k < 2; k++) {
            var sv = slots[i].subs[k];
            for (j = 0; j < 2; j++) glideTo(sv.oscs[j].detune, (j ? -cents : cents) + sv.off[j], t, tau);
            if (sv.org) glideTo(sv.org.detune, (i % 2 ? -0.35 : 0.35) * cents + sv.off[0], t, tau);
          }
          glideTo(wLL.gain, a, t, tau); glideTo(wRR.gain, a, t, tau); glideTo(wLR.gain, b, t, tau); glideTo(wRL.gain, b, t, tau); break;
        case 'padShimmer': glideTo(shimLevel.gain, lvl(x) * CAL.shimmer, t, tau); break;
        case 'subLevel': glideTo(subLevel.gain, lvl(x) * CAL.sub, t, tau); break;
        case 'notesLevel': glideTo(notesLevel.gain, lvl(x) * CAL.notes, t, tau); break;
        case 'notesDensity':
          var cand = t + 0.05 + expRand((1 / 20) * Math.pow(60, x));
          if (!phraseQ.length && cand < nextNoteT) nextNoteT = cand;     // ускорение — сразу, замедление — со следующей ноты
          break;
        case 'noiseLevel': glideTo(noiseLevel.gain, lvl(x) * CAL.noise, t, tau); break;
        case 'noiseColor':
          var wr, ww, wh, ws = 0;
          if (x <= 0.5) { var u = x * 2; wr = Math.cos(u * Math.PI / 2); ww = Math.sin(u * Math.PI / 2); wh = 0; }
          else {
            var u2 = (x - 0.5) * 2, bump = Math.sin(u2 * Math.PI);
            wr = 0; ww = Math.cos(u2 * Math.PI / 2) * (1 - 0.4 * bump); wh = Math.sin(u2 * Math.PI / 2) * (1 - 0.4 * bump); ws = bump;
            glideTo(shellBP.frequency, 650 * Math.pow(2, u2 * 1.3), t, tau);
          }
          glideTo(gRum.gain, wr * CAL.rumble, t, tau); glideTo(gWind.gain, ww * CAL.wind, t, tau); glideTo(gHiss.gain, wh * CAL.hiss, t, tau);
          glideTo(gShell.gain, ws * CAL.shell, t, tau);
          glideTo(rumLP1.frequency, 110 + 120 * x, t, tau); glideTo(rumLP2.frequency, 110 + 120 * x, t, tau);
          glideTo(windBP.frequency, 260 * Math.pow(2, x * 2.6), t, tau);           // ~260 … 1600 Гц
          glideTo(hissHP.frequency, 1100 * Math.pow(2, (x - 0.5) * 1.6), t, tau);  // 1100 … 1900 Гц: шипение мягче
          break;
        case 'noiseWaves':
          var wd = x * 0.45;
          glideTo(waveAmpD.gain, wd, t, tau); glideTo(nAmp.gain, 1 - wd, t, tau);
          glideTo(waveFiltD.gain, x * 1700, t, tau); glideTo(nSweep.detune, -x * 1700, t, tau); break;
        case 'noiseGrain': glideTo(grainLevel.gain, lvl(x) * CAL.grain, t, tau); break;
        case 'rainLevel': glideTo(rainLevel.gain, lvl(x) * CAL.rain, t, tau); break;
        case 'reverb':
          glideTo(dryBus.gain, Math.cos(x * Math.PI * 0.45), t, tau);
          glideTo(revOut.gain, Math.sin(x * Math.PI / 2) * CAL.wet, t, tau); break;
        case 'reverbSize':
          if (tau > 0.5) break;                      // долгий глайд — реверб пересчитывается в tick() по E
          if (opts.syncReverb) regenReverb(Math.max(0.6, tau * 3)); else scheduleReverb(Math.max(0.8, tau * 3));
          break;
        case 'delay':
          glideTo(notesDelay.gain, x * 0.9, t, tau); glideTo(padDelay.gain, x * 0.12, t, tau);
          glideTo(fb.gain, 0.22 + 0.38 * x, t, tau); break;
        case 'tape':
          var td = Math.pow(x, 1.4);
          // амплитуда модуляции задержки A = отклонение высоты / (2π f)
          if (x > 0) tapeEnsure(t);
          TAPE.forEach(function (w) { glideTo(w.depth.gain, td * w.dev / (2 * Math.PI * w.f), t, tau); });
          break;
        case 'warmth':
          var wet = Math.min(1, x * 1.6), drive = 1 + 2.2 * x;
          glideTo(warmClean.gain, 1 - wet, t, tau);
          glideTo(warmPre.gain, drive / WARM_K, t, tau);
          glideTo(warmWet.gain, wet / drive, t, tau);
          glideTo(warmShelf.gain, -10 * Math.pow(x, 1.2), t, tau);
          glideTo(warmSum.gain, Math.pow(10, 1.2 * x / 20), t, tau);   // компенсация громкости (срез верха + сжатие пиков)
          glideTo(warmShelf.frequency, 7000 * Math.pow(2, -1.2 * x), t, tau);
          break;
        case 'binaural':
          if (x > 0) binEnsure(t);
          glideTo(binLevel.gain, lvl(x) * CAL.bin, t, tau); break;
        case 'beatRate':
          if (bin) {
            var h = beatHz(x) / 2;
            if (bin.hs) glideTo(bin.hs.offset, h, t, tau);
            else { var c0 = mtof(binMidi(H)); glideTo(bin.oL.frequency, c0 - h, t, tau); glideTo(bin.oR.frequency, c0 + h, t, tau); }
          }
          break;
        case 'volume': glideTo(volume.gain, vol(x) * CAL.master, t, tau); break;
        case 'drift':
          var np = t + chordPeriod(x);
          if (np < nextChordT) nextChordT = np;
          break;
        case 'notesTone': case 'notesHeight': notesEQ(t, tau); break;
        // padTone, notesTone, notesPhrase, notesDecay, notesHeight — читаются из E (tick / планировщики)
      }
    }

    // смена тоники/лада: новый аккорд на тонике, суб/биения — глайдом.
    // delay > 0 — отложить (для долгого setMany: кроссфейд в середине глайда)
    function harmony(dur, t, delay) {
      t = t == null ? ctx.currentTime : t;
      if (delay > 0.3) {
        pendingHarm = { at: t + delay, dur: dur };
        nextChordT = Math.max(nextChordT, t + delay + dur);
        return;
      }
      pendingHarm = null;
      H.root = P.root; H.scale = P.scale;
      chordDeg = 0;
      applyChord(buildChord(H, 0, E.drift), t + 0.02, dur, Math.min(1.5, dur * 0.3));
      var bm = baseMidi(H);
      if (EV.on) EV.fn({ type: 'sub', t: t, midis: [bm - 12, bm] });
      glideTo(subO.frequency, mtof(bm - 12), t, dur / 4);
      glideTo(subO2.frequency, mtof(bm), t, dur / 4);
      binCarrier(t, dur / 4);
      lastDeg = null; phraseQ = [];
      nextChordT = Math.max(nextChordT, t + dur);
    }

    // пачка параметров с общим временем глайда (как setMany)
    function applyMany(ids, glideSec, harm, t) {
      t = t == null ? ctx.currentTime : t;
      var tau = Math.max(0.02, glideSec / 3);     // ≈95 % пути за glideSec
      ids.forEach(function (id) { apply(id, tau, t); });
      if (harm) {
        var dur = clamp(glideSec, 1.5, HARM_MAX);
        harmony(dur, t, Math.max(0, (glideSec - dur) / 2));
      }
    }

    // ---- аккорды и блуждание
    function chordPeriod(d) {
      d = d == null ? E.drift : d;
      if (d < 0.01) return Infinity;
      // drift 1 → ≥ 20 с, 0.4 → ~49 с, 0.1 → ~3 мин, 0.05 → ~5 мин (было 12·d^-1.5: 12 с / 47 с / 6.3 мин)
      return Math.max(20, 20 * Math.pow(d, -0.9) * rand(0.9, 1.25));
    }
    var nextChordT = t0 + chordPeriod(), nextWanderT = t0 + 2, driftDrawn = E.drift;

    function wander(t) {
      var d = E.drift;
      var pd = (Math.random() * 2 - 1) * d * 650 + W.bri.v * 7200;     // + «погода» (padBright 1 = 6 октав)
      glideTo(padF1.detune, pd, t, 3 + Math.random() * 3); glideTo(padF2.detune, pd, t, 4);
      glideTo(windBP.detune, (Math.random() * 2 - 1) * (250 + d * 900), t, 3);
      glideTo(windBP.Q, rand(0.8, 1.6 + d), t, 4);
      glideTo(shellBP.Q, rand(2.5, 5), t, 5);
      glideTo(waveL.frequency, waveRate(E.noiseWaves) * rand(0.94, 1.06), t, 6);
      glideTo(windL.frequency, rand(0.03, 0.06), t, 6);
      glideTo(grainLP.frequency, rand(3500, 8000), t, 3);
      // медленно «дышащий» баланс голосов пэда (сильнее при большом дрейфе)
      var s = slots[Math.floor(Math.random() * SLOTS)];
      glideTo(s.bal.gain, 1 + (Math.random() * 2 - 1) * 0.28 * d, t, 6 + Math.random() * 6);
      // плёнка: частоты wow чуть плавают → рисунок не повторяется
      if (tapeOn) {
        glideTo(TAPE[0].osc.frequency, TAPE[0].f * rand(0.85, 1.2), t, 8);
        glideTo(TAPE[1].osc.frequency, TAPE[1].f * rand(0.85, 1.2), t, 8);
      }
    }

    // E догоняет P (экспоненциально, со своей tau на каждый параметр)
    function stepE(dt) {
      for (var id in P) {
        var target = P[id];
        if (id === 'root' || id === 'scale' || typeof target !== 'number') continue;
        var cur = E[id];
        if (cur === target) continue;
        if (cur == null || !isFinite(cur)) { E[id] = target; continue; }
        var tau = Etau[id] || SET_TAU, nv = cur + (target - cur) * (1 - Math.exp(-dt / tau));
        E[id] = Math.abs(target - nv) < 1e-4 ? target : nv;
      }
    }

    function tick(now) {
      now = now == null ? ctx.currentTime : now;
      var dt = Math.max(0, now - lastTickT);
      lastTickT = now;
      stepE(dt);
      weatherStep(now);
      var horizon = now + LOOKAHEAD;

      if (pendingHarm && now >= pendingHarm.at) harmony(pendingHarm.dur, now);
      if (Math.abs(E.padTone - toneApplied) > 0.0005) toneUpdate(now, 0.15);

      // плотность/дрейф выросли в ходе глайда — не ждать давно запланированного события
      var rate = noteRate();
      if (!phraseQ.length && rate > rateDrawn * 1.3) {
        var cand = now + 0.05 + expRand(rate);
        if (cand < nextNoteT) nextNoteT = cand;
        rateDrawn = rate;
      }
      if (E.drift > driftDrawn + 0.08) {
        var np = now + chordPeriod();
        if (np < nextChordT) nextChordT = np;
        driftDrawn = E.drift;
      } else if (E.drift < driftDrawn) driftDrawn = E.drift;

      // смена аккорда решается за LOOKAHEAD до начала → уже запланированные ноты знают, какой аккорд будет звучать
      if (nextChordT <= horizon && !pendingHarm) {
        var tc = Math.max(now + 0.05, nextChordT);
        chordDeg = pickChordDeg(H, chordDeg);
        var dur = 5 + 7 * (1 - E.drift);            // кроссфейд 5–12 с (было 3–8 с)
        applyChord(buildChord(H, chordDeg, E.drift), tc, dur, 3);
        nextChordT = tc + chordPeriod();
      }

      scheduleNotes(now, horizon);
      scheduleRain(now, horizon);
      scheduleShimmer(now, horizon);
      scheduleGrain(now, horizon);
      if (now >= nextWanderT) { wander(now); nextWanderT = now + rand(3, 7); }

      // реверб при долгом глайде размера: пересборка не чаще раза в 4 с, финальная — когда E доехало
      if (!revTimer && revSlot) {
        var want = revSecsOf(E.reverbSize), settled = Math.abs(E.reverbSize - P.reverbSize) < 0.004;
        var rel = Math.abs(want - revSecs) / revSecs;
        if ((settled && rel > 0.01 && now - revLastT > 0.5) || (!settled && rel > 0.15 && now - revLastT > 4)) {
          regenReverb(settled ? 1.5 : 3, E.reverbSize);
        }
      }

      // органный слой пэда: создать, когда E.padTone > 0.5 (громкость морфа там с нуля → без щелчка);
      // убрать, когда E.padTone ≤ 0.5 держится 5 с (og-гейны к тому времени ≈ 0)
      if (E.padTone > 0.5 || P.padTone > 0.5) { organEnsure(now); organLowSince = -1; }
      else if (organOn) {
        if (organLowSince < 0) organLowSince = now;
        else if (now - organLowSince > 5) organRelease();
      }
      // плёнка: LFO выключаются, когда tape = 0 и глубина модуляции доехала до нуля (5 с)
      if (P.tape > 0) { tapeEnsure(now); tapeLowSince = -1; }
      else if (tapeOn) {
        if (tapeLowSince < 0) tapeLowSince = now;
        else if (now - tapeLowSince > 5 && E.tape <= 0.001) tapeRelease();
      }
      // бинауральные осцилляторы: выключить, когда слой доехал до нуля
      if (bin && P.binaural <= 0 && binLevel.gain.value < 2e-4) binRelease();   // < −74 dBFS — остановка неслышна
      else if (!bin && P.binaural > 0) binEnsure(now);

      // страховка: если onended не пришёл (напр. вкладка спала) — чистим вручную
      [live, drops, shims, grains].forEach(function (list) {
        for (var i = list.length - 1; i >= 0; i--) if (list[i].end < now - 1) freeVoice(list[i]);
      });
    }

    // плавный фейд мастер-фейдера
    function fade(target, secs, t) {
      t = t == null ? ctx.currentTime : t;
      var p = fader.gain;
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
      else { var cur = p.value; p.cancelScheduledValues(t); p.setValueAtTime(cur, t); }
      p.linearRampToValueAtTime(target, t + Math.max(0.02, secs));
    }

    // ---- таймер сна: отдельный гейн после лимитера (поэтому кривая не искажается компрессором)
    var SLEEP_FLOOR_DB = -72;
    // зафиксировать текущее значение в момент t (следующий рамп считается от t, а не от прошлого события)
    function holdParam(p, t) {
      var cur = p.value;
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t); else p.cancelScheduledValues(t);
      p.setValueAtTime(cur, t);
    }
    // равные шаги в дБ: экспоненциальный рамп амплитуды (по амплитуде — всё медленнее к концу) до −72 дБ,
    // затем короткий линейный уход в 0. Рампы, а не setValueCurve: cancelAndHold на кривой в Chrome даёт выброс.
    function sleepFade(secs, t) {
      t = t == null ? ctx.currentTime : t;
      var p = sleepG.gain, v = clamp(p.value, 0, 1), floor = Math.pow(10, SLEEP_FLOOR_DB / 20);
      secs = Math.max(0.1, secs);
      holdParam(p, t);
      sleepLow = true;
      if (v < 0.01) p.linearRampToValueAtTime(0.01, t + 0.02);   // экспоненциальный рамп не стартует с нуля
      p.exponentialRampToValueAtTime(floor, t + secs);
      p.linearRampToValueAtTime(0, t + secs + 0.05);
      return t + secs + 0.05;
    }
    function sleepHold(t) { holdParam(sleepG.gain, t == null ? ctx.currentTime : t); }
    function sleepRestore(secs, t) {
      if (!sleepLow) return;
      t = t == null ? ctx.currentTime : t;
      // тоже равными шагами в дБ: от max(текущего, −40 дБ) к 0 дБ (экспоненциальный рамп не стартует с нуля)
      var p = sleepG.gain, v = clamp(p.value, 0, 1);
      holdParam(p, t);
      p.linearRampToValueAtTime(Math.max(v, 0.01), t + 0.02);
      p.exponentialRampToValueAtTime(1, t + Math.max(0.1, secs));
      sleepLow = false;
    }
    function sleepReset(t) {
      t = t == null ? ctx.currentTime : t;
      sleepG.gain.cancelScheduledValues(0); sleepG.gain.setValueAtTime(1, t);
      sleepLow = false;
    }

    // убрать все запланированные ноты/капли/голоса (перед suspend)
    function killTransients() {
      [live, drops, shims, grains].forEach(function (list) {
        while (list.length) { var v = list[list.length - 1]; v.nodes.forEach(function (n) { if (n.stop) safeStop(n, 0); }); freeVoice(v); }
      });
      phraseQ = [];
    }
    function resetSchedule(now) {
      nextNoteT = now + 0.5 + Math.random();
      nextDropT = now + 0.3;
      nextGrainT = now + 0.2;
      nextShimT = now + rand(1, 4);
      phraseQ = [];
      lastTickT = now;
    }

    // ---- инициализация: значения без глайда, запуск источников
    ['padLevel', 'padBright', 'padMotion', 'padWidth', 'padShimmer', 'subLevel', 'notesLevel', 'noiseLevel', 'noiseColor',
     'noiseWaves', 'noiseGrain', 'rainLevel', 'reverb', 'delay', 'tape', 'warmth', 'binaural', 'volume'].forEach(function (id) { apply(id, 0.005, t0); });
    for (k0 in Etau) delete Etau[k0];
    notesEQ(t0, 0.005);
    if (P.padTone > 0.5) organEnsure(t0);
    toneUpdate(t0, 0.005);
    regenReverb(0.05);
    continuous.forEach(function (o) { o.start(t0); });
    nSrc.forEach(function (s) { s.start(t0, Math.random() * 9); });

    return {
      analyser: analyser,
      apply: apply,
      applyMany: applyMany,
      harmony: harmony,
      tick: tick,
      fade: fade,
      sleepFade: sleepFade, sleepHold: sleepHold, sleepRestore: sleepRestore, sleepReset: sleepReset,
      killTransients: killTransients,
      resetSchedule: resetSchedule,
      regenReverb: regenReverb,
      chord: function () { return chord.slice(); },
      sub: function () { var bm = baseMidi(H); return [bm - 12, bm]; },
      stats: function () {
        var e = {}; for (var k in E) e[k] = E[k];
        return { notes: live.length, drops: drops.length, shims: shims.length, grains: grains.length, bin: !!bin, organ: organOn, tapeLfo: tapeOn,
                 chord: chord.slice(), reverbSecs: revSecs, eff: e, harm: { root: H.root, scale: H.scale, pending: !!pendingHarm },
                 weather: { den: W.den.v, bri: W.bri.v, next: W.next }, sleepGain: sleepG.gain.value, sub2: subO2g.gain.value,
                 noteLog: noteLog.slice(), chordT: chordT };
      }
    };
  }

  // ---------------------------------------------------------------- публичный API

  var params = {}, meta = {};
  SCHEMA.params.forEach(function (p) { params[p.id] = p.def; meta[p.id] = p; });

  function coerce(id, v) {
    var m = meta[id];
    if (!m) return null;
    v = Number(v);
    if (!isFinite(v)) return null;
    if (m.type === 'select') return clamp(Math.round(v), 0, (m.options ? m.options.length : 1) - 1);
    return clamp(v, 0, 1);
  }

  var ctx = null, core = null, timer = null, running = false, stopToken = 0;

  // ---- события для визуализации: onEvent(fn) / offEvent(fn).
  // Слушатель получает { type: 'chord' | 'note' | 'sub', t, … } в момент планирования (до LOOKAHEAD раньше t).
  // Ошибка слушателя не доходит до планировщика; без слушателей объекты событий не создаются.
  var listeners = [], EVT = { on: false, fn: dispatch };
  function dispatch(ev) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](ev); } catch (e) { if (window.console) console.error(e); }
    }
  }
  var sleep = null;   // идущий fadeOut: { end, resolve, timer }

  function ensureContext() {
    if (ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Web Audio API is not supported');
    try { ctx = new AC({ latencyHint: 'playback' }); } catch (e) { ctx = new AC(); }
    core = createCore(ctx, params, { events: EVT });
    Ambient.analyser = core.analyser;
    // мобильные браузеры могут приостановить контекст (звонок, блокировка) — пытаемся вернуть
    document.addEventListener('visibilitychange', function () {
      if (running && ctx.state !== 'running' && !document.hidden) ctx.resume().catch(function () {});
    });
  }

  function startTimer() {
    if (timer) return;
    timer = setInterval(function () {
      try { core.tick(); } catch (e) { console.error(e); }
      if (sleep && ctx.currentTime >= sleep.end) sleepDone();   // страховка, если setTimeout заморожен
    }, TICK_MS);
  }

  // остановка: фейд фейдера → убрать таймер и ноты → suspend; гейн сна возвращается в 1 (неслышно: фейдер на 0)
  function doStop(fadeSec) {
    running = false;
    var token = ++stopToken;
    core.fade(0, fadeSec);
    return new Promise(function (res) { setTimeout(res, fadeSec * 1000 + 80); }).then(function () {
      if (token !== stopToken) return;            // start() вызван во время фейда
      if (timer) { clearInterval(timer); timer = null; }
      core.killTransients();
      return ctx.suspend().then(function () { if (token === stopToken) core.sleepReset(); });
    }).then(function () {}, function () {});
  }
  // снять идущий fadeOut (его промис разрешается false)
  function sleepCancel() {
    if (!sleep) return null;
    var s = sleep; sleep = null;
    clearTimeout(s.timer);
    s.resolve(false);
    return s;
  }
  function sleepCheck() {
    if (!sleep) return;
    var left = sleep.end - ctx.currentTime;
    if (left > 0.02) { clearTimeout(sleep.timer); sleep.timer = setTimeout(sleepCheck, left * 1000 + 50); return; }
    sleepDone();
  }
  function sleepDone() {
    var s = sleep; sleep = null;
    clearTimeout(s.timer);
    if (!running) { s.resolve(false); return; }
    doStop(0.05).then(function () { s.resolve(!running); });
  }

  var Ambient = {
    analyser: null,

    start: function () {
      try { ensureContext(); } catch (e) { return Promise.reject(e); }
      stopToken++;                                  // отменяет незавершённый stop()
      var wasRunning = running;
      running = true;
      sleepCancel();
      core.sleepRestore(2);                         // после fadeOut / во время него — обратно к 1 за ~2 с
      var p = ctx.state === 'running' ? Promise.resolve() : ctx.resume();
      return Promise.resolve(p).then(function () {
        if (!running) return;
        if (!timer) core.resetSchedule(ctx.currentTime);
        core.fade(1, wasRunning ? 0.5 : 2);
        startTimer();
        core.tick();
        if (EVT.on) {
          var ch = core.chord(), now = ctx.currentTime;
          dispatch({ type: 'chord', t: now, midis: ch, fade: 0, initial: true });
          dispatch({ type: 'sub', t: now, midis: core.sub(), initial: true });
        }
      });
    },

    stop: function (fadeSec) {
      fadeSec = fadeSec == null ? 1.5 : Math.max(0, Number(fadeSec) || 0);
      if (!ctx || !running) return Promise.resolve();
      if (sleepCancel()) core.sleepHold();          // fadeOut прерван: гейн сна держим где есть, дальше обычный фейд
      return doStop(fadeSec);
    },

    // таймер сна: плавно (равными шагами в дБ) увести звук в тишину за sec секунд, затем как stop().
    // Промис → true, если дошло до остановки; false, если отменено (start / stop / cancelFade / новый fadeOut).
    fadeOut: function (sec) {
      sec = Number(sec);
      sec = isFinite(sec) ? clamp(sec, 0.1, 6 * 3600) : 0.1;
      if (!ctx || !running) return Promise.resolve(false);
      sleepCancel();                                // новый fadeOut продолжает с текущего уровня
      return new Promise(function (res) {
        var end = core.sleepFade(sec);
        sleep = { end: end, resolve: res, timer: 0 };
        sleep.timer = setTimeout(sleepCheck, sec * 1000 + 50);
      });
    },

    // отменить fadeOut: звук возвращается к прежнему уровню за ~2 с
    cancelFade: function () {
      if (!sleepCancel()) return;
      core.sleepRestore(2);
    },

    // ручное изменение: побеждает идущий долгий глайд этого параметра сразу
    set: function (id, value) {
      var v = coerce(id, value);
      if (v === null) return;
      var prev = params[id];
      params[id] = v;
      if (!core || prev === v) return;
      if (id === 'root' || id === 'scale') core.harmony(2.5);
      else core.apply(id, SET_TAU);
    },

    // glideSec 0…120: каждый параметр плавно едет к цели; глайды разных вызовов не мешают друг другу
    setMany: function (obj, glideSec) {
      if (!obj || typeof obj !== 'object') return;
      glideSec = glideSec == null ? 0.3 : Math.max(0, Number(glideSec) || 0);
      var changed = [], harm = false;
      Object.keys(obj).forEach(function (id) {
        var v = coerce(id, obj[id]);
        if (v === null || params[id] === v) return;
        params[id] = v;
        if (id === 'root' || id === 'scale') harm = true; else changed.push(id);
      });
      if (!core) return;
      core.applyMany(changed, glideSec, harm);
    },

    get: function (id) { return params[id]; },
    getAll: function () { var o = {}; for (var k in params) o[k] = params[k]; return o; },

    // события планировщика (см. dispatch): аккорды, ноты, суб
    onEvent: function (fn) {
      if (typeof fn !== 'function' || listeners.indexOf(fn) >= 0) return;
      listeners.push(fn);
      EVT.on = true;
    },
    offEvent: function (fn) {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
      EVT.on = listeners.length > 0;
    },
    // время AudioContext (0 до первого запуска) и текущий аккорд пэда (midi)
    now: function () { return ctx ? ctx.currentTime : 0; },
    chord: function () { return core ? core.chord() : []; }
  };

  Object.defineProperty(Ambient, 'running', { get: function () { return running; }, enumerable: true });
  Object.defineProperty(Ambient, 'fading', { get: function () { return !!sleep; }, enumerable: true });
  // тестовый хук (не часть UI-API): построить граф на произвольном контексте, напр. OfflineAudioContext
  Object.defineProperty(Ambient, '_createCore', { value: createCore, enumerable: false });

  window.Ambient = Ambient;
})();
