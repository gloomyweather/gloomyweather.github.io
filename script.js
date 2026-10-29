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

  /* skip link for keyboard users */
  if ($("main")) {
    const sk = el("a", "skip", "skip to content");
    sk.href = "#main";
    $("main").id = "main";
    d.body.prepend(sk);
  }

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

  const go = pr => pr.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });

  /* ascii rain: always on at load (calmer for reduced motion), drops splash */
  const cv = el("canvas", "rain");
  cv.setAttribute("aria-hidden", "true");
  d.body.append(cv);
  const ctx = cv.getContext("2d");
  const FS = 14, COL = FS * 1.2;
  let drops = [], splashes = [], raining = false, raf = 0, last = 0, W = 0, H = 0, stopTimer, wind = 0.35, windT = 0.35, rainBtn = null;
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
  setRain(true, false);

  /* footer: the weather where you are (it is overcast) */
  const bottom = $(".bottom");
  if (bottom) {
    const w = el("span", "wx");
    const tick = () => { const n = new Date(); w.textContent = `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")} · overcast`; };
    tick(); setInterval(tick, 15000);
    bottom.firstElementChild.after(w);
  }

  /* easter egg: a small orange visitor (type "clawd" or "claude") */
  let clawdBusy = false;
  async function clawd() {
    if (clawdBusy) return;
    clawdBusy = true;
    const body = ["..#######..", "..#o###o#..", "###########", "..#######.."];
    const legs = [["..#.#.#.#.."], ["..##.#.##.."]];
    const draw = (leg, shut) => {
      const rows = [...body, ...legs[leg]];
      let s = "";
      rows.forEach((r, y) => Array.from(r).forEach((ch, x) => { if (ch === "#") s += `<rect x="${x}" y="${y}" width="1.02" height="1.02"/>`; else if (ch === "o") s += shut ? `<rect x="${x}" y="${y}" width="1.02" height="1.02"/>` : `<rect class="eye" x="${x}" y="${y}" width="1.02" height="1.02"/>`; }));
      svg.innerHTML = s;
    };
    const wrap = el("div", "clawd");
    wrap.setAttribute("aria-hidden", "true");
    const bubble = el("div", "bubble", "hi. i helped build this site.");
    const svg = d.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 11 5");
    wrap.append(bubble, svg);
    d.body.append(wrap);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const W = 55, mid = Math.max(0, (innerWidth - W) / 2);
    let leg = 0, timer = 0;
    const walkOn = () => { timer = setInterval(() => { leg ^= 1; draw(leg, false); svg.style.transform = leg ? "translateY(-1px)" : ""; }, 170); };
    const walkOff = () => { clearInterval(timer); leg = 0; draw(0, false); svg.style.transform = ""; };
    const walk = (a, b, ms) => wrap.animate([{ transform: `translateX(${a}px)` }, { transform: `translateX(${b}px)` }], { duration: ms, easing: "linear", fill: "forwards" }).finished;
    draw(0, false);
    if (reduce) {
      wrap.style.transform = `translateX(${mid}px)`; bubble.classList.add("on");
      await sleep(3200);
    } else {
      walkOn(); await walk(-70, mid, 2300); walkOff();
      bubble.classList.add("on");
      await sleep(900); draw(0, true); await sleep(170); draw(0, false); await sleep(1700);
      bubble.classList.remove("on"); await sleep(250);
      walkOn(); await walk(mid, innerWidth + 20, 2300); walkOff();
    }
    wrap.remove();
    clawdBusy = false;
  }

  /* command palette: ctrl+k or / */
  const pal = el("dialog", "pal");
  pal.setAttribute("aria-label", "command palette");
  pal.innerHTML = '<div class="pin"><span aria-hidden="true">›</span><input type="text" spellcheck="false" autocomplete="off" placeholder="type a command or a project" aria-label="search"><span class="cnt"></span></div><ul role="listbox"><div class="hl"></div></ul><div class="pprev"></div><p class="phint"><span>↑↓ move · ⏎ run · esc close</span><span class="tip"></span></p>';
  d.body.append(pal);
  const pin = $("input", pal), plist = $("ul", pal), hl = $(".hl", pal), prev = $(".pprev", pal), pcnt = $(".cnt", pal), ptip = $(".tip", pal);
  let items = [], psel = 0;
  const jump = y => scrollTo({ top: y, behavior: reduce ? "auto" : "smooth" });
  const recent = () => { try { return JSON.parse(localStorage.getItem("recent") || "[]"); } catch (e) { return []; } };
  const remember = id => { try { localStorage.setItem("recent", JSON.stringify([id, ...recent().filter(x => x !== id)].slice(0, 3))); } catch (e) {} };
  const copyText = t => navigator.clipboard.writeText(t).then(() => toast("install command copied"), () => toast("press ctrl + c on the command"));
  const commands = () => {
    const c = [];
    projects.forEach((p, i) => {
      const name = $(".pn", p).textContent, tag = $(".tagline", p).textContent, cmd = $("pre.cmd", p), src = $(".meta a:last-child", p), shot = $(".zoombtn", p);
      const code = cmd ? cmd.textContent.trim() : "";
      c.push({ id: "go:" + name, group: "projects", label: "go to " + name, hint: String(i + 1), kw: tag, desc: tag, code, run: () => go(p) });
      if (cmd) c.push({ id: "copy:" + name, search: true, label: "copy install command: " + name, hint: "copy", desc: "copies the install commands to your clipboard", code, run: () => copyText(code) });
      if (src) c.push({ id: "src:" + name, search: true, label: "open source: " + name, hint: "github", desc: src.href.replace("https://", ""), run: () => open(src.href, "_blank", "noopener") });
      if (shot) c.push({ id: "shot:" + name, search: true, label: "view screenshot: " + name, hint: "view", desc: "opens it full size", run: () => shot.click() });
    });
    c.push({ id: "clawd", search: true, label: "say hi to clawd", hint: "hi", kw: "claude clawd mascot crab", desc: "a small visitor", run: clawd });
    c.push({ id: "theme", group: "actions", label: "switch to " + (isDark() ? "light" : "dark") + " theme", hint: "t", desc: "the page keeps your choice", run: () => toggleTheme() });
    c.push({ id: "rain", group: "actions", label: (raining ? "stop" : "start") + " the rain", hint: "r", desc: "ascii rain, off until you reload", run: toggleRain });
    c.push({ id: "random", group: "actions", label: "surprise me", hint: "random", kw: "random lucky", desc: "jumps to a random project", run: () => go(projects[(Math.random() * projects.length) | 0]) });
    c.push({ id: "weather", group: "actions", label: "check the weather", hint: "wx", kw: "wx forecast", desc: "outside, probably", run: () => toast(`overcast, ${6 + new Date().getHours() % 5}°c${raining ? ", light rain" : ""}`) });
    c.push({ id: "top", group: "actions", label: "scroll to top", hint: "g", run: () => jump(0), desc: "back to the beginning" });
    c.push({ id: "bottom", group: "actions", label: "scroll to bottom", hint: "G", run: () => jump(root.scrollHeight), desc: "to the footer" });
    if (help) c.push({ id: "keys", group: "actions", label: "show keys", hint: "?", desc: "every shortcut on one page", run: () => help.showModal() });
    c.push({ id: "gh", group: "links", label: "open github profile", hint: "github", desc: "github.com/gloomyweather", run: () => open("https://github.com/gloomyweather", "_blank", "noopener") });
    return c;
  };
  const fuzzy = (q, s) => {
    let qi = 0, score = 0, last = -2;
    const hits = [];
    for (let i = 0; i < s.length && qi < q.length; i++) {
      if (s[i] === q[qi]) { hits.push(i); score += 1 + (i === last + 1 ? 3 : 0) + (i === 0 || " -:/".includes(s[i - 1]) ? 4 : 0); last = i; qi++; }
    }
    return qi === q.length ? { score: score - s.length * 0.02, hits } : null;
  };
  function render(fresh) {
    const q = pin.value.toLowerCase().replace(/\s+/g, "");
    const all = commands();
    let rows = [];
    if (!q) {
      const rec = recent().map(id => all.find(c => c.id === id)).filter(Boolean);
      const ids = new Set(rec.map(c => c.id));
      if (rec.length) rows.push({ head: "recent" }, ...rec.map(c => ({ c })));
      ["projects", "actions", "links"].forEach(g => rows.push({ head: g }, ...all.filter(c => c.group === g && !ids.has(c.id)).map(c => ({ c }))));
    } else {
      rows = all.map(c => { const l = fuzzy(q, c.label.toLowerCase()); if (l) return { c, hits: l.hits, s: l.score + 10 }; const k = fuzzy(q, ((c.kw || "") + " " + c.hint).toLowerCase()); return k ? { c, s: k.score } : null; })
        .filter(Boolean).sort((x, y) => y.s - x.s);
    }
    items = rows.filter(r => r.c).map(r => r.c);
    psel = Math.min(psel, Math.max(0, items.length - 1));
    let n = 0;
    plist.replaceChildren(hl, ...rows.map(r => {
      const li = el("li");
      if (r.head) { li.className = "hdr"; li.textContent = r.head; return li; }
      const i = n++;
      li.className = "it"; li.setAttribute("role", "option");
      const lab = el("span", "lab");
      const hs = new Set(r.hits || []);
      Array.from(r.c.label).forEach((ch, k) => { if (hs.has(k)) lab.append(el("mark", "", ch)); else lab.append(ch); });
      li.append(lab, el("span", "k", r.c.hint));
      if (!reduce && fresh) { li.style.animation = "fade .3s ease both"; li.style.animationDelay = Math.min(i, 12) * 18 + "ms"; }
      li.addEventListener("pointermove", () => { if (psel !== i) { psel = i; mark(); } });
      li.addEventListener("click", () => run(i));
      return li;
    }));
    if (!items.length) { const li = el("li", "none", "nothing here. try: theme, rain, jot"); plist.append(li); }
    pcnt.textContent = q ? items.length + (items.length === 1 ? " match" : " matches") : "";
    hl.style.transition = "none";
    mark();
    requestAnimationFrame(() => { hl.style.transition = ""; });
  }
  function mark() {
    const its = $$("li.it", plist);
    its.forEach((li, i) => li.classList.toggle("sel", i === psel));
    const s = its[psel];
    hl.style.opacity = s ? 1 : 0;
    if (s) { hl.style.height = s.offsetHeight + "px"; hl.style.transform = `translateY(${s.offsetTop}px)`; s.scrollIntoView({ block: "nearest" }); }
    const c = items[psel];
    prev.replaceChildren();
    if (c) {
      prev.append(el("div", "pd", c.desc || ""));
      if (c.code) prev.append(el("pre", "pc", c.code));
    }
    ptip.textContent = c && c.code && c.id.startsWith("go:") ? "tab: copy install" : "";
  }
  const run = i => { const c = items[i]; if (!c) return; remember(c.id); pal.close(); setTimeout(c.run, 60); };
  const openPalette = () => { pin.value = ""; psel = 0; render(true); pal.showModal(); pin.focus(); hl.style.transition = "none"; mark(); requestAnimationFrame(() => { hl.style.transition = ""; }); };
  if (nav) {
    const sb = el("button", "theme", "search");
    sb.type = "button";
    sb.setAttribute("aria-label", "open search and commands");
    sb.addEventListener("click", openPalette);
    nav.insertBefore(sb, rainBtn || themeBtn);
  }
  pin.addEventListener("input", () => { psel = 0; render(false); });
  pin.addEventListener("keydown", e => {
    const len = Math.max(1, items.length);
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) { psel = (psel + 1) % len; mark(); }
    else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) { psel = (psel - 1 + len) % len; mark(); }
    else if (e.key === "Escape" && pin.value) { pin.value = ""; psel = 0; render(false); }
    else if (e.key === "Enter") run(psel);
    else if (e.key === "Tab") { const c = items[psel]; if (c && c.code && c.id.startsWith("go:")) { copyText(c.code); remember("copy:" + c.id.slice(3)); pal.close(); } }
    else return;
    e.preventDefault();
  });
  pal.addEventListener("click", e => { if (e.target === pal) pal.close(); });

  /* a small joke for anyone who types sudo */
  let typed = "";
  addEventListener("keypress", e => {
    if (/^(input|textarea)$/i.test(e.target.tagName)) return;
    typed = (typed + e.key).slice(-6).toLowerCase();
    if (typed.endsWith("sudo")) toast("nice try. you are not in the sudoers file.");
    else if (typed.endsWith("clawd") || typed.endsWith("claude")) clawd();
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
