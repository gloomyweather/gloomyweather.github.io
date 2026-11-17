/* viz.js — полноэкранный ascii-визуализатор для orpheus.
   Classic script, без модулей и библиотек. Определяет window.AmbientViz = { open(), close(), isOpen }.
   Читает (только читает) window.Ambient.analyser / .running / .getAll(). Никогда не вызывает set/start/stop.

   Устройство:
     1. шум (simplex 2d/3d), хэш, дизеринг
     2. сетка символов: canvas + атлас глифов (тайл = символ × тон, непрозрачный фон), рисуются только изменившиеся ячейки
     3. аудио-признаки: уровень, низ / середина / верх, медленная огибающая, онсеты по спектральному потоку
     4. сцены: каждая пишет в свой буфер (глиф + тон) — переходы смешивают два буфера по «шумовому» порогу
     5. оверлей, управление, жизненный цикл
*/
(function () {
  'use strict';

  var TAU = Math.PI * 2;

  // ================================================================ 1. шум

  var perm = new Uint8Array(512), pm12 = new Uint8Array(512);
  (function seed() {
    var p = new Uint8Array(256), i, j, t;
    for (i = 0; i < 256; i++) p[i] = i;
    for (i = 255; i > 0; i--) { j = (Math.random() * (i + 1)) | 0; t = p[i]; p[i] = p[j]; p[j] = t; }
    for (i = 0; i < 512; i++) { perm[i] = p[i & 255]; pm12[i] = perm[i] % 12; }
  })();
  var GX = new Float32Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0]);
  var GY = new Float32Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1]);
  var GZ = new Float32Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1]);
  var F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;

  function noise2(xin, yin) {
    var s = (xin + yin) * F2;
    var i = Math.floor(xin + s), j = Math.floor(yin + s);
    var t = (i + j) * G2;
    var x0 = xin - (i - t), y0 = yin - (j - t);
    var i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    var x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    var x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    var ii = i & 255, jj = j & 255, n = 0, g, tt;
    tt = 0.5 - x0 * x0 - y0 * y0;
    if (tt > 0) { g = pm12[ii + perm[jj]]; tt *= tt; n += tt * tt * (GX[g] * x0 + GY[g] * y0); }
    tt = 0.5 - x1 * x1 - y1 * y1;
    if (tt > 0) { g = pm12[ii + i1 + perm[jj + j1]]; tt *= tt; n += tt * tt * (GX[g] * x1 + GY[g] * y1); }
    tt = 0.5 - x2 * x2 - y2 * y2;
    if (tt > 0) { g = pm12[ii + 1 + perm[jj + 1]]; tt *= tt; n += tt * tt * (GX[g] * x2 + GY[g] * y2); }
    return 70 * n;
  }

  var F3 = 1 / 3, G3 = 1 / 6;
  function noise3(xin, yin, zin) {
    var s = (xin + yin + zin) * F3;
    var i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    var t = (i + j + k) * G3;
    var x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
    var i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    var x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    var x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    var x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    var ii = i & 255, jj = j & 255, kk = k & 255, n = 0, g, tt;
    tt = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (tt > 0) { g = pm12[ii + perm[jj + perm[kk]]]; tt *= tt; n += tt * tt * (GX[g] * x0 + GY[g] * y0 + GZ[g] * z0); }
    tt = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (tt > 0) { g = pm12[ii + i1 + perm[jj + j1 + perm[kk + k1]]]; tt *= tt; n += tt * tt * (GX[g] * x1 + GY[g] * y1 + GZ[g] * z1); }
    tt = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (tt > 0) { g = pm12[ii + i2 + perm[jj + j2 + perm[kk + k2]]]; tt *= tt; n += tt * tt * (GX[g] * x2 + GY[g] * y2 + GZ[g] * z2); }
    tt = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (tt > 0) { g = pm12[ii + 1 + perm[jj + 1 + perm[kk + 1]]]; tt *= tt; n += tt * tt * (GX[g] * x3 + GY[g] * y3 + GZ[g] * z3); }
    return 32 * n;
  }

  function fbm2(x, y, oct) {
    var s = 0, a = 0.5, n = 0;
    for (var o = 0; o < oct; o++) { s += a * noise2(x, y); n += a; x = x * 2.03 + 17.1; y = y * 2.03 - 9.7; a *= 0.5; }
    return s / n;
  }

  // целочисленный хэш → [0, 1)
  function hash(n) {
    n = (n ^ 61) ^ (n >>> 16); n = (n + (n << 3)) | 0; n ^= n >>> 4;
    n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15;
    return (n >>> 0) / 4294967296;
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function smooth(a, b, v) { v = clamp01((v - a) / (b - a)); return v * v * (3 - 2 * v); }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  // упорядоченный дизеринг 4×4, значения в (-0.5, 0.5)
  var BAYER = new Float32Array([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
  for (var bi = 0; bi < 16; bi++) BAYER[bi] = (BAYER[bi] + 0.5) / 16 - 0.5;

  // ================================================================ 2. глифы и тоны

  var CHARS = ' .·:-=+*#%@' +              // 0..10 — основная шкала плотности
    ',\'`~^_|/\\()<>oO°•∙x' +
    '0123456789' +
    '─│╱╲┼═║┃╎¦≈∗╭╮╰╯';
  var GL = [];
  (function () { var seen = {}; for (var i = 0; i < CHARS.length; i++) { var c = CHARS[i]; if (!seen[c]) { seen[c] = 1; GL.push(c); } } })();
  var NG = GL.length;
  // после шрифтовых глифов — 256 «брайлевских» узоров 2×4 точки и треугольник; рисуются в атласе вручную,
  // поэтому не зависят от того, есть ли брайль в шрифте устройства
  var BR0 = NG, TRI = NG + 256, NGT = NG + 257;
  // бит точки: (sx, sy) → sy * 2 + sx
  function gi(c) { var k = GL.indexOf(c); return k < 0 ? 0 : k; }
  function gis(s) { var a = new Uint16Array(s.length); for (var i = 0; i < s.length; i++) a[i] = gi(s[i]); return a; }

  var RAMP = gis(' .·:-=+*#%@');
  var NR = RAMP.length - 1;

  // тоны: 0 — пусто, 1..8 — от фона через --muted к --fg, 9..11 — акцент
  var NT = 12;
  var ACC1 = 9, ACC2 = 10, ACC3 = 11;
  var TONE_U = [0, 0.3, 0.46, 0.62, 0.8, 1.0, 1.28, 1.6, 2.0];
  var ACC_U = [0.5, 0.75, 1.0];

  var GH = {
    sp: gi(' '), dot: gi('.'), mid: gi('·'), colon: gi(':'), dash: gi('-'), eq: gi('='), plus: gi('+'), star: gi('*'),
    hash: gi('#'), at: gi('@'), comma: gi(','), apos: gi('\''), tick: gi('`'), tilde: gi('~'), caret: gi('^'), under: gi('_'),
    bar: gi('|'), slash: gi('/'), bslash: gi('\\'), lp: gi('('), rp: gi(')'), o: gi('o'), O: gi('O'), deg: gi('°'),
    bullet: gi('•'), bdot: gi('∙'), x: gi('x'),
    h: gi('─'), v: gi('│'), d1: gi('╱'), d2: gi('╲'), cross: gi('┼'), hh: gi('═'), vv: gi('║'), vb: gi('┃'), vd: gi('╎'), brk: gi('¦'),
    approx: gi('≈'), ast: gi('∗'), tri: TRI, cTL: gi('╭'), cTR: gi('╮'), cBL: gi('╰'), cBR: gi('╯'),
    digit0: gi('0')
  };

  // запись в буфер: тон берём максимальный (при наложении побеждает более яркий)
  function put(o, i, g, t) {
    var cur = o.t[i];
    if (t > cur || (cur >= ACC1 && t >= ACC1) || (t >= ACC1 && cur >= 5)) { o.t[i] = t; o.g[i] = g; }
  }
  function putXY(o, x, y, g, t) {
    x = x | 0; y = y | 0;
    if (x < 0 || y < 0 || x >= G.cols || y >= G.rows) return;
    put(o, y * G.cols + x, g, t);
  }
  // значение 0..1 → символ шкалы и тон, с дизерингом
  function shade(o, i, x, y, v) {
    if (v <= 0.004) { o.t[i] = 0; return; }
    var q = v * NR + (BAYER[((y & 3) << 2) | (x & 3)] * 0.5 + (G.hash[i] - 0.5) * 0.5) * 0.95;
    var k = q < 0.5 ? 0 : q >= NR ? NR : (q + 0.5) | 0;
    if (k === 0) { o.t[i] = 0; return; }
    var t = 1 + ((v * 7.999) | 0); if (t > 8) t = 8;
    o.g[i] = RAMP[k]; o.t[i] = t;
  }
  // мягкая шкала: всё ниже порога — пустота, формы проявляются из темноты; мало типов глифов внизу
  var RAMP_SOFT = gis(' ··+*#%@'), NRS = RAMP_SOFT.length - 1;
  function softShade(o, i, v, lo) {
    v = (v - lo) / (1 - lo);
    if (v <= 0) { o.t[i] = 0; return; }
    if (v > 1) v = 1;
    var q = Math.pow(v, 1.4) * NRS + (G.hash[i] - 0.5) * 0.6;
    var k = q < 0.3 ? 0 : q >= NRS ? NRS : q < 1 ? 1 : (q + 0.3) | 0;
    if (k === 0) { o.t[i] = 0; return; }
    o.g[i] = RAMP_SOFT[k]; o.t[i] = Math.min(8, 1 + ((v * v * 0.5 + v * 0.5) * 7.999) | 0);
  }
  // порог для точек 2×4 (упорядоченный дизеринг), индекс бита = sy * 2 + sx
  var DITH8 = new Float32Array([0, 4, 6, 2, 1, 5, 7, 3]);
  for (var di = 0; di < 8; di++) DITH8[di] = (DITH8[di] + 0.5) / 8;

  function toneOf(v) { if (v <= 0) return 0; var t = 1 + ((v * 7.999) | 0); return t > 8 ? 8 : t; }
  // глиф линии по направлению (dx в ширинах ячейки, dy в строках)
  function dirGlyph(dx, dy) {
    var px = dx, py = dy * G.asp;
    var ax = px < 0 ? -px : px, ay = py < 0 ? -py : py;
    if (ay < ax * 0.42) return GH.h;
    if (ax < ay * 0.42) return GH.v;
    return (px > 0) === (py > 0) ? GH.d2 : GH.d1;
  }
  function dirGlyphAscii(dx, dy) {
    var px = dx, py = dy * G.asp;
    var ax = px < 0 ? -px : px, ay = py < 0 ? -py : py;
    if (ay < ax * 0.42) return GH.dash;
    if (ax < ay * 0.42) return GH.bar;
    return (px > 0) === (py > 0) ? GH.bslash : GH.slash;
  }
  // линия по ячейкам; tone0/tone1 — тон в начале и в конце; dotted — каждая вторая ячейка точкой
  function line(o, x0, y0, x1, y1, t0, t1, dotted) {
    var dx = x1 - x0, dy = y1 - y0;
    var steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy) * 1.0));
    if (steps < 1) steps = 1;
    var g = dotted ? GH.mid : dirGlyph(dx, dy);
    var lastI = -1;
    for (var s = 0; s <= steps; s++) {
      var f = s / steps;
      var x = (x0 + dx * f + 0.5) | 0, y = (y0 + dy * f + 0.5) | 0;
      if (x < 0 || y < 0 || x >= G.cols || y >= G.rows) continue;
      var i = y * G.cols + x;
      if (i === lastI) continue; lastI = i;
      if (dotted && (s & 1)) continue;
      var t = Math.round(t0 + (t1 - t0) * f);
      if (t > 0) put(o, i, g, t);
    }
  }

  // ================================================================ сетка (общая для всех сцен)

  var G = {
    cols: 0, rows: 0, n: 0, asp: 2, unit: 1,
    cw: 0, ch: 0, ox: 0, oy: 0, W: 0, H: 0, dpr: 1, font: 0,
    hash: null       // Float32Array — постоянный случайный шум по ячейке
  };
  var MONO = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

  // ================================================================ 3. аудио

  var A = {
    level: 0, low: 0, mid: 0, high: 0, env: 0, onset: 0, flux: 0, active: 0,
    // сглаженные параметры звука
    rain: 0, waves: 0.3, density: 0.3, bright: 0.4, shimmer: 0.15, space: 0.6, drift: 0.4, root: 0, scale: 0
  };
  var spec = null, prevSpec = null, specBins = null, fluxMean = 0.01, lastOnset = 0, paramClock = 0;
  var PTarget = { rain: 0, waves: 0.3, density: 0.3, bright: 0.4, shimmer: 0.15, space: 0.6, drift: 0.4 };

  function readParams() {
    var amb = window.Ambient;
    if (!amb || typeof amb.getAll !== 'function') return;
    var p; try { p = amb.getAll(); } catch (e) { return; }
    if (!p) return;
    function num(v, d) { v = Number(v); return isFinite(v) ? clamp01(v) : d; }
    PTarget.rain = num(p.rainLevel, 0);
    PTarget.waves = num(p.noiseWaves, 0.3);
    PTarget.density = num(p.notesDensity, 0.3);
    PTarget.bright = num(p.padBright, 0.4);
    PTarget.shimmer = num(p.padShimmer, 0.15);
    PTarget.space = num(p.reverbSize, 0.6);
    PTarget.drift = num(p.drift, 0.4);
    A.root = p.root | 0; A.scale = p.scale | 0;
  }

  function follow(cur, target, dt, tauUp, tauDown) {
    var tau = target > cur ? tauUp : tauDown;
    return cur + (target - cur) * (1 - Math.exp(-dt / tau));
  }

  function updateAudio(dt, now) {
    paramClock -= dt;
    if (paramClock <= 0) { paramClock = 0.5; readParams(); }
    for (var k in PTarget) A[k] = follow(A[k], PTarget[k], dt, 2.5, 2.5);

    var amb = window.Ambient, an = amb && amb.analyser, lvl = 0, lo = 0, mi = 0, hi = 0, onset = 0;
    var live = !!(an && amb.running);
    if (live) {
      try {
        var nb = an.frequencyBinCount;
        if (!spec || spec.length !== nb) {
          spec = new Uint8Array(nb); prevSpec = new Uint8Array(nb);
          var hz = (an.context && an.context.sampleRate ? an.context.sampleRate : 48000) / an.fftSize;
          var b = function (f) { return Math.max(1, Math.min(nb - 1, Math.round(f / hz))); };
          specBins = [b(30), b(250), b(2000), b(8000), b(300), b(6000)];
        }
        an.getByteFrequencyData(spec);
        var s = 0, i;
        for (i = specBins[0]; i < specBins[1]; i++) s += spec[i];
        lo = s / (specBins[1] - specBins[0]) / 255;
        s = 0; for (i = specBins[1]; i < specBins[2]; i++) s += spec[i];
        mi = s / (specBins[2] - specBins[1]) / 255;
        s = 0; for (i = specBins[2]; i < specBins[3]; i++) s += spec[i];
        hi = s / (specBins[3] - specBins[2]) / 255;
        // спектральный поток в середине-верхе: онсеты нот
        var fl = 0, d;
        for (i = specBins[4]; i < specBins[5]; i++) { d = spec[i] - prevSpec[i]; if (d > 0) fl += d * d; }
        fl = Math.sqrt(fl / (specBins[5] - specBins[4])) / 255;
        prevSpec.set(spec);
        var ratio = fl / (fluxMean + 0.002);
        fluxMean += (Math.min(fl, fluxMean * 1.5) - fluxMean) * (1 - Math.exp(-dt / 1.5));
        if (ratio > 1.9 && now - lastOnset > 220 && A.active > 0.5) {
          lastOnset = now;
          onset = clamp01((ratio - 1.6) / 3);
        }
        // в шкалу 0..1 (байты analyser — децибелы в диапазоне −100…−30)
        lo = clamp01((lo - 0.45) / 0.45);
        mi = clamp01((mi - 0.2) / 0.45);
        hi = clamp01((hi - 0.02) / 0.3);
        lvl = clamp01(lo * 0.4 + mi * 0.4 + hi * 0.2);
      } catch (e) { live = false; }
    }
    A.active = follow(A.active, live ? 1 : 0, dt, 1.5, 2.5);
    A.level = follow(A.level, lvl, dt, 0.6, 2.0);
    A.low = follow(A.low, lo, dt, 0.5, 1.5);
    A.mid = follow(A.mid, mi, dt, 0.5, 1.5);
    A.high = follow(A.high, hi, dt, 0.4, 1.2);
    A.env = follow(A.env, lvl, dt, 5, 8);
    A.onset = onset;
  }

  // ================================================================ 4. сцены

  // буфер сцены
  function makeBuf() { return { g: new Uint16Array(G.n), t: new Uint8Array(G.n) }; }

  // общие «искры» — короткие вспышки (по онсетам)
  function Sparks(max) {
    this.x = new Float32Array(max); this.y = new Float32Array(max);
    this.age = new Float32Array(max); this.life = new Float32Array(max);
    this.max = max; this.n = 0;
  }
  Sparks.prototype.add = function (x, y, life) {
    var k = this.n < this.max ? this.n++ : (Math.random() * this.max) | 0;
    this.x[k] = x; this.y[k] = y; this.age[k] = 0; this.life[k] = life;
  };
  Sparks.prototype.step = function (o, dt) {
    for (var k = 0; k < this.n; k++) {
      this.age[k] += dt;
      if (this.age[k] >= this.life[k]) { this.n--; this.x[k] = this.x[this.n]; this.y[k] = this.y[this.n]; this.age[k] = this.age[this.n]; this.life[k] = this.life[this.n]; k--; continue; }
      var f = this.age[k] / this.life[k];
      var x = this.x[k] | 0, y = this.y[k] | 0;
      // мягкая вспышка: · → * → · , акцент только на пике
      var a = f < 0.25 ? f / 0.25 : 1 - (f - 0.25) / 0.75;
      a = a * a * (3 - 2 * a);
      var g = a > 0.7 ? GH.star : GH.mid;
      var t = a > 0.85 ? ACC3 : a > 0.7 ? ACC2 : toneOf(a * 0.8);
      if (t) putXY(o, x, y, g, t);
    }
  };

  // фоновые звёзды по хэшу ячейки (статичны, мерцают)
  function hashStars(o, density, t, maxTone, mask) {
    var n = G.n, h = G.hash;
    for (var i = 0; i < n; i++) {
      var r = h[i];
      if (r > density) continue;
      if (mask && mask[i]) continue;
      if (o.t[i]) continue;
      var tw = 0.55 + 0.45 * Math.sin(t * (0.4 + r * 37) + i);
      var big = r < density * 0.12;
      var tone = Math.round((big ? maxTone : maxTone * 0.6) * tw);
      if (tone < 1) continue;
      o.g[i] = big ? (tw > 0.85 ? GH.plus : GH.mid) : GH.dot;
      o.t[i] = tone;
    }
  }

  // «брайлевский» холст: точки 2×4 на ячейку — тонкие линии и эллипсы высокого разрешения
  function Dots() { this.b = new Uint8Array(G.n); this.t = new Uint8Array(G.n); this.used = new Int32Array(G.n); this.nu = 0; }
  Dots.prototype.clear = function () {
    for (var k = 0; k < this.nu; k++) { var i = this.used[k]; this.b[i] = 0; this.t[i] = 0; }
    this.nu = 0;
  };
  Dots.prototype.plot = function (sx, sy, tone) {
    if (sx < 0 || sy < 0) return;
    var x = sx >> 1, y = sy >> 2;
    if (x >= G.cols || y >= G.rows) return;
    var i = y * G.cols + x;
    if (!this.b[i]) this.used[this.nu++] = i;
    this.b[i] |= 1 << (((sy & 3) << 1) | (sx & 1));
    if (tone > this.t[i]) this.t[i] = tone;
  };
  // отрезок в координатах ячеек
  Dots.prototype.line = function (x0, y0, x1, y1, tone, gap) {
    var ax = x0 * 2, ay = y0 * 4, bx = x1 * 2, by = y1 * 4;
    var dx = bx - ax, dy = by - ay, n = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
    if (n < 1) n = 1;
    gap = gap || 1;
    for (var s = 0; s <= n; s += gap) this.plot((ax + dx * s / n) | 0, (ay + dy * s / n) | 0, tone);
  };
  // эллипс: центр и радиусы в ячейках (rx — по ширине, ry — в строках); minY — не рисовать выше
  Dots.prototype.ellipse = function (cx, cy, rx, ry, tone, minY) {
    var n = Math.ceil((rx * 2 + ry * 4) * 3.2 + 6), my = minY * 4;
    for (var k = 0; k < n; k++) {
      var a = k / n * TAU, py = (cy + Math.sin(a) * ry) * 4;
      if (py < my) continue;
      this.plot(((cx + Math.cos(a) * rx) * 2) | 0, py | 0, tone);
    }
  };
  Dots.prototype.commit = function (o) {
    for (var k = 0; k < this.nu; k++) {
      var i = this.used[k], t = this.t[i];
      if (t >= o.t[i] || o.g[i] >= BR0) { o.g[i] = BR0 + this.b[i]; if (t > o.t[i] || o.g[i] >= BR0) o.t[i] = t; }
    }
  };

  var SCENES = [];

  // ---------------------------------------------------------------- туманность
  SCENES.push({ name: 'туманность', make: function () {
    var cw = (G.cols >> 1) + 2, rows = G.rows;
    var fld = new Float32Array(cw * rows), wrp = new Float32Array(cw * rows);
    var sp = new Sparks(48), ox = rnd(0, 100), oy = rnd(0, 100);
    return {
      frame: function (o, t, dt) {
        var s = 1.25 / G.unit, asp = G.asp, cx = G.cols / 2, cy = G.rows / 2;
        var y, j, x, i;
        for (y = 0; y < rows; y++) {
          var py = (y - cy) * asp * s + oy;
          for (j = 0; j < cw; j++) {
            var px = (j * 2 - cx) * s + ox;
            var qx = fbm2(px + t * 0.016, py - t * 0.01, 1);
            var qy = fbm2(px + 5.2 - t * 0.013, py + 1.3 + t * 0.009, 1);
            var rx = fbm2(px + 0.9 * qx + 1.7, py + 0.9 * qy + 9.2 + t * 0.012, 2);
            var ry = fbm2(px + 0.9 * qx + 8.3 - t * 0.01, py + 0.9 * qy + 2.8, 2);
            var v = fbm2(px + 0.85 * rx, py + 0.85 * ry, 4);
            fld[y * cw + j] = v;
            wrp[y * cw + j] = rx * rx + ry * ry;
          }
        }
        var gain = 0.9 + 0.35 * A.level + 0.25 * A.bright;
        for (y = 0, i = 0; y < rows; y++) {
          var row = y * cw;
          for (x = 0; x < G.cols; x++, i++) {
            var jj = x >> 1, f = (x & 1) * 0.5;
            var v = fld[row + jj] * (1 - f) + fld[row + jj + 1] * f;
            var w = wrp[row + jj] * (1 - f) + wrp[row + jj + 1] * f;
            var wv = w > 0.4 ? 1 : w * 2.5;
            var b = smooth(-0.46, 0.6, v);
            b = Math.pow(b, 1.35) * (0.5 + 0.4 * wv) * gain;
            if (b > 0.9 && G.hash[i] < 0.08) { o.g[i] = GH.star; o.t[i] = b > 0.98 ? ACC3 : ACC2; continue; }
            softShade(o, i, b, 0.07);
          }
        }
        hashStars(o, 0.006, t, 4, null);
        if (Math.random() < dt * 0.15) this.onset(0.3);
        sp.step(o, dt);
      },
      onset: function (s) {
        // искра в яркой области
        for (var k = 0; k < 6; k++) {
          var i = (Math.random() * G.n) | 0;
          if (k === 5 || G.hash[i] > 0.3) { sp.add(i % G.cols, (i / G.cols) | 0, 1.6 + s * 1.5); break; }
        }
      }
    };
  } });

  // ---------------------------------------------------------------- океан
  SCENES.push({ name: 'океан', make: function () {
    var NW = 7;
    var wa = new Float32Array(NW), wkx = new Float32Array(NW), wkz = new Float32Array(NW), ww = new Float32Array(NW), wp = new Float32Array(NW), att = new Float32Array(NW);
    for (var k = 0; k < NW; k++) {
      var lam = 3.4 * Math.pow(0.66, k), kk = TAU / lam, ang = rnd(-0.95, 0.95) * (k ? 1 : 0.4);
      wkx[k] = Math.sin(ang) * kk; wkz[k] = Math.cos(ang) * kk;
      wa[k] = lam * 0.1;
      ww[k] = Math.sqrt(9.8 * kk) * 0.32;
      wp[k] = rnd(0, TAU);
    }
    var sp = new Sparks(32), moonPh = rnd(0, TAU), lightPh = rnd(-0.6, 0.6), swell = 0.6;
    return {
      frame: function (o, t, dt) {
        var cols = G.cols, rows = G.rows, asp = G.asp, u = G.unit, x, y, i, k;
        var hy = Math.round(rows * 0.42), D = rows - hy - 1;
        swell = follow(swell, 0.55 + A.waves * 0.9 + A.low * 0.25, dt, 3, 3);
        // луна: медленно плывёт, фаза медленно меняется
        var mx = cols * (0.5 + 0.3 * Math.sin(t * 0.003 + moonPh) + 0.05 * noise2(t * 0.007, 3.1));
        var mr = Math.max(2.5, u * 0.05);
        var my = hy * (0.42 + 0.12 * Math.sin(t * 0.0041 + moonPh * 1.7));
        var la = lightPh + 0.5 * Math.sin(t * 0.0023), Lx = Math.sin(la), Lz = Math.cos(la), Ly = -0.15;
        for (y = 0; y < hy; y++) {
          for (x = 0; x < cols; x++) {
            i = y * cols + x;
            var dx = x + 0.5 - mx, dy = (y + 0.5 - my) * asp;
            var d = Math.sqrt(dx * dx + dy * dy) / mr;
            if (d < 3.2) {
              // диск и ореол в точках 2×4: плотность точек = яркость, мягкий край
              var bits = 0, sum = 0;
              for (var b8 = 0; b8 < 8; b8++) {
                var sx = x + 0.25 + 0.5 * (b8 & 1), sy = y + ((b8 >> 1) + 0.5) / 4;
                var ddx = sx - mx, ddy = (sy - my) * asp, dd = Math.sqrt(ddx * ddx + ddy * ddy) / mr, val;
                if (dd < 1) {
                  var nx = ddx / mr, ny = ddy / mr, nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
                  var lit = clamp01(nx * Lx + ny * Ly + nz * Lz);
                  val = (0.12 + 0.88 * Math.sqrt(lit)) * (0.88 + 0.12 * noise2(nx * 2.5 + 11, ny * 2.5)) * smooth(1, 0.8, dd);
                } else { var hb = (3.2 - dd) / 2.2; val = hb * hb * 0.16; }
                sum += val;
                if (val > DITH8[b8] * 0.95 + 0.03) bits |= 1 << b8;
              }
              if (bits) { o.g[i] = BR0 + bits; o.t[i] = sum / 8 > 0.62 ? 8 : toneOf(Math.min(1, 0.08 + sum / 8 * 1.05)); }
              else o.t[i] = 0;
            } else {
              var hz = (y - hy * 0.6) / (hy * 0.4);
              if (hz > 0) shade(o, i, x, y, hz * hz * 0.1 * (0.6 + 0.4 * noise2(x * 0.03 + t * 0.02, y * 0.25)));
              else o.t[i] = 0;
            }
          }
        }
        hashStars(o, 0.009, t, 5, null);
        for (x = 0; x < cols; x++) { i = hy * cols + x; o.g[i] = GH.h; o.t[i] = Math.abs(x + 0.5 - mx) < mr * 0.8 ? 6 : 3; }
        // море: перспектива, волны с подавлением алиасинга по дальности
        for (y = hy + 1; y < rows; y++) {
          var r = (y - hy) / D, z = 5 / r, fz = 5 / (r * r * D), fx = z * 6 / cols;
          var fog = Math.sqrt(r), suma = 0, sumk = 0;
          for (k = 0; k < NW; k++) {
            var e = (wkz[k] * fz) * (wkz[k] * fz) + (wkx[k] * fx) * (wkx[k] * fx);
            att[k] = wa[k] * Math.exp(-0.6 * e);
            suma += att[k]; sumk += att[k] * Math.abs(wkz[k]);
          }
          var spread = 1.2 + r * u * 0.16;
          for (x = 0; x < cols; x++) {
            i = y * cols + x;
            var wx = (x - cols / 2) * fx;
            var h = 0, dzh = 0;
            for (k = 0; k < NW; k++) {
              if (att[k] < 1e-4) continue;
              var ph = wkx[k] * wx + wkz[k] * z - ww[k] * t + wp[k];
              h += att[k] * Math.sin(ph); dzh += att[k] * wkz[k] * Math.cos(ph);
            }
            var hn = h / (suma + 1e-6), sl = dzh / (sumk + 1e-6);
            hn = hn * (0.75 + 0.35 * swell) + 0.28 * noise2(wx * 0.9 + t * 0.05, z * 1.1 - t * 0.08);
            // лунная дорожка
            var gx = (x + 0.5 - mx) / spread, path = Math.exp(-gx * gx);
            if (path > 0.08) {
              var gl = path * clamp01(0.5 + sl * 0.7 + hn * 0.5 + 0.25 * noise2(x * 0.9, y * 1.7 + t * 1.5));
              if (gl > 0.72) { o.g[i] = r > 0.3 ? GH.tilde : GH.dash; o.t[i] = gl > 0.86 ? ACC3 : ACC2; continue; }
              if (gl > 0.5) { o.g[i] = GH.dash; o.t[i] = 4 + (fog * 3 | 0); continue; }
            }
            var hv = hn + (G.hash[i] - 0.5) * 0.16;
            if (hv > 0.5) { o.g[i] = r > 0.28 ? GH.tilde : GH.dash; o.t[i] = Math.min(8, 3 + Math.round(fog * 3.5 + (hv - 0.5) * 3 * swell)); }
            else if (hv > 0.15) { o.g[i] = r > 0.5 && hv > 0.32 ? GH.tilde : GH.dash; o.t[i] = 2 + Math.round(fog * 1.5); }
            else if (hv > -0.2) { o.g[i] = GH.dash; o.t[i] = 1; }
            else o.t[i] = 0;
          }
        }
        sp.step(o, dt);
      },
      onset: function (s) {
        var hy = Math.round(G.rows * 0.42);
        sp.add(rnd(0.05, 0.95) * G.cols, rnd(0.05, 0.75) * hy, 1.5 + s * 2);
      }
    };
  } });

  // ---------------------------------------------------------------- дождь
  SCENES.push({ name: 'дождь', make: function () {
    var MAXD = 800, MAXR = 220;
    var dx = new Float32Array(MAXD), dy = new Float32Array(MAXD), dz = new Float32Array(MAXD), dl = new Float32Array(MAXD), dn = 0;
    var rx = new Float32Array(MAXR), ry = new Float32Array(MAXR), rz = new Float32Array(MAXR), ra = new Float32Array(MAXR), rl = new Float32Array(MAXR), rs = new Uint8Array(MAXR), rn = 0;
    var acc = 0;
    function ripple(x, y, z, life, strong) {
      var k = rn < MAXR ? rn++ : (Math.random() * MAXR) | 0;
      rx[k] = x; ry[k] = y; rz[k] = z; ra[k] = 0; rl[k] = life; rs[k] = strong;
    }
    var dots = new Dots();
    function ring(o, cx, cy, R, flat, tone, gy) {
      if (R < 0.35) { dots.plot((cx * 2) | 0, (cy * 4) | 0, tone); return; }
      dots.ellipse(cx, cy, R, R * flat, tone, gy);
    }
    return {
      frame: function (o, t, dt) {
        var cols = G.cols, rows = G.rows, asp = G.asp;
        var gy = Math.round(rows * 0.62), depth = rows - gy;
        var x, y, i, k;
        o.t.fill(0); dots.clear();
        // гладь воды: редкие горизонтальные штрихи в перспективе
        for (y = gy; y < rows; y++) {
          var r = (y - gy + 0.5) / depth;
          for (x = 0; x < cols; x++) {
            var v = noise2(x * 0.035 / (r + 0.25) + t * 0.02, (y - gy) * 0.55 / (r + 0.15) - t * 0.06);
            if (v > 0.58) { i = y * cols + x; o.g[i] = GH.dash; o.t[i] = 1; }
          }
        }
        for (x = 0; x < cols; x++) { i = (gy - 1) * cols + x; if (G.hash[i] < 0.9) { o.g[i] = GH.h; o.t[i] = 2; } }
        // новые капли
        var wind = 0.3 * noise2(t * 0.025, 7.7);
        var rate = cols * (0.22 + 1.5 * A.rain) * (0.85 + 0.3 * A.mid);
        acc += rate * dt;
        while (acc >= 1 && dn < MAXD) {
          acc -= 1;
          var zz = Math.pow(Math.random(), 0.7);
          dx[dn] = rnd(-cols * 0.1, cols * 1.1); dy[dn] = rnd(-rows * 0.2, 0); dz[dn] = zz;
          dl[dn] = gy + zz * (depth - 1) + rnd(-0.4, 0.4);
          dn++;
        }
        if (acc > 1) acc = 1;
        var dg = Math.abs(wind) < 0.2 ? GH.bar : wind > 0 ? GH.bslash : GH.slash;
        for (k = 0; k < dn; k++) {
          var z = dz[k], spd = (16 + 30 * z) * 1.7 / asp;
          var ny = dy[k] + spd * dt;
          dx[k] += wind * spd * dt * 0.5;
          if (ny >= dl[k]) {
            if (Math.random() < 0.45) ripple(dx[k], dl[k], z, 1.0 + 1.3 * z, 0);
            dn--; dx[k] = dx[dn]; dy[k] = dy[dn]; dz[k] = dz[dn]; dl[k] = dl[dn]; k--; continue;
          }
          dy[k] = ny;
          var len = 1 + z * 2.4, tone = 2 + Math.round(z * 4.5);
          for (var s = 0; s < len; s++) {
            var yy = (ny - s) | 0;
            if (yy < 0 || yy > dl[k]) continue;
            var xx = (dx[k] - wind * s * 0.5 + 0.5) | 0;
            if (xx < 0 || xx >= cols) continue;
            put(o, yy * cols + xx, s === 0 || z > 0.55 ? dg : GH.apos, Math.max(1, tone - s));
          }
        }
        // круги на воде
        for (k = 0; k < rn; k++) {
          ra[k] += dt;
          if (ra[k] >= rl[k]) { rn--; rx[k] = rx[rn]; ry[k] = ry[rn]; rz[k] = rz[rn]; ra[k] = ra[rn]; rl[k] = rl[rn]; rs[k] = rs[rn]; k--; continue; }
          var f = ra[k] / rl[k], zr = rz[k], rr = (ry[k] - gy) / depth;
          var flat = (0.1 + 0.2 * rr) / asp * 2;
          if (rs[k]) {
            var R = 0.6 + f * (6 + 6 * zr);
            var tt = f < 0.35 ? ACC3 : f < 0.6 ? ACC2 : Math.max(1, Math.round((1 - f) * 7));
            ring(o, rx[k], ry[k], R, flat, tt, gy);
            if (f > 0.12) ring(o, rx[k], ry[k], R * 0.6, flat, Math.max(1, Math.round((1 - f) * 5)), gy);
            if (f > 0.3) ring(o, rx[k], ry[k], R * 0.3, flat, Math.max(1, Math.round((1 - f) * 3)), gy);
          } else {
            var R1 = 0.4 + f * (1.0 + zr * 2.8);
            var t1 = Math.round(Math.pow(1 - f, 1.5) * (1.2 + zr * 3.4));
            if (t1 >= 1) ring(o, rx[k], ry[k], R1, flat, t1, gy);
          }
        }
        dots.commit(o);
      },
      onset: function (s) {
        var gy = Math.round(G.rows * 0.62);
        ripple(rnd(0.15, 0.85) * G.cols, gy + rnd(0.35, 0.85) * (G.rows - gy), 0.6 + s * 0.4, 3.2 + s * 1.5, 1);
      }
    };
  } });

  // ---------------------------------------------------------------- звёзды
  SCENES.push({ name: 'звёзды', make: function () {
    var NS = Math.min(1600, Math.max(120, (G.n / 14) | 0));
    var sx = new Float32Array(NS), sy = new Float32Array(NS), sl = new Uint8Array(NS), sph = new Float32Array(NS), sf = new Float32Array(NS);
    var SPEED = [0.12, 0.32, 0.8];
    function spawn(k, anywhere) {
      var r = Math.random();
      sl[k] = r < 0.72 ? 0 : r < 0.94 ? 1 : 2;
      sx[k] = anywhere ? rnd(0, G.cols) : G.cols + rnd(0, 4);
      sy[k] = rnd(0, G.rows);
      sph[k] = rnd(0, TAU); sf[k] = 0;
    }
    for (var k = 0; k < NS; k++) spawn(k, true);
    var mw = rnd(-0.35, 0.35), mo = rnd(0.3, 0.7), shoot = { on: 0, x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 0 }, nextShoot = rnd(6, 20);
    var tilt = rnd(-0.3, 0.3);
    function launch(s) {
      shoot.on = 1; shoot.age = 0; shoot.life = rnd(1.4, 2.4);
      var dir = Math.random() < 0.5 ? -1 : 1;
      shoot.x = rnd(0.15, 0.85) * G.cols; shoot.y = rnd(0.05, 0.4) * G.rows;
      var sp = (30 + 20 * s) * G.unit / 90;
      var ang = rnd(0.25, 0.6);
      shoot.vx = Math.cos(ang) * sp * dir; shoot.vy = Math.sin(ang) * sp / G.asp;
    }
    return {
      frame: function (o, t, dt) {
        var cols = G.cols, rows = G.rows, asp = G.asp, x, y, i;
        var drift = 0.8 + 0.4 * A.drift;
        // млечный путь — полоса шума, смещается со скоростью дальнего слоя
        var off = t * SPEED[0] * drift;
        var mx0 = mo * rows;
        for (y = 0; y < rows; y++) {
          for (x = 0; x < cols; x++) {
            i = y * cols + x;
            var bandC = mx0 + (x - cols / 2) * mw + 4 * noise2((x + off) * 0.01, 2.2);
            var d = (y - bandC) * asp / (G.unit * 0.22);
            var band = Math.exp(-d * d);
            if (band < 0.03) { o.t[i] = 0; continue; }
            var v = fbm2((x + off) * 0.05, y * asp * 0.05, 3) * 0.5 + 0.5;
            var b = band * smooth(0.35, 0.9, v) * 0.42;
            shade(o, i, x, y, b);
          }
        }
        // слои звёзд
        for (var k = 0; k < NS; k++) {
          var l = sl[k];
          sx[k] -= SPEED[l] * drift * dt;
          sy[k] += SPEED[l] * drift * dt * tilt / asp;
          if (sx[k] < -1 || sy[k] < -1 || sy[k] > rows + 1) { spawn(k, false); if (tilt > 0 && Math.random() < 0.3) { sx[k] = rnd(0, cols); sy[k] = -0.5; } if (tilt < 0 && Math.random() < 0.3) { sx[k] = rnd(0, cols); sy[k] = rows + 0.5; } continue; }
          if (sf[k] > 0) sf[k] = Math.max(0, sf[k] - dt * 0.45);
          var tw = 0.65 + 0.35 * Math.sin(t * (0.7 + (k % 7) * 0.31) + sph[k]);
          var xi = sx[k] | 0, yi = sy[k] | 0;
          if (xi < 0 || xi >= cols || yi < 0 || yi >= rows) continue;
          var g, tone;
          if (sf[k] > 0.05) {
            var f = sf[k];
            g = f > 0.45 ? GH.star : GH.mid; tone = f > 0.6 ? ACC3 : f > 0.3 ? ACC2 : 6;
          } else if (l === 0) { g = GH.dot; tone = Math.round(2 + 2 * tw); }
          else if (l === 1) { g = tw > 0.8 ? GH.plus : GH.mid; tone = Math.round(3 + 3 * tw); }
          else { g = tw > 0.75 ? GH.star : GH.plus; tone = Math.round(5 + 3 * tw); }
          put(o, yi * cols + xi, g, tone);
        }
        // падающая звезда
        nextShoot -= dt;
        if (!shoot.on && nextShoot <= 0) { launch(0.3); nextShoot = rnd(14, 40); }
        if (shoot.on) {
          shoot.age += dt;
          var fa = shoot.age / shoot.life;
          if (fa >= 1) shoot.on = 0;
          else {
            shoot.x += shoot.vx * dt; shoot.y += shoot.vy * dt;
            var a = Math.sin(fa * Math.PI);
            var tl = 0.45 + 0.25 * a;
            var hx = shoot.x, hy = shoot.y, txx = hx - shoot.vx * tl, tyy = hy - shoot.vy * tl;
            line(o, txx, tyy, hx, hy, 0, Math.round(2 + 5 * a), false);
            putXY(o, hx, hy, GH.star, a > 0.5 ? ACC3 : ACC2);
          }
        }
      },
      onset: function (s) {
        if (!shoot.on && s > 0.6 && nextShoot < 8) { launch(s); nextShoot = rnd(14, 40); return; }
        for (var tries = 0; tries < 8; tries++) {
          var k = (Math.random() * NS) | 0;
          if (sl[k] > 0 && sf[k] === 0) { sf[k] = 0.7 + 0.3 * s; break; }
        }
      }
    };
  } });

  // ---------------------------------------------------------------- интерференция
  SCENES.push({ name: 'интерференция', make: function () {
    var NSRC = 3;
    var ph = new Float32Array(NSRC * 4);
    for (var k = 0; k < ph.length; k++) ph[k] = rnd(0, TAU);
    var pulses = [], sxs = new Float32Array(NSRC), sys = new Float32Array(NSRC);
    for (k = 0; k < 5; k++) pulses.push({ on: 0, x: 0, y: 0, age: 0 });
    return {
      frame: function (o, t, dt) {
        var cols = G.cols, rows = G.rows, asp = G.asp, u = G.unit, x, y, i, k;
        for (k = 0; k < NSRC; k++) {
          sxs[k] = cols / 2 + u * (0.55 * Math.sin(t * 0.019 * (1 + k * 0.37) + ph[k]) + 0.2 * noise2(t * 0.011, k * 9.1));
          sys[k] = (rows * asp / 2 + u * (0.38 * Math.sin(t * 0.015 * (1 + k * 0.23) + ph[k + 3]) + 0.15 * noise2(k * 7.3, t * 0.01))) / asp;
        }
        var kf = TAU / (u * (0.15 + 0.03 * Math.sin(t * 0.009))), om = 0.5 + 0.3 * A.drift;
        var gain = 0.9 + 0.25 * A.level;
        for (y = 0, i = 0; y < rows; y++) {
          var ey = (y / rows - 0.5) * 2;
          for (x = 0; x < cols; x++, i++) {
            var v = 0, wsum = 0;
            for (k = 0; k < NSRC; k++) {
              var ddx = x - sxs[k], ddy = (y - sys[k]) * asp;
              var d = Math.sqrt(ddx * ddx + ddy * ddy);
              var w = 1 / (1 + d / u * 2.2);
              v += Math.cos(d * kf - t * om + ph[k + 6]) * w; wsum += w;
            }
            v /= wsum;
            for (k = 0; k < pulses.length; k++) {
              var p = pulses[k];
              if (!p.on) continue;
              var px = x - p.x, py = (y - p.y) * asp, pd = Math.sqrt(px * px + py * py);
              var dd = (pd - p.age * u * 0.16) / (u * 0.03);
              if (dd > -4 && dd < 4) v += Math.exp(-dd * dd) * (1 - p.age / 7) * 0.9;
            }
            // только гребни волн: чистые кольца на пустом фоне
            var b = smooth(0.3, 1.0, 0.5 + 0.5 * v);
            var ex = (x / cols - 0.5) * 2;
            b *= (0.78 + 0.15 * A.level) * (1 - 0.25 * (ex * ex + ey * ey));
            if (b > 0.8 && G.hash[i] < 0.06) { o.g[i] = GH.star; o.t[i] = ACC2; continue; }
            softShade(o, i, b, 0.03);
          }
        }
        for (k = 0; k < pulses.length; k++) { if (pulses[k].on) { pulses[k].age += dt; if (pulses[k].age > 7) pulses[k].on = 0; } }
      },
      onset: function (s) {
        for (var k = 0; k < pulses.length; k++) {
          var p = pulses[k];
          if (p.on) continue;
          var src = (Math.random() * NSRC) | 0;
          p.on = 1; p.age = 0; p.x = sxs[src]; p.y = sys[src];
          return;
        }
      }
    };
  } });

  // ---------------------------------------------------------------- течение
  SCENES.push({ name: 'течение', make: function () {
    // линии тока в «брайлевском» разрешении: 2×4 точки на ячейку
    var NP = Math.min(1100, Math.max(100, (G.n / 13) | 0));
    var SW = G.cols * 2, SH = G.rows * 4;
    var S = new Float32Array(SW * SH), AC = new Float32Array(G.n);
    var px = new Float32Array(NP), py = new Float32Array(NP), pa = new Float32Array(NP), pl = new Float32Array(NP), pc = new Uint8Array(NP);
    var boost = 0, ox = rnd(0, 50), oy = rnd(0, 50), tz = 0;
    function spawn(k) {
      // реже в «тихих» областях — остаётся воздух
      for (var tries = 0; tries < 5; tries++) {
        px[k] = rnd(0, G.cols); py[k] = rnd(0, G.rows);
        var m = noise3(px[k] / G.unit * 1.1 + 40, py[k] * G.asp / G.unit * 1.1, tz * 0.5);
        if (m > -0.05 || tries === 4) break;
      }
      pa[k] = 0; pl[k] = rnd(4, 11);
      pc[k] = Math.random() < 0.02 ? 1 : 0;
    }
    for (var k = 0; k < NP; k++) { spawn(k); pa[k] = rnd(0, pl[k]); }
    return {
      frame: function (o, t, dt) {
        var cols = G.cols, rows = G.rows, asp = G.asp, s = 1.5 / G.unit, n = G.n, i, k, j;
        tz = t * 0.03;
        var decay = Math.exp(-dt / 1.25), m = SW * SH;
        for (j = 0; j < m; j++) S[j] *= decay;
        for (i = 0; i < n; i++) AC[i] *= decay;
        boost = follow(boost, 0, dt, 1, 1.2);
        var spd = (4 + 2.5 * A.level + 5 * boost) * G.unit / 90;
        for (k = 0; k < NP; k++) {
          pa[k] += dt;
          var fx = px[k], fy = py[k];
          if (pa[k] > pl[k] || fx < 0 || fy < 0 || fx >= cols || fy >= rows) { spawn(k); continue; }
          var wx = fx * s + ox, wy = fy * asp * s + oy;
          var ang = noise3(wx, wy, tz) * 3.2 + noise3(wx * 2.1 + 5, wy * 2.1, tz * 1.6) * 0.5;
          var vx = Math.cos(ang) * spd * dt, vy = Math.sin(ang) * spd * dt / asp;
          var life = pa[k] / pl[k], b = 0.3 + 0.7 * Math.sin(life * Math.PI);
          // ставим точки вдоль шага, чтобы линия была непрерывной
          var steps = Math.max(1, Math.ceil(Math.max(Math.abs(vx) * 2, Math.abs(vy) * 4)));
          for (var st = 1; st <= steps; st++) {
            var qx = fx + vx * st / steps, qy = fy + vy * st / steps;
            var sx = (qx * 2) | 0, sy = (qy * 4) | 0;
            if (sx < 0 || sy < 0 || sx >= SW || sy >= SH) continue;
            j = sy * SW + sx;
            if (b > S[j]) S[j] = b;
            if (pc[k]) { i = (sy >> 2) * cols + (sx >> 1); if (b > AC[i]) AC[i] = b; }
          }
          px[k] = fx + vx; py[k] = fy + vy;
        }
        var gain = 0.9 + 0.2 * A.level;
        for (var y = 0; y < rows; y++) {
          for (var x = 0; x < cols; x++) {
            i = y * cols + x;
            var base = (y * 4) * SW + x * 2, bits = 0, mx = 0, v;
            for (var r = 0; r < 4; r++) {
              var row = base + r * SW;
              v = S[row]; if (v > 0.1) { bits |= 1 << (r * 2); if (v > mx) mx = v; }
              v = S[row + 1]; if (v > 0.1) { bits |= 2 << (r * 2); if (v > mx) mx = v; }
            }
            if (!bits) { o.t[i] = 0; continue; }
            o.g[i] = BR0 + bits;
            mx *= gain;
            o.t[i] = AC[i] > 0.45 ? (AC[i] > 0.75 ? ACC3 : ACC2) : toneOf(mx * 0.95);
          }
        }
      },
      onset: function (s) { boost = Math.min(1, boost + 0.3 + 0.3 * s); }
    };
  } });

  // ---------------------------------------------------------------- сияние
  SCENES.push({ name: 'сияние', make: function () {
    var cols0 = G.cols;
    var rN = new Float32Array(cols0 * 2 + 2), rF = new Float32Array(cols0 * 2 + 2), dots = new Dots(), mask = new Uint8Array(G.n), sp = new Sparks(24), ox = rnd(0, 100), glow = 0;
    var cBase = new Float32Array(cols0), cBase2 = new Float32Array(cols0), cAmp = new Float32Array(cols0), cAmp2 = new Float32Array(cols0), cH = new Float32Array(cols0);
    var ray = new Float32Array(cols0 * 2), ray2 = new Float32Array(cols0 * 2);
    var D8 = new Float32Array([0, 4, 6, 2, 1, 5, 7, 3]);
    for (var q = 0; q < 8; q++) D8[q] = (D8[q] + 0.5) / 8;
    // линия хребта в точках 2×4: R — высота по подколонкам (в строках)
    function ridge(R, tone) {
      var prev = -1, n = G.cols * 2;
      for (var sc = 0; sc < n; sc++) {
        var sy = (R[sc] * 4) | 0;
        if (prev < 0) prev = sy;
        var a = Math.min(prev, sy), b = Math.max(prev, sy);
        if (b - a > 1) { a = prev < sy ? prev + 1 : sy; b = prev < sy ? sy : prev - 1; } else { a = b = sy; }
        for (var y = a; y <= b; y++) dots.plot(sc, y, tone);
        prev = sy;
      }
    }
    function curtain(x, sx, yy) {
      // яркость сияния в точке (колонка x, подколонка sx, строка yy — дробная)
      var I = 0, d1 = cBase[x] - yy, H = cH[x], r1 = ray[x * 2 + sx], r2 = ray2[x * 2 + sx];
      if (d1 >= 0) I = cAmp[x] * r1 * Math.exp(-d1 / H) * (1 - Math.exp(-(d1 + 0.3) * 1.6));
      else I = cAmp[x] * r1 * Math.exp(d1 * 1.8) * 0.8;
      var d2 = cBase2[x] - yy;
      if (d2 >= 0) I += cAmp2[x] * r2 * Math.exp(-d2 / (H * 0.8)) * (1 - Math.exp(-(d2 + 0.3) * 1.6)) * 0.7;
      else I += cAmp2[x] * r2 * Math.exp(d2 * 1.8) * 0.55;
      return I;
    }
    return {
      frame: function (o, t, dt) {
        var cols = G.cols, rows = G.rows, u = G.unit, x, y, i;
        glow = follow(glow, A.level * 0.5 + A.shimmer * 0.5, dt, 2, 3);
        o.t.fill(0); mask.fill(0); dots.clear();
        // две гряды гор с параллаксом
        for (var sc = 0; sc <= cols * 2 + 1; sc++) {
          x = sc * 0.5;
          var gn = (x + t * 0.3) / u, gf = (x + t * 0.12) / u;
          var nr = 1 - Math.abs(noise2(gn * 1.6 + ox, 1.1)), hN = 0.6 * nr * nr + 0.4 * (0.5 + 0.5 * fbm2(gn * 1.1 + ox, 7.7, 3));
          var fr = 1 - Math.abs(noise2(gf * 2.2 + ox, 5.5)), hF = 0.55 * fr * fr * fr + 0.45 * (0.5 + 0.5 * fbm2(gf * 1.4 + ox, 2.2, 3));
          rN[sc] = rows * (0.985 - 0.22 * hN);
          rF[sc] = Math.min(rN[sc] - 1.2, rows * (0.9 - 0.22 * hF));
        }
        var drift = t * (0.6 + 0.6 * A.drift), boost = 0.85 + 0.35 * glow;
        for (x = 0; x < cols; x++) {
          var xx = x / u;
          cBase[x] = rows * (0.48 + 0.13 * noise2(xx * 1.1 + drift * 0.013, 1.7) + 0.06 * noise2(xx * 3.1 - drift * 0.02, 4.4));
          cAmp[x] = (0.38 + 0.62 * smooth(-0.45, 0.4, fbm2(xx * 0.9 - drift * 0.011, drift * 0.008 + 3.1, 3))) * boost * 1.9;
          cAmp2[x] = smooth(-0.05, 0.6, noise2(xx * 1.4 + drift * 0.009, 9.9 + drift * 0.01)) * 1.5;
          cBase2[x] = cBase[x] - rows * (0.15 + 0.05 * noise2(xx * 1.1, drift * 0.01));
          cH[x] = rows * (0.13 + 0.06 * noise2(xx * 1.7, 5 + drift * 0.012));
          for (var sx = 0; sx < 2; sx++) {
            var xs = x + 0.25 + sx * 0.5;
            var r1 = 0.5 + 0.5 * noise2(xs * 0.3, drift * 0.05), r2 = 0.5 + 0.5 * noise2(xs * 0.38 + 40, drift * 0.06);
            ray[x * 2 + sx] = 0.15 + 0.85 * r1 * r1; ray2[x * 2 + sx] = 0.15 + 0.85 * r2 * r2;
          }
        }
        for (x = 0; x < cols; x++) {
          var top = Math.min(rF[x * 2], rF[x * 2 + 1]);
          for (y = 0; y < rows; y++) {
            i = y * cols + x;
            if (y + 1 > top) { mask[i] = 1; continue; }
            // грубая отсечка по центру ячейки
            var ic = curtain(x, 0, y + 0.5) + curtain(x, 1, y + 0.5);
            if (ic < 0.06) continue;
            var bits = 0, sum = 0;
            var jit = (G.hash[i] - 0.5) * 0.08;
            for (var b = 0; b < 8; b++) {
              var I = curtain(x, b & 1, y + ((b >> 1) + 0.5) / 4);
              sum += I;
              if (I > 0.05 + 0.7 * D8[b] + jit) bits |= 1 << b;
            }
            if (!bits) continue;
            var mean = sum / 8;
            var edge = cBase[x] - y;
            o.g[i] = BR0 + bits;
            if (edge > -0.5 && edge < 2 && mean > 0.55) o.t[i] = mean > 0.78 ? ACC3 : ACC2;
            else o.t[i] = toneOf(Math.min(1, 0.15 + mean * 0.95));
          }
        }
        hashStars(o, 0.012, t, 5, mask);
        // склоны: редкая фактура, ближняя гряда плотнее; затем линии хребтов
        for (x = 0; x < cols; x++) {
          var f0 = Math.ceil(Math.max(rF[x * 2], rF[x * 2 + 1])), n0 = Math.max(rN[x * 2], rN[x * 2 + 1]);
          for (y = Math.max(0, f0); y < rows; y++) {
            i = y * cols + x;
            var r = G.hash[i];
            o.t[i] = 0;
            if (y > n0 + 0.5) { if (r < 0.06) { o.g[i] = BR0 + (1 << ((i * 7) & 7)); o.t[i] = 2; } }
            else if (r < 0.03) { o.g[i] = BR0 + (1 << ((i * 5) & 7)); o.t[i] = 1; }
          }
        }
        ridge(rF, 2);
        // ближняя гряда перекрывает дальнюю
        for (x = 0; x < cols; x++) for (y = Math.max(0, Math.floor(Math.min(rN[x * 2], rN[x * 2 + 1]))); y < rows; y++) {
          i = y * cols + x;
          if (dots.b[i] && y > rN[x * 2] + 0.25) { dots.b[i] = 0; dots.t[i] = 0; }
        }
        ridge(rN, 5);
        dots.commit(o);
        sp.step(o, dt);
      },
      onset: function (s) {
        var x = rnd(0.05, 0.95) * G.cols, y = rnd(0.04, 0.35) * G.rows;
        var i = (y | 0) * G.cols + (x | 0);
        if (!mask[i]) sp.add(x, y, 1.4 + s * 1.5);
      }
    };
  } });

  // ---------------------------------------------------------------- тор
  SCENES.push({ name: 'тор', make: function () {
    var zb = new Float32Array(G.n), lum = new Float32Array(G.n);
    var RT = gis('.,-~:;=!*#%@');
    var a = rnd(0, TAU), bb = rnd(0, TAU), lp = rnd(0, TAU), pulse = 0;
    var PC = new Float32Array(1024), PS = new Float32Array(1024);   // таблицы cos/sin по φ
    return {
      frame: function (o, t, dt) {
        var cols = G.cols, rows = G.rows, asp = G.asp, u = G.unit, n = G.n, i;
        pulse = follow(pulse, 0, dt, 0.4, 1.6);
        var sp = 0.7 + 0.5 * A.drift;
        a += dt * sp * (0.15 + 0.06 * noise2(t * 0.02, 1.1));
        bb += dt * sp * (0.08 + 0.05 * noise2(t * 0.017, 7.3));
        zb.fill(0); o.t.fill(0);
        var R1 = 1, R2 = 2.1, K2 = 8;
        var breathe = 1 + 0.025 * Math.sin(t * 0.21) + 0.04 * A.env;
        var K1 = u * 0.47 * (K2 - R1 - R2) / (R1 + R2) * breathe;
        var cx = cols / 2, cy = rows / 2;
        // свет медленно облетает тор (со стороны зрителя)
        var lx = Math.cos(t * 0.045 + lp) * 0.8, ly = 0.45 + 0.35 * Math.sin(t * 0.033 + lp), lz = -0.75 - 0.2 * Math.sin(t * 0.027);
        var ln = 1 / Math.sqrt(lx * lx + ly * ly + lz * lz); lx *= ln; ly *= ln; lz *= ln;
        var cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(bb), sB = Math.sin(bb);
        var tubeR = K1 * R1 / (K2 - R1 - R2), outR = K1 * (R1 + R2) / (K2 - R1 - R2);
        var NT_ = Math.min(240, Math.ceil(tubeR * TAU * 2)), NPh = Math.min(1024, Math.ceil(outR * TAU * 2));
        var dth = TAU / NT_, dph = TAU / NPh, ip;
        for (ip = 0; ip < NPh; ip++) { PC[ip] = Math.cos(ip * dph); PS[ip] = Math.sin(ip * dph); }
        for (var it = 0; it < NT_; it++) {
          var th = it * dth, ct = Math.cos(th), st = Math.sin(th);
          var cxr = R2 + R1 * ct, cyr = R1 * st;
          // смещение по φ через строку θ — чтобы точки не выстраивались в сетку
          for (ip = (it & 1); ip < NPh; ip++) {
            var cp = PC[ip], spp = PS[ip];
            var X = cxr * (cB * cp + sA * sB * spp) - cyr * cA * sB;
            var Y = cxr * (sB * cp - sA * cB * spp) + cyr * cA * cB;
            var Z = K2 + cA * cxr * spp + cyr * sA;
            var ooz = 1 / Z;
            var xp = (cx + K1 * ooz * X) | 0, yp = (cy - K1 * ooz * Y / asp) | 0;
            if (xp < 0 || yp < 0 || xp >= cols || yp >= rows) continue;
            i = yp * cols + xp;
            if (ooz <= zb[i]) continue;
            zb[i] = ooz;
            var Nx = ct * (cB * cp + sA * sB * spp) - st * cA * sB;
            var Ny = ct * (sB * cp - sA * cB * spp) + st * cA * cB;
            var Nz = cA * ct * spp + st * sA;
            lum[i] = Nx * lx + Ny * ly + Nz * lz;
          }
        }
        var gain = 0.95 + 0.2 * A.level + 0.3 * pulse;
        for (i = 0; i < n; i++) {
          if (zb[i] === 0) continue;
          var L = lum[i];
          // ночная сторона — едва видимая точка, чтобы читалась форма
          if (L <= 0.02) { o.g[i] = GH.dot; o.t[i] = 1; continue; }
          var v = Math.pow(L, 1.7) * 0.82 * gain;
          if (L > 0.988 && v > 0.8) { o.g[i] = RT[11]; o.t[i] = v > 0.98 ? ACC3 : ACC2; continue; }
          var k = (v * 11.99) | 0; if (k > 11) k = 11;
          o.g[i] = RT[k]; o.t[i] = 1 + Math.min(7, (v * 7.8) | 0);
        }
        hashStars(o, 0.004, t, 3, null);
      },
      onset: function (s) { pulse = Math.min(1, pulse + 0.35 * s + 0.15); }
    };
  } });

  // ---------------------------------------------------------------- рельеф
  SCENES.push({ name: 'рельеф', make: function () {
    var CW = G.cols + 1, CH = G.rows + 1;
    var H = new Float32Array(CW * CH), Lv = new Int16Array(CW * CH), labels = new Uint8Array(G.n);
    var ox = rnd(0, 100), oy = rnd(0, 100), dirA = rnd(0, TAU);
    var NL = 13;
    return {
      frame: function (o, t, dt) {
        var cols = G.cols, rows = G.rows, asp = G.asp, s = 1.15 / G.unit, n = G.n, x, y, i, c;
        // медленный пролёт: направление плавно поворачивается
        var ang = dirA + 1.2 * noise2(t * 0.003, 2.5), vv = 0.012 * (0.8 + 0.4 * A.drift) * dt;
        ox += Math.cos(ang) * vv; oy += Math.sin(ang) * vv;
        var morph = t * 0.008;
        // высоты в углах ячеек
        for (y = 0, c = 0; y < CH; y++) {
          var wy = y * asp * s + oy;
          for (x = 0; x < CW; x++, c++) {
            var wx = x * s + ox;
            var h = fbm2(wx, wy, 3) * 0.85 + 0.3 * noise3(wx * 0.6, wy * 0.6, morph);
            h = clamp01(h * 0.62 + 0.5);
            H[c] = h; Lv[c] = Math.floor(h * NL);
          }
        }
        o.t.fill(0); labels.fill(0);
        // marching squares: линия проходит через середины рёбер — это ровно символы ─ │ ╭ ╮ ╰ ╯
        for (y = 0, i = 0; y < rows; y++) {
          for (x = 0; x < cols; x++, i++) {
            c = y * CW + x;
            var a = Lv[c], b = Lv[c + 1], d = Lv[c + CW + 1], e = Lv[c + CW];
            if (a === b && b === d && d === e) {
              if (a <= 2 && G.hash[i] < 0.04 + (2 - a) * 0.03) { o.g[i] = GH.tilde; o.t[i] = 2; }
              continue;
            }
            var L = a > b ? a : b; if (d > L) L = d; if (e > L) L = e;
            var tl = a >= L, tr = b >= L, br = d >= L, bl = e >= L;
            var top = tl !== tr, right = tr !== br, bot = bl !== br, left = tl !== bl, g;
            if (top && right && bot && left) g = GH.cross;
            else if (left && right) g = GH.h;
            else if (top && bot) g = GH.v;
            else if (left && top) g = GH.cBR;
            else if (top && right) g = GH.cBL;
            else if (left && bot) g = GH.cTR;
            else g = GH.cTL;
            o.g[i] = g;
            o.t[i] = L >= NL - 1 ? ACC2 : L % 4 === 0 ? 6 : 3;
          }
        }
        // вершины с отметками высот
        var nl = 0;
        for (y = 2; y < rows - 2 && nl < 7; y++) {
          for (x = 2; x < cols - 8; x++) {
            i = y * cols + x; c = y * CW + x;
            var hv = H[c];
            if (hv < 0.74 || labels[i]) continue;
            if (hv < H[c - 1] || hv < H[c + 1] || hv < H[c - CW] || hv < H[c + CW] || hv < H[c - CW - 1] || hv < H[c - CW + 1] || hv < H[c + CW - 1] || hv < H[c + CW + 1]) continue;
            var num = Math.round(hv * 2600 / 10) * 10;
            o.g[i] = GH.tri; o.t[i] = ACC3;
            var str = num, digits = num >= 1000 ? 4 : 3;
            o.t[i + 1] = 0;
            for (var dgt = digits - 1; dgt >= 0; dgt--) {
              var dc = str % 10; str = (str / 10) | 0;
              o.g[i + 2 + dgt] = GH.digit0 + dc; o.t[i + 2 + dgt] = 5;
            }
            o.t[i + 2 + digits] = 0;
            for (var m = -2; m <= digits + 3; m++) for (var dy = -2; dy <= 2; dy++) { var q = i + m + dy * cols; if (q >= 0 && q < n) labels[q] = 1; }
            nl++;
          }
        }
      },
      onset: function () {}
    };
  } });

  // ---------------------------------------------------------------- созвездия
  SCENES.push({ name: 'созвездия', make: function () {
    var NN = Math.max(22, Math.min(90, (G.n / 190) | 0));
    var nx = new Float32Array(NN), ny = new Float32Array(NN), ns = new Float32Array(NN), nf = new Float32Array(NN), nseed = new Float32Array(NN);
    var bd = new Dots();
    for (var k = 0; k < NN; k++) { nx[k] = rnd(0, G.cols); ny[k] = rnd(0, G.rows * G.asp); ns[k] = Math.random(); nseed[k] = rnd(0, 100); }
    return {
      frame: function (o, t, dt) {
        var cols = G.cols, rows = G.rows, asp = G.asp, u = G.unit, W = cols, Hh = rows * asp, k, j;
        o.t.fill(0);
        hashStars(o, 0.007, t, 3, null);
        var spd = (1.2 + 0.8 * A.drift + 0.6 * A.level) * u / 90;
        for (k = 0; k < NN; k++) {
          var a = noise2(nseed[k], t * 0.03) * TAU * 1.5;
          nx[k] += Math.cos(a) * spd * dt; ny[k] += Math.sin(a) * spd * dt;
          var m = 3;
          if (nx[k] < -m) nx[k] += W + 2 * m; else if (nx[k] > W + m) nx[k] -= W + 2 * m;
          if (ny[k] < -m) ny[k] += Hh + 2 * m; else if (ny[k] > Hh + m) ny[k] -= Hh + 2 * m;
          if (nf[k] > 0) nf[k] = Math.max(0, nf[k] - dt * 0.35);
        }
        var D = u * 0.26, D2 = D * D;
        bd.clear();
        for (k = 0; k < NN; k++) {
          for (j = k + 1; j < NN; j++) {
            var dx = nx[j] - nx[k], dy = ny[j] - ny[k], d2 = dx * dx + dy * dy;
            if (d2 > D2) continue;
            var len = Math.sqrt(d2);
            if (len < 2.5) continue;
            var s = 1 - len / D;
            s = s * s * (3 - 2 * s);
            var fl = Math.max(nf[k], nf[j]);
            var tone = Math.round(s * 5 + fl * 3);
            if (tone < 1) continue;
            // отступ от звёзд, тонкая линия в точках 2×4
            var ux = dx / len * 1.3, uy = dy / len * 1.3;
            bd.line(nx[k] + ux, (ny[k] + uy) / asp, nx[j] - ux, (ny[j] - uy) / asp, fl > 0.4 ? ACC1 : Math.min(6, tone), s < 0.3 ? 2 : 1);
          }
        }
        bd.commit(o);
        for (k = 0; k < NN; k++) {
          var xi = nx[k] | 0, yi = (ny[k] / asp) | 0;
          var f = nf[k], sz = ns[k];
          var tw = 0.85 + 0.15 * Math.sin(t * 1.1 + nseed[k]);
          if (f > 0.15) { putXY(o, xi, yi, f > 0.5 ? GH.star : GH.plus, f > 0.35 ? ACC3 : ACC2); continue; }
          if (sz > 0.97) putXY(o, xi, yi, GH.star, ACC2);
          else putXY(o, xi, yi, sz > 0.6 ? GH.star : sz > 0.3 ? GH.plus : GH.bullet, Math.round((5 + sz * 3) * tw));
        }
      },
      onset: function (s) {
        var k = (Math.random() * NN) | 0;
        nf[k] = Math.min(1, 0.7 + s * 0.5);
      }
    };
  } });

  // пустая сцена — для плавного появления при открытии
  var EMPTY = { name: '', make: function () { return { frame: function (o) { o.t.fill(0); }, onset: function () {} }; } };

  // ================================================================ 5. оверлей и цикл

  var CSS = [
    '.av-root{position:fixed;inset:0;z-index:2147483000;background:var(--bg,#0b0c0e);color:var(--fg,#f3f4f6);overflow:hidden;',
    'font-family:' + MONO.replace(/"/g, "'") + ';-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;touch-action:manipulation;outline:none;',
    'opacity:0;transition:opacity .6s cubic-bezier(.2,.7,.2,1)}',
    '.av-root.av-in{opacity:1}',
    '.av-root.av-idle{cursor:none}',
    '.av-cv{position:absolute;left:0;top:0;display:block}',
    '.av-bar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:space-between;gap:12px;',
    'padding:16px max(20px,env(safe-area-inset-right,0px)) max(16px,env(safe-area-inset-bottom,0px)) max(20px,env(safe-area-inset-left,0px));',
    'transition:opacity .7s cubic-bezier(.2,.7,.2,1);pointer-events:none}',
    '.av-idle .av-bar{opacity:0}',
    '.av-name{font-size:13px;color:var(--muted,#9aa1ab);letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
    'background:color-mix(in srgb,var(--bg,#0b0c0e) 80%,transparent);padding:6px 10px;border-radius:8px;transition:opacity .5s}',
    '.av-btns{display:flex;gap:8px;flex:none}',
    '.av-btn{pointer-events:auto;height:36px;padding:0 16px;border-radius:18px;border:1px solid var(--line,#272a2f);font:inherit;font-size:13px;',
    'background:color-mix(in srgb,var(--bg,#0b0c0e) 82%,transparent);color:var(--fg,#f3f4f6);cursor:pointer;display:inline-flex;align-items:center;gap:8px;',
    'transition:border-color .25s,color .25s,background-color .25s,transform .2s}',
    '.av-btn:hover{border-color:var(--accent,#5c8dff);color:var(--accent,#5c8dff)}',
    '.av-btn:active{transform:scale(.95)}',
    '.av-btn:focus{outline:none}.av-btn:focus-visible{outline:2px solid var(--accent,#5c8dff);outline-offset:2px}',
    '.av-idle .av-btn{pointer-events:none}',
    '.av-x{font-size:16px;line-height:1;margin-top:-1px}',
    '@media (pointer:coarse){.av-btn{height:42px;padding:0 18px}}',
    '@media (prefers-reduced-motion:reduce){.av-root,.av-bar,.av-btn,.av-name{transition:none!important}}'
  ].join('');

  var root = null, cv = null, ctx = null, nameEl = null, btnNext = null, btnClose = null, styleEl = null;
  var isOpen = false, raf = 0, lastFrame = 0, lastTick = 0, idleTimer = 0, prevFocus = null;
  var wakeLock = null, enteredFs = false, fsSince = 0, mqDark = null, mqReduce = null, mo = null, reduced = false;
  var atlas = null, atlasCtx = null, atlasCols = 0, prevKey = null, outBuf = null, needFull = true, needResize = true;
  var cur = null, nxt = null, curBuf = null, nxtBuf = null, curT = 0, nxtT = 0, trans = 0, transDur = 3.5, thr = null;
  var bag = [], lastIdx = -1, sceneAge = 0, sceneDur = 75, curIdx = -1, nxtIdx = -1;
  var colors = { bg: '#0b0c0e', fg: '#f3f4f6', muted: '#9aa1ab', accent: '#5c8dff' };

  // ---------- цвета темы
  function parseColor(str, fallback) {
    var c = document.createElement('canvas').getContext('2d');
    c.fillStyle = '#010203';
    try { c.fillStyle = (str || '').trim() || fallback; } catch (e) {}
    var v = c.fillStyle;
    if (v === '#010203' && str !== '#010203') { c.fillStyle = fallback; v = c.fillStyle; }
    var m;
    if (v[0] === '#') return [parseInt(v.substr(1, 2), 16), parseInt(v.substr(3, 2), 16), parseInt(v.substr(5, 2), 16)];
    m = v.match(/[\d.]+/g);
    return m ? [+m[0], +m[1], +m[2]] : [0, 0, 0];
  }
  function readTheme() {
    var cs = getComputedStyle(document.documentElement);
    var bg = parseColor(cs.getPropertyValue('--bg'), '#0b0c0e');
    var fg = parseColor(cs.getPropertyValue('--fg'), '#f3f4f6');
    var muted = parseColor(cs.getPropertyValue('--muted'), '#9aa1ab');
    var accent = parseColor(cs.getPropertyValue('--accent'), '#5c8dff');
    colors = { bg: bg, fg: fg, muted: muted, accent: accent };
  }
  function mix(a, b, f) { return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; }
  function rgb(c) { return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')'; }
  function toneColor(t) {
    if (t >= ACC1) return mix(colors.bg, colors.accent, ACC_U[t - ACC1]);
    var u = TONE_U[t];
    // на светлом фоне слабые тоны теряются сильнее — чуть поднимаем нижние ступени
    var lum = (colors.bg[0] * 0.3 + colors.bg[1] * 0.59 + colors.bg[2] * 0.11) / 255;
    if (lum > 0.5) u = 2 * Math.pow(u / 2, 1.25);
    return u <= 1 ? mix(colors.bg, colors.muted, u) : mix(colors.muted, colors.fg, u - 1);
  }

  // ---------- атлас глифов: строка = тон, колонка = глиф; тайлы непрозрачные
  function buildAtlas() {
    var cw = G.cw, ch = G.ch;
    var total = NT * NGT;
    atlasCols = Math.max(1, Math.min(total, Math.floor(4096 / cw)));
    var arows = Math.ceil(total / atlasCols);
    if (!atlas) { atlas = document.createElement('canvas'); }
    atlas.width = atlasCols * cw; atlas.height = arows * ch;
    atlasCtx = atlas.getContext('2d');
    var c = atlasCtx;
    c.fillStyle = rgb(colors.bg); c.fillRect(0, 0, atlas.width, atlas.height);
    c.font = '400 ' + G.font + 'px ' + MONO;
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    var mH = c.measureText('H');
    var capH = mH.actualBoundingBoxAscent || G.font * 0.73;
    var base = Math.round(ch / 2 + capH / 2);
    var dr = Math.max(0.75, cw * 0.115);
    for (var t = 1; t < NT; t++) {
      c.fillStyle = rgb(toneColor(t));
      for (var g = 1; g < NGT; g++) {
        var k = t * NGT + g, sx = (k % atlasCols) * cw, sy = ((k / atlasCols) | 0) * ch;
        if (g < NG) {
          c.save(); c.beginPath(); c.rect(sx, sy, cw, ch); c.clip();
          c.fillText(GL[g], sx + cw / 2, sy + base);
          c.restore();
        } else if (g < TRI) {
          var bits = g - BR0;
          if (!bits) continue;
          c.beginPath();
          for (var b = 0; b < 8; b++) {
            if (!(bits & (1 << b))) continue;
            var px = sx + cw * (0.3 + 0.4 * (b & 1)), py = sy + ch * ((b >> 1) + 0.5) / 4;
            c.moveTo(px + dr, py); c.arc(px, py, dr, 0, TAU);
          }
          c.fill();
        } else {
          var tw = cw * 0.36, th = Math.min(ch * 0.32, tw * 1.6), cx0 = sx + cw / 2, cy0 = sy + ch * 0.54;
          c.beginPath(); c.moveTo(cx0, cy0 - th / 2); c.lineTo(cx0 + tw, cy0 + th / 2); c.lineTo(cx0 - tw, cy0 + th / 2); c.closePath(); c.fill();
        }
      }
    }
    needFull = true;
  }

  // ---------- геометрия сетки
  function layout() {
    var vw = Math.max(1, root.clientWidth || window.innerWidth), vh = Math.max(1, root.clientHeight || window.innerHeight);
    var dpr = Math.min(3, window.devicePixelRatio || 1);
    var small = Math.min(vw, vh) < 560;
    var cssCell = small ? 10.5 : 9;
    var maxCells = small ? 6500 : 20000;
    var cw, ch, cols, rows;
    for (var guard = 0; guard < 40; guard++) {
      cw = Math.max(4, Math.round(cssCell * dpr));
      ch = Math.round(cw * 1.95);
      cols = Math.floor(vw * dpr / cw); rows = Math.floor(vh * dpr / ch);
      if (cols * rows <= maxCells) break;
      cssCell *= 1.06;
    }
    var W = Math.round(vw * dpr), H = Math.round(vh * dpr);
    cv.width = W; cv.height = H;
    cv.style.width = (W / dpr) + 'px'; cv.style.height = (H / dpr) + 'px';
    var changed = cols !== G.cols || rows !== G.rows || cw !== G.cw || ch !== G.ch;
    G.W = W; G.H = H; G.dpr = dpr;
    G.cw = cw; G.ch = ch; G.cols = Math.max(1, cols); G.rows = Math.max(1, rows); G.n = G.cols * G.rows;
    G.asp = ch / cw;
    // масштаб сцен: короткая сторона, но не меньше 0.62 длинной — на узком портретном экране узоры не мельчат
    var sa = G.cols, sb = G.rows * G.asp;
    G.unit = Math.max(Math.min(sa, sb), 0.62 * Math.max(sa, sb));
    G.font = Math.round(cw / 0.6 * 0.98);
    G.ox = Math.floor((W - G.cols * cw) / 2); G.oy = Math.floor((H - G.rows * ch) / 2);
    ctx = cv.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    if (changed || !G.hash || G.hash.length !== G.n) {
      G.hash = new Float32Array(G.n);
      var seed = (Math.random() * 1e9) | 0;
      for (var i = 0; i < G.n; i++) G.hash[i] = hash(i * 2654435761 + seed);
      prevKey = new Int32Array(G.n);
      outBuf = makeBuf();
      thr = new Float32Array(G.n);
      // пересоздаём активные сцены под новую сетку
      if (cur) { curBuf = makeBuf(); cur = SCENES_ALL(curIdx).make(); }
      if (nxt) { nxtBuf = makeBuf(); nxt = SCENES_ALL(nxtIdx).make(); }
    }
    buildAtlas();
  }
  function SCENES_ALL(idx) { return idx < 0 ? EMPTY : SCENES[idx]; }

  // ---------- порядок сцен
  function pickNext() {
    if (!bag.length) {
      for (var i = 0; i < SCENES.length; i++) bag.push(i);
      for (i = bag.length - 1; i > 0; i--) { var j = (Math.random() * (i + 1)) | 0, t = bag[i]; bag[i] = bag[j]; bag[j] = t; }
      if (bag[bag.length - 1] === lastIdx && bag.length > 1) { t = bag[0]; bag[0] = bag[bag.length - 1]; bag[bag.length - 1] = t; }
    }
    lastIdx = bag.pop();
    return lastIdx;
  }

  function prepThresholds() {
    var ox = rnd(0, 100), oy = rnd(0, 100), s = 3.0 / G.unit;
    for (var y = 0, i = 0; y < G.rows; y++) for (var x = 0; x < G.cols; x++, i++) {
      var v = fbm2(x * s + ox, y * G.asp * s + oy, 3) * 0.5 + 0.5;
      thr[i] = clamp01((v - 0.2) / 0.6) * 0.7 + G.hash[(i * 7 + 13) % G.n] * 0.3;
    }
  }

  function startTransition(idx, dur) {
    if (nxt) finishTransition();
    nxtIdx = idx; nxt = SCENES[idx].make(); nxtBuf = makeBuf(); nxtT = 0; trans = 0;
    transDur = dur || (reduced ? 6 : 3.6);
    prepThresholds();
    sceneAge = 0; sceneDur = reduced ? rnd(120, 160) : rnd(60, 90);
    setName(SCENES[idx].name);
  }
  function finishTransition() {
    cur = nxt; curBuf = nxtBuf; curT = nxtT; curIdx = nxtIdx;
    nxt = null; nxtBuf = null; nxtIdx = -1;
  }
  function next() { startTransition(pickNext()); }

  function setName(s) { if (nameEl) nameEl.textContent = s; }

  // ---------- кадр
  function composite() {
    var n = G.n, o = outBuf, a = curBuf, b = nxtBuf, p = trans * 1.25, w = 0.25;
    for (var i = 0; i < n; i++) {
      var th = thr[i];
      if (th < p - w) { o.g[i] = b.g[i]; o.t[i] = b.t[i]; }
      else if (th < p) {
        // шов перехода: приглушённое смешение
        var src = b.t[i] ? b : a;
        var tt = src.t[i];
        o.g[i] = src.g[i]; o.t[i] = tt >= ACC1 ? 3 : tt > 3 ? 3 : tt > 1 ? tt - 1 : tt;
      }
      else { o.g[i] = a.g[i]; o.t[i] = a.t[i]; }
    }
    return o;
  }

  function draw(o) {
    var c = ctx, n = G.n, cols = G.cols, cw = G.cw, ch = G.ch, ox = G.ox, oy = G.oy, ac = atlasCols;
    if (needFull) {
      c.fillStyle = rgb(colors.bg); c.fillRect(0, 0, G.W, G.H);
      prevKey.fill(-1);
      needFull = false;
    }
    var g = o.g, t = o.t, pk = prevKey, x = 0, y = 0;
    for (var i = 0; i < n; i++) {
      var tt = t[i], k = tt ? tt * NGT + g[i] : 0;
      if (k !== pk[i]) {
        pk[i] = k;
        c.drawImage(atlas, (k % ac) * cw, ((k / ac) | 0) * ch, cw, ch, ox + x * cw, oy + y * ch, cw, ch);
      }
      if (++x === cols) { x = 0; y++; }
    }
  }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    var minDt = reduced ? 1000 / 8 : 1000 / 30;
    if (now - lastFrame < minDt - 3) return;
    var dtReal = Math.min(0.1, Math.max(0.001, (now - (lastTick || now)) / 1000)) || 1 / 30;
    if (!lastTick) dtReal = 1 / 30;
    lastFrame = now; lastTick = now;
    try { frame(dtReal, now); } catch (e) { if (window.console) console.error(e); }
  }

  function frame(dtReal, now) {
    if (needResize) { needResize = false; layout(); }
    updateAudio(dtReal, now);
    var speed = (reduced ? 0.35 : 1) * (0.8 + 0.45 * A.drift) * (1 + 0.15 * A.env);
    var dt = dtReal * speed;
    if (A.onset > 0) {
      if (cur) cur.onset(A.onset);
      if (nxt) nxt.onset(A.onset);
    }
    curT += dt;
    cur.frame(curBuf, curT, dt);
    var out = curBuf;
    if (nxt) {
      nxtT += dt;
      nxt.frame(nxtBuf, nxtT, dt);
      trans += dtReal / transDur;
      if (trans >= 1) { finishTransition(); out = curBuf; }
      else out = composite();
    } else {
      sceneAge += dtReal;
      if (sceneAge >= sceneDur && SCENES.length > 1) next();
    }
    draw(out);
  }

  function startLoop() {
    if (raf || !isOpen || document.hidden) return;
    lastTick = 0; lastFrame = 0;
    raf = requestAnimationFrame(tick);
  }
  function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  // ---------- управление
  function showControls() {
    if (!root) return;
    root.classList.remove('av-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { if (root) root.classList.add('av-idle'); }, 3000);
  }

  function onPointerMove(e) {
    if (e.pointerType === 'mouse' && e.movementX === 0 && e.movementY === 0) return;
    showControls();
  }
  function onRootClick(e) {
    if (e.target && e.target.closest && e.target.closest('.av-btn')) return;
    showControls();
    next();
  }
  function onKey(e) {
    if (!isOpen || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); close(); return; }
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'ArrowRight' || e.code === 'KeyN' || e.key === 'n' || e.key === 'т') {
      e.preventDefault(); showControls(); next();
    }
  }
  function onVisibility() {
    if (!isOpen) return;
    if (document.hidden) stopLoop();
    else { startLoop(); requestWakeLock(); }
  }
  function onResize() { needResize = true; }
  function onTheme() {
    if (!isOpen) return;
    // даём стилям примениться
    requestAnimationFrame(function () { if (!isOpen) return; readTheme(); if (G.cw) buildAtlas(); });
  }
  function onReduce() { reduced = !!(mqReduce && mqReduce.matches); }
  // закрываемся, только если видели свой оверлей в полноэкранном режиме и он из него вышел (Esc в браузере)
  function onFsChange() {
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    needResize = true;
    if (fsEl && fsEl === root) { if (!enteredFs) fsSince = performance.now(); enteredFs = true; return; }
    // выход сразу после входа — это гонка с предыдущим закрытием, а не Esc: остаёмся открытыми без полного экрана
    if (enteredFs) { enteredFs = false; if (isOpen && performance.now() - fsSince > 900) close(); }
  }
  function onFontsLoaded() { if (isOpen && G.cw) buildAtlas(); }

  function requestWakeLock() {
    try {
      if (wakeLock || !navigator.wakeLock || document.hidden) return;
      navigator.wakeLock.request('screen').then(function (l) {
        if (!isOpen) { try { l.release(); } catch (e) {} return; }
        wakeLock = l;
        l.addEventListener('release', function () { if (wakeLock === l) wakeLock = null; });
      }, function () {});
    } catch (e) {}
  }
  function releaseWakeLock() {
    var l = wakeLock; wakeLock = null;
    if (l) { try { l.release().catch(function () {}); } catch (e) {} }
  }

  function buildDom() {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.setAttribute('data-ambient-viz', '');
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);
    }
    root = document.createElement('div');
    root.className = 'av-root';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'визуализация');
    root.tabIndex = -1;
    cv = document.createElement('canvas');
    cv.className = 'av-cv';
    cv.setAttribute('aria-hidden', 'true');
    var bar = document.createElement('div'); bar.className = 'av-bar';
    nameEl = document.createElement('span'); nameEl.className = 'av-name'; nameEl.setAttribute('aria-live', 'polite');
    var btns = document.createElement('span'); btns.className = 'av-btns';
    btnNext = document.createElement('button'); btnNext.type = 'button'; btnNext.className = 'av-btn'; btnNext.textContent = 'дальше';
    btnClose = document.createElement('button'); btnClose.type = 'button'; btnClose.className = 'av-btn';
    btnClose.setAttribute('aria-label', 'закрыть');
    btnClose.innerHTML = '<span>закрыть</span><span class="av-x" aria-hidden="true">×</span>';
    btns.appendChild(btnNext); btns.appendChild(btnClose);
    bar.appendChild(nameEl); bar.appendChild(btns);
    root.appendChild(cv); root.appendChild(bar);
    btnNext.addEventListener('click', function (e) {
      showControls(); next();
      if (e.detail) { btnNext.blur(); root.focus({ preventScroll: true }); }   // пробел должен оставаться «играть/пауза»
    });
    btnClose.addEventListener('click', function () { close(); });
    root.addEventListener('click', onRootClick);
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerdown', showControls);
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    prevFocus = document.activeElement;
    buildDom();
    document.body.appendChild(root);

    mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    mqReduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    onReduce();
    if (mqDark) { if (mqDark.addEventListener) mqDark.addEventListener('change', onTheme); else if (mqDark.addListener) mqDark.addListener(onTheme); }
    if (mqReduce) { if (mqReduce.addEventListener) mqReduce.addEventListener('change', onReduce); else if (mqReduce.addListener) mqReduce.addListener(onReduce); }
    if (window.MutationObserver) {
      mo = new MutationObserver(onTheme);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', onFontsLoaded);

    readTheme();
    G.cols = 0; G.hash = null;
    cur = EMPTY.make(); curIdx = -1; curT = 0; nxt = null;
    needResize = false; layout(); curBuf = makeBuf();
    A.active = 0; spec = null; fluxMean = 0.01; paramClock = 0; readParams();
    for (var k in PTarget) A[k] = PTarget[k];
    startTransition(pickNext(), reduced ? 4 : 2.6);
    try {
      if (document.fonts && document.fonts.load) document.fonts.load('400 ' + G.font + 'px "JetBrains Mono"').then(onFontsLoaded, function () {});
    } catch (e) {}

    // полноэкранный режим — по возможности
    try {
      var req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (req && !(document.fullscreenElement || document.webkitFullscreenElement)) {
        var myRoot = root;
        var pr = req.call(root, { navigationUI: 'hide' });
        // если успели закрыть до входа в полноэкранный режим — выходим
        if (pr && pr.then) pr.then(function () { if (!isOpen || root !== myRoot) exitFsOf(myRoot); }, function () {});
      }
    } catch (e) {}
    requestWakeLock();

    root.focus({ preventScroll: true });
    requestAnimationFrame(function () { if (root) root.classList.add('av-in'); });
    showControls();
    startLoop();
  }

  function exitFs() { exitFsOf(root); }
  function exitFsOf(el) {
    try {
      var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl && fsEl === el) {
        var ex = document.exitFullscreen || document.webkitExitFullscreen;
        if (ex) { var p = ex.call(document); if (p && p.catch) p.catch(function () {}); }
      }
    } catch (e) {}
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    stopLoop();
    clearTimeout(idleTimer); idleTimer = 0;
    releaseWakeLock();
    enteredFs = false; exitFs();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('fullscreenchange', onFsChange);
    document.removeEventListener('webkitfullscreenchange', onFsChange);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    if (document.fonts && document.fonts.removeEventListener) document.fonts.removeEventListener('loadingdone', onFontsLoaded);
    if (mqDark) { if (mqDark.removeEventListener) mqDark.removeEventListener('change', onTheme); else if (mqDark.removeListener) mqDark.removeListener(onTheme); }
    if (mqReduce) { if (mqReduce.removeEventListener) mqReduce.removeEventListener('change', onReduce); else if (mqReduce.removeListener) mqReduce.removeListener(onReduce); }
    mqDark = mqReduce = null;
    if (mo) { mo.disconnect(); mo = null; }
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = cv = ctx = nameEl = btnNext = btnClose = null;
    cur = nxt = null; curBuf = nxtBuf = outBuf = null; prevKey = null; thr = null;
    atlas = null; atlasCtx = null; G.hash = null; G.cols = 0;
    var pf = prevFocus; prevFocus = null;
    if (pf && pf.focus && document.contains(pf)) { try { pf.focus({ preventScroll: true }); } catch (e) {} }
  }

  var api = { open: open, close: close };
  Object.defineProperty(api, 'isOpen', { get: function () { return isOpen; }, enumerable: true });
  window.AmbientViz = api;
})();
