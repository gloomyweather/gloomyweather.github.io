/* orpheus — интерфейс. строит контролы из window.AMBIENT_SCHEMA, говорит с window.Ambient. */
(function () {
  'use strict';

  var SCHEMA = window.AMBIENT_SCHEMA;
  if (!SCHEMA) return;
  var STORE_KEY = 'ambient.v1'; // старые сохранения (values + active) читаются как есть, новые поля необязательны
  var PRESETS = Array.isArray(window.AMBIENT_PRESETS) ? window.AMBIENT_PRESETS : [];
  var TRANS_OPTS = [{ s: 3, t: '3 с' }, { s: 15, t: '15 с' }, { s: 60, t: '1 мин' }, { s: 120, t: '2 мин' }];
  var HIST_MAX = 30, NAME_MAX = 24;

  function A() { return window.Ambient || null; }
  var fading = false; // таймер сна: движок ещё затухает, а ui уже «стоит»
  function isRunning() { var a = A(); return !!(a && a.running) && !fading; }
  function engineCall(fn) { try { var a = A(); if (a) return fn(a); } catch (e) { /* движок не должен ронять ui */ } }

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') n.textContent = attrs[k];
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  var booted = false;
  var reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function r2(v) { return Math.round(v * 100) / 100; }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function emit(name, detail) {
    try { document.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (e) { /* события — только для сцены */ }
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ок */ } }

  var params = SCHEMA.params.slice();
  var byId = {};
  params.forEach(function (p) { byId[p.id] = p; });
  var state = {};
  params.forEach(function (p) { state[p.id] = p.def != null ? p.def : 0; });
  var activePreset = null;
  var controls = {}; // id -> { set(v, durSec) } (у громкости несколько ползунков)
  var ctlSets = {};
  function addCtl(id, fn) {
    (ctlSets[id] = ctlSets[id] || []).push(fn);
    controls[id] = { set: function (v, d) { ctlSets[id].forEach(function (f) { f(v, d); }); } };
  }
  var locked = {};   // group id -> true
  var anchors = {};  // опорные значения для живого режима
  var custom = [];   // свои пресеты { id, name, values }
  var live = false, transSec = 3;
  var hist = [];

  function normalize(p, v) {
    v = Number(v);
    if (!isFinite(v)) return state[p.id];
    if (p.type === 'select') {
      var n = p.options.length;
      return Math.max(0, Math.min(n - 1, Math.round(v)));
    }
    return r2(clamp01(v));
  }
  function isAuto(p) { return p.group != null && !locked[p.group]; } // параметр доступен автоматике
  function allPresets() { return PRESETS.concat(custom); }
  function findPreset(id) {
    var all = allPresets();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  // ---------- persistence ----------
  var saveTimer = 0;
  function saveNow() {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        values: state, active: activePreset, custom: custom,
        locked: Object.keys(locked).filter(function (g) { return locked[g]; }), live: live, trans: transSec
      }));
    } catch (e) { /* без хранилища тоже ок */ }
  }
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 250); }
  function loadSaved() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      return o && typeof o === 'object' && o.values && typeof o.values === 'object' ? o : null;
    } catch (e) { return null; }
  }

  // ---------- state changes ----------
  // строка-описание под чипами: описание активного пресета; при наведении/фокусе — чипа под курсором
  var descEl = $('presetDesc'), hoverId = null, descShown = null, descTimer = 0;
  function descOf(pr) { return pr.desc ? String(pr.desc) : (PRESETS.indexOf(pr) < 0 ? pr.name : ''); }
  function descWanted() {
    var id = hoverId || activePreset, pr = id ? findPreset(id) : null;
    return pr ? descOf(pr) : 'свой звук';
  }
  function renderDesc() {
    var t = descWanted();
    if (t === descShown) return;
    descShown = t;
    clearTimeout(descTimer);
    if (!booted || reduceMotion.matches) { descEl.classList.remove('out'); descEl.textContent = t; return; }
    descEl.classList.add('out');
    descTimer = setTimeout(function () { descEl.textContent = t; descEl.classList.remove('out'); }, 180);
  }
  function wireChip(b, id) {
    b.setAttribute('aria-describedby', 'presetDesc');
    function on() { hoverId = id; renderDesc(); }
    function off() { if (hoverId === id) { hoverId = null; renderDesc(); } }
    b.addEventListener('mouseenter', on); b.addEventListener('focus', on);
    b.addEventListener('mouseleave', off); b.addEventListener('blur', off);
  }
  function updateActiveChips() {
    var chips = document.querySelectorAll('#presets .chip');
    for (var i = 0; i < chips.length; i++) {
      var on = chips[i].getAttribute('data-id') === activePreset;
      chips[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      if (chips[i].parentNode.classList.contains('chipx')) chips[i].parentNode.classList.toggle('on', on);
    }
    renderDesc();
    renderNames();
    updateSession();
    revealActive();
  }
  function revealActive() {
    var b = document.querySelector('#presets .chip[aria-pressed="true"]');
    var row = b && b.closest ? b.closest('.chips') : null;
    if (!row || row.scrollWidth <= row.clientWidth + 1) return;
    var t = b.offsetLeft - (row.clientWidth - b.offsetWidth) / 2;
    try { row.scrollTo({ left: Math.max(0, t), behavior: booted && !reduceMotion.matches ? 'smooth' : 'auto' }); } catch (e) { row.scrollLeft = Math.max(0, t); }
  }
  function presetName() { var pr = activePreset ? findPreset(activePreset) : null; return pr ? pr.name : 'свой звук'; }
  function renderNames() {
    var n = presetName();
    $('hdrPreset').textContent = n; $('miniName').textContent = n;
  }
  var lastEmitted;
  function emitPreset(force) {
    if (!booted) return;
    var id = null;
    if (activePreset) id = PRESETS.indexOf(findPreset(activePreset)) >= 0 ? activePreset : 'user:' + presetName();
    if (!force && id === lastEmitted) return;
    lastEmitted = id;
    emit('orpheus:preset', { id: id, name: presetName() });
  }
  // применяет набор значений: state, контролы, движок. glide в секундах (0 — мгновенно).
  // opts.live — движение живого режима: не трогает пресет и опорные значения
  function applyValues(obj, glide, presetId, opts) {
    var out = {}, isLive = !!(opts && opts.live);
    var vis = glide > 0 ? glide : rnd(0.5, 0.9); // ползунки едут столько же, сколько звук
    for (var id in obj) {
      var p = byId[id];
      if (!p) continue;
      var v = normalize(p, obj[id]);
      state[id] = v; out[id] = v;
      if (!isLive) anchors[id] = v;
      if (controls[id]) controls[id].set(v, vis);
    }
    if (!isLive) { activePreset = presetId || null; updateActiveChips(); }
    engineCall(function (a) { a.setMany(out, glide); });
    refreshMacros(vis);
    if (!isLive) emitPreset(true);
    saveSoon();
  }
  function userChange(id, v) {
    state[id] = v; anchors[id] = v;
    engineCall(function (a) { a.set(id, v); });
    if (id !== 'volume' && activePreset) { activePreset = null; updateActiveChips(); emitPreset(); }
    if (id !== 'volume') refreshMacros(0.2);
    saveSoon();
  }
  function glideSec() { return isRunning() ? transSec : 0; }

  // ---------- undo ----------
  var undoBtn = $('undo');
  function snapshot() {
    var vals = {};
    params.forEach(function (p) { if (p.group != null) vals[p.id] = state[p.id]; });
    return { values: vals, active: activePreset };
  }
  function renderUndo() {
    var none = !hist.length;
    undoBtn.disabled = none;
    if (none && undoBtn.hidden === false && document.activeElement === undoBtn) $('nudge').focus();
    undoBtn.hidden = none;
  }
  function pushUndo() {
    hist.push(snapshot());
    if (hist.length > HIST_MAX) hist.shift();
    renderUndo();
  }
  function filterLocked(vals) {
    var f = {}, skipped = false;
    for (var id in vals) {
      var p = byId[id];
      if (!p || p.id === 'volume' || p.group == null) continue;
      if (locked[p.group]) skipped = true; else f[id] = vals[id];
    }
    return { vals: f, skipped: skipped, n: Object.keys(f).length };
  }
  // автоматическое изменение: уважает замки, кладёт состояние в историю
  function applyAuto(vals, presetId) {
    var f = filterLocked(vals);
    if (!f.n) return false;
    pushUndo();
    applyValues(f.vals, glideSec(), f.skipped ? null : presetId);
    return true;
  }
  function undo() {
    var s = hist.pop();
    renderUndo();
    if (!s) return;
    var f = filterLocked(s.values);
    if (!f.n) return;
    applyValues(f.vals, glideSec(), f.skipped ? null : s.active);
  }
  undoBtn.addEventListener('click', undo);
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || (e.key !== 'z' && e.key !== 'Z' && e.code !== 'KeyZ')) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && t.type !== 'range') || (t && t.isContentEditable)) return;
    e.preventDefault();
    undo();
  });

  // ---------- ascii-дорожки ----------
  // нативный input остаётся (клавиатура, тач, a11y), дорожка — ряд моно-символов под ним
  var GLYPH = {
    tone: ['─', '━'], pad: ['═', '█'], notes: ['·', '•'], noise: [':', '¦'],
    space: ['~', '≈'], char: ['≈', '='], macro: ['─', '━'], volume: ['─', '━']
  };
  var RIP_MS = 420;
  var CW = 8.4; // ширина символа при 14px, уточняется измерением
  var allTracks = [], ripples = [], ripRaf = 0;
  function measureCW() {
    var pr = el('span', { 'aria-hidden': 'true', style: 'position:absolute;left:0;top:0;visibility:hidden;white-space:pre;font-size:14px' });
    pr.textContent = new Array(41).join('M');
    $('app').appendChild(pr);
    var w = pr.getBoundingClientRect().width / 40;
    $('app').removeChild(pr);
    if (w > 4 && w < 16) CW = w;
  }
  function ripStep(now) {
    ripRaf = 0;
    ripples = ripples.filter(function (t) { t.draw(now); return t.rip >= 0; });
    if (ripples.length) ripRaf = requestAnimationFrame(ripStep);
  }
  function makeTrack(kind) {
    var g = GLYPH[kind] || GLYPH.tone;
    var f = el('span', { 'class': 'af' }), r = document.createTextNode('');
    var box = el('span', { 'class': 'atrack', 'aria-hidden': 'true' }, [f]);
    box.appendChild(r);
    var T = { box: box, n: 0, v: 0, rip: -1 };
    function rep(ch, n) { return n > 0 ? new Array(n + 1).join(ch) : ''; }
    T.draw = function (now) {
      var n = T.n;
      if (!n) return;
      var k = Math.round(T.v * n), fs;
      if (T.rip >= 0 && now != null) {
        var p = (now - T.rip) / RIP_MS;
        if (p >= 1) { T.rip = -1; fs = rep(g[0], k); }
        else {
          var pos = p * (k + 3) - 1.5; // бегущая волна по заполненной части
          var from = Math.max(0, Math.round(pos - 1)), to = Math.min(k, Math.round(pos + 2));
          fs = rep(g[0], from) + rep(g[1], Math.max(0, to - from)) + rep(g[0], k - Math.max(from, to));
        }
      } else fs = rep(g[0], k);
      f.textContent = fs;
      r.nodeValue = rep(g[0], n - k);
    };
    T.layout = function () {
      var w = box.clientWidth;
      if (!w) return;
      var n = Math.max(4, Math.floor(w / CW));
      T.n = n;
      box.style.letterSpacing = ((w - n * CW) / n).toFixed(3) + 'px';
      T.draw();
    };
    T.set = function (v) {
      var moved = Math.abs(v - T.v) >= 0.004;
      T.v = v;
      if (moved && booted && !reduceMotion.matches && T.n) {
        var now = performance.now();
        if (T.rip < 0 || now - T.rip > RIP_MS) {
          T.rip = now;
          if (ripples.indexOf(T) < 0) ripples.push(T);
          if (!ripRaf) ripRaf = requestAnimationFrame(ripStep);
        }
      }
      T.draw(T.rip >= 0 ? performance.now() : null);
    };
    box.__t = T;
    allTracks.push(T);
    if (trackRO) trackRO.observe(box);
    return T;
  }
  var trackRO = null;
  try { if ('ResizeObserver' in window) trackRO = new ResizeObserver(function (es) { es.forEach(function (e) { if (e.target.__t) e.target.__t.layout(); }); }); } catch (e) {}
  function layoutTracks() { measureCW(); allTracks.forEach(function (t) { t.layout(); }); }
  window.addEventListener('resize', layoutTracks);
  try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(layoutTracks); } catch (e) {}

  function buildRng(kind, id, label) {
    var input = el('input', { type: 'range', id: id, min: 0, max: 1, step: 0.01, 'aria-label': label });
    var tr = makeTrack(kind);
    return { input: input, tr: tr, rng: el('div', { 'class': 'rng' }, [tr.box, input]) };
  }
  // плавный доезд значения до нового; durSec — длительность, как у звука
  function makeGlider(paint, initial) {
    var cur = initial, raf = 0;
    var g = function (v, durSec) {
      cancelAnimationFrame(raf);
      if (!booted || reduceMotion.matches || Math.abs(v - cur) < 0.005) { cur = v; paint(v); return; }
      var from = cur, t0 = performance.now(), dur = Math.max(200, (durSec || 0.7) * 1000);
      var soft = dur > 1500;
      (function step(now) {
        var k = Math.min(1, (now - t0) / dur);
        var e = soft ? k * k * (3 - 2 * k) : 1 - Math.pow(1 - k, 3);
        cur = from + (v - from) * e;
        paint(k < 1 ? cur : v);
        if (k < 1) raf = requestAnimationFrame(step); else cur = v;
      })(t0);
    };
    g.stop = function (v) { cancelAnimationFrame(raf); cur = v; };
    return g;
  }

  // ---------- controls ----------
  function makeSlider(p, groupLabel, o) {
    o = o || {};
    var iid = o.id || ('ctl-' + p.id);
    var b = buildRng(p.group || 'volume', iid, (groupLabel ? groupLabel + ' ' : '') + p.label);
    var input = b.input, tr = b.tr, out = null, row = b.rng;
    if (!o.compact) {
      out = el('output', { 'for': iid });
      var label = el('label', { 'for': iid, text: p.label });
      if (p.id === 'binaural') label.appendChild(el('span', { 'class': 'tag', text: 'наушники · эксп.' }));
      row = el('div', { 'class': 'slider' }, [el('div', { 'class': 'shead' }, [label, out]), b.rng]);
    }
    if (p.hint) { row.title = p.hint; input.setAttribute('aria-description', p.hint); }
    function paint(v) {
      input.value = v;
      tr.set(v);
      if (out) out.textContent = String(Math.round(v * 100));
    }
    var glide = makeGlider(paint, state[p.id]);
    input.addEventListener('input', function () {
      var v = r2(parseFloat(input.value));
      glide.stop(v);
      paint(v);
      userChange(p.id, v);
      if (p.id === 'volume') syncVolume(input, v);
    });
    addCtl(p.id, glide);
    paint(state[p.id]);
    return row;
  }
  // громкость в шапке и в мини-плеере — один параметр
  function syncVolume(from, v) {
    ctlSets.volume.forEach(function (f) { f(v, 0); });
  }

  function makeSelect(p) {
    var iid = 'ctl-' + p.id;
    var short = p.options.every(function (o) { return String(o).length <= 3; }) && p.options.length <= 12;
    var wrap = el('div', { 'class': 'field' });
    if (short) {
      var lid = iid + '-label';
      wrap.appendChild(el('span', { 'class': 'flabel', id: lid, text: p.label }));
      var seg = el('div', { 'class': 'seg', id: iid, role: 'radiogroup', 'aria-labelledby': lid });
      var btns = p.options.map(function (o, i) {
        var b = el('button', { type: 'button', id: iid + '-' + i, role: 'radio', 'aria-checked': 'false', text: String(o) });
        b.addEventListener('click', function () { paint(i); userChange(p.id, i); });
        seg.appendChild(b);
        return b;
      });
      wrap.appendChild(seg);
      var paint = function (v) {
        btns.forEach(function (b, i) { b.setAttribute('aria-checked', i === v ? 'true' : 'false'); b.tabIndex = (i === v) ? 0 : -1; });
      };
      seg.addEventListener('keydown', function (e) {
        var d = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var n = (state[p.id] + d + btns.length) % btns.length;
        paint(n); userChange(p.id, n); btns[n].focus();
      });
      controls[p.id] = { set: paint };
      paint(state[p.id]);
    } else {
      wrap.appendChild(el('label', { 'class': 'flabel', 'for': iid, text: p.label }));
      var sel = el('select', { 'class': 'sel', id: iid });
      p.options.forEach(function (o, i) { sel.appendChild(el('option', { value: String(i), text: String(o) })); });
      wrap.appendChild(el('div', { 'class': 'selwrap' }, [sel]));
      sel.addEventListener('change', function () { var v = parseInt(sel.value, 10); userChange(p.id, v); });
      controls[p.id] = { set: function (v) { sel.value = String(v); } };
      sel.value = String(state[p.id]);
    }
    if (p.hint) wrap.title = p.hint;
    return wrap;
  }

  // ---------- randomization ----------
  function randomFor(p) {
    if (p.type === 'select') return Math.floor(Math.random() * p.options.length);
    if (p.rare) return Math.random() < 0.8 ? 0 : r2(rnd(0.12, 0.5));
    if (/Level$/.test(p.id)) return r2(rnd(0.05, 0.85));
    if (p.id === 'reverb') return r2(rnd(0.25, 0.85));
    return r2(Math.random());
  }
  // хотя бы пэд или шум должны быть слышны (только в незаблокированных группах)
  function ensureAudible(vals, gid) {
    var pad = 'padLevel' in vals ? vals.padLevel : state.padLevel;
    var noise = 'noiseLevel' in vals ? vals.noiseLevel : state.noiseLevel;
    if (Math.max(pad || 0, noise || 0) >= 0.3) return;
    var opts = [];
    if (byId.padLevel && !locked.pad && (!gid || gid === 'pad')) opts.push('padLevel');
    if (byId.noiseLevel && !locked.noise && (!gid || gid === 'noise')) opts.push('noiseLevel');
    if (!opts.length) return;
    var target = opts.length > 1 && Math.random() < 0.3 ? 'noiseLevel' : opts[0];
    vals[target] = r2(rnd(0.4, 0.8));
  }
  function randomize(gid) {
    if (gid && locked[gid]) return;
    var vals = {};
    params.forEach(function (p) {
      if (p.id === 'volume' || p.group == null || locked[p.group]) return;
      if (gid && p.group !== gid) return;
      vals[p.id] = randomFor(p);
    });
    ensureAudible(vals, gid);
    applyAuto(vals, null);
  }
  function nudge() {
    var vals = {};
    params.forEach(function (p) {
      if (p.type !== 'slider' || !isAuto(p)) return;
      if (p.rare && !state[p.id]) return; // редкие слои не заводим «чуть-чуть»
      vals[p.id] = r2(clamp01(state[p.id] + rnd(-0.12, 0.12)));
    });
    ensureAudible(vals, null);
    applyAuto(vals, null);
  }

  // ---------- build ----------
  var DICE = '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="14" height="14" rx="3"/><circle cx="6.2" cy="6.2" r=".6" fill="currentColor"/><circle cx="11.8" cy="11.8" r=".6" fill="currentColor"/><circle cx="9" cy="9" r=".6" fill="currentColor"/></svg>';
  var LOCK_SHUT = 'M5.5 8V6a3.5 3.5 0 0 1 7 0v2', LOCK_OPEN = 'M5.5 8V6a3.5 3.5 0 0 1 6.9-.9';
  var LOCK = '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="8" width="11" height="7.5" rx="2"/><path d="' + LOCK_OPEN + '"/></svg>';

  var volumeParam = byId.volume;
  if (volumeParam) {
    $('volumeSlot').appendChild(makeSlider(volumeParam, ''));
    $('miniVolSlot').appendChild(makeSlider(volumeParam, '', { compact: true, id: 'ctl-volume-mini' }));
  }

  var lockBtns = {}, diceBtns = {}, groupEls = {};
  var groupsEl = $('groups');
  SCHEMA.groups.forEach(function (g) {
    var gp = params.filter(function (p) { return p.group === g.id; });
    if (!gp.length) return;
    var dice = el('button', { type: 'button', 'class': 'dice', id: 'dice-' + g.id, 'aria-label': 'случайно: ' + g.label, title: 'случайно: ' + g.label });
    dice.innerHTML = DICE;
    dice.addEventListener('click', function () { randomize(g.id); });
    var lock = el('button', { type: 'button', 'class': 'lock', id: 'lock-' + g.id, 'aria-pressed': 'false', 'aria-label': 'не менять автоматически: ' + g.label, title: 'не менять автоматически' });
    lock.innerHTML = LOCK;
    lock.addEventListener('click', function () { setLocked(g.id, !locked[g.id]); saveNow(); });
    var ctr = el('div', { 'class': 'controls' });
    gp.forEach(function (p) { ctr.appendChild(p.type === 'select' ? makeSelect(p) : makeSlider(p, g.label)); });
    var sec = el('section', { 'class': 'group', id: 'group-' + g.id, 'aria-label': g.label }, [
      el('div', { 'class': 'ghead' }, [el('h2', { 'class': 'gname', text: g.label }), el('div', { 'class': 'gtools' }, [lock, dice])]), ctr
    ]);
    groupsEl.appendChild(sec);
    lockBtns[g.id] = lock; diceBtns[g.id] = dice; groupEls[g.id] = sec;
  });
  function setLocked(gid, on) {
    if (!lockBtns[gid]) return;
    if (on) locked[gid] = true; else delete locked[gid];
    lockBtns[gid].setAttribute('aria-pressed', on ? 'true' : 'false');
    lockBtns[gid].querySelector('path').setAttribute('d', on ? LOCK_SHUT : LOCK_OPEN);
    diceBtns[gid].disabled = !!on;
    groupEls[gid].classList.toggle('locked', !!on);
  }

  // пресеты по назначению: четыре ряда + «мои»
  var presetsEl = $('presets');
  var ROWS = [
    { label: 'работа', ids: ['focus', 'morning', 'calm', 'warmth', 'fog'] },
    { label: 'сон и отдых', ids: ['sleep', 'meditation', 'deep', 'midnight', 'temple'] },
    { label: 'природа', ids: ['rain', 'forest', 'storm', 'winter'] },
    { label: 'настроение', ids: ['space', 'weightless', 'nostalgia', 'sunset'] }
  ];
  var GLYPHS = {
    focus: '·', morning: '○', calm: '~', warmth: '◦', fog: '░',
    sleep: '◐', meditation: '◎', deep: '▽', midnight: '●', temple: '∩',
    rain: '╱', forest: '│', storm: '≋', winter: '+',
    space: '∗', weightless: '°', nostalgia: '≡', sunset: '◒'
  };
  function applyPreset(pr) {
    var wasRunning = isRunning();
    if (!wasRunning) {
      // стоим: применяем мгновенно, но с историей и замками, и запускаем звук
      var f = filterLocked(pr.values);
      if (f.n) { pushUndo(); applyValues(f.vals, 0, f.skipped ? null : pr.id); }
      start();
    } else {
      applyAuto(pr.values, pr.id);
    }
  }
  function makeRow(label) {
    var chips = el('div', { 'class': 'chips' });
    var lab = el('span', { 'class': 'plabel', text: label });
    return { row: el('div', { 'class': 'prow' }, [lab, chips]), chips: chips };
  }
  var placed = {};
  ROWS.forEach(function (r) {
    var mk = makeRow(r.label);
    r.ids.forEach(function (id) {
      var pr = findPreset(id);
      if (!pr) return;
      placed[id] = true;
      mk.chips.appendChild(presetChip(pr, GLYPHS[id] || '·'));
    });
    if (mk.chips.children.length) presetsEl.appendChild(mk.row);
  });
  // встроенные, которых нет в рядах (на будущее) — в последний ряд
  PRESETS.forEach(function (pr) {
    if (placed[pr.id]) return;
    var rows = presetsEl.querySelectorAll('.chips');
    if (rows.length) rows[rows.length - 1].appendChild(presetChip(pr, '·'));
  });
  function presetChip(pr, g, pre) {
    var b = el('button', { type: 'button', 'class': 'chip', id: (pre || 'preset-') + pr.id, 'data-id': pr.id, 'data-g': g, 'aria-pressed': 'false', text: pr.name });
    b.addEventListener('click', function () { applyPreset(pr); });
    wireChip(b, pr.id);
    return b;
  }
  var mine = makeRow('мои');
  presetsEl.appendChild(mine.row);
  var delTimer = 0;
  function renderCustom() {
    mine.chips.innerHTML = '';
    custom.forEach(function (pr) {
      var b = presetChip(pr, '◇', 'cpreset-');
      var x = el('button', { type: 'button', 'class': 'cdel', id: 'cdel-' + pr.id, 'aria-label': 'удалить: ' + pr.name });
      var ask = false;
      function idle() { ask = false; x.classList.remove('ask'); x.textContent = ''; x.innerHTML = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg>'; x.setAttribute('aria-label', 'удалить: ' + pr.name); }
      idle();
      x.addEventListener('click', function () {
        if (!ask) {
          ask = true; x.classList.add('ask'); x.innerHTML = ''; x.textContent = 'удалить?';
          x.setAttribute('aria-label', 'подтвердить удаление: ' + pr.name);
          clearTimeout(delTimer); delTimer = setTimeout(idle, 3500);
          return;
        }
        clearTimeout(delTimer);
        custom = custom.filter(function (c) { return c.id !== pr.id; });
        if (activePreset === pr.id) activePreset = null;
        if (hoverId === pr.id) hoverId = null;
        renderCustom(); updateActiveChips(); emitPreset(); saveNow();
      });
      x.addEventListener('blur', function () { if (ask) { clearTimeout(delTimer); idle(); } });
      mine.chips.appendChild(el('span', { 'class': 'chipx' }, [b, x]));
    });
    mine.row.hidden = !custom.length;
    updateActiveChips();
  }

  // сохранить своё
  var saveForm = $('saveForm'), saveName = $('saveName'), saveOpen = $('saveOpen');
  function openSave(on) {
    saveForm.hidden = !on;
    saveOpen.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) { saveName.value = ''; saveName.focus(); } else if (document.activeElement && saveForm.contains(document.activeElement)) saveOpen.focus();
  }
  saveOpen.addEventListener('click', function () { openSave(saveForm.hidden); });
  $('saveCancel').addEventListener('click', function () { openSave(false); });
  saveName.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); openSave(false); } });
  saveForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = saveName.value.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    if (!name) { saveName.focus(); return; }
    var vals = {};
    params.forEach(function (p) { if (p.id !== 'volume') vals[p.id] = state[p.id]; });
    var key = name.toLowerCase(), ex = null;
    custom.forEach(function (c) { if (c.name.toLowerCase() === key) ex = c; });
    var pr;
    if (ex) { ex.name = name; ex.values = vals; pr = ex; }
    else { pr = { id: 'u' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36), name: name, values: vals }; custom.push(pr); }
    activePreset = pr.id;
    renderCustom(); emitPreset(true); saveNow();
    openSave(false);
  });

  $('randomAll').addEventListener('click', function () { randomize(null); });
  $('nudge').addEventListener('click', nudge);

  // ---------- переход ----------
  var transSeg = $('transSeg');
  var transBtns = TRANS_OPTS.map(function (o) {
    var b = el('button', { type: 'button', id: 'trans-' + o.s, role: 'radio', 'aria-checked': 'false', text: o.t });
    b.addEventListener('click', function () { setTrans(o.s); saveNow(); });
    transSeg.appendChild(b);
    return b;
  });
  function setTrans(s) {
    transSec = s;
    transBtns.forEach(function (b, i) { b.setAttribute('aria-checked', TRANS_OPTS[i].s === s ? 'true' : 'false'); });
  }

  // ---------- живой режим ----------
  var liveBtn = $('live'), liveTimer = 0;
  function liveSchedule() {
    clearTimeout(liveTimer); liveTimer = 0;
    if (live && isRunning()) liveTimer = setTimeout(liveTick, rnd(20, 40) * 1000);
  }
  function liveTick() {
    liveTimer = 0;
    if (!live || !isRunning()) return;
    var cand = params.filter(function (p) {
      if (p.type !== 'slider' || !isAuto(p) || p.id === 'beatRate') return false;
      if (p.rare && !(anchors[p.id] > 0 && state[p.id] > 0)) return false;
      return true;
    });
    var n = Math.min(cand.length, 2 + Math.floor(Math.random() * 3)), vals = {};
    for (var i = 0; i < n; i++) {
      var p = cand.splice(Math.floor(Math.random() * cand.length), 1)[0];
      var an = anchors[p.id] != null ? anchors[p.id] : state[p.id];
      var d = (Math.random() < 0.5 ? -1 : 1) * rnd(0.04, 0.12);
      var v = Math.max(an - 0.18, Math.min(an + 0.18, state[p.id] + d));
      if (/Level$/.test(p.id) && an > 0.05) v = Math.max(0.05, v);
      vals[p.id] = r2(clamp01(v));
    }
    if (n) applyValues(vals, rnd(15, 30), null, { live: true });
    liveSchedule();
  }
  function setLive(on) {
    live = !!on;
    liveBtn.setAttribute('aria-pressed', live ? 'true' : 'false');
    if (live) params.forEach(function (p) { anchors[p.id] = state[p.id]; });
    liveSchedule();
  }
  liveBtn.addEventListener('click', function () { setLive(!live); saveNow(); });

  // ---------- фон: mediaSession + тихий <audio> ----------
  var silent = null, silentTried = false;
  function silentWav() {
    var n = 8000, bytes = n * 2, b = new Uint8Array(44 + bytes), dv = new DataView(b.buffer);
    function s(o, t) { for (var i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i); }
    s(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); s(8, 'WAVE'); s(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, n, true); dv.setUint32(28, n * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    s(36, 'data'); dv.setUint32(40, bytes, true);
    var str = '';
    for (var i = 0; i < 44; i++) str += String.fromCharCode(b[i]);
    for (var j = 0; j < bytes; j++) str += '\0';
    return 'data:audio/wav;base64,' + btoa(str);
  }
  function silentPlay() {
    try {
      if (!silent && !silentTried) {
        silentTried = true;
        silent = new Audio(silentWav());
        silent.loop = true;
        silent.setAttribute('playsinline', '');
      }
      if (silent) { var pr = silent.play(); if (pr && pr.catch) pr.catch(function () {}); }
    } catch (e) { /* не страшно */ }
  }
  function silentPause() { try { if (silent) silent.pause(); } catch (e) {} }
  function updateSession() {
    try {
      var ms = navigator.mediaSession;
      if (!ms) return;
      var pr = activePreset ? findPreset(activePreset) : null;
      if (window.MediaMetadata) ms.metadata = new MediaMetadata({ title: pr ? pr.name : 'свой звук', artist: 'orpheus' });
      ms.playbackState = isRunning() ? 'playing' : 'paused';
    } catch (e) {}
  }
  function initSession() {
    try {
      var ms = navigator.mediaSession;
      if (!ms || !ms.setActionHandler) return;
      ms.setActionHandler('play', function () { if (!isRunning()) start(); });
      ms.setActionHandler('pause', function () { if (isRunning()) { setTimerMin(0, true); stop(); } });
    } catch (e) {}
  }

  // ---------- transport ----------
  var playBtn = $('play'), playIcon = $('playIcon'), playLabel = $('playLabel'), statusEl = $('status');
  var PLAY_D = 'M5 3.2v13.6L16.5 10z', PAUSE_D = 'M4.5 3h3.8v14H4.5zM11.7 3h3.8v14h-3.8z';
  var miniPlay = $('miniPlay'), miniIcon = $('miniIcon'), lastPlaying = false;
  var busy = false;
  function renderTransport() {
    var on = isRunning();
    playBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    playIcon.setAttribute('d', on ? PAUSE_D : PLAY_D);
    playLabel.textContent = on ? 'пауза' : 'играть';
    miniPlay.setAttribute('aria-pressed', on ? 'true' : 'false');
    miniPlay.setAttribute('aria-label', on ? 'пауза' : 'играть');
    miniIcon.setAttribute('d', on ? PAUSE_D : PLAY_D);
    statusEl.textContent = on ? 'играет' : 'тихо';
    statusEl.classList.toggle('on', on);
    $('app').classList.toggle('playing', on);
    if (booted && on !== lastPlaying) emit('orpheus:transport', { playing: on });
    lastPlaying = on;
    if (on) silentPlay(); else if (!fading) silentPause();
    updateSession();
    if (on) { if (live && !liveTimer) liveSchedule(); } else { clearTimeout(liveTimer); liveTimer = 0; }
  }
  function start() {
    var a = A();
    if (!a || busy) return Promise.resolve();
    silentPlay(); // в том же жесте, что и запуск
    busy = true; fading = false;
    if (fadeActive) { cancelSleepFade(); if (timerMin) setTimerMin(timerMin); }
    return Promise.resolve().then(function () { return a.start(); })
      .then(function () { try { a.setMany(state, 0); } catch (e) {} })
      .catch(function () {})
      .then(function () { busy = false; renderTransport(); });
  }
  function stop(fade) {
    var a = A();
    if (!a || busy) return Promise.resolve();
    busy = true;
    return Promise.resolve().then(function () { return a.stop(fade); })
      .catch(function () {})
      .then(function () { busy = false; renderTransport(); });
  }
  function toggle() {
    if (isRunning()) { setTimerMin(0, true); return stop(); }
    return start();
  }
  playBtn.addEventListener('click', toggle);
  miniPlay.addEventListener('click', toggle);
  function vizIsOpen() { try { return !!(window.AmbientViz && window.AmbientViz.isOpen); } catch (e) { return false; } }
  function inTextField(t) {
    var tag = t && t.tagName;
    return tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && t.type !== 'range') || (t && t.isContentEditable);
  }
  function isSpace(e) { return e.key === ' ' || e.code === 'Space'; }
  // capture: пробел работает и поверх оверлея визуализации
  document.addEventListener('keydown', function (e) {
    if (!isSpace(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target, tag = t && t.tagName;
    if (vizIsOpen()) {
      if (inTextField(t)) return;
    } else if (e.defaultPrevented || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON' || (t && t.isContentEditable)) return;
    e.preventDefault();
    if (!e.repeat) toggle();
  }, true);
  document.addEventListener('keyup', function (e) {
    if (isSpace(e) && vizIsOpen() && !inTextField(e.target)) e.preventDefault();
  }, true);

  // ---------- полный экран ----------
  var vizOpenBtn = $('vizOpen');
  vizOpenBtn.hidden = !(window.AmbientViz && typeof window.AmbientViz.open === 'function');
  vizOpenBtn.addEventListener('click', function () { try { window.AmbientViz.open(); } catch (e) {} });

  // ---------- поповеры ----------
  var pops = [];
  function makePop(popEl) {
    var P = { el: popEl, anchor: null };
    P.isOpen = function () { return !popEl.hidden; };
    P.place = function () {
      if (!P.anchor || popEl.hidden) return;
      var r = P.anchor.getBoundingClientRect(), w = popEl.offsetWidth, h = popEl.offsetHeight;
      var vw = document.documentElement.clientWidth, vh = window.innerHeight, m = 16;
      var left = r.left + w > vw - m ? r.right - w : r.left;
      left = Math.max(m, Math.min(left, vw - w - m));
      var top = r.bottom + 8;
      if (top + h > vh - m && r.top - 8 - h >= m) top = r.top - 8 - h;
      popEl.style.left = Math.round(left) + 'px';
      popEl.style.top = Math.round(top) + 'px';
    };
    P.open = function (anchor, focusIn) {
      pops.forEach(function (o) { if (o !== P) o.close(false); });
      P.anchor = anchor;
      popEl.hidden = false;
      anchor.setAttribute('aria-expanded', 'true');
      P.place();
      if (focusIn) {
        var t = popEl.querySelector('[aria-checked="true"], button');
        if (t) t.focus();
      }
    };
    P.close = function (refocus) {
      if (popEl.hidden) return;
      var a = P.anchor, had = popEl.contains(document.activeElement);
      popEl.hidden = true;
      if (a) a.setAttribute('aria-expanded', 'false');
      if (a && (refocus || had)) { try { a.focus(); } catch (e) {} }
      P.anchor = null;
    };
    P.toggle = function (anchor, ev) {
      if (P.isOpen() && P.anchor === anchor) P.close(false);
      else P.open(anchor, !!(ev && ev.detail === 0)); // с клавиатуры — фокус внутрь
    };
    popEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = Array.prototype.slice.call(popEl.querySelectorAll('button:not([disabled])')).filter(function (b) { return !b.hidden; });
      if (!f.length) return;
      if ((!e.shiftKey && document.activeElement === f[f.length - 1]) || (e.shiftKey && document.activeElement === f[0])) { e.preventDefault(); P.close(true); }
    });
    popEl.addEventListener('focusout', function (e) {
      var n = e.relatedTarget;
      if (n && !popEl.contains(n) && n !== P.anchor) P.close(false);
    });
    pops.push(P);
    return P;
  }
  document.addEventListener('pointerdown', function (e) {
    pops.forEach(function (P) { if (P.isOpen() && !P.el.contains(e.target) && !(P.anchor && P.anchor.contains(e.target))) P.close(false); });
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    pops.forEach(function (P) { if (P.isOpen()) { e.preventDefault(); P.close(true); } });
  });
  function placePops() { pops.forEach(function (P) { P.place(); }); }
  window.addEventListener('resize', placePops);
  window.addEventListener('scroll', placePops, { passive: true });
  function arrowNav(seg) {
    seg.addEventListener('keydown', function (e) {
      var d = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
      if (!d) return;
      var b = Array.prototype.slice.call(seg.querySelectorAll('button')), i = b.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      b[(i + d + b.length) % b.length].focus();
    });
  }
  var sleepPop = makePop($('sleepPop')), morePop = makePop($('morePop'));
  $('moreBtn').addEventListener('click', function (e) { morePop.toggle($('moreBtn'), e); });
  arrowNav(transSeg);

  // ---------- sleep timer ----------
  var TIMER_OPTS = [0, 15, 30, 60];
  var RING = 141.4; // длина окружности кольца луны
  var timerEnd = 0, timerInt = 0, timerMin = 0;
  var sleepSeg = $('sleepSeg'), sleepLeft = $('sleepLeft');
  var moons = Array.prototype.slice.call(document.querySelectorAll('.moon'));
  moons.forEach(function (m) { m.addEventListener('click', function (e) { sleepPop.toggle(m, e); }); });
  var timerBtns = TIMER_OPTS.map(function (m) {
    var b = el('button', { type: 'button', id: 'sleep-' + m, role: 'radio', 'aria-checked': 'false', 'aria-label': m ? m + ' минут' : 'выключить таймер', text: m ? String(m) : 'выкл' });
    b.addEventListener('click', function () { setTimerMin(m); });
    sleepSeg.appendChild(b);
    return b;
  });
  arrowNav(sleepSeg);
  $('sleepTitle').textContent = 'таймер сна, мин';
  function renderTimerBtns() {
    timerBtns.forEach(function (b, i) { b.setAttribute('aria-checked', TIMER_OPTS[i] === timerMin ? 'true' : 'false'); });
  }
  // луна: кольцо-прогресс и минуты до конца
  function renderMoons(left) {
    var on = !!timerMin;
    moons.forEach(function (m) {
      var mb = m.querySelector('.mb'), rp = m.querySelector('.rp');
      m.classList.toggle('on', on);
      mb.hidden = !on;
      if (on) {
        mb.textContent = String(Math.max(1, Math.ceil(left / 60000)));
        rp.style.strokeDashoffset = (RING * (1 - clamp01(left / (timerMin * 60000)))).toFixed(1);
      } else rp.style.strokeDashoffset = '0';
      m.setAttribute('aria-label', on ? 'таймер сна: ' + sleepLeft.textContent : 'таймер сна');
    });
  }
  function fmt(ms) {
    var s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60);
    return m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }
  // плавное затухание: F = clamp(T/3, 5, 15) мин (15 -> 5, 30 -> 10, 60 -> 15)
  function fadeMin(t) { return Math.max(5, Math.min(15, t / 3)); }
  var fadeTok = 0, fadeActive = false, fadeLen = 0;
  function endFade(tok) {
    if (tok !== fadeTok) return; // отменили или перезапустили
    fadeActive = false; fadeTok++;
    setTimerMin(0, true);
    renderTransport();
  }
  function startFade(a, secs) {
    var tok = ++fadeTok;
    fadeActive = true;
    emit('orpheus:sleepfade', { state: 'start', sec: secs });
    var pr;
    try { pr = a.fadeOut(secs); } catch (e) { pr = null; }
    Promise.resolve(pr).catch(function () { return false; }).then(function (res) {
      if (tok === fadeTok) emit('orpheus:sleepfade', { state: res === true ? 'end' : 'cancel' });
      endFade(tok);
    });
  }
  function cancelSleepFade() {
    if (!fadeActive) return;
    fadeActive = false; fadeTok++;
    emit('orpheus:sleepfade', { state: 'cancel' });
    engineCall(function (a) { if (typeof a.cancelFade === 'function') a.cancelFade(); });
  }
  function tickTimer() {
    var left = timerEnd - Date.now(), a = A();
    var canFade = !!(a && typeof a.fadeOut === 'function');
    if (fadeActive) { sleepLeft.textContent = 'затихает ' + fmt(left); renderMoons(left); return; }
    if (canFade && a.running && left > 0 && left <= fadeLen * 60000) {
      startFade(a, Math.max(1, left / 1000));
      sleepLeft.textContent = 'затихает ' + fmt(left);
      renderMoons(left);
      return;
    }
    if (left <= 0) {
      setTimerMin(0, true);
      if (a) {
        fading = true; renderTransport();
        Promise.resolve().then(function () { return a.stop(20); }).catch(function () {})
          .then(function () { if (fading) { fading = false; renderTransport(); } });
      }
      return;
    }
    sleepLeft.textContent = 'осталось ' + fmt(left);
    renderMoons(left);
  }
  // keep: не отменять затухание (пауза/конец — движок остановится сам)
  function setTimerMin(m, keep) {
    clearInterval(timerInt); timerInt = 0;
    if (!keep) cancelSleepFade();
    else if (fadeActive) { fadeActive = false; fadeTok++; emit('orpheus:sleepfade', { state: 'cancel' }); }
    timerMin = m;
    renderTimerBtns();
    if (!m) { timerEnd = 0; sleepLeft.hidden = true; sleepLeft.textContent = ''; renderMoons(0); return; }
    timerEnd = Date.now() + m * 60000;
    fadeLen = fadeMin(m);
    sleepLeft.hidden = false;
    tickTimer();
    timerInt = setInterval(tickTimer, 1000);
  }
  sleepLeft.hidden = true;
  renderTimerBtns();

  // ---------- макро ----------
  var MACROS = [
    { id: 'bright', label: 'яркость', hint: 'светлее или глуше: тембр и фильтр пэда, тембр и высота нот, тепло в обратную сторону',
      w: { padBright: 1, padTone: 0.5, notesTone: 0.5, notesHeight: 0.5, warmth: -0.6 } },
    { id: 'motion', label: 'движение', hint: 'насколько звук живёт: модуляция пэда, плотность нот и фраз, дрейф, волны',
      w: { padMotion: 1, notesDensity: 1, drift: 0.6, notesPhrase: 0.6, noiseWaves: 0.4 } },
    { id: 'room', label: 'простор', hint: 'размер пространства: реверб, длина хвоста, эхо и ширина пэда',
      w: { reverb: 1, reverbSize: 1, delay: 0.7, padWidth: 0.8 } },
    { id: 'nature', label: 'природа', hint: 'шум, волны, дождь и зерно — только те слои, что уже включены',
      w: { noiseLevel: 1, noiseWaves: 0.5, rainLevel: 0.8, noiseGrain: 0.3 }, cond: { rainLevel: 1, noiseGrain: 1 } }
  ];
  function macroValue(m) {
    var num = 0, den = 0;
    for (var id in m.w) {
      if (!byId[id] || (m.cond && m.cond[id] && state[id] <= 0.01)) continue;
      var wt = m.w[id], a = Math.abs(wt);
      num += a * (wt > 0 ? state[id] : 1 - state[id]);
      den += a;
    }
    return den ? clamp01(num / den) : 0;
  }
  var macroGesture = null;
  function refreshMacros(dur) {
    MACROS.forEach(function (m) {
      if (!m.glide || (macroGesture && macroGesture.m === m)) return;
      m.glide(r2(macroValue(m)), dur || 0.4);
    });
  }
  function applyMacro(vals) {
    for (var id in vals) {
      state[id] = vals[id]; anchors[id] = vals[id];
      if (controls[id]) controls[id].set(vals[id], 0.15);
    }
    engineCall(function (a) { a.setMany(vals, 0.15); });
    if (activePreset) { activePreset = null; updateActiveChips(); emitPreset(); }
    refreshMacros(0.3);
    saveSoon();
  }
  var macrosEl = $('macros');
  MACROS.forEach(function (m) {
    var iid = 'macro-' + m.id;
    var b = buildRng('macro', iid, m.label);
    var out = el('output', { 'for': iid });
    var label = el('label', { 'for': iid, text: m.label });
    var row = el('div', { 'class': 'slider macro', title: m.hint }, [el('div', { 'class': 'shead' }, [label, out]), b.rng]);
    b.input.setAttribute('aria-description', m.hint);
    m.cur = 0;
    function paint(v) { m.cur = v; b.input.value = v; b.tr.set(v); out.textContent = String(Math.round(v * 100)); }
    m.glide = makeGlider(paint, 0);
    b.input.addEventListener('input', function () {
      var v = r2(parseFloat(b.input.value));
      if (!macroGesture || macroGesture.m !== m) {
        // начало жеста: запоминаем исходные значения, одна запись в историю на жест
        var g = { m: m, d0: m.cur, start: {} };
        for (var id in m.w) if (byId[id] && !(m.cond && m.cond[id] && state[id] <= 0.01)) g.start[id] = state[id];
        macroGesture = g;
        pushUndo();
      }
      m.glide.stop(v);
      paint(v);
      var d = v - macroGesture.d0, vals = {};
      for (var k in macroGesture.start) vals[k] = r2(clamp01(macroGesture.start[k] + m.w[k] * d));
      applyMacro(vals);
    });
    b.input.addEventListener('change', function () {
      if (macroGesture && macroGesture.m === m) { macroGesture = null; refreshMacros(0.4); }
    });
    macrosEl.appendChild(row);
  });
  refreshMacros(0);

  // ---------- тонкая настройка ----------
  var fineEl = $('fine'), fineBtn = $('fineToggle');
  function setFine(open) {
    fineEl.classList.toggle('open', open);
    fineBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) fineEl.removeAttribute('inert'); else fineEl.setAttribute('inert', '');
  }
  setFine(lsGet('orpheus.fine') === '1');
  fineBtn.addEventListener('click', function () {
    var open = !fineEl.classList.contains('open');
    setFine(open);
    lsSet('orpheus.fine', open ? '1' : '0');
  });

  // ---------- мини-плеер ----------
  var miniEl = $('mini'), playOut = false;
  var narrow = window.matchMedia ? window.matchMedia('(max-width: 719px)') : { matches: false };
  function renderMini() {
    var show = playOut && narrow.matches;
    miniEl.classList.toggle('show', show);
    if (show) miniEl.removeAttribute('inert'); else miniEl.setAttribute('inert', '');
    if (!show && sleepPop.anchor === $('miniMoon')) sleepPop.close(false);
  }
  try {
    new IntersectionObserver(function (es) {
      es.forEach(function (e) { playOut = !e.isIntersecting; });
      renderMini();
    }).observe(playBtn);
    if (narrow.addEventListener) narrow.addEventListener('change', renderMini); else if (narrow.addListener) narrow.addListener(renderMini);
  } catch (e) {}
  renderMini();

  // ---------- initial state ----------
  var saved = loadSaved();
  var fromSave = false;
  if (saved) {
    fromSave = true;
    if (Array.isArray(saved.custom)) {
      saved.custom.forEach(function (c) {
        if (c && typeof c.id === 'string' && typeof c.name === 'string' && c.values && typeof c.values === 'object') custom.push({ id: c.id, name: c.name.slice(0, NAME_MAX), values: c.values });
      });
    }
    if (Array.isArray(saved.locked)) saved.locked.forEach(function (g) { setLocked(g, true); });
    var vals = {};
    for (var id in saved.values) if (byId[id]) vals[id] = saved.values[id];
    applyValues(vals, 0, saved.active && findPreset(saved.active) ? saved.active : null);
    setTrans(TRANS_OPTS.some(function (o) { return o.s === saved.trans; }) ? saved.trans : 3);
  } else {
    setTrans(3);
    if (PRESETS.length) applyValues(PRESETS[0].values, 0, PRESETS[0].id);
  }
  renderCustom();
  renderUndo();
  params.forEach(function (p) { anchors[p.id] = state[p.id]; });
  if (fromSave && saved.live === true) setLive(true);
  initSession();
  renderTransport();
  layoutTracks();
  booted = true;
  refreshMacros(0);
  emitPreset(true);
})();
