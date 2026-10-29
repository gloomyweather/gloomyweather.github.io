(() => {
  "use strict";
  const d = document, root = d.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, c = d) => c.querySelector(s);
  const $$ = (s, c = d) => Array.from(c.querySelectorAll(s));
  const el = (tag, cls, text) => { const e = d.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  const store = (k, v) => { try { v === undefined ? localStorage.getItem(k) : localStorage.setItem(k, v); } catch (e) {} };

  let toastEl, toastTimer;
  const toast = msg => {
    if (!toastEl) { toastEl = el("div", "toast"); toastEl.setAttribute("role", "status"); d.body.append(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.remove("show"); void toastEl.offsetWidth; toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  };

  const projects = $$(".project");
  const home = !!projects.length;

  /* theme: a circle grows from the button */
  const isDark = () => root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  let turns = 0, themeBtn = null;
  const setTheme = t => { root.dataset.theme = t; store("theme", t); };
  function toggleTheme(at) {
    const next = isDark() ? "light" : "dark";
    if (themeBtn) themeBtn.firstElementChild.style.transform = `rotate(${++turns * 180}deg)`;
    toast("theme: " + next);
    if (!d.startViewTransition || reduce) return setTheme(next);
    const x = at ? at.x : innerWidth / 2, y = at ? at.y : 0;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    d.startViewTransition(() => setTheme(next)).ready.then(() => root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 650, easing: "cubic-bezier(.65,0,.35,1)", pseudoElement: "::view-transition-new(root)" }
    )).catch(() => {});
  }
  const nav = $(".top nav");
  if (nav) {
    themeBtn = el("button", "theme");
    themeBtn.type = "button";
    themeBtn.setAttribute("aria-label", "toggle light and dark theme");
    themeBtn.innerHTML = '<span class="ico" aria-hidden="true">◐</span> theme';
    themeBtn.addEventListener("click", e => {
      const b = themeBtn.getBoundingClientRect();
      toggleTheme(e.detail ? { x: e.clientX, y: e.clientY } : { x: b.left + b.width / 2, y: b.top + b.height / 2 });
    });
    nav.append(themeBtn);
  }

  /* scramble: letters decode left to right */
  const GLYPHS = "abcdefghijklmnopqrstuvwxyz0123456789/\\|_-<>#";
  function scramble(node) {
    if (reduce || node._busy) return;
    const final = node.dataset.t || (node.dataset.t = node.textContent);
    const steps = 14;
    let f = 0;
    node._busy = true;
    const id = setInterval(() => {
      f++;
      const k = (f / steps) * final.length;
      node.textContent = Array.from(final, (c, i) => (c === " " || i < k) ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0]).join("");
      if (f >= steps) { clearInterval(id); node.textContent = final; node._busy = false; }
    }, 32);
  }
  const h1t = $(".hero .type");
  if (h1t) $(".hero h1").addEventListener("mouseenter", () => scramble(h1t));
  $$(".index .name").forEach(n => n.closest("a").addEventListener("mouseenter", () => scramble(n)));

  /* project names decode when they scroll into view */
  $$(".project h3").forEach(h => {
    const t = Array.from(h.childNodes).find(n => n.nodeType === 3 && n.textContent.trim());
    if (!t) return;
    const sp = el("span", "pn", t.textContent);
    t.replaceWith(sp);
  });

  /* stats count up once the intro has played */
  const counters = $$(".stats b[data-n]");
  if (counters.length && !reduce) {
    counters.forEach(b => { b.textContent = "0"; });
    setTimeout(() => {
      const t0 = performance.now();
      const step = t => {
        const p = Math.min(1, (t - t0) / 1100), e = 1 - Math.pow(1 - p, 3);
        counters.forEach(b => { b.textContent = Math.round(+b.dataset.n * e); });
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, 2400);
  }

  /* copy buttons on install commands */
  $$("pre.cmd").forEach(pre => {
    const wrap = el("div", "cmdwrap");
    pre.replaceWith(wrap);
    wrap.append(pre);
    const b = el("button", "copy", "copy");
    b.type = "button";
    b.setAttribute("aria-label", "copy command");
    wrap.append(b);
    let timer;
    const say = (t, ok) => {
      if (ok) toast("install command copied"); b.textContent = t; b.classList.toggle("ok", ok); clearTimeout(timer); timer = setTimeout(() => { b.textContent = "copy"; b.classList.remove("ok"); }, 1800); };
    b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(pre.textContent.trim()); say("copied ✓", true); }
      catch (e) {
        const r = d.createRange(); r.selectNodeContents(pre);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        say("ctrl + c", false);
      }
    });
  });

  /* screenshots open full size */
  const lb = el("dialog", "lb");
  lb.setAttribute("aria-label", "screenshot");
  const lbImg = el("img");
  lb.append(lbImg);
  lb.addEventListener("click", () => lb.close());
  d.body.append(lb);
  $$(".shot").forEach(img => {
    const b = el("button", "zoombtn");
    b.type = "button";
    b.setAttribute("aria-label", "open screenshot full size");
    img.replaceWith(b);
    b.append(img);
    b.addEventListener("click", () => { lbImg.src = img.currentSrc || img.src; lbImg.alt = img.alt; lb.showModal(); });
  });

  /* screenshots tilt toward the pointer */
  if (matchMedia("(hover: hover) and (pointer: fine)").matches && !reduce) {
    $$(".zoombtn").forEach(b => {
      b.addEventListener("pointermove", e => {
        const r = b.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
        b.style.transition = "transform .12s linear";
        b.style.transform = `perspective(1000px) rotateY(${px * 5}deg) rotateX(${-py * 4}deg)`;
      });
      b.addEventListener("pointerleave", () => { b.style.transition = "transform .6s cubic-bezier(.2,.7,.2,1)"; b.style.transform = ""; });
    });
  }

  /* ripples where you click */
  addEventListener("pointerdown", e => {
    if (reduce || e.target.closest("dialog, input")) return;
    for (let i = 0; i < 2; i++) {
      const r = el("span", "rip");
      r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px"; r.style.animationDelay = i * 140 + "ms";
      d.body.append(r);
      r.addEventListener("animationend", () => r.remove());
    }
  }, { passive: true });

  /* tab title notices when you leave */
  const title = d.title;
  d.addEventListener("visibilitychange", () => { d.title = d.hidden ? "still raining · " + title : title; });

  /* todoterm is a toy: hover moves the selection, click or space checks a task */
  const todo = $("#todoterm .tui");
  if (todo) {
    const rows = $$(".t", todo), cnt = $(".cnt", todo);
    let cur = Math.max(0, rows.findIndex(r => r.classList.contains("sel")));
    const select = i => {
      cur = (i + rows.length) % rows.length;
      rows.forEach((r, k) => { r.classList.toggle("sel", k === cur); $(".gut", r).textContent = k === cur ? " › " : "   "; });
    };
    const toggle = r => {
      const done = r.classList.toggle("done");
      $(".box", r).textContent = done ? "[x] " : "[ ] ";
      cnt.textContent = rows.filter(x => x.classList.contains("done")).length;
    };
    rows.forEach((r, k) => {
      r.addEventListener("pointerenter", e => { if (e.pointerType === "mouse") select(k); });
      r.addEventListener("click", () => { select(k); toggle(r); });
    });
    todo.removeAttribute("role");
    todo.setAttribute("role", "group");
    todo.tabIndex = 0;
    todo.title = "try it: hover, click, or j / k / space";
    todo.addEventListener("keydown", e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      if (k === "j" || k === "ArrowDown") select(cur + 1);
      else if (k === "k" || k === "ArrowUp") select(cur - 1);
      else if (k === " " || k === "x" || k === "Enter") toggle(rows[cur]);
      else return;
      e.preventDefault(); e.stopPropagation();
    });
    const cap = $("figcaption span", todo.parentElement);
    cap.append(el("span", "try", " · try it"));
  }

  /* reveal on scroll */
  if (!reduce && "IntersectionObserver" in window) {
    const items = [
      ...$$(".group > header"), ...$$(".project > :not(ul):not(figure)"),
      ...$$(".project li"), ...$$(".index li"), ...$$(".bottom"),
    ];
    items.forEach(n => {
      n.classList.add("rv");
      if (n.matches("li")) n.style.setProperty("--i", $$(":scope > li", n.parentElement).indexOf(n));
    });
    $$(".win").forEach(w => w.classList.add("rvw"));
    const early = performance.now() < 900;
    const io = new IntersectionObserver(entries => entries.forEach(en => {
      if (!en.isIntersecting) return;
      const n = en.target;
      if (n.classList.contains("rv")) {
        const i = +n.style.getPropertyValue("--i") || 0;
        n.style.transitionDelay = ((early && performance.now() < 900 ? 1300 : 0) + i * 70) + "ms";
      }
      n.classList.add("in");
      if (n.matches(".project > h3")) setTimeout(() => scramble($(".pn", n)), 250);
      io.unobserve(n);
    }), { rootMargin: "0px 0px -8% 0px", threshold: 0.01 });
    [...items, ...$$(".win")].forEach(n => io.observe(n));
  }

  /* block cursor */
  if (matchMedia("(hover: hover) and (pointer: fine)").matches && !reduce) {
    const blk = el("div", "blk");
    blk.setAttribute("aria-hidden", "true");
    d.body.append(blk);
    let tx = 0, ty = 0, tw = 10, th = 10, x = 0, y = 0, w = 10, h = 10, run = false;
    const loop = () => {
      x += (tx - x) * 0.28; y += (ty - y) * 0.28; w += (tw - w) * 0.28; h += (th - h) * 0.28;
      blk.style.width = w + "px"; blk.style.height = h + "px";
      blk.style.transform = `translate(${x}px, ${y}px)`;
      if (Math.abs(tx - x) + Math.abs(ty - y) + Math.abs(tw - w) + Math.abs(th - h) > 0.2) requestAnimationFrame(loop); else run = false;
    };
    const kick = () => { if (!run) { run = true; requestAnimationFrame(loop); } };
    addEventListener("pointermove", e => {
      if (e.pointerType !== "mouse") return;
      const a = e.target.closest && e.target.closest("a:not(.index a), button:not(.zoombtn):not(.copy)");
      if (a) { const r = a.getBoundingClientRect(); tx = r.left - 3; ty = r.top - 1; tw = r.width + 6; th = r.height + 2; }
      else { tx = e.clientX + 8; ty = e.clientY + 8; tw = 10; th = 10; }
      if (!blk.classList.contains("on")) { x = tx; y = ty; blk.classList.add("on"); }
      kick();
    }, { passive: true });
    root.addEventListener("mouseleave", () => blk.classList.remove("on"));
  }

  /* progress bar and status line */
  const bar = el("div", "progress");
  bar.setAttribute("aria-hidden", "true");
  d.body.append(bar);
  let sl, slMode, slWhere, slPct;
  if (home) {
    sl = el("div", "sl");
    sl.setAttribute("aria-hidden", "true");
    slMode = el("span", "mode", "NORMAL");
    slWhere = el("span", "where", "home");
    slPct = el("span", "pct", "0%");
    sl.append(slMode, slWhere, el("span", "grow"), el("span", "hint", "/ search · ? help"), slPct);
    d.body.append(sl);
  }
  let queued = false;
  function update() {
    queued = false;
    const max = root.scrollHeight - innerHeight;
    const p = max > 0 ? Math.min(1, scrollY / max) : 0;
    bar.style.transform = `scaleX(${p})`;
    if (!sl) return;
    let idx = -1;
    projects.forEach((pr, i) => { if (pr.getBoundingClientRect().top < innerHeight * 0.45) idx = i; });
    slWhere.textContent = idx < 0 ? "home" : `${String(idx + 1).padStart(2, "0")}/${String(projects.length).padStart(2, "0")} ${$("h3", projects[idx]).childNodes[1].textContent}`;
    slPct.textContent = Math.round(p * 100) + "%";
    sl.classList.toggle("show", scrollY > 240);
  }
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  addEventListener("scroll", queue, { passive: true });
  addEventListener("resize", queue);
  update();

  /* jumping to a project blinks its title once the scroll settles */
  const settle = fn => {
    let last = -1, n = 0;
    const t = () => { if (scrollY === last) { if (++n > 6) return fn(); } else { n = 0; last = scrollY; } requestAnimationFrame(t); };
    requestAnimationFrame(t);
  };
  const flash = pr => {
    const h = $("h3", pr);
    if (!h || reduce) return;
    h.classList.remove("hit"); void h.offsetWidth; h.classList.add("hit");
  };
  const hashTarget = () => { const t = location.hash && d.getElementById(decodeURIComponent(location.hash.slice(1))); return t && t.classList.contains("project") ? t : null; };
  addEventListener("hashchange", () => { const t = hashTarget(); if (t) settle(() => flash(t)); });
  if (hashTarget()) addEventListener("load", () => settle(() => flash(hashTarget())), { once: true });
  const go = pr => { pr.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }); settle(() => flash(pr)); };

  /* ascii rain: always on at load (calmer for reduced motion), wind follows the mouse, drops splash */
  const cv = el("canvas", "rain");
  cv.setAttribute("aria-hidden", "true");
  d.body.append(cv);
  const ctx = cv.getContext("2d");
  const FS = 14, COL = FS * 1.2;
  let drops = [], splashes = [], raining = false, raf = 0, last = 0, W = 0, H = 0, stopTimer, wind = 0, windT = 0, rainBtn = null;
  const spawn = init => ({ x: Math.floor(Math.random() * (W / COL + 6)) * COL - 3 * COL, y: init ? Math.random() * H : -Math.random() * H * 0.4, v: 6 + Math.random() * 7, len: 3 + ((Math.random() * 6) | 0), hit: false });
  function size() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `${FS}px "JetBrains Mono", monospace`;
    const n = Math.round(W / COL * 0.55);
    while (drops.length < n) drops.push(spawn(true));
    drops.length = n;
  }
  addEventListener("pointermove", e => { windT = (e.clientX / innerWidth - 0.5) * 2; }, { passive: true });
  function frame(t) {
    const dt = Math.min(48, t - last) / 16.67 * (reduce ? 0.35 : 1); last = t;
    wind += (windT - wind) * 0.04 * dt;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = getComputedStyle(root).getPropertyValue("--ink").trim() || "#000";
    const slant = wind * 0.5, ch = Math.abs(wind) > 0.45 ? (wind > 0 ? "\\" : "/") : "|";
    for (const dr of drops) {
      for (let k = 0; k < dr.len; k++) { ctx.globalAlpha = 0.34 * (1 - k / dr.len); ctx.fillText(ch, dr.x - k * FS * slant, dr.y - k * FS); }
      dr.y += dr.v * dt; dr.x += dr.v * slant * dt;
      if (!dr.hit && dr.y > H - 6) { dr.hit = true; splashes.push({ x: dr.x, age: 0 }); }
      if (dr.y - dr.len * FS > H) Object.assign(dr, spawn(false));
    }
    for (let i = splashes.length - 1; i >= 0; i--) {
      const sp = splashes[i]; sp.age += dt;
      if (sp.age > 22) { splashes.splice(i, 1); continue; }
      ctx.globalAlpha = 0.5 * (1 - sp.age / 22);
      ctx.fillText(sp.age < 7 ? "." : sp.age < 14 ? "o" : "°", sp.x, H - 4);
      if (sp.age > 5) { ctx.fillText("·", sp.x - 9 - sp.age * 0.5, H - 4); ctx.fillText("·", sp.x + 9 + sp.age * 0.5, H - 4); }
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }
  function setRain(on, save) {
    raining = on;
    clearTimeout(stopTimer);
    if (rainBtn) { rainBtn.textContent = on ? "rain ✓" : "rain"; rainBtn.setAttribute("aria-pressed", on); }
    if (on) { size(); last = performance.now(); cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); cv.classList.add("on"); }
    else { cv.classList.remove("on"); stopTimer = setTimeout(() => cancelAnimationFrame(raf), 1000); }
  }
  const toggleRain = () => { setRain(!raining, true); toast(raining ? "rain: on" : "rain: off"); };
  addEventListener("resize", () => { if (raining) size(); });
  if (nav) {
    rainBtn = el("button", "theme", "rain");
    rainBtn.type = "button";
    rainBtn.addEventListener("click", toggleRain);
    nav.insertBefore(rainBtn, themeBtn);
  }
  const cur = $(".hero .cur") || $(".lost .cur");
  if (cur) { cur.classList.add("live"); cur.title = "rain?"; cur.addEventListener("click", toggleRain); }
  setRain(true, false);

  /* footer: the weather where you are (it is overcast) */
  const bottom = $(".bottom");
  if (bottom) {
    const w = el("span", "wx");
    const tick = () => { const n = new Date(); w.textContent = `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")} · overcast`; };
    tick(); setInterval(tick, 15000);
    bottom.firstElementChild.after(w);
  }

  /* command palette: ctrl+k or / */
  const pal = el("dialog", "pal");
  pal.setAttribute("aria-label", "command palette");
  pal.innerHTML = '<div class="pin"><span aria-hidden="true">›</span><input type="text" spellcheck="false" autocomplete="off" placeholder="type a command or a project" aria-label="search"></div><ul role="listbox"></ul><p class="phint">↑↓ move · ⏎ run · esc close</p>';
  d.body.append(pal);
  const pin = $("input", pal), plist = $("ul", pal);
  let items = [], psel = 0;
  const jump = y => scrollTo({ top: y, behavior: reduce ? "auto" : "smooth" });
  const commands = () => {
    const c = [];
    projects.forEach((p, i) => {
      const name = $(".pn", p).textContent, cmd = $("pre.cmd", p), src = $(".meta a:last-child", p);
      c.push({ label: "go to " + name, hint: String(i + 1), run: () => go(p) });
      if (cmd) c.push({ label: "copy install command: " + name, hint: "copy", run: () => navigator.clipboard.writeText(cmd.textContent.trim()).then(() => toast("install command copied"), () => toast("press ctrl + c on the command")) });
      if (src) c.push({ label: "open source: " + name, hint: "github", run: () => open(src.href, "_blank", "noopener") });
    });
    c.push({ label: "switch to " + (isDark() ? "light" : "dark") + " theme", hint: "t", run: () => toggleTheme() });
    c.push({ label: (raining ? "stop" : "start") + " the rain", hint: "r", run: toggleRain });
    c.push({ label: "scroll to top", hint: "g", run: () => jump(0) });
    c.push({ label: "scroll to bottom", hint: "G", run: () => jump(root.scrollHeight) });
    c.push({ label: "open github profile", hint: "github", run: () => open("https://github.com/gloomyweather", "_blank", "noopener") });
    if (help) c.push({ label: "show keys", hint: "?", run: () => help.showModal() });
    return c;
  };
  function render() {
    const terms = pin.value.toLowerCase().split(/\s+/).filter(Boolean);
    const all = commands().filter(c => terms.every(t => (c.label + " " + c.hint).toLowerCase().includes(t)));
    all.sort((a, b) => (b.label.toLowerCase().startsWith(terms[0] || "\0") ? 1 : 0) - (a.label.toLowerCase().startsWith(terms[0] || "\0") ? 1 : 0));
    items = all; psel = Math.min(psel, Math.max(0, items.length - 1));
    plist.replaceChildren(...items.map((c, i) => { const li = el("li"); li.setAttribute("role", "option"); li.append(el("span", "", c.label), el("span", "k", c.hint)); if (i === psel) li.className = "sel"; li.addEventListener("pointermove", () => { if (psel !== i) { psel = i; mark(); } }); li.addEventListener("click", () => run(i)); return li; }));
    if (!items.length) plist.append(el("li", "none", "nothing here. try: theme, rain, jot"));
  }
  const mark = () => { $$("li", plist).forEach((li, i) => li.classList.toggle("sel", i === psel)); const s = $("li.sel", plist); if (s) s.scrollIntoView({ block: "nearest" }); };
  const run = i => { const c = items[i]; if (!c) return; pal.close(); setTimeout(c.run, 60); };
  const openPalette = () => { pin.value = ""; psel = 0; render(); pal.showModal(); pin.focus(); };
  pin.addEventListener("input", () => { psel = 0; render(); });
  pin.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) { psel = (psel + 1) % Math.max(1, items.length); mark(); }
    else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) { psel = (psel - 1 + items.length) % Math.max(1, items.length); mark(); }
    else if (e.key === "Enter") run(psel);
    else return;
    e.preventDefault();
  });
  pal.addEventListener("click", e => { if (e.target === pal) pal.close(); });

  /* a small joke for anyone who types sudo */
  let typed = "";
  addEventListener("keypress", e => {
    if (/^(input|textarea)$/i.test(e.target.tagName)) return;
    typed = (typed + e.key).slice(-4);
    if (typed === "sudo") toast("nice try. you are not in the sudoers file.");
  });

  /* keyboard */
  const help = $("#help");
  if (help) help.addEventListener("click", e => { if (e.target === help) help.close(); });
  addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && !e.altKey) { e.preventDefault(); if (!d.querySelector("dialog[open]")) openPalette(); return; }
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable) return;
    const k = e.key;
    if (k === "/" && !d.querySelector("dialog[open]")) { e.preventDefault(); openPalette(); return; }
    if (k === "?" && help) { help.open ? help.close() : help.showModal(); return; }
    if (d.querySelector("dialog[open]")) return;
    if (k === "t") toggleTheme();
    else if (k === "r") toggleRain();
    else if (k === "g") scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    else if (k === "G") scrollTo({ top: root.scrollHeight, behavior: reduce ? "auto" : "smooth" });
    else if (home && k === "j") { const n = projects.find(p => p.getBoundingClientRect().top > 40); n ? go(n) : scrollTo({ top: root.scrollHeight, behavior: reduce ? "auto" : "smooth" }); }
    else if (home && k === "k") { const p = projects.filter(p => p.getBoundingClientRect().top < 8).pop(); p ? go(p) : scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" }); }
    else if (home && /^[1-9]$/.test(k) && projects[k - 1]) go(projects[k - 1]);
    else return;
    e.preventDefault();
  });

  /* 404: show what you typed, shell style */
  const path = $("#path");
  if (path) { path.textContent = `cd: no such file or directory: ${decodeURIComponent(location.pathname)}`; path.hidden = false; }

  console.log("%cgloomyweather", "font-family:monospace;font-weight:bold;font-size:14px", "\npress ? for keys. press r for rain.");
})();
