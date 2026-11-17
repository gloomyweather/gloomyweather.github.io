/* stage.js — ascii-сцена orpheus: поле за страницей, «герой» в #stage, дыхание, ночник, заставка.
   Classic script, без модулей и библиотек. Определяет window.OrpheusStage и монтируется сам (идемпотентно).
   Только читает window.Ambient (onEvent / now / chord / analyser / running / getAll) и события UI
   (orpheus:preset / orpheus:transport / orpheus:sleepfade). Никогда не меняет звук.

   Устройство:
     1. утилиты, шум, глифы, тоны (цвета только из css-токенов)
     2. Grid — сетка символов на canvas: атлас глифов, перерисовка только изменившихся ячеек
     3. звук: уровень (rms анализатора, сглаженный), очередь событий движка (ждём now() ≥ t)
     4. поле — фиксированный canvas за интерфейсом (z 0): редкие точки, дыхание, круги от нот, волна аккорда
     5. герой — лира / река / пейзаж (+ кольцо дыхания), переключатель режимов
     6. ночник (z 50) и заставка (z 40)
     7. общий цикл rAF (≤ 30 к/с, пауза в фоне и при открытом AmbientViz), монтирование
*/
(function () {
  'use strict';
  if (window.OrpheusStage) return;

  var TAU = Math.PI * 2;
  var MONO = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
  var LS_KEY = 'orpheus.stage';

  // ================================================================ 1. утилиты

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, u) { return a + (b - a) * u; }
  function sstep(u) { u = clamp01(u); return u * u * (3 - 2 * u); }
  function smooth(a, b, v) { return sstep((v - a) / (b - a)); }
  function follow(cur, target, dt, tauUp, tauDown) {
    var tau = target > cur ? tauUp : (tauDown == null ? tauUp : tauDown);
    return cur + (target - cur) * (1 - Math.exp(-dt / tau));
  }
  function hash(n) {
    n = (n ^ 61) ^ (n >>> 16); n = (n + (n << 3)) | 0; n ^= n >>> 4;
    n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15;
    return (n >>> 0) / 4294967296;
  }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function wall() { return performance.now() / 1000; }

  // simplex 2d
  var perm = new Uint8Array(512), pm12 = new Uint8Array(512);
  (function () {
    var p = new Uint8Array(256), i, j, t;
    for (i = 0; i < 256; i++) p[i] = i;
    for (i = 255; i > 0; i--) { j = (Math.random() * (i + 1)) | 0; t = p[i]; p[i] = p[j]; p[j] = t; }
    for (i = 0; i < 512; i++) { perm[i] = p[i & 255]; pm12[i] = perm[i] % 12; }
  })();
  var GX = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0], GY = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1];
  var F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  function noise2(xin, yin) {
    var s = (xin + yin) * F2, i = Math.floor(xin + s), j = Math.floor(yin + s), t = (i + j) * G2;
    var x0 = xin - (i - t), y0 = yin - (j - t), i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    var x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    var ii = i & 255, jj = j & 255, n = 0, g, tt;
    tt = 0.5 - x0 * x0 - y0 * y0;
    if (tt > 0) { g = pm12[ii + perm[jj]]; tt *= tt; n += tt * tt * (GX[g] * x0 + GY[g] * y0); }
    tt = 0.5 - x1 * x1 - y1 * y1;
    if (tt > 0) { g = pm12[ii + i1 + perm[jj + j1]]; tt *= tt; n += tt * tt * (GX[g] * x1 + GY[g] * y1); }
    tt = 0.5 - x2 * x2 - y2 * y2;
    if (tt > 0) { g = pm12[ii + 1 + perm[jj + 1]]; tt *= tt; n += tt * tt * (GX[g] * x2 + GY[g] * y2); }
    return 70 * n;
  }
  function fbm(x, y, oct) {
    var s = 0, a = 0.5, n = 0;
    for (var o = 0; o < oct; o++) { s += a * noise2(x, y); n += a; x = x * 2.03 + 17.1; y = y * 2.03 - 9.7; a *= 0.5; }
    return s / n;
  }

  var NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
  function noteName(m) { m = Math.round(m); return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }

  // ================================================================ глифы

  var CHARS = ' .·:-=+*#%@,\'`~^_|/\\()<>oO°•∙x─│╱╲┼═║┃╎¦≈∗╭╮╰╯┌┐└┘├┤┬┴▁▂▃▄▅▆▇█░▒▓▲△∧∩▪▫◦v' +
    'abcdefghijklmnopqrstuvwxyz0123456789−';
  var GL = [];
  (function () { var seen = {}; for (var i = 0; i < CHARS.length; i++) { var c = CHARS[i]; if (!seen[c]) { seen[c] = 1; GL.push(c); } } })();
  var NGF = GL.length;
  // рисованные глифы: 8 горизонтальных штрихов по высоте ячейки (струны), 8 точек по высоте, колок, косая волна
  var STR0 = NGF, DOT0 = NGF + 8, PEG = NGF + 16, NG = NGF + 17;
  function gi(c) { var k = GL.indexOf(c); return k < 0 ? 0 : k; }
  var GH = {};
  (function () {
    var names = { sp: ' ', dot: '.', mid: '·', colon: ':', dash: '-', eq: '=', plus: '+', star: '*', hash: '#', pct: '%', at: '@',
      comma: ',', apos: '\'', tick: '`', tilde: '~', caret: '^', under: '_', bar: '|', slash: '/', bslash: '\\', lp: '(', rp: ')',
      lt: '<', gt: '>', o: 'o', O: 'O', deg: '°', bullet: '•', bdot: '∙', x: 'x', h: '─', v: '│', d1: '╱', d2: '╲', cross: '┼',
      hh: '═', vv: '║', vb: '┃', vd: '╎', brk: '¦', approx: '≈', ast: '∗', cTL: '╭', cTR: '╮', cBL: '╰', cBR: '╯',
      sTL: '┌', sTR: '┐', sBL: '└', sBR: '┘', tL: '├', tR: '┤', tT: '┬', tB: '┴',
      b1: '▁', b2: '▂', b3: '▃', b4: '▄', b5: '▅', b6: '▆', b7: '▇', b8: '█', sh1: '░', sh2: '▒', sh3: '▓',
      tri: '▲', trio: '△', wedge: '∧', arch: '∩', sq: '▪', sqo: '▫', ring: '◦', vee: 'v' };
    for (var k in names) GH[k] = gi(names[k]);
  })();
  var RAMP = [' ', '.', '·', ':', '-', '=', '+', '*', '#', '%', '@'].map(gi);
  var BLOCKS = [GH.sp, GH.b1, GH.b2, GH.b3, GH.b4, GH.b5, GH.b6, GH.b7, GH.b8];

  // ================================================================ тоны (цвета из токенов)

  // 1..8 — от фона через --muted к --fg; 9..11 — акцент; 12..17 — очень тихие тоны поля (от --line)
  var NT = 18, ACC1 = 9, ACC2 = 10, ACC3 = 11;
  var F1 = 12, F2t = 13, F3 = 14, F4 = 15, FA1 = 16, FA2 = 17;
  var TONE_U = [0, 0.22, 0.4, 0.58, 0.78, 1.0, 1.28, 1.6, 2.0];
  var colors = { bg: [255, 255, 255], fg: [12, 13, 15], muted: [100, 106, 115], line: [225, 228, 232], accent: [21, 88, 240], dark: false };
  var toneRGB = [];
  function parseColor(str, fallback) {
    var c = parseColor.c || (parseColor.c = document.createElement('canvas').getContext('2d'));
    c.fillStyle = '#010203';
    try { c.fillStyle = (str || '').trim() || fallback; } catch (e) {}
    var v = c.fillStyle;
    if (v === '#010203') { c.fillStyle = fallback; v = c.fillStyle; }
    if (v[0] === '#') return [parseInt(v.substr(1, 2), 16), parseInt(v.substr(3, 2), 16), parseInt(v.substr(5, 2), 16)];
    var m = v.match(/[\d.]+/g);
    return m ? [+m[0], +m[1], +m[2]] : [0, 0, 0];
  }
  function mix(a, b, f) { return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; }
  function rgb(c) { return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')'; }
  function lum(c) { return (c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11) / 255; }
  function readTheme() {
    var cs = getComputedStyle(document.documentElement);
    colors.bg = parseColor(cs.getPropertyValue('--bg'), '#ffffff');
    colors.fg = parseColor(cs.getPropertyValue('--fg'), '#0c0d0f');
    colors.muted = parseColor(cs.getPropertyValue('--muted'), '#646a73');
    colors.line = parseColor(cs.getPropertyValue('--line'), '#e1e4e8');
    colors.accent = parseColor(cs.getPropertyValue('--accent'), '#1558f0');
    colors.dark = lum(colors.bg) < 0.5;
    var bg = colors.bg, mu = colors.muted, fg = colors.fg, ln = colors.line, ac = colors.accent, dk = colors.dark;
    toneRGB = [bg];
    for (var t = 1; t <= 8; t++) {
      var u = TONE_U[t];
      if (!dk) u = 2 * Math.pow(u / 2, 1.18);
      toneRGB[t] = u <= 1 ? mix(bg, mu, u) : mix(mu, fg, u - 1);
    }
    toneRGB[ACC1] = mix(bg, ac, 0.45); toneRGB[ACC2] = mix(bg, ac, 0.72); toneRGB[ACC3] = ac;
    // поле: светлая тема — от --line к --muted; тёмная — то же, но --line там почти фон, поэтому шаг крупнее
    var lnA = dk ? mix(bg, mu, 0.16) : ln, lnB = dk ? mix(bg, mu, 0.27) : mix(ln, mu, 0.16);
    toneRGB[F1] = mix(bg, lnA, dk ? 0.75 : 0.85);
    toneRGB[F2t] = lnA;
    toneRGB[F3] = lnB;
    toneRGB[F4] = dk ? mix(bg, mu, 0.4) : mix(ln, mu, 0.36);
    toneRGB[FA1] = dk ? mix(bg, ac, 0.3) : mix(ln, ac, 0.28);
    toneRGB[FA2] = dk ? mix(bg, ac, 0.5) : mix(ln, ac, 0.5);
    nightColor = rgb(lum(bg) < lum(fg) ? bg : fg);
    themeGen++;
  }
  var themeGen = 0, nightColor = '#000';

  // ================================================================ 2. сетка символов

  function Grid(cv, opaque) {
    this.cv = cv; this.opaque = opaque; this.ctx = null;
    this.cols = 0; this.rows = 0; this.n = 0; this.cw = 0; this.ch = 0; this.ox = 0; this.oy = 0;
    this.W = 0; this.H = 0; this.dpr = 1; this.font = 0; this.asp = 2; this.cssW = 0; this.cssH = 0;
    this.g = null; this.t = null; this.prev = null; this.hash = null;
    this.atlas = null; this.acols = 1; this.gen = -1; this.full = true;
  }
  // cell — ширина ячейки в css-px, ratio — высота / ширина
  Grid.prototype.layout = function (wCss, hCss, cell, ratio) {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var cw = Math.max(4, Math.round(cell * dpr)), ch = Math.round(cw * ratio);
    var W = Math.max(1, Math.round(wCss * dpr)), H = Math.max(1, Math.round(hCss * dpr));
    var cols = Math.max(1, Math.floor(W / cw)), rows = Math.max(1, Math.floor(H / ch));
    var same = cols === this.cols && rows === this.rows && cw === this.cw && ch === this.ch && W === this.W && H === this.H;
    this.cssW = wCss; this.cssH = hCss;
    if (same) return false;
    this.cv.width = W; this.cv.height = H;
    this.W = W; this.H = H; this.dpr = dpr; this.cw = cw; this.ch = ch; this.cols = cols; this.rows = rows; this.n = cols * rows;
    this.asp = ch / cw; this.font = Math.round(cw / 0.6 * 0.98);
    this.ox = Math.floor((W - cols * cw) / 2); this.oy = Math.floor((H - rows * ch) / 2);
    this.g = new Uint16Array(this.n); this.t = new Uint8Array(this.n); this.prev = new Int32Array(this.n);
    this.hash = new Float32Array(this.n);
    var seed = (Math.random() * 1e9) | 0;
    for (var i = 0; i < this.n; i++) this.hash[i] = hash(i * 2654435761 + seed);
    this.ctx = this.cv.getContext('2d', { alpha: !this.opaque });
    this.ctx.imageSmoothingEnabled = false;
    this.gen = -1;
    return true;
  };
  Grid.prototype.buildAtlas = function () {
    var cw = this.cw, ch = this.ch, total = NT * NG;
    this.acols = Math.max(1, Math.min(total, Math.floor(4096 / cw)));
    var arows = Math.ceil(total / this.acols);
    if (!this.atlas) this.atlas = document.createElement('canvas');
    var a = this.atlas;
    a.width = this.acols * cw; a.height = arows * ch;
    var c = a.getContext('2d');
    c.clearRect(0, 0, a.width, a.height);
    if (this.opaque) { c.fillStyle = rgb(colors.bg); c.fillRect(0, 0, a.width, a.height); }
    c.font = '400 ' + this.font + 'px ' + MONO;
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    var capH = c.measureText('H').actualBoundingBoxAscent || this.font * 0.73;
    var base = Math.round(ch / 2 + capH / 2);
    var lw = Math.max(1, Math.round(this.dpr * 1.1)), dr = Math.max(0.8, cw * 0.12);
    for (var t = 1; t < NT; t++) {
      c.fillStyle = rgb(toneRGB[t]); c.strokeStyle = c.fillStyle;
      for (var g = 1; g < NG; g++) {
        var k = t * NG + g, sx = (k % this.acols) * cw, sy = ((k / this.acols) | 0) * ch;
        if (g < NGF) {
          c.save(); c.beginPath(); c.rect(sx, sy, cw, ch); c.clip();
          c.fillText(GL[g], sx + cw / 2, sy + base);
          c.restore();
        } else if (g < DOT0) {
          var lv = g - STR0, y = sy + Math.round((lv + 0.5) * ch / 8 - lw / 2);
          c.fillRect(sx, y, cw, lw);
        } else if (g < PEG) {
          var lv2 = g - DOT0, py = sy + (lv2 + 0.5) * ch / 8;
          c.beginPath(); c.arc(sx + cw / 2, py, dr, 0, TAU); c.fill();
        } else {
          c.lineWidth = Math.max(1, this.dpr * 0.9);
          c.beginPath(); c.arc(sx + cw / 2, sy + ch / 2, cw * 0.28, 0, TAU); c.stroke();
        }
      }
    }
    this.gen = themeGen; this.full = true;
  };
  Grid.prototype.clear = function () { this.t.fill(0); };
  Grid.prototype.draw = function () {
    if (this.gen !== themeGen || !this.atlas) this.buildAtlas();
    var c = this.ctx, n = this.n, cols = this.cols, cw = this.cw, ch = this.ch, ox = this.ox, oy = this.oy, ac = this.acols;
    var g = this.g, t = this.t, pk = this.prev, at = this.atlas, op = this.opaque, changed = 0;
    if (this.full) {
      if (op) { c.fillStyle = rgb(colors.bg); c.fillRect(0, 0, this.W, this.H); } else c.clearRect(0, 0, this.W, this.H);
      pk.fill(0); this.full = false;
    }
    var x = 0, y = 0;
    for (var i = 0; i < n; i++) {
      var tt = t[i], k = tt ? tt * NG + g[i] : 0;
      if (k !== pk[i]) {
        pk[i] = k; changed++;
        var dx = ox + x * cw, dy = oy + y * ch;
        if (op) c.drawImage(at, (k % ac) * cw, ((k / ac) | 0) * ch, cw, ch, dx, dy, cw, ch);
        else { c.clearRect(dx, dy, cw, ch); if (k) c.drawImage(at, (k % ac) * cw, ((k / ac) | 0) * ch, cw, ch, dx, dy, cw, ch); }
      }
      if (++x === cols) { x = 0; y++; }
    }
    return changed;
  };

  // буфер сцены
  function Buf(cols, rows) { this.cols = cols; this.rows = rows; this.n = cols * rows; this.g = new Uint16Array(this.n); this.t = new Uint8Array(this.n); }
  Buf.prototype.clear = function () { this.t.fill(0); };
  Buf.prototype.put = function (x, y, g, t) {
    x = x | 0; y = y | 0;
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows || t <= 0) return;
    var i = y * this.cols + x; this.g[i] = g; this.t[i] = t;
  };
  // запись только если ярче того, что уже есть
  Buf.prototype.max = function (x, y, g, t) {
    x = x | 0; y = y | 0;
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows || t <= 0) return;
    var i = y * this.cols + x, cur = this.t[i];
    if (!cur || rank(t) >= rank(cur)) { this.g[i] = g; this.t[i] = t; }
  };
  Buf.prototype.text = function (x, y, s, t) { for (var k = 0; k < s.length; k++) this.put(x + k, y, gi(s[k]), t); };
  function rank(t) { return t >= ACC1 && t <= ACC3 ? 5 + (t - ACC1) * 2 : t; }

  // ================================================================ 3. звук и события

  var AU = { level: 0, slow: 0, raw: 0, active: 0, playing: false, wave: 0 };
  var tdBuf = null;
  function readLevel(dt) {
    var amb = window.Ambient, an = amb && amb.analyser, lv = 0, live = false;
    try { live = !!(an && amb.running); } catch (e) { live = false; }
    if (live) {
      try {
        if (!tdBuf || tdBuf.length !== an.fftSize) tdBuf = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(tdBuf);
        var s = 0; for (var i = 0; i < tdBuf.length; i += 2) s += tdBuf[i] * tdBuf[i];
        var rms = Math.sqrt(s / (tdBuf.length / 2));
        lv = clamp01((20 * Math.log10(rms + 1e-9) + 52) / 36);       // −52 … −16 dBFS → 0 … 1
      } catch (e) { live = false; }
    }
    AU.raw = lv;
    AU.active = follow(AU.active, live ? 1 : 0, dt, 1.2, 2.5);
    AU.level = follow(AU.level, lv, dt, 0.8, 2.0);
    AU.slow = follow(AU.slow, lv, dt, 3.0, 5.0);
    AU.playing = live;
  }

  var P = {};           // параметры звука (сглаженные), читаются раз в 0.5 с
  var Ptarget = {}, pClock = 0;
  function readParams(dt) {
    pClock -= dt;
    if (pClock <= 0) {
      pClock = 0.5;
      var amb = window.Ambient;
      if (amb && typeof amb.getAll === 'function') {
        try { var p = amb.getAll(); for (var k in p) if (typeof p[k] === 'number') Ptarget[k] = p[k]; } catch (e) {}
      }
      if (!presetSeen) guessPreset();
    }
    for (var id in Ptarget) {
      if (P[id] == null || id === 'root' || id === 'scale') P[id] = Ptarget[id];
      else P[id] = follow(P[id], Ptarget[id], dt, 1.5);
    }
  }
  function pv(id, d) { var v = P[id]; return typeof v === 'number' && isFinite(v) ? v : d; }

  // текущий пресет: из события orpheus:preset, а до первого события — угадываем по значениям
  var preset = { id: null, name: '' }, presetSeen = false;
  function guessPreset() {
    var list = window.AMBIENT_PRESETS;
    if (!list || !list.length) return;
    var found = null;
    for (var i = 0; i < list.length && !found; i++) {
      var v = list[i].values, ok = true;
      for (var k in v) if (k !== 'volume' && Ptarget[k] != null && Math.abs(Ptarget[k] - v[k]) > 1e-6) { ok = false; break; }
      if (ok) found = list[i];
    }
    var id = found ? found.id : null;
    if (id !== preset.id) setPreset(id, found ? found.name : '');
  }

  // очередь событий движка: приходят заранее (до 2 с), применяем, когда now() ≥ t
  var queue = [], MAXQ = 400;
  function onEngineEvent(ev) {
    if (!ev || !ev.type) return;
    if (queue.length >= MAXQ) queue.shift();
    var e = { type: ev.type, t: +ev.t || 0, midis: ev.midis ? ev.midis.slice() : null, midi: ev.midi, vel: ev.vel, decay: ev.decay, fade: ev.fade, tone: ev.tone };
    var i = queue.length;
    while (i > 0 && queue[i - 1].t > e.t) i--;
    queue.splice(i, 0, e);
  }
  function audioNow() { try { return window.Ambient && window.Ambient.now ? window.Ambient.now() : 0; } catch (e) { return 0; } }
  function drainQueue() {
    if (!queue.length) return;
    var now = audioNow(), w = wall();
    while (queue.length && queue[0].t <= now) {
      var e = queue.shift();
      var late = Math.max(0, now - e.t);
      if (late > 4) continue;                 // слишком старое (вкладка спала) — пропускаем
      var wt = w - late;
      if (e.type === 'chord') onChord(e.midis, e.fade || 0, wt);
      else if (e.type === 'note') onNote(e.midi, e.vel == null ? 0.7 : e.vel, e.decay || 1, wt);
    }
  }
  // когда звук остановлен, now() стоит — запланированное «наперёд» уже не прозвучит
  function dropQueueIfStopped() { if (!AU.playing && queue.length) queue.length = 0; }

  // гармония: аккорд пэда (midi) и диапазон высот для героя
  var harm = { chord: [], hasChord: false };
  function fallbackChord() {
    var root = pv('root', 2) | 0, b = 38 + ((root - 2 + 12) % 12);
    return [b, b + 7, b + 12, b + 19, b + 24];
  }
  function currentChord() {
    if (harm.hasChord) return harm.chord;
    var c = [];
    try { c = window.Ambient && window.Ambient.chord ? window.Ambient.chord() : []; } catch (e) { c = []; }
    if (c && c.length) { harm.chord = uniqSorted(c); harm.hasChord = true; return harm.chord; }
    return fallbackChord();
  }
  function uniqSorted(a) {
    var s = a.slice().map(Math.round).sort(function (x, y) { return x - y; }), out = [];
    for (var i = 0; i < s.length; i++) if (!out.length || out[out.length - 1] !== s[i]) out.push(s[i]);
    return out;
  }
  function onChord(midis, fade, wt) {
    if (!midis || !midis.length) return;
    var c = uniqSorted(midis);
    harm.chord = c; harm.hasChord = true;
    Lyre.setChord(c, fade, wt);
    River.chord(c, fade);
    if (fade > 0) Field.wave(fade, wt);
  }
  function onNote(midi, vel, decay, wt) {
    recentNotes.push({ m: midi, w: wt });
    if (recentNotes.length > 40) recentNotes.shift();
    Lyre.pluck(midi, vel, decay, wt);
    River.note(midi, vel, decay);
    Field.ripple(midi, vel, decay, wt);
    Land.note(midi, vel);
  }
  var recentNotes = [];

  // диапазон высот (общий для лиры и реки): медленно следует за аккордом и недавними нотами
  // аккорд занимает основную высоту, ноты выше/ниже сжимаются в поля сверху/снизу
  var PR = { lo: 36, hi: 66 };
  function stepRange(dt) {
    var c = currentChord(), lo = c[0] - 2, hi = c[c.length - 1] + 2;
    if (hi - lo < 24) { var mid = (hi + lo) / 2; lo = mid - 12; hi = mid + 12; }
    PR.lo = follow(PR.lo, lo, dt, 4); PR.hi = follow(PR.hi, hi, dt, 4);
  }
  // midi → строка (float): [top, bot] — поле для нот выше аккорда, [top + mt, bot] — сам аккорд
  function pitchRow(m, top, bot) {
    var mt = Math.min(1.8, (bot - top) * 0.16), a = top + mt;
    if (m >= PR.hi) return a - mt * (1 - Math.exp(-(m - PR.hi) / 10));
    if (m <= PR.lo) return bot + 0.6 * (1 - Math.exp(-(PR.lo - m) / 8));
    return bot - (m - PR.lo) / (PR.hi - PR.lo) * (bot - a);
  }

  // ================================================================ 4. поле

  var Field = {
    cv: null, grid: null, cell: 11, ratio: 2,
    site: null, px: null, py: null, mask: null, maskDirty: true,
    ripples: [], waves: [], T: Math.random() * 100, B: 0.25,
    lastDraw: 0,
    init: function () {
      var cv = document.createElement('canvas');
      cv.className = 'stg-field'; cv.setAttribute('aria-hidden', 'true');
      document.body.insertBefore(cv, document.body.firstChild);
      this.cv = cv; this.grid = new Grid(cv, false);
    },
    layout: function () {
      var vw = window.innerWidth || document.documentElement.clientWidth, vh = window.innerHeight || document.documentElement.clientHeight;
      var small = vw < 720;
      this.cell = small ? 10 : 11;
      var G = this.grid;
      if (G.layout(vw, vh, this.cell, 2.0) || !this.site) {
        var n = G.n;
        this.site = new Float32Array(n); this.px = new Float32Array(n); this.py = new Float32Array(n); this.mask = new Float32Array(n);
        for (var i = 0; i < n; i++) {
          var x = i % G.cols, y = (i / G.cols) | 0;
          this.px[i] = (G.ox + (x + 0.5) * G.cw) / G.dpr; this.py[i] = (G.oy + (y + 0.5) * G.ch) / G.dpr;
          this.site[i] = G.hash[i];
        }
      }
      this.cv.style.width = vw + 'px'; this.cv.style.height = vh + 'px';
      this.maskDirty = true;
    },
    // плотность поля: под колонкой интерфейса — тише, под героем — пусто
    computeMask: function () {
      var G = this.grid, n = G.n, m = this.mask, col = null, st = null;
      var app = document.getElementById('app') || document.querySelector('.wrap');
      if (app) {
        var r = app.getBoundingClientRect(), cs = getComputedStyle(app);
        col = { l: r.left + (parseFloat(cs.paddingLeft) || 0), r: r.right - (parseFloat(cs.paddingRight) || 0) };
      }
      if (Hero.el) { var s = Hero.el.getBoundingClientRect(); if (s.height > 0) st = s; }
      for (var i = 0; i < n; i++) {
        var x = this.px[i], y = this.py[i], v = 1;
        if (col) {
          var d = Math.max(col.l - x, x - col.r);          // < 0 внутри колонки
          v = lerp(0.42, 1, smooth(-90, 40, d));
        }
        if (st) {
          var dx = Math.max(st.left - x, x - st.right, 0), dy = Math.max(st.top - y, y - st.bottom, 0);
          var dd = Math.sqrt(dx * dx + dy * dy);
          v *= smooth(4, 70, dd);
        }
        m[i] = v;
      }
      this.maskDirty = false;
    },
    ripple: function (midi, vel, decay, wt) {
      if (reduced) return;
      var vw = this.grid.cssW || window.innerWidth, vh = this.grid.cssH || window.innerHeight;
      var u = clamp01((midi - 40) / 52);
      if (this.ripples.length >= 14) this.ripples.shift();
      this.ripples.push({ x: vw * (0.06 + 0.88 * u), y: vh * rnd(0.08, 0.92), w0: wt, life: clamp(2.2 + decay * 0.55, 2.5, 7), amp: 0.35 + 0.45 * vel, spd: 70 + 40 * vel });
    },
    wave: function (fade, wt) {
      if (reduced) return;
      if (this.waves.length >= 3) this.waves.shift();
      this.waves.push({ w0: wt, dur: clamp(fade * 1.6, 9, 22), dir: Math.random() < 0.5 ? 1 : -1 });
    },
    frame: function (dt, w) {
      var G = this.grid;
      if (!G.n) return;
      if (this.maskDirty) this.computeMask();
      var playing = AU.active;
      // дыхание: уровень пэда, сглаженный по секундам; в тишине — едва заметное движение
      this.B = follow(this.B, 0.22 + 0.78 * AU.slow * playing, dt, 2.5, 4);
      this.T += dt * (reduced ? 0.02 : lerp(0.05, 1, playing));
      var T = this.T, B = this.B, n = G.n, gg = G.g, tt = G.t, site = this.site, px = this.px, py = this.py, mask = this.mask;
      var rp = this.ripples, wv = this.waves, k;
      for (k = rp.length - 1; k >= 0; k--) if (w - rp[k].w0 > rp[k].life) rp.splice(k, 1);
      for (k = wv.length - 1; k >= 0; k--) if (w - wv[k].w0 > wv[k].dur) wv.splice(k, 1);
      var nr = rp.length, nw = wv.length, vw = G.cssW, SITE = 0.34;
      // предрасчёт кругов
      var rr = this._rr || (this._rr = []);
      for (k = 0; k < nr; k++) {
        var R = rp[k], age = w - R.w0, f = age / R.life;
        rr[k] = { x: R.x, y: R.y, r: R.spd * age * (1 - 0.25 * f), a: R.amp * Math.pow(1 - f, 1.6) * smooth(0, 0.15, age), th: 14 + 10 * f };
      }
      var wc = this._wc || (this._wc = []);
      for (k = 0; k < nw; k++) {
        var Wv = wv[k], p = (w - Wv.w0) / Wv.dur;
        var cx = Wv.dir > 0 ? lerp(-0.3, 1.3, p) * vw : lerp(1.3, -0.3, p) * vw;
        wc[k] = { cx: cx, a: 0.32 * Math.sin(Math.PI * clamp01(p)), wd: vw * 0.13 };
      }
      var s1 = 0.0042, s2 = 0.0075;
      for (var i = 0; i < n; i++) {
        var m = mask[i];
        if (m <= 0.01) { tt[i] = 0; continue; }
        var h = site[i], x = px[i], y = py[i], v = 0, ex = 0;
        for (k = 0; k < nr; k++) {
          var q = rr[k], dx = x - q.x, dy = y - q.y, d = Math.sqrt(dx * dx + dy * dy) - q.r;
          if (d > -40 && d < 40) { var e = d / q.th; ex += q.a * Math.exp(-e * e); }
        }
        for (k = 0; k < nw; k++) {
          var c = wc[k], u = (x - c.cx + Math.sin(y * 0.006 + T * 0.1) * 60) / c.wd;
          ex += c.a * Math.exp(-u * u);
        }
        if (h < SITE) {
          var nz = noise2(x * s1 + T * 0.021, y * s2 - T * 0.014) * 0.5 + 0.5;
          var sparkle = (h * 37.7) % 1;
          v = (nz * 0.85 + sparkle * 0.3) * (0.32 + 0.68 * B) * (0.75 + 0.25 * Math.sin(T * (0.15 + h) + h * 40));
        }
        v = (v + ex * (h < SITE ? 1 : 0.75)) * m;
        if (v < 0.3) { tt[i] = 0; continue; }
        var g, t;
        if (v < 0.42) { g = GH.dot; t = F1; }
        else if (v < 0.56) { g = GH.mid; t = F2t; }
        else if (v < 0.7) { g = GH.mid; t = F3; }
        else if (v < 0.85) { g = GH.colon; t = F3; }
        else { g = GH.plus; t = F4; }
        if (ex > 0.18 && ex * m > v * 0.45) { t = ex > 0.42 ? FA2 : FA1; if (g === GH.dot) g = GH.mid; }
        gg[i] = g; tt[i] = t;
      }
      return G.draw();
    }
  };

  // ================================================================ 5. герой

  var MODES = ['lyre', 'river', 'land'], MODE_NAMES = { lyre: 'lyre', river: 'river', land: 'landscape' };

  // ---------------------------------------------------------------- лира
  var Lyre = {
    strings: [], temps: [],
    setChord: function (c, fade, wt) {
      var S = this.strings, i;
      var live = S.filter(function (s) { return !s.dying; });
      live.sort(function (a, b) { return a.to - b.to; });
      var dur = Math.max(0.6, fade || 0);
      // пары по порядку; лишние струны гаснут, новые проявляются
      var n = Math.min(live.length, c.length);
      // если новых меньше — сохраняем ближайшие по высоте
      var used = [];
      for (i = 0; i < c.length; i++) {
        var best = -1, bd = 1e9;
        for (var j = 0; j < live.length; j++) {
          if (used.indexOf(j) >= 0) continue;
          var d = Math.abs(live[j].to - c[i]) + Math.abs(j - i) * 0.5;
          if (d < bd) { bd = d; best = j; }
        }
        if (best >= 0 && used.length < n) {
          used.push(best);
          var s = live[best];
          s.from = this.pitchAt(s, wt); s.to = c[i]; s.g0 = wt; s.gd = dur;
        } else {
          S.push(this.make(c[i], wt, dur));
        }
      }
      for (i = 0; i < live.length; i++) if (used.indexOf(i) < 0) { live[i].dying = true; live[i].d0 = wt; live[i].dd = Math.max(1.5, dur * 0.7); }
    },
    make: function (m, wt, fadeIn) {
      return { from: m, to: m, g0: wt, gd: 0.01, a0: wt, ad: Math.max(1.2, fadeIn || 1.2), dying: false, d0: 0, dd: 1,
        ph: Math.random() * TAU, plucks: [], flash: -10 };
    },
    pitchAt: function (s, w) { return lerp(s.from, s.to, sstep((w - s.g0) / s.gd)); },
    alphaAt: function (s, w) {
      var a = sstep((w - s.a0) / s.ad);
      if (s.dying) a *= 1 - sstep((w - s.d0) / s.dd);
      return a;
    },
    // щипок: ближайшая струна (≤ 2.5 полутона); иначе — струна того же звукоряда в другой октаве откликается
    // симпатически, а на высоте ноты появляется короткая временная струна
    pluck: function (midi, vel, decay, wt) {
      var best = null, bd = 1e9, sym = null, sd = 1e9, S = this.strings, i;
      for (i = 0; i < S.length; i++) {
        if (S[i].dying) continue;
        var pm = this.pitchAt(S[i], wt), d = Math.abs(pm - midi);
        if (d < bd) { bd = d; best = S[i]; }
        if (((Math.round(pm) - Math.round(midi)) % 12 + 12) % 12 === 0 && d < sd) { sd = d; sym = S[i]; }
      }
      var pos = 0.16 + 0.68 * ((midi * 0.6180339) % 1), tau = clamp(decay * 0.42, 0.45, 3.2), f = lerp(1.6, 3.4, clamp01((midi - 40) / 50));
      if (best && bd <= 2.5) { this.excite(best, wt, (0.6 + 0.8 * vel), tau, pos, f); return; }
      if (sym) this.excite(sym, wt, (0.35 + 0.5 * vel), tau * 0.8, pos, f);
      if (this.temps.length >= 7) this.temps.shift();
      var tp = this.make(midi, wt, 0.2);
      tp.temp = true; tp.life = clamp(decay * 1.2, 1.4, 8); tp.c = pos; tp.half = 0.1 + 0.16 * vel;
      this.temps.push(tp);
      this.excite(tp, wt, (0.45 + 0.6 * vel), tau, 0.5, f);
    },
    excite: function (s, wt, amp, tau, pos, f) {
      if (s.plucks.length >= 4) s.plucks.shift();
      s.plucks.push({ w0: wt, amp: amp, tau: tau, p: pos, f: f });
      s.flash = wt;
    },
    // смещение струны (в строках, вверх > 0) в точке u ∈ [0,1]
    disp: function (s, u, w, padA, padW) {
      var y = padA * Math.sin(Math.PI * u) * Math.sin(padW * w + s.ph) + padA * 0.35 * Math.sin(TAU * u) * Math.sin(padW * 1.7 * w + s.ph * 2.3);
      var pk = 0;
      for (var k = 0; k < s.plucks.length; k++) {
        var p = s.plucks[k], age = w - p.w0;
        if (age < 0) continue;
        var env = Math.exp(-age / p.tau), sum = 0, norm = 0;
        if (env < 0.01) continue;
        for (var m = 1; m <= 4; m++) {
          var cm = Math.sin(m * Math.PI * p.p) / (m * m);
          norm += cm * Math.sin(m * Math.PI * p.p);
          sum += cm * Math.sin(m * Math.PI * u) * Math.cos(TAU * p.f * m * age) * Math.exp(-age * (m - 1) * 0.9);
        }
        var v = p.amp * env * sum / (norm || 1) * smooth(0, 0.04, age);
        y += v; pk += Math.abs(v);
      }
      this._pk = pk;
      return y;
    },
    rowOf: function (m, top, bot) { return pitchRow(m, top, bot); },
    frame: function (o, w, dt, still) {
      var S = this.strings, i, k;
      if (!S.length) { var c0 = currentChord(); for (i = 0; i < c0.length; i++) S.push(this.make(c0[i], w - 10, 0.01)); }
      for (i = S.length - 1; i >= 0; i--) {
        var s0 = S[i];
        if (s0.dying && w - s0.d0 > s0.dd) S.splice(i, 1);
        else for (k = s0.plucks.length - 1; k >= 0; k--) if (w - s0.plucks[k].w0 > s0.plucks[k].tau * 6) s0.plucks.splice(k, 1);
      }
      for (i = this.temps.length - 1; i >= 0; i--) if (w - this.temps[i].a0 > this.temps[i].life) this.temps.splice(i, 1);

      var cols = o.cols, rows = o.rows, top = TOP_ROWS + 0.4, bot = rows - 1.3;
      var xa = 2, xb = cols - 6, lx = 3;
      if (cols < 60) { xa = 1; xb = cols - 5; lx = 2; }
      var L = AU.level * AU.active;
      var padA = still ? 0.06 : 0.1 + 0.5 * L, padW = TAU * 0.21;
      // высота струны: смесь «по высоте звука» и «по порядку» — близкие тоны не слипаются в одну строку
      var live = S.filter(function (q) { return !q.dying; }), self = this;
      live.forEach(function (q) { q._m = self.pitchAt(q, w); });
      live.sort(function (p1, p2) { return p1._m - p2._m; });
      var mt = Math.min(1.8, (bot - top) * 0.16), ya = top + mt, n = live.length;
      for (i = 0; i < S.length; i++) {
        var q = S[i], m0 = this.pitchAt(q, w), yp = pitchRow(m0, top, bot), r = live.indexOf(q);
        var target = r >= 0 && n > 1 ? lerp(yp, bot - r / (n - 1) * (bot - ya), 0.75) : yp;
        q.yS = q.yS == null ? target : follow(q.yS, target, dt, 0.5);
      }
      var labels = {};
      var all = S.concat(this.temps);
      for (i = 0; i < all.length; i++) {
        var s = all[i], a = this.alphaAt(s, w);
        if (s.temp) a *= 1 - sstep((w - s.a0 - s.life * 0.5) / (s.life * 0.5));
        if (a <= 0.02) continue;
        var y0 = s.temp ? pitchRow(s.to, top, bot) : s.yS;
        var gliding = w - s.g0 < s.gd;
        var baseT = Math.max(1, Math.round(a * (s.temp ? 3.5 : 4.4 + 1.8 * L + (gliding ? 0.8 : 0))));
        var x1 = xa, x2 = xb;
        if (s.temp) { var cxp = xa + s.c * (xb - xa), hw = s.half * (xb - xa); x1 = Math.max(xa, Math.round(cxp - hw)); x2 = Math.min(xb, Math.round(cxp + hw)); }
        for (var x = x1; x <= x2; x++) {
          var u = (x - x1 + 0.5) / (x2 - x1 + 1);
          var y = y0 - this.disp(s, u, w, s.temp ? 0 : padA * a, padW), pk = this._pk;
          var row = Math.floor(y), lv = Math.floor((y - row) * 8);
          if (row < 0 || row >= rows) continue;
          var t = baseT, g;
          if (pk > 0.5) t = ACC3; else if (pk > 0.24) t = ACC2; else if (pk > 0.09) t = ACC1;
          if (s.temp) {
            var edge = Math.min(u, 1 - u) * 2;                  // концы временной струны тают
            if (edge < 0.35 && t < ACC1) t = Math.max(1, t - 2);
            g = (x & 1) && pk < 0.09 ? 0 : DOT0 + lv;
          } else g = STR0 + lv;
          if (g) o.max(x, row, g, t);
        }
        if (!s.temp) {
          var ry = Math.floor(y0), rl = clamp(Math.floor((y0 - ry) * 8), 0, 7), pt = Math.max(1, Math.round(a * 5));
          o.max(xa - 1, ry, DOT0 + rl, pt);
          o.max(xb + 1, ry, DOT0 + rl, pt);
          var fl = w - s.flash, lt = fl < 1.6 ? (fl < 0.6 ? ACC3 : ACC2) : Math.max(1, Math.round(a * 4));
          if (cols >= 30 && !labels[ry] && !labels[ry - 1] && !labels[ry + 1] && a > 0.3) { labels[ry] = 1; o.text(xb + lx, ry, noteName(s.to), lt); }
        }
      }
    }
  };

  // ---------------------------------------------------------------- река
  var River = {
    span: 150, clock: 0, chords: [], notes: [], lv: new Float32Array(1024), lvHead: 0, lvT: 0, STEP: 0.5,
    chord: function (c, fade) {
      var prev = this.chords.length ? this.chords[this.chords.length - 1] : null;
      var from = prev ? prev.to : c;
      this.chords.push({ rt: this.clock, from: from, to: c, fade: Math.max(0.5, fade || 0) });
      while (this.chords.length > 2 && this.chords[1].rt < this.clock - this.span - 30) this.chords.shift();
    },
    note: function (m, vel, decay) {
      this.notes.push({ rt: this.clock, m: m, vel: vel, decay: decay });
      while (this.notes.length && this.notes[0].rt < this.clock - this.span - 20) this.notes.shift();
      if (this.notes.length > 600) this.notes.shift();
    },
    step: function (dt) {
      if (!AU.playing) return;
      this.clock += dt;
      while (this.lvT + this.STEP <= this.clock) {
        this.lvT += this.STEP;
        this.lv[this.lvHead] = AU.level; this.lvHead = (this.lvHead + 1) % this.lv.length;
      }
    },
    levelAt: function (rt) {
      var back = Math.round((this.lvT - rt) / this.STEP);
      if (back < 0) return AU.level;
      if (back >= this.lv.length) return 0;
      return this.lv[(this.lvHead - 1 - back + this.lv.length * 2) % this.lv.length];
    },
    lo: 36, hi: 84,
    rowOf: function (m, top, bot) { return bot - (m - this.lo) / (this.hi - this.lo) * (bot - top); },
    frame: function (o, w, dt) {
      var cols = o.cols, rows = o.rows, top = TOP_ROWS + 0.3, bot = rows - 2.4;
      if (!this.chords.length) this.chords.push({ rt: -1e9, from: currentChord(), to: currentChord(), fade: 0.5 });
      var spc = this.span / cols, now = this.clock, ci = 0, CH = this.chords, prevY = null, x, k;
      // диапазон: всё видимое (аккорды и ноты), медленно
      var lo = 1e9, hi = -1e9, t0 = now - this.span;
      for (k = 0; k < CH.length; k++) if (k === CH.length - 1 || CH[k + 1].rt > t0) { lo = Math.min(lo, CH[k].to[0], CH[k].from[0]); hi = Math.max(hi, CH[k].to[CH[k].to.length - 1], CH[k].from[CH[k].from.length - 1]); }
      for (k = 0; k < this.notes.length; k++) if (this.notes[k].rt > t0) { lo = Math.min(lo, this.notes[k].m); hi = Math.max(hi, this.notes[k].m); }
      lo -= 2; hi += 2;
      if (hi - lo < 30) { var md = (hi + lo) / 2; lo = md - 15; hi = md + 15; }
      this.lo = follow(this.lo, lo, dt || 0.03, 3); this.hi = follow(this.hi, hi, dt || 0.03, 3);
      for (x = 0; x < cols; x++) {
        var tc = now - (cols - 1 - x) * spc;
        while (ci + 1 < CH.length && CH[ci + 1].rt <= tc) ci++;
        var C = CH[ci], ms;
        if (C.rt > tc) { prevY = null; continue; }
        var u = sstep((tc - C.rt) / C.fade);
        ms = [];
        var nn = Math.max(C.from.length, C.to.length);
        for (k = 0; k < nn; k++) {
          var a = C.from[Math.min(k, C.from.length - 1)], b = C.to[Math.min(k, C.to.length - 1)];
          ms.push(lerp(a, b, u));
        }
        var lvl = Math.max(this.levelAt(tc), 0), on = lvl > 0.04, ys = [];
        for (k = 0; k < ms.length; k++) {
          var y = this.rowOf(ms[k], top, bot);
          ys.push(y);
          if (!on) continue;
          var row = Math.round(y), py = prevY && prevY[k] != null ? Math.round(prevY[k]) : row;
          var t = clamp(Math.round(1.5 + lvl * 4), 1, 6), g;
          if (row < py) g = GH.d1; else if (row > py) g = GH.d2;
          else g = lvl > 0.8 ? GH.hh : lvl > 0.3 ? GH.h : GH.mid;
          if (row === py && lvl <= 0.8 && hash(x * 13 + k * 71) < 0.12) g = GH.dash;   // лёгкая «зернистость» звучания
          o.max(x, row, g, clamp(Math.round(1 + lvl * 3.2), 1, 4));
        }
        prevY = on ? ys : null;
      }
      // ноты: точка и хвост вправо по длительности
      var N = this.notes;
      for (k = 0; k < N.length; k++) {
        var nt = N[k], xc = Math.round(cols - 1 - (now - nt.rt) / spc);
        if (xc < -12 || nt.rt > now) continue;
        var rn = Math.round(this.rowOf(nt.m, top, bot)), age = now - nt.rt;
        var tail = Math.max(1, Math.round(nt.decay / spc));
        for (var j = 1; j <= tail; j++) {
          var f = j / (tail + 1);
          if (xc + j >= cols) break;
          o.max(xc + j, rn, f < 0.5 ? GH.h : GH.mid, f < 0.35 ? ACC1 : Math.max(1, Math.round(4 * (1 - f))));
        }
        var fresh = age < 1.2;
        o.max(xc, rn, nt.vel > 0.75 ? GH.bullet : nt.vel > 0.5 ? GH.o : GH.bdot, fresh ? ACC3 : nt.vel > 0.6 ? ACC2 : ACC1);
      }
      // ось времени
      var ay = rows - 1;
      for (x = 0; x < cols; x++) {
        var back = (cols - 1 - x) * spc, tick = Math.floor((back + spc) / 30) !== Math.floor(back / 30);
        if (tick) o.put(x, ay, GH.mid, 3);
      }
      var lab = 'now';
      o.text(cols - lab.length, ay, lab, 3);
      var mins = Math.round(this.span / 60 * 10) / 10, ll = (mins % 1 ? mins.toFixed(1) : String(mins)) + ' min';
      o.text(0, ay, ll, 3);
    }
  };

  // ---------------------------------------------------------------- пейзаж
  // сцена: make(cols, rows) → { frame(o, T, dt), note(midi, vel) }. Тоны 1..8, акцент — только искры от нот.
  function Sparks(max) { this.a = []; this.max = max; }
  Sparks.prototype.add = function (x, y, life, big) {
    if (this.a.length >= this.max) this.a.shift();
    this.a.push({ x: x, y: y, age: 0, life: life, big: !!big });
  };
  Sparks.prototype.draw = function (o, dt) {
    for (var k = this.a.length - 1; k >= 0; k--) {
      var s = this.a[k];
      s.age += dt;
      if (s.age >= s.life) { this.a.splice(k, 1); continue; }
      var f = s.age / s.life, a = f < 0.18 ? f / 0.18 : 1 - (f - 0.18) / 0.82;
      a = sstep(a);
      var g = a > 0.7 ? (s.big ? GH.ast : GH.plus) : a > 0.35 ? GH.mid : GH.dot;
      var t = a > 0.8 ? ACC3 : a > 0.5 ? ACC2 : a > 0.2 ? ACC1 : 2;
      o.put(s.x, s.y, g, t);
    }
  };
  function noteX(midi, cols) { return Math.round(clamp01((midi - 42) / 46) * (cols - 6) + 3 + rnd(-2, 2)); }
  function shadeV(o, x, y, v, t0, t1) {
    if (v <= 0.02) return;
    var k = clamp(Math.round(v * 10), 1, 10);
    o.put(x, y, RAMP[k], Math.max(1, Math.round(lerp(t0, t1, clamp01(v)))));
  }
  function stars(o, rowsMax, dens, T, maxT, seed) {
    var cols = o.cols;
    for (var y = 0; y < rowsMax; y++) for (var x = 0; x < cols; x++) {
      var h = hash(x * 7919 + y * 104729 + seed);
      if (h > dens) continue;
      var tw = 0.55 + 0.45 * Math.sin(T * (0.25 + h * 31) + h * 999);
      var big = h < dens * 0.15, t = Math.round((big ? maxT : maxT * 0.6) * tw);
      if (t < 1) continue;
      o.put(x, y, big ? (tw > 0.9 ? GH.plus : GH.mid) : GH.dot, t);
    }
  }
  // ---- примитивы: кривая и контур фигуры (точные: штрихи по высоте ячейки, на склонах — ╱ ╲ │)
  var ASP = 1.95;
  // кривая y = fy(x) (x в колонках, y в строках, float); tone — число или функция (x) → тон
  function curve(o, fy, x0, x1, tone, dotted) {
    for (var x = Math.max(0, x0 | 0); x < Math.min(o.cols, x1); x++) {
      var t = typeof tone === 'function' ? tone(x) : tone;
      if (t <= 0) continue;
      var ya = fy(x), yb = fy(x + 1), ym = fy(x + 0.5), ra = Math.floor(ya), rb = Math.floor(yb);
      if (ra === rb || Math.abs(yb - ya) < 0.5) {
        var r = Math.floor(ym);
        if (dotted && (x & 1)) continue;
        o.put(x, r, dotted ? DOT0 + clamp(Math.floor((ym - r) * 8), 0, 7) : STR0 + clamp(Math.floor((ym - r) * 8), 0, 7), t);
      } else {
        var dy = yb - ya, g = Math.abs(dy) > 2.6 ? GH.v : dy > 0 ? GH.d2 : GH.d1;
        for (var y = Math.min(ra, rb); y <= Math.max(ra, rb); y++) o.put(x, y, g, t);
      }
    }
  }
  // фигура по знаковому расстоянию f(X, Y) (X — в «строковых» единицах, X = x / ASP); контур в одну ячейку
  // и заливка fill(o, x, y, depth) внутри
  function shape(o, bx0, by0, bx1, by1, f, edgeT, fill, round) {
    var h = 0.2;
    for (var y = Math.max(0, by0 | 0); y <= Math.min(o.rows - 1, by1); y++) {
      for (var x = Math.max(0, bx0 | 0); x <= Math.min(o.cols - 1, bx1); x++) {
        var X = (x + 0.5) / ASP, Y = y + 0.5, d = f(X, Y);
        if (d > 1.2) continue;
        var nx = (f(X + h, Y) - f(X - h, Y)) / (2 * h), ny = (f(X, Y + h) - f(X, Y - h)) / (2 * h), nm = Math.sqrt(nx * nx + ny * ny) || 1;
        nx /= nm; ny /= nm;
        var half = 0.5 * Math.max(Math.abs(ny), Math.abs(nx) / ASP) + 0.06;
        if (Math.abs(d) <= half) {
          if (edgeT <= 0) continue;
          var g, ax = Math.abs(nx), ay = Math.abs(ny);
          if (ay > 0.93) { var fy = (Y - d * ny) - y; g = STR0 + clamp(Math.floor(fy * 8), 0, 7); }
          else if (ax > 0.9) g = round ? (nx < 0 ? GH.lp : GH.rp) : GH.v;
          else g = nx * ny < 0 ? GH.d2 : GH.d1;
          o.put(x, y, g, edgeT);
        } else if (d < 0 && fill) fill(o, x, y, -d);
      }
    }
  }
  function circleF(cx, cy, r) { return function (X, Y) { var dx = X - cx, dy = Y - cy; return Math.sqrt(dx * dx + dy * dy) - r; }; }
  // рельеф: линия гребня и редкая заливка, гуще книзу
  function terrain(o, fy, edgeT, fillT, dens, seed) {
    curve(o, fy, 0, o.cols, edgeT);
    if (!fillT) { for (var x0 = 0; x0 < o.cols; x0++) for (var y0 = Math.floor(fy(x0 + 0.5)) + 1; y0 < o.rows; y0++) o.t[y0 * o.cols + x0] = 0; return; }
    for (var x = 0; x < o.cols; x++) {
      var top = fy(x + 0.5);
      for (var y = Math.floor(top) + 1; y < o.rows; y++) {
        var i = y * o.cols + x, k = y - top;
        o.t[i] = 0;
        if (hash(x * 73 + y * 1031 + seed) < dens * Math.min(1, 0.4 + k * 0.25)) { o.g[i] = k > 3 && hash(x * 7 + y + seed) < 0.3 ? GH.colon : GH.dot; o.t[i] = fillT; }
      }
    }
  }
  function ridgeFn(C, base, amp, sc, seed, oct) {
    return function (x) { return base - amp * fbm(x / C * sc + seed, seed * 0.37, oct || 3); };
  }

  var SCENES = {};

  // сон: серп луны, редкие звёзды, тёмные холмы
  SCENES.sleep = function (C, R) {
    var sp = new Sparks(8);
    return {
      frame: function (o, T, dt) {
        o.clear();
        stars(o, R - 2, 0.016, T * 0.5, 4, 11);
        var r = Math.max(2.2, R * 0.21), cx = C * 0.72 / ASP, cy = R * 0.38;
        // ореол
        for (var y = 0; y < R; y++) for (var x = 0; x < C; x++) {
          var dx = (x + 0.5) / ASP - cx, dy = y + 0.5 - cy, d = Math.sqrt(dx * dx + dy * dy) / r;
          if (d > 1.25 && d < 2.3 && hash(x * 13 + y * 71) < 0.42 * (1 - (d - 1.25) / 1.05)) o.put(x, y, GH.dot, 2);
        }
        var c1 = circleF(cx, cy, r), c2 = circleF(cx + r * 0.45, cy - r * 0.22, r * 0.92);
        var moon = function (X, Y) { return Math.max(c1(X, Y), -c2(X, Y)); };
        shape(o, cx * ASP - r * ASP - 2, cy - r - 1, cx * ASP + r * ASP + 2, cy + r + 1, moon, 6,
          function (o2, x, y, dep) { if (((x + y) & 1) === 0) o2.put(x, y, dep > 0.9 ? GH.colon : GH.mid, dep > 0.9 ? 4 : 3); else o2.t[y * o2.cols + x] = 0; }, true);
        terrain(o, ridgeFn(C, R - 1.4, R * 0.1, 5, 3.1), 3, 1, 0.12, 5);
        sp.draw(o, dt);
      },
      note: function (m, v) { sp.add(noteX(m, C), Math.floor(rnd(0, R * 0.6)), 2.4, v > 0.7); }
    };
  };

  // дождь / гроза: косые штрихи, земля, всплески; у грозы — тучи и редкая молния
  SCENES.rain = function (C, R, opt) {
    var drops = [], sp = new Sparks(14), heavy = !!(opt && opt.heavy), flash = 0, bolt = [], ground = R - 1.3;
    function spawn(any) { drops.push({ x: rnd(0, C + R * 0.6), y: any ? rnd(0, R) : rnd(-3, 0), v: rnd(heavy ? 10 : 6, heavy ? 15 : 9), l: Math.random() }); }
    return {
      frame: function (o, T, dt) {
        o.clear();
        var lvl = heavy ? 1 : clamp(0.4 + pv('rainLevel', 0.5) * 1.0, 0.35, 1);
        var target = Math.round(C * R * (heavy ? 0.075 : 0.045) * lvl);
        while (drops.length < target) spawn(drops.length < target * 0.8 && T < 2);
        var cl = heavy ? Math.ceil(R * 0.32) : 0;
        if (heavy) {
          for (var y = 0; y < cl; y++) for (var x = 0; x < C; x++) {
            var v = fbm(x * 0.05 + T * 0.06, y * 0.32 - T * 0.02, 3) * 0.5 + 0.5 - y / cl * 0.5;
            if (v > 0.42) o.put(x, y, v > 0.62 ? GH.approx : v > 0.52 ? GH.tilde : GH.dash, v > 0.6 ? 5 : v > 0.5 ? 4 : 2);
          }
        }
        for (var k = drops.length - 1; k >= 0; k--) {
          var d = drops[k];
          d.y += d.v * dt; d.x -= d.v * dt * 0.45;
          if (d.y >= ground) { if (Math.random() < 0.4) sp.add(Math.round(d.x), Math.floor(ground) - (Math.random() < 0.5 ? 0 : 1), 0.45, false); drops.splice(k, 1); continue; }
          if (d.y < cl * 0.6) continue;
          o.put(Math.round(d.x), Math.floor(d.y), GH.d1, d.l < 0.25 ? (heavy ? 5 : 4) : d.l < 0.7 ? 3 : 2);
        }
        curve(o, function () { return ground; }, 0, C, 3);
        for (var x2 = 0; x2 < C; x2++) if (hash(x2 * 17 + 3) < 0.12) o.put(x2, Math.floor(ground) + 1, GH.dash, 2);
        sp.draw(o, dt);
        if (flash > 0) {
          flash -= dt;
          var t = flash > 0.2 ? 7 : 3;
          for (var b = 0; b < bolt.length; b++) o.put(bolt[b][0], bolt[b][1], bolt[b][2], t);
        }
      },
      note: function (m, v) {
        if (heavy && v > 0.8 && flash <= 0 && Math.random() < 0.3) {
          bolt = []; var x = noteX(m, C), y = Math.ceil(R * 0.25);
          while (y < ground) { var s = Math.random() < 0.5 ? -1 : 1; bolt.push([x, y, s < 0 ? GH.d1 : GH.d2]); x += s; y++; }
          flash = 0.45;
        } else sp.add(noteX(m, C), Math.floor(ground) - 1, 1.4, v > 0.7);
      }
    };
  };
  SCENES.storm = function (C, R) { return SCENES.rain(C, R, { heavy: true }); };

  // лес: стволы на разной глубине, кроны, светлячки
  SCENES.forest = function (C, R) {
    var trees = [], sp = new Sparks(12), x = 1;
    while (x < C - 1) { trees.push({ x: x, d: hash(x * 97 + 5), h: rnd(0.5, 0.95) }); x += Math.round(rnd(3, 8)); }
    trees.sort(function (a, b) { return b.d - a.d; });
    var motes = [];
    for (var i = 0; i < Math.round(C * R * 0.006); i++) motes.push({ x: rnd(0, C), y: rnd(2, R - 2), p: rnd(0, TAU) });
    return {
      frame: function (o, T, dt) {
        o.clear();
        var gr = R - 1;
        for (var k = 0; k < trees.length; k++) {
          var tr = trees[k], near = tr.d < 0.4, t = near ? 6 : tr.d < 0.72 ? 4 : 2;
          var top = Math.round(R - 1 - tr.h * (R - 2)), sway = Math.sin(T * 0.4 + tr.x) * 0.5;
          for (var y = top + 2; y < gr; y++) o.put(tr.x, y, GH.v, t);
          var w = near ? 3 : 2;
          for (var cy = 0; cy < 3; cy++) {
            for (var cx = -w + cy; cx <= w - cy; cx++) {
              var gx = Math.round(tr.x + cx + sway * (3 - cy) / 3), gy = top + 2 - cy;
              if (cy === 0 && Math.abs(cx) === w && hash(gx + k) < 0.5) continue;
              o.put(gx, gy, cy === 2 ? GH.caret : GH.wedge, Math.max(1, t - (cy === 0 ? 0 : 1)));
            }
          }
        }
        for (var x2 = 0; x2 < C; x2++) o.put(x2, gr, hash(x2 * 53) < 0.25 ? GH.comma : GH.under, 3);
        for (var m = 0; m < motes.length; m++) {
          var mo = motes[m]; mo.x += Math.sin(T * 0.3 + mo.p) * dt * 0.6; mo.y += Math.cos(T * 0.23 + mo.p) * dt * 0.3;
          var a = 0.5 + 0.5 * Math.sin(T * 0.8 + mo.p * 3);
          if (a > 0.6) o.put(Math.round(mo.x), Math.round(mo.y), GH.mid, a > 0.9 ? 4 : 2);
        }
        sp.draw(o, dt);
      },
      note: function (m, v) { sp.add(noteX(m, C), Math.floor(rnd(2, R - 3)), 2.2, v > 0.7); }
    };
  };

  // храм: колоннада круглых арок, ступени; ноты — круги, как от колокола
  SCENES.temple = function (C, R) {
    var rings = [];
    return {
      frame: function (o, T, dt) {
        o.clear();
        var floor = R - 2.2, top = Math.max(TOP_ROWS + 0.6, R * 0.2), bay = C < 70 ? 12 : 16;
        var n = Math.max(1, Math.floor((C - 4) / bay)), x0 = (C - n * bay) / 2, hw = (bay - 3) / 2 / ASP;
        var spring = top + 1.4 + hw;
        // карниз
        curve(o, function () { return top; }, Math.floor(x0) - 1, Math.ceil(x0 + n * bay) + 2, 5);
        curve(o, function () { return top + 0.7; }, Math.floor(x0), Math.ceil(x0 + n * bay) + 1, 3);
        for (var b = 0; b < n; b++) {
          var cx = (x0 + b * bay + bay / 2) / ASP;
          var arch = function (X, Y) {
            var dx = Math.abs(X - cx) - hw, box = Y > spring ? dx : Math.sqrt((X - cx) * (X - cx) + (Y - spring) * (Y - spring)) - hw;
            return box;
          };
          var lit = 0.5 + 0.5 * Math.sin(T * 0.15 + b * 1.3);
          shape(o, x0 + b * bay, top + 1, x0 + (b + 1) * bay, floor - 0.5, arch, 5, function (o2, x, y, dep) {
            if (hash(x * 41 + y * 13) < 0.05 + 0.05 * lit && y > spring - 1) o2.put(x, y, GH.dot, 2);
          }, false);
        }
        curve(o, function () { return floor; }, 0, C, 5);
        curve(o, function () { return floor + 0.9; }, 2, C - 2, 3);
        curve(o, function () { return floor + 1.8; }, 5, C - 5, 2);
        for (var k = rings.length - 1; k >= 0; k--) {
          var rg = rings[k]; rg.age += dt;
          if (rg.age > 3.5) { rings.splice(k, 1); continue; }
          var rr = 0.6 + rg.age * 2.4, a = 1 - rg.age / 3.5, nn = Math.round(rr * 16 + 8);
          for (var s = 0; s < nn; s++) {
            var an = s / nn * TAU, py = rg.y + Math.sin(an) * rr * 0.55, row = Math.floor(py);
            if (row > top + 1 && row < floor) o.max(Math.round(rg.x + Math.cos(an) * rr * ASP), row, DOT0 + clamp(Math.floor((py - row) * 8), 0, 7), a > 0.6 ? ACC2 : a > 0.3 ? ACC1 : 2);
          }
        }
      },
      note: function (m, v) { if (rings.length < 5) rings.push({ x: noteX(m, C), y: R * 0.62, age: 0 }); }
    };
  };

  // зима: падающие хлопья, сугробы, ели
  SCENES.winter = function (C, R) {
    var fl = [], sp = new Sparks(8);
    for (var i = 0; i < Math.round(C * R * 0.03); i++) fl.push({ x: rnd(0, C), y: rnd(0, R), v: rnd(0.5, 1.4), p: rnd(0, TAU), z: Math.random() });
    var pines = [], x = rnd(2, 8);
    while (x < C - 3) { pines.push({ x: Math.round(x), h: Math.round(rnd(2, Math.max(3, R * 0.42))), d: Math.random() }); x += rnd(7, 26); }
    var snow = ridgeFn(C, R - 1.6, 0.9, 3, 7.7);
    return {
      frame: function (o, T, dt) {
        o.clear();
        for (var p = 0; p < pines.length; p++) {
          var pn = pines[p], base = Math.floor(snow(pn.x)) , t = pn.d < 0.5 ? 6 : 4;
          for (var k = 0; k < pn.h; k++) {
            var y = base - 1 - k, w = Math.max(0, Math.round((pn.h - k) * 0.65 - 0.2));
            for (var dx = -w; dx <= w; dx++) o.put(pn.x + dx, y, dx < 0 ? GH.slash : dx > 0 ? GH.bslash : (k === pn.h - 1 ? GH.caret : GH.v), dx === 0 ? t : t - 1);
          }
        }
        terrain(o, snow, 5, 1, 0.08, 9);
        for (var f = 0; f < fl.length; f++) {
          var q = fl[f];
          q.y += q.v * dt * 0.9; q.x += Math.sin(T * 0.7 + q.p) * dt * 0.8;
          if (q.y >= R - 1) { q.y = -1; q.x = rnd(0, C); }
          o.max(Math.round(q.x), Math.floor(q.y), q.z < 0.15 ? GH.star : q.z < 0.55 ? GH.mid : GH.dot, q.z < 0.3 ? 5 : q.z < 0.7 ? 3 : 2);
        }
        sp.draw(o, dt);
      },
      note: function (m, v) { sp.add(noteX(m, C), Math.floor(rnd(1, R * 0.6)), 2.0, v > 0.7); }
    };
  };

  // космос: звёзды с параллаксом, планета с кольцом
  SCENES.space = function (C, R) {
    var st = [], sp = new Sparks(10);
    for (var i = 0; i < Math.round(C * R * 0.045); i++) st.push({ x: rnd(0, C), y: rnd(0, R), z: Math.random(), p: rnd(0, TAU) });
    return {
      frame: function (o, T, dt) {
        o.clear();
        for (var k = 0; k < st.length; k++) {
          var s = st[k]; s.x -= dt * (0.04 + s.z * 0.3);
          if (s.x < 0) s.x += C;
          var tw = 0.6 + 0.4 * Math.sin(T * (0.5 + s.z) + s.p), t = Math.round((1 + s.z * 4) * tw);
          if (t >= 1) o.put(Math.floor(s.x), Math.floor(s.y), s.z > 0.93 ? GH.plus : s.z > 0.6 ? GH.mid : GH.dot, t);
        }
        var r = Math.max(2.2, R * 0.24), cx = C * 0.26 / ASP, cy = R * 0.56, ra = r * 2.0, rb = r * 0.42, tilt = -0.12;
        var ringY = function (X, side) { var u = (X - cx) / ra; if (Math.abs(u) > 1) return null; return cy + tilt * (X - cx) + side * rb * Math.sqrt(1 - u * u); };
        // задняя часть кольца
        for (var x = 0; x < C; x++) { var y1 = ringY((x + 0.5) / ASP, -1); if (y1 != null) { var rw = Math.floor(y1); o.put(x, rw, DOT0 + clamp(Math.floor((y1 - rw) * 8), 0, 7), 3); } }
        var lx = -0.6, ly = -0.55;
        shape(o, (cx - r) * ASP - 2, cy - r - 1, (cx + r) * ASP + 2, cy + r + 1, circleF(cx, cy, r), 6, function (o2, x2, y2) {
          var nx = ((x2 + 0.5) / ASP - cx) / r, ny = (y2 + 0.5 - cy) / r, nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
          var l = clamp01(-(nx * lx + ny * ly) * 0.8 + nz * 0.4), band = Math.sin(ny * 7 + 0.5) > 0.6;
          if (l < 0.25) { o2.t[y2 * o2.cols + x2] = 0; return; }
          o2.put(x2, y2, band ? GH.dash : l > 0.75 ? GH.colon : GH.mid, l > 0.6 ? 4 : 3);
        }, true);
        // передняя часть кольца поверх диска
        for (var x3 = 0; x3 < C; x3++) {
          var y2 = ringY((x3 + 0.5) / ASP, 1);
          if (y2 != null) { var rw2 = Math.floor(y2); o.put(x3, rw2, STR0 + clamp(Math.floor((y2 - rw2) * 8), 0, 7), 6); }
        }
        sp.draw(o, dt);
      },
      note: function (m, v) { sp.add(noteX(m, C), Math.floor(rnd(0, R)), 2.6, v > 0.65); }
    };
  };

  // утро: солнце поднимается над горизонтом, точечные лучи, дымка
  SCENES.morning = function (C, R) {
    var sp = new Sparks(10);
    return {
      frame: function (o, T, dt) {
        o.clear();
        var hor = R * 0.74, cx = C * 0.5 / ASP, rise = 0.62 + 0.3 * Math.sin(T * 0.008);
        var r = Math.max(2.4, R * 0.22), cy = hor + r * 0.35 - rise * r * 0.9;
        for (var k = 0; k < 15; k++) {
          var an = Math.PI + (k + 0.5) / 15 * Math.PI, len = r * (2.0 + 0.5 * Math.sin(T * 0.25 + k * 1.7));
          for (var s = r * 1.35; s < len; s += 0.55) {
            var px = Math.round((cx + Math.cos(an) * s) * ASP), py = Math.floor(cy + Math.sin(an) * s);
            if (py >= hor - 0.5 || py < 0) continue;
            o.put(px, py, GH.mid, s < r * 1.7 ? 4 : 2);
          }
        }
        shape(o, (cx - r) * ASP - 2, cy - r - 1, (cx + r) * ASP + 2, Math.min(cy + r + 1, hor - 0.6), circleF(cx, cy, r), 7, function (o2, x, y, dep) {
          if (((x + y) & 1) === 0 && y < hor - 0.6) o2.put(x, y, dep > 1.2 ? GH.colon : GH.mid, dep > 1.2 ? 5 : 4);
        }, true);
        for (var c = 0; c < C; c++) for (var yy = Math.floor(hor); yy < R; yy++) o.t[yy * C + c] = 0;
        curve(o, function () { return hor; }, 0, C, function (x) { return Math.abs(x / ASP - cx) < r * 1.4 ? 7 : 5; });
        for (var x = 0; x < C; x++) for (var y = Math.floor(hor) + 1; y < R; y++) {
          var v = fbm(x * 0.05 - T * 0.03, y * 0.6, 2) * 0.5 + 0.5 - (y - hor) * 0.07;
          if (v > 0.52) o.put(x, y, v > 0.62 ? GH.tilde : GH.dash, 2);
          if (y === Math.floor(hor) + 1 && Math.abs(x / ASP - cx) < r * 1.1 && hash(x * 7 + Math.floor(T * 1.5)) < 0.55) o.put(x, y, GH.h, 4);
        }
        sp.draw(o, dt);
      },
      note: function (m, v) { sp.add(noteX(m, C), Math.floor(rnd(1, R * 0.55)), 1.8, v > 0.7); }
    };
  };

  // фокус: неподвижный горизонт, одна точка
  SCENES.focus = function (C, R) {
    var sp = new Sparks(6);
    return {
      frame: function (o, T, dt) {
        o.clear();
        var hor = R * 0.6;
        curve(o, function () { return hor; }, 0, C, function (x) { var e = Math.min(x, C - 1 - x) / (C * 0.2); return e < 1 ? Math.max(1, Math.round(e * 5)) : 5; });
        for (var x = 0; x < C; x += 8) o.put(x, Math.floor(hor) + 1, GH.dot, 2);
        var b = 0.5 + 0.5 * Math.sin(T * 0.35);
        o.put(Math.round(C / 2), Math.floor(hor) - 1, b > 0.5 ? GH.bullet : GH.mid, b > 0.7 ? 7 : 5);
        sp.draw(o, dt);
      },
      note: function (m, v) { sp.add(noteX(m, C), Math.floor(R * 0.6) - 2, 1.5, false); }
    };
  };

  // медитация: тихая вода и круги
  SCENES.meditation = function (C, R) {
    var rings = [{ age: 0 }], next = 0;
    return {
      frame: function (o, T, dt) {
        o.clear();
        var hor = R * 0.42, cx = C / 2, cy = R * 0.72;
        stars(o, Math.floor(hor), 0.008, T * 0.4, 3, 5);
        curve(o, function () { return hor; }, 0, C, 4);
        for (var x = 0; x < C; x++) for (var y = Math.floor(hor) + 1; y < R; y++) if (hash(x * 13 + y * 101) < 0.03 + (y - hor) * 0.004) o.put(x, y, GH.dash, 2);
        next -= dt;
        if (next <= 0) { rings.push({ age: 0 }); next = 1 / Math.max(0.05, waveHz()); }
        for (var k = rings.length - 1; k >= 0; k--) {
          var rg = rings[k]; rg.age += dt;
          var life = 14;
          if (rg.age > life) { rings.splice(k, 1); continue; }
          var rr = 0.6 + rg.age * 0.75, a = 1 - rg.age / life, n = Math.round(rr * 16 + 8);
          for (var s = 0; s < n; s++) {
            var an = s / n * TAU, px = Math.round(cx + Math.cos(an) * rr * 3.6), py = cy + Math.sin(an) * rr * 0.5, row = Math.floor(py);
            if (row > hor && row < R) o.max(px, row, STR0 + clamp(Math.floor((py - row) * 8), 0, 7), Math.max(1, Math.round(a * 5)));
          }
        }
        o.put(Math.round(cx), Math.floor(cy), GH.mid, 5);
      },
      note: function () { if (rings.length < 8) rings.push({ age: 0 }); }
    };
  };

  // глубина: медленные глубокие волны, оседающие частицы
  SCENES.deep = function (C, R) {
    var parts = [], sp = new Sparks(8);
    for (var i = 0; i < Math.round(C * R * 0.01); i++) parts.push({ x: rnd(0, C), y: rnd(0, R), v: rnd(0.1, 0.35) });
    return {
      frame: function (o, T, dt) {
        o.clear();
        for (var p = 0; p < parts.length; p++) {
          var q = parts[p]; q.y += q.v * dt; if (q.y > R) { q.y = 0; q.x = rnd(0, C); }
          o.put(Math.round(q.x), Math.floor(q.y), GH.dot, 2);
        }
        var Ls = 4;
        for (var l = 0; l < Ls; l++) {
          (function (l) {
            var base = R * (0.3 + l * 0.18), amp = 0.7 + l * 0.45, k = 0.07 - l * 0.01, s2 = 0.16 - l * 0.025;
            curve(o, function (x) { return base + amp * Math.sin(x * k + T * s2 + l * 1.7) + 0.35 * Math.sin(x * k * 2.3 - T * s2 * 1.3 + l); }, 0, C, 6 - l);
          })(l);
        }
        sp.draw(o, dt);
      },
      note: function (m, v) { sp.add(noteX(m, C), Math.floor(rnd(R * 0.3, R - 1)), 2.6, v > 0.7); }
    };
  };

  // полночь: далёкий город, окна, звёзды
  SCENES.midnight = function (C, R) {
    var blds = [], x = 0, sp = new Sparks(8);
    while (x < C) { var w = Math.round(rnd(3, 8)), h = Math.round(rnd(R * 0.15, R * 0.5)); blds.push({ x: x, w: w, h: h, s: (Math.random() * 1000) | 0 }); x += w + (Math.random() < 0.3 ? 1 : 0); }
    return {
      frame: function (o, T, dt) {
        o.clear();
        stars(o, Math.round(R * 0.5), 0.012, T * 0.4, 3, 77);
        o.put(Math.round(C * 0.82), Math.round(R * 0.18), GH.o, 5);
        for (var b = 0; b < blds.length; b++) {
          var B = blds[b], top = R - 1 - B.h;
          for (var xx = B.x; xx < B.x + B.w && xx < C; xx++) {
            o.put(xx, top, xx === B.x ? GH.sTL : xx === B.x + B.w - 1 ? GH.sTR : GH.h, 4);
            for (var y = top + 1; y < R - 1; y++) {
              if (xx === B.x || xx === B.x + B.w - 1) { o.put(xx, y, GH.v, 3); continue; }
              var hh = hash(xx * 131 + y * 17 + B.s), on = hh < 0.28 && Math.sin(T * 0.05 * (1 + hh * 3) + hh * 50) > -0.6;
              if (on) o.put(xx, y, hh < 0.06 ? GH.sq : GH.dot, hh < 0.06 ? 6 : 4);
            }
          }
        }
        curve(o, function () { return R - 0.5; }, 0, C, 4);
        sp.draw(o, dt);
      },
      note: function (m, v) { sp.add(noteX(m, C), Math.floor(rnd(0, R * 0.45)), 2.0, v > 0.75); }
    };
  };

  // туман: слоистая дымка, сквозь неё холмы
  SCENES.fog = function (C, R) {
    var sp = new Sparks(6);
    return {
      frame: function (o, T, dt) {
        o.clear();
        terrain(o, ridgeFn(C, R * 0.62, R * 0.16, 3, 2.2), 3, 0, 0, 1);
        terrain(o, ridgeFn(C, R * 0.86, R * 0.1, 5, 6.4), 4, 1, 0.06, 2);
        for (var y = 0; y < R; y++) {
          var band = 0.5 + 0.5 * Math.sin(y * 0.8 + T * 0.04);
          for (var x = 0; x < C; x++) {
            var v = fbm(x * 0.03 + T * 0.035 * (1 + y * 0.04), y * 0.25, 3) * 0.5 + 0.5;
            v = v * (0.55 + 0.45 * band) - 0.38;
            if (v > 0.1 && hash(x * 7 + y * 131) < v * 3) o.put(x, y, v > 0.22 ? GH.dash : GH.dot, v > 0.22 ? 3 : 2);
          }
        }
        sp.draw(o, dt);
      },
      note: function (m, v) { sp.add(noteX(m, C), Math.floor(rnd(1, R - 2)), 2.2, false); }
    };
  };

  // ностальгия: катушки плёнки, лента, зерно
  SCENES.nostalgia = function (C, R) {
    var sp = new Sparks(6);
    return {
      frame: function (o, T, dt) {
        o.clear();
        var cy = R * 0.45, r = Math.max(2, R * 0.27), gap = Math.min(C * 0.2, r * ASP * 2.4) / ASP;
        var cxs = [C / 2 / ASP - gap, C / 2 / ASP + gap], hy = cy + r + 1.6;
        for (var k = 0; k < 2; k++) {
          var cx = cxs[k], rr = r * (k ? 0.8 : 1), rot = T * 0.3 * (k ? 1.25 : 1);
          shape(o, (cx - rr) * ASP - 2, cy - rr - 1, (cx + rr) * ASP + 2, cy + rr + 1, circleF(cx, cy, rr), 5, function (o2, x, y, dep) {
            if (dep > rr * 0.62 && dep < rr * 0.68 + 0.4 && ((x + y) & 1)) o2.put(x, y, GH.dot, 2);
          }, true);
          for (var s = 0; s < 3; s++) {
            var sa = rot + s * TAU / 3, c = Math.cos(sa), sn = Math.sin(sa);
            var g = Math.abs(c) < 0.38 ? GH.v : Math.abs(c) > 0.92 ? GH.h : (c * sn > 0 ? GH.bslash : GH.slash);
            for (var d = 0.7; d < rr * 0.55; d += 0.35) o.put(Math.round((cx + c * d) * ASP), Math.floor(cy + sn * d + 0.5), g, 5);
          }
          o.put(Math.round(cx * ASP), Math.floor(cy + 0.5), GH.o, 6);
          // лента к головке
          var tx = (cx + (k ? -1 : 1) * rr * 0.2);
          curve(o, function (x) { var u = clamp01((x / ASP - tx) / ((C / 2 / ASP) - tx)); return cy + rr + (hy - cy - rr) * sstep(Math.abs(u)); }, Math.min(tx * ASP, C / 2), Math.max(tx * ASP, C / 2), 3);
        }
        o.text(Math.round(C / 2) - 1, Math.floor(hy) + 0, '▫', 4);
        for (var g2 = 0; g2 < Math.round(C * R * 0.005); g2++) {
          var fr = Math.floor(T * 6);
          o.max(Math.floor(hash(g2 * 7 + fr * 131) * C), Math.floor(hash(g2 * 13 + fr * 17) * R), GH.dot, 2);
        }
        sp.draw(o, dt);
      },
      note: function (m, v) { sp.add(noteX(m, C), Math.floor(rnd(1, R - 1)), 1.6, false); }
    };
  };

  // тепло: окно со светом, свет на полу, пар от чашки
  SCENES.warmth = function (C, R) {
    var sp = new Sparks(6);
    return {
      frame: function (o, T, dt) {
        o.clear();
        var w = Math.min(C - 6, Math.max(18, Math.round(C * 0.24))), h = Math.max(6, R - TOP_ROWS - 4);
        var x0 = Math.round(C / 2 - w / 2), y0 = TOP_ROWS, x1 = x0 + w, y1 = y0 + h, mx = Math.round((x0 + x1) / 2), my = Math.round(y0 + h * 0.45);
        var fl = 0.9 + 0.1 * Math.sin(T * 0.5) * Math.sin(T * 0.21);
        for (var y = y0 + 1; y < y1; y++) for (var x = x0 + 1; x < x1; x++) {
          if (x === mx || y === my) continue;
          var dx = (x - mx) / (w / 2), dy = (y - y1) / h, v = (1 - Math.sqrt(dx * dx * 0.5 + dy * dy * 0.9)) * fl;
          if (hash(x * 31 + y * 7) < v * 0.55) o.put(x, y, v > 0.55 ? GH.colon : GH.mid, v > 0.5 ? 4 : 3);
        }
        for (var x2 = x0; x2 <= x1; x2++) { o.put(x2, y0, GH.h, 6); o.put(x2, y1, GH.hh, 6); if (x2 !== x0 && x2 !== x1) o.put(x2, my, GH.h, 5); }
        for (var y2 = y0; y2 <= y1; y2++) { o.put(x0, y2, GH.v, 6); o.put(x1, y2, GH.v, 6); if (y2 !== y0 && y2 !== y1) o.put(mx, y2, GH.v, 5); }
        o.put(x0, y0, GH.sTL, 6); o.put(x1, y0, GH.sTR, 6); o.put(x0, y1, GH.hh, 6); o.put(x1, y1, GH.hh, 6);
        o.put(mx, y0, GH.tT, 6); o.put(x0, my, GH.tL, 6); o.put(x1, my, GH.tR, 6); o.put(mx, my, GH.cross, 5);
        o.put(x0 - 1, y1, GH.hh, 5); o.put(x1 + 1, y1, GH.hh, 5);
        // чашка на подоконнике и пар
        var cx = x1 - 3;
        o.text(cx - 1, y1 - 1, '╰─╯', 5);
        for (var s = 0; s < 3; s++) {
          var ph = (T * 0.35 + s / 3) % 1, sy = y1 - 2 - ph * 3.5, sx = cx + Math.sin(ph * 6 + s) * 0.8;
          if (sy > y0) o.put(Math.round(sx), Math.floor(sy), ph < 0.5 ? (s & 1 ? GH.rp : GH.lp) : GH.tilde, ph < 0.6 ? 3 : 2);
        }
        for (var y3 = y1 + 1; y3 < R; y3++) {
          var k = y3 - y1;
          for (var x3 = x0 - k * 3; x3 <= x1 + k * 3; x3++) if (hash(x3 * 19 + y3 * 7) < 0.4 / k) o.put(x3, y3, GH.dot, 2);
        }
        sp.draw(o, dt);
      },
      note: function (m, v) { sp.add(noteX(m, C), Math.floor(rnd(TOP_ROWS + 1, R - 2)), 1.6, false); }
    };
  };

  // закат: низкое солнце в полосах, горизонт, отражение
  SCENES.sunset = function (C, R) {
    var sp = new Sparks(8);
    return {
      frame: function (o, T, dt) {
        o.clear();
        var hor = R * 0.62, cx = C * 0.62 / ASP, r = Math.max(2.6, R * 0.3), cy = hor + r * 0.15;
        for (var y = 0; y < Math.floor(hor); y++) {
          var d = (hor - y) / hor;
          for (var x = 0; x < C; x++) {
            var v = fbm(x * 0.025 + T * 0.01, y * 0.45, 2) * 0.5 + 0.5;
            if (v * (1 - d) > 0.38 && hash(x * 11 + y * 53) < 0.5) o.put(x, y, d < 0.3 ? GH.dash : GH.dot, d < 0.3 ? 3 : 2);
          }
        }
        shape(o, (cx - r) * ASP - 2, cy - r - 1, (cx + r) * ASP + 2, hor - 0.6, circleF(cx, cy, r), 7, function (o2, x, y, dep) {
          var yy = y - (cy - r), gapOn = yy > r * 0.9 && (y % 2 === 0);      // полосы в нижней половине
          if (gapOn) { o2.t[y * o2.cols + x] = 0; return; }
          o2.put(x, y, STR0 + 4, 5);
        }, true);
        for (var c = 0; c < C; c++) for (var y4 = Math.floor(hor); y4 < R; y4++) o.t[y4 * C + c] = 0;
        curve(o, function () { return hor; }, 0, C, 6);
        for (var y2 = Math.floor(hor) + 1; y2 < R; y2++) {
          var k = y2 - hor, wd = r * ASP * (1.1 - k * 0.12);
          for (var x3 = 0; x3 < C; x3++) {
            var dx = Math.abs(x3 - cx * ASP), sh = Math.sin(x3 * 0.6 + T * 0.7 + k * 2.1);
            if (dx < wd && sh > 0) o.put(x3, y2, GH.h, dx < wd * 0.5 ? 5 : 3);
            else if (hash(x3 * 7 + y2 * 29) < 0.05) o.put(x3, y2, GH.dash, 2);
          }
        }
        sp.draw(o, dt);
      },
      note: function (m, v) { sp.add(noteX(m, C), Math.floor(rnd(1, R * 0.5)), 1.8, v > 0.7); }
    };
  };

  // невесомость: парящие частицы
  SCENES.weightless = function (C, R) {
    var ps = [];
    for (var i = 0; i < Math.round(C * R * 0.028); i++) ps.push({ x: rnd(0, C), y: rnd(0, R), vx: rnd(-0.25, 0.25), vy: rnd(-0.18, 0.08), z: Math.random(), p: rnd(0, TAU) });
    var sp = new Sparks(10);
    return {
      frame: function (o, T, dt) {
        o.clear();
        for (var k = 0; k < ps.length; k++) {
          var q = ps[k];
          q.x += (q.vx + 0.15 * Math.sin(T * 0.2 + q.p)) * dt; q.y += (q.vy + 0.1 * Math.cos(T * 0.17 + q.p)) * dt;
          if (q.x < -1) q.x += C + 2; if (q.x > C + 1) q.x -= C + 2; if (q.y < -1) q.y += R + 2; if (q.y > R + 1) q.y -= R + 2;
          var g = q.z > 0.88 ? GH.O : q.z > 0.65 ? GH.o : q.z > 0.4 ? GH.deg : GH.mid;
          o.max(Math.round(q.x), Math.round(q.y), g, Math.max(1, Math.round(1 + q.z * 5)));
        }
        sp.draw(o, dt);
      },
      note: function (m, v) { sp.add(noteX(m, C), Math.floor(rnd(1, R - 1)), 2.4, v > 0.6); }
    };
  };

  // спокойствие: мягкие холмы, облако
  SCENES.calm = function (C, R) {
    var sp = new Sparks(8);
    return {
      frame: function (o, T, dt) {
        o.clear();
        var cx = ((T * 0.15) % (C + 40)) - 20, cy = R * 0.28;
        for (var y = 0; y < R * 0.55; y++) for (var x = 0; x < C; x++) {
          var dx = (x - cx) / 14, dy = (y - cy) / 1.7;
          var v = 1 - (dx * dx + dy * dy) + 0.5 * fbm(x * 0.12, y * 0.5 + T * 0.01, 2);
          if (v > 0.3 && hash(x * 3 + y * 17) < 0.75) o.put(x, y, v > 0.75 ? GH.colon : GH.mid, v > 0.6 ? 3 : 2);
        }
        terrain(o, ridgeFn(C, R * 0.62, R * 0.14, 3.5, 5.3), 3, 0, 0, 1);
        terrain(o, ridgeFn(C, R * 0.8, R * 0.12, 5, 9.1), 5, 2, 0.14, 2);
        sp.draw(o, dt);
      },
      note: function (m, v) { sp.add(noteX(m, C), Math.floor(rnd(1, R * 0.5)), 2.0, v > 0.7); }
    };
  };

  // свой звук: медленный рельеф из параметров
  SCENES.custom = function (C, R) {
    var sp = new Sparks(10), seed = Math.random() * 50;
    return {
      frame: function (o, T, dt) {
        o.clear();
        var rough = 2 + pv('drift', 0.3) * 6, height = 0.25 + pv('padBright', 0.4) * 0.3, space = pv('reverbSize', 0.6);
        stars(o, Math.round(R * 0.5), 0.004 + space * 0.012, T * 0.4, 3, 3);
        terrain(o, function (x) { return R - R * (height + 0.12) - R * 0.16 * fbm(x / C * rough * 0.6 + seed + T * 0.003, seed + 3, 3); }, 3, 0, 0, 4);
        terrain(o, function (x) { return R - R * height - R * 0.2 * fbm(x / C * rough + seed + T * 0.004, seed, 4); }, 5, 2, 0.12, 7);
        var rain = pv('rainLevel', 0);
        if (rain > 0.05) for (var k = 0; k < C * R * 0.02 * rain; k++) {
          var hx = hash(k * 31 + 7), hy = (hash(k * 17 + 3) + T * 0.6) % 1;
          o.max(Math.floor(hx * C - hy * R * 0.5 + C) % C, Math.floor(hy * R), GH.d1, 2);
        }
        sp.draw(o, dt);
      },
      note: function (m, v) { sp.add(noteX(m, C), Math.floor(rnd(1, R * 0.55)), 2.0, v > 0.7); }
    };
  };

  function waveHz() { return 0.1 * Math.pow(2, -0.8 * (pv('noiseWaves', 0.5) - 0.5)); }

  // ---------------------------------------------------------------- пейзаж: менеджер и смена сцен
  var Land = {
    cur: null, curId: null, nxt: null, nxtId: null, a: null, b: null, morph: 0, cols: 0, rows: 0, T: 0, order: null,
    sceneFor: function (id) { return id && SCENES[id] && id !== 'custom' ? id : 'custom'; },
    ensure: function (cols, rows) {
      if (cols !== this.cols || rows !== this.rows) {
        this.cols = cols; this.rows = rows;
        this.a = new Buf(cols, rows); this.b = new Buf(cols, rows);
        this.order = new Float32Array(cols * rows);
        for (var i = 0; i < this.order.length; i++) this.order[i] = hash(i * 7349 + 11);
        this.cur = null; this.nxt = null;
      }
      var want = this.sceneFor(preset.id);
      if (!this.cur) { this.cur = SCENES[want](cols, rows); this.curId = want; }
      else if (want !== (this.nxt ? this.nxtId : this.curId)) {
        if (this.nxt) { this.cur = this.nxt; this.curId = this.nxtId; var t = this.a; this.a = this.b; this.b = t; }
        this.nxt = SCENES[want](cols, rows); this.nxtId = want; this.morph = 0;
      }
    },
    note: function (m, v) {
      try { if (this.cur) this.cur.note(m, v); if (this.nxt) this.nxt.note(m, v); } catch (e) {}
    },
    frame: function (o, w, dt, speed) {
      this.ensure(o.cols, o.rows);
      var d = dt * speed;
      this.T += d;
      this.cur.frame(this.a, this.T, d);
      var src = this.a;
      if (this.nxt) {
        this.nxt.frame(this.b, this.T, d);
        this.morph += dt / (reduced ? 0.6 : 1.5);
        if (this.morph >= 1) {
          this.cur = this.nxt; this.curId = this.nxtId; this.nxt = null;
          var t = this.a; this.a = this.b; this.b = t; src = this.a;
        } else {
          var p = this.morph, n = o.n, A = this.a, B = this.b, ord = this.order;
          for (var i = 0; i < n; i++) {
            var h = ord[i];
            if (h < p - 0.08) { o.g[i] = B.g[i]; o.t[i] = B.t[i]; }
            else if (h < p) { var s = B.t[i] ? B : A; o.g[i] = s.g[i] === GH.sp ? GH.dot : (s.t[i] ? GH.mid : 0); o.t[i] = s.t[i] ? 2 : 0; }
            else { o.g[i] = A.g[i]; o.t[i] = A.t[i]; }
          }
          return;
        }
      }
      o.g.set(src.g); o.t.set(src.t);
    }
  };

  // ---------------------------------------------------------------- кольцо дыхания
  var Breath = {
    on: 0, ph: 0,
    wanted: function () {
      if (preset.id === 'meditation') return true;
      if (preset.id && preset.id.indexOf('user:') !== 0) return false;
      return pv('noiseWaves', 0) >= 0.45 && pv('notesDensity', 1) <= 0.05;
    },
    frame: function (o, dt) {
      this.on = follow(this.on, this.wanted() ? 1 : 0, dt, 1.5);
      this.ph = (this.ph + dt * waveHz() * (reduced ? 1 : 1)) % 1;
      if (this.on < 0.03) return;
      var cols = o.cols, rows = o.rows, cx = cols / 2, cy = (rows + TOP_ROWS) / 2 - 0.3;
      var e = 0.5 - 0.5 * Math.cos(this.ph * TAU);                  // 0 → 1 → 0 за один период волны
      var rmax = Math.min((rows - TOP_ROWS) * 0.42, cols / 4.2), rmin = rmax * 0.38, r = lerp(rmin, rmax, e);
      var n = Math.round(r * 10 + 14), tone = Math.max(1, Math.round(this.on * (3 + e * 2)));
      for (var s = 0; s < n; s++) {
        var an = s / n * TAU, px = cx + Math.cos(an) * r * 1.95, py = cy + Math.sin(an) * r;
        var row = Math.floor(py), lv = Math.floor((py - row) * 8);
        o.put(Math.round(px), row, DOT0 + clamp(lv, 0, 7), tone);
      }
      // подписи: «вдох» пока круг растёт, «выдох» пока сжимается
      var inhale = this.ph < 0.5, f = Math.sin(this.ph * 2 * Math.PI), a = Math.abs(f);
      var lab = inhale ? 'inhale' : 'exhale', lt = Math.max(0, Math.round(this.on * (1 + a * 2.6)));
      if (lt >= 1) o.text(Math.round(cx - lab.length / 2), Math.round(cy), lab, lt);
    }
  };

  // ---------------------------------------------------------------- герой: холст, режимы, переключатель
  var TOP_ROWS = 2;
  var Hero = {
    el: null, cv: null, grid: null, seg: null, btns: {}, mode: 'lyre', buf: null, snap: null, snapP: 1,
    init: function (el) {
      this.el = el;
      var cv = document.createElement('canvas');
      cv.className = 'stg-hero'; cv.setAttribute('aria-hidden', 'true');
      el.insertBefore(cv, el.firstChild);
      this.cv = cv; this.grid = new Grid(cv, true);
      var seg = document.createElement('div');
      seg.className = 'stg-seg'; seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'view');
      var self = this;
      MODES.forEach(function (m, i) {
        if (i) { var sep = document.createElement('span'); sep.className = 'stg-sep'; sep.setAttribute('aria-hidden', 'true'); sep.textContent = '·'; seg.appendChild(sep); }
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'stg-mode'; b.textContent = MODE_NAMES[m];
        b.setAttribute('role', 'radio'); b.setAttribute('data-mode', m);
        b.addEventListener('click', function () { self.setMode(m, true); });
        b.addEventListener('keydown', function (e) {
          var k = e.key, d = k === 'ArrowRight' || k === 'ArrowDown' ? 1 : k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          var nm = MODES[(MODES.indexOf(self.mode) + d + MODES.length) % MODES.length];
          self.setMode(nm, true); self.btns[nm].focus();
        });
        self.btns[m] = b; seg.appendChild(b);
      });
      el.appendChild(seg);
      this.seg = seg;
      var saved = null;
      try { saved = window.localStorage.getItem(LS_KEY); } catch (e) { saved = null; }
      this.setMode(MODES.indexOf(saved) >= 0 ? saved : 'lyre', false);
    },
    setMode: function (m, save) {
      if (MODES.indexOf(m) < 0) return;
      if (m !== this.mode && this.buf) { this.snap = { g: this.buf.g.slice(), t: this.buf.t.slice() }; this.snapP = 0; }
      this.mode = m;
      for (var k in this.btns) {
        var on = k === m;
        this.btns[k].setAttribute('aria-checked', on ? 'true' : 'false');
        this.btns[k].tabIndex = on ? 0 : -1;
      }
      if (save) { try { window.localStorage.setItem(LS_KEY, m); } catch (e) {} }
    },
    layout: function () {
      if (!this.el) return;
      var r = this.el.getBoundingClientRect(), w = Math.round(r.width), h = Math.round(r.height);
      if (w < 10 || h < 10) { this.cv.style.display = 'none'; return; }
      this.cv.style.display = '';
      var small = w < 560;
      var cell = small ? 6.6 : 7.2;
      if (this.grid.layout(w, h, cell, 1.9) || !this.buf) {
        this.buf = new Buf(this.grid.cols, this.grid.rows);
        this.snap = null;
      }
      this.cv.style.width = w + 'px'; this.cv.style.height = h + 'px';
      // ряды под переключателем
      var segH = this.seg ? this.seg.getBoundingClientRect().height : 24;
      TOP_ROWS = Math.max(1, Math.ceil((segH + 2) * this.grid.dpr / this.grid.ch));
      this.segCols = this.seg ? Math.ceil((this.seg.getBoundingClientRect().width + 6) * this.grid.dpr / this.grid.cw) : 0;
    },
    frame: function (dt, w) {
      var G = this.grid;
      if (!G || !G.n || !this.buf) return 0;
      var o = this.buf, still = !AU.playing;
      var speed = reduced ? 0.25 : lerp(0.12, 1, AU.active);
      o.clear();
      try {
        if (this.mode === 'lyre') Lyre.frame(o, w, dt, still);
        else if (this.mode === 'river') River.frame(o, w, dt);
        else Land.frame(o, w, dt, speed);
        Breath.frame(o, dt);
      } catch (e) { if (window.console) console.error(e); }
      // под переключателем — пусто
      for (var y = 0; y < TOP_ROWS && y < o.rows; y++) for (var x = 0; x < this.segCols && x < o.cols; x++) o.t[y * o.cols + x] = 0;
      // смена режима: растворение
      if (this.snap && this.snapP < 1) {
        this.snapP += dt / 0.7;
        var s = this.snap, ord = G.hash;
        for (var i = 0; i < o.n; i++) if (ord[i] > this.snapP) { o.g[i] = s.g[i]; o.t[i] = s.t[i]; }
      }
      G.g.set(o.g); G.t.set(o.t);
      return G.draw();
    }
  };

  // ================================================================ 6. ночник и заставка

  // ночник: затемнение страницы в такт затуханию звука (линейно по дБ → по непрозрачности), в конце — одна синяя точка
  var Night = {
    el: null, dot: null, state: 'idle', s0: 0, sec: 1, op: 0, liftUntil: 0, lift: 0, endAt: 0, back0: 0, backFrom: 0, backDur: 1,
    MAX: 0.94,
    init: function () {
      var el = document.createElement('div');
      el.className = 'stg-night'; el.setAttribute('aria-hidden', 'true');
      var d = document.createElement('div'); d.className = 'stg-dot'; el.appendChild(d);
      document.body.appendChild(el);
      this.el = el; this.dot = d;
      var self = this;
      function poke() { self.interact(); }
      document.addEventListener('pointerdown', poke, true);
      document.addEventListener('keydown', poke, true);
    },
    start: function (sec) {
      this.state = 'fading'; this.s0 = wall(); this.sec = Math.max(1, +sec || 60); this.liftUntil = 0;
      this.el.style.background = nightColor; this.el.style.display = 'block';
      this.dot.classList.remove('on');
    },
    end: function () {
      if (this.state === 'idle') return;
      this.state = 'done'; this.endAt = wall();
      this.el.style.display = 'block';
      this.dot.classList.add('on');
    },
    cancel: function () { if (this.state !== 'idle') this.back(1); },
    back: function (dur) { this.state = 'back'; this.back0 = wall(); this.backFrom = this.op; this.backDur = dur; this.dot.classList.remove('on'); },
    interact: function () {
      if (this.state === 'fading') this.liftUntil = wall() + 6;
      else if (this.state === 'done') this.back(1.5);
    },
    target: function (w) {
      if (this.state === 'fading') {
        var p = clamp01((w - this.s0) / this.sec);
        return this.MAX * p;                     // дБ звука идут линейно во времени → темнота тоже
      }
      if (this.state === 'done') return this.MAX;
      if (this.state === 'back') return this.backFrom * (1 - sstep((w - this.back0) / this.backDur));
      return 0;
    },
    frame: function (dt, w) {
      if (this.state === 'idle') return;
      var tg = this.target(w);
      // касание во время затухания: на 6 с приподнять затемнение
      var want = this.state === 'fading' && w < this.liftUntil ? 1 : 0;
      this.lift = follow(this.lift, want, dt, 0.35, 1.6);
      var op = tg * (1 - 0.85 * this.lift);
      this.op = op;
      this.el.style.opacity = op.toFixed(3);
      if (this.state === 'done' && w - this.endAt > 10) this.dot.classList.remove('on');
      if (this.state === 'back' && w - this.back0 >= this.backDur) { this.state = 'idle'; this.op = 0; this.el.style.opacity = '0'; this.el.style.display = 'none'; }
    }
  };

  // заставка: «orpheus» крупно из глифов, затем символы рассыпаются и тают в поле
  var Splash = {
    done: false, cv: null, grid: null, parts: null, t0: 0, cols: 0, rows: 0, running: false,
    play: function () {
      if (this.done) return;
      this.done = true;
      try { this.build(); } catch (e) { this.cleanup(); }
    },
    build: function () {
      var vw = window.innerWidth, vh = window.innerHeight, small = vw < 720;
      var cv = document.createElement('canvas');
      cv.className = 'stg-splash'; cv.setAttribute('aria-hidden', 'true');
      document.body.appendChild(cv);
      var G = new Grid(cv, false);
      G.layout(vw, vh, small ? 4.5 : 7, 2.0);
      cv.style.width = vw + 'px'; cv.style.height = vh + 'px';
      this.cv = cv; this.grid = G;
      // слово рисуем в маленький холст: 1 ячейка = sub px по ширине и sub·asp px по высоте (квадратные пиксели)
      var word = 'orpheus', cols = G.cols, rows = G.rows, asp = G.asp, sub = 4;
      var tw = Math.min(cols - 4, Math.round(cols * (small ? 0.84 : 0.56)));
      var oc = document.createElement('canvas'), c = oc.getContext('2d');
      var fs = 100;
      c.font = '400 ' + fs + 'px ' + MONO;
      fs = fs * tw * sub / Math.max(1, c.measureText(word).width);
      var bh = sub * asp, hc = Math.ceil(fs * 0.9 / bh) + 2, wc = tw;
      oc.width = wc * sub; oc.height = Math.ceil(hc * bh);
      c.font = '400 ' + fs + 'px ' + MONO; c.fillStyle = '#000'; c.textBaseline = 'middle'; c.textAlign = 'left';
      c.fillText(word, 0, oc.height * 0.5);
      var data = c.getImageData(0, 0, oc.width, oc.height).data;
      var x0 = Math.floor((cols - wc) / 2), y0 = Math.floor((rows - hc) / 2);
      var cov = new Float32Array(wc * hc);
      for (var y = 0; y < hc; y++) for (var x = 0; x < wc; x++) {
        var sm = 0, cnt = 0, ya = Math.floor(y * bh), yb = Math.min(oc.height, Math.floor((y + 1) * bh));
        for (var py = ya; py < yb; py++) for (var px = x * sub; px < (x + 1) * sub; px++) { sm += data[(py * oc.width + px) * 4 + 3]; cnt++; }
        cov[y * wc + x] = cnt ? sm / cnt / 255 : 0;
      }
      function cv2(x, y) { return x < 0 || y < 0 || x >= wc || y >= hc ? 0 : cov[y * wc + x]; }
      var parts = [];
      for (var y2 = 0; y2 < hc; y2++) for (var x2 = 0; x2 < wc; x2++) {
        var v = cv2(x2, y2);
        if (v < 0.12) continue;
        // край: глиф по направлению контура (перпендикуляр к градиенту покрытия), внутри — мягкая заливка
        var gx = cv2(x2 + 1, y2) - cv2(x2 - 1, y2), gy = (cv2(x2, y2 + 1) - cv2(x2, y2 - 1)) / asp;
        var gm = Math.sqrt(gx * gx + gy * gy), g, kind;
        if (v > 0.82 && gm < 0.35) { g = GH.colon; kind = 0; }
        else {
          kind = 1;
          var ax = Math.abs(gx), ay = Math.abs(gy);
          if (ay > ax * 2.2) g = gy > 0 ? GH.under : GH.h;                // горизонтальный край
          else if (ax > ay * 2.2) g = GH.v;                              // вертикальный
          else g = (gx > 0) === (gy > 0) ? GH.d1 : GH.d2;
          if (v < 0.3) g = (g === GH.v) ? GH.vd : g;
        }
        var X = x0 + x2, Y = y0 + y2;
        var ang = Math.atan2((Y - rows / 2) * asp, X - cols / 2) + rnd(-0.6, 0.6);
        var spd = rnd(3, 10);
        parts.push({ x: X, y: Y, g: g, k: kind, v: v, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd / asp - rnd(0, 0.8), d: rnd(0, 0.4), h: Math.random() });
      }
      this.parts = parts; this.t0 = wall(); this.running = true;
    },
    frame: function (dt, w) {
      if (!this.running) return 0;
      var G = this.grid, age = w - this.t0, P = this.parts, cols = G.cols, rows = G.rows;
      var hold = reduced ? 0.6 : 0.6, inT = reduced ? 0.15 : 0.35, out = reduced ? 0.4 : 1.6;
      G.clear();
      var total = inT + hold + out;
      if (age > total) { this.cleanup(); return 0; }
      if (reduced) {
        var a = age < inT ? age / inT : age < inT + hold ? 1 : 1 - (age - inT - hold) / out;
        this.cv.style.opacity = clamp01(a).toFixed(3);
      }
      // вуаль цвета фона под словом: страница на миг затихает и возвращается вместе с разлётом
      var veil = age < inT ? sstep(age / inT) : age < inT + hold ? 1 : 1 - sstep((age - inT - hold) / (out * 0.75));
      this.cv.style.backgroundColor = 'rgba(' + colors.bg.map(Math.round).join(',') + ',' + (veil * 0.92).toFixed(3) + ')';
      for (var k = 0; k < P.length; k++) {
        var p = P[k], x = p.x, y = p.y, g = p.g, t, f = 1;
        if (age < inT) {
          if (p.h > age / inT * 1.2) continue;                 // проявление в случайном порядке
        } else if (age > inT + hold && !reduced) {
          var u = clamp01((age - inT - hold - p.d) / (out - 0.45));
          if (u >= 1) continue;
          var e = 1 - Math.pow(1 - u, 2.4);
          x = p.x + p.vx * e * 1.5; y = p.y + p.vy * e * 1.5; f = 1 - u;
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
          if (u > 0.15) g = u > 0.55 ? GH.dot : GH.mid;
        }
        if (f >= 1) t = p.k ? (p.v > 0.5 ? 8 : 6) : 4;
        else t = f > 0.75 ? (p.k ? 6 : 4) : f > 0.5 ? 4 : f > 0.3 ? F4 : f > 0.15 ? F3 : F2t;
        if (p.h < 0.05 && f > 0.4 && age > inT * 0.5) t = ACC3;
        var i = (y | 0) * cols + (x | 0);
        G.g[i] = g; G.t[i] = t;
      }
      return G.draw();
    },
    cleanup: function () {
      this.running = false;
      if (this.cv && this.cv.parentNode) this.cv.parentNode.removeChild(this.cv);
      this.cv = null; this.grid = null; this.parts = null;
    }
  };

  // ================================================================ 7. цикл и монтирование

  var CSS = [
    '.stg-field{position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:0;pointer-events:none;display:block}',
    ':where(#stage){position:relative;display:block}',
    '#stage .stg-hero{position:absolute;left:0;top:0;display:block;pointer-events:none;transition:opacity 1.4s cubic-bezier(.2,.7,.2,1)}',
    '#stage .stg-hero.still{opacity:.8}',
    '#stage .stg-seg{position:absolute;left:0;top:0;z-index:1;display:flex;align-items:center;gap:0;font-size:12px;line-height:1;color:var(--muted)}',
    '#stage .stg-mode{font:inherit;font-size:12px;color:var(--muted);background:transparent;border:0;margin:0;padding:6px 6px 8px;border-radius:6px;cursor:pointer;',
    'letter-spacing:.02em;transition:color .25s cubic-bezier(.2,.7,.2,1);position:relative}',
    '#stage .stg-mode:first-child{padding-left:0}',
    '#stage .stg-mode::after{content:"";position:absolute;inset:-6px -2px}',
    '#stage .stg-mode:hover{color:var(--accent)}',
    '#stage .stg-mode[aria-checked="true"]{color:var(--fg)}',
    '#stage .stg-mode:focus{outline:none}#stage .stg-mode:focus-visible{outline:2px solid var(--accent);outline-offset:1px}',
    '#stage .stg-sep{color:var(--line);padding:0 1px;user-select:none}',
    '.stg-night{position:fixed;inset:0;z-index:50;pointer-events:none;display:none;opacity:0}',
    '.stg-dot{position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:var(--accent);opacity:0;transition:opacity 2.5s ease}',
    '.stg-dot.on{opacity:.55;animation:stg-pulse 5s ease-in-out infinite}',
    '@keyframes stg-pulse{0%,100%{opacity:.18}50%{opacity:.6}}',
    '.stg-splash{position:fixed;left:0;top:0;z-index:40;pointer-events:none;display:block}',
    '@media (prefers-reduced-motion:reduce){#stage .stg-hero,.stg-dot{transition:none}.stg-dot.on{animation:none;opacity:.4}}'
  ].join('\n');

  var mounted = false, reduced = false, raf = 0, lastFrame = 0, lastT = 0, needLayout = true, mqDark = null, mqReduce = null;
  var stats = { n: 0, sum: 0, max: 0, samples: [], field: 0, hero: 0, cells: 0 };
  var lastFieldDraw = 0;

  function vizOpen() { try { return !!(window.AmbientViz && window.AmbientViz.isOpen); } catch (e) { return false; } }

  function setPreset(id, name) {
    preset = { id: id == null ? null : String(id), name: name || '' };
  }

  function onPresetEv(e) { var d = e && e.detail || {}; presetSeen = true; setPreset(d.id, d.name); }
  var everPlayed = false;
  function onTransportEv(e) {
    var d = e && e.detail || {};
    if (d.playing && !everPlayed) { everPlayed = true; Splash.play(); }
  }
  function onSleepEv(e) {
    var d = e && e.detail || {};
    if (d.state === 'start') Night.start(d.sec);
    else if (d.state === 'end') Night.end();
    else if (d.state === 'cancel') Night.cancel();
  }

  function frame(now) {
    raf = 0;
    if (document.hidden) return;
    schedule();
    var minDt = reduced ? 1000 / 8 : 1000 / 30;
    if (now - lastFrame < minDt - 2) return;
    var dt = lastT ? Math.min(0.1, Math.max(0.001, (now - lastT) / 1000)) : 1 / 30;
    lastFrame = now; lastT = now;
    var w = wall();
    var t0 = performance.now();
    try {
      readLevel(dt);
      readParams(dt);
      drainQueue(); dropQueueIfStopped();
      Night.frame(dt, w);
      if (vizOpen()) return;
      if (needLayout) { needLayout = false; Field.layout(); Hero.layout(); }
      // первая «живая» игра — заставка (если UI не прислал orpheus:transport)
      if (AU.playing && !everPlayed) { everPlayed = true; Splash.play(); }
      stepRange(dt);
      River.step(dt);
      var hc = 0, fc = 0;
      if (Hero.grid) {
        hc = Hero.frame(dt, w);
        if (Hero.cv) Hero.cv.classList.toggle('still', !AU.playing);
      }
      // поле в покое обновляем реже
      var fieldEvery = reduced ? 2 : (AU.active > 0.05 || Field.ripples.length || Field.waves.length ? 0 : 0.2);
      if (w - lastFieldDraw >= fieldEvery) { fc = Field.frame(Math.min(0.5, w - lastFieldDraw || dt), w) || 0; lastFieldDraw = w; }
      Splash.frame(dt, w);
      stats.cells = hc + fc;
    } catch (e) { if (window.console) console.error(e); }
    var ms = performance.now() - t0;
    stats.n++; stats.sum += ms; if (ms > stats.max) stats.max = ms;
    stats.samples.push(ms); if (stats.samples.length > 600) stats.samples.shift();
  }
  function schedule() { if (!raf && !document.hidden) raf = requestAnimationFrame(frame); }

  function onTheme() {
    requestAnimationFrame(function () {
      readTheme();
      if (Night.state !== 'idle') Night.el.style.background = nightColor;
      if (Hero.grid) Hero.grid.full = true;
      if (Field.grid) Field.grid.full = true;
    });
  }
  function onReduce() { reduced = !!(mqReduce && mqReduce.matches); }

  function mount() {
    if (mounted) { attachHero(); return api; }
    if (!document.body) { document.addEventListener('DOMContentLoaded', mount); return api; }
    mounted = true;
    var st = document.createElement('style'); st.setAttribute('data-orpheus-stage', ''); st.textContent = CSS;
    (document.head || document.body).appendChild(st);
    readTheme();
    mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    mqReduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    onReduce();
    [[mqDark, onTheme], [mqReduce, onReduce]].forEach(function (p) {
      var mq = p[0]; if (!mq) return;
      if (mq.addEventListener) mq.addEventListener('change', p[1]); else if (mq.addListener) mq.addListener(p[1]);
    });
    try { new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] }); } catch (e) {}
    Field.init();
    Night.init();
    attachHero();
    window.addEventListener('resize', function () { needLayout = true; schedule(); });
    window.addEventListener('orientationchange', function () { needLayout = true; });
    window.addEventListener('scroll', function () { Field.maskDirty = true; }, { passive: true });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { lastT = 0; needLayout = true; schedule(); } });
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', function () { themeGen++; });
    try { if (document.fonts && document.fonts.load) document.fonts.load('400 12px "JetBrains Mono"').then(function () { themeGen++; }, function () {}); } catch (e) {}
    document.addEventListener('orpheus:preset', onPresetEv);
    document.addEventListener('orpheus:transport', onTransportEv);
    document.addEventListener('orpheus:sleepfade', onSleepEv);
    subscribe();
    schedule();
    return api;
  }
  function attachHero() {
    if (Hero.el) return;
    var el = document.getElementById('stage');
    if (!el) return;
    Hero.init(el);
    needLayout = true;
    if ('ResizeObserver' in window) new ResizeObserver(function () { needLayout = true; Field.maskDirty = true; schedule(); }).observe(el);
    var app = document.getElementById('app');
    if (app && 'ResizeObserver' in window) new ResizeObserver(function () { Field.maskDirty = true; }).observe(app);
  }
  var subscribed = false;
  function subscribe() {
    if (subscribed) return;
    var amb = window.Ambient;
    if (amb && typeof amb.onEvent === 'function') { amb.onEvent(onEngineEvent); subscribed = true; }
  }

  function frameStats() {
    var s = stats.samples.slice().sort(function (a, b) { return a - b; });
    var q = function (p) { return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
    return { frames: stats.n, avg: stats.n ? stats.sum / stats.n : 0, p50: q(0.5), p95: q(0.95), max: stats.max };
  }

  var api = {
    mount: mount,
    setMode: function (m) { Hero.setMode(m, true); },
    stats: frameStats,
    resetStats: function () { stats.n = 0; stats.sum = 0; stats.max = 0; stats.samples = []; },
    // для тестов и отладки
    _night: Night, _splash: Splash, _hero: Hero, _field: Field, _lyre: Lyre, _river: River, _land: Land,
    _preset: function () { return preset; }, _scenes: SCENES
  };
  Object.defineProperty(api, 'mode', { get: function () { return Hero.mode; }, enumerable: true });
  window.OrpheusStage = api;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
