/* live demos of todoterm and jot: real keys, saved in this browser only */
(() => {
  "use strict";
  const d = document;
  const $ = (s, c = d) => c.querySelector(s);
  const el = (tag, cls, text) => { const e = d.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const len = s => Array.from(s).length;
  const clip = (s, n) => len(s) > n ? Array.from(s).slice(0, Math.max(0, n - 1)).join("") + "…" : s;
  const toast = m => dispatchEvent(new CustomEvent("gw:toast", { detail: m }));
  const load = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const coarse = matchMedia("(pointer: coarse)").matches;
  const ask = (label, initial) => coarse ? prompt(label, initial || "") : null;

  /* shared window chrome: focus ring, caption hint, key routing */
  function mount(pre, app) {
    const fig = pre.closest("figure");
    const cap = $("figcaption span", fig);
    const hint = el("span", "try", coarse ? " · tap to try" : " · click to try");
    cap.append(hint);
    pre.removeAttribute("role");
    pre.setAttribute("role", "group");
    pre.tabIndex = 0;
    pre.title = coarse ? "" : "click, then use the keys at the bottom";
    const draw = () => { pre.innerHTML = app.render(); };
    pre.addEventListener("focus", () => { fig.classList.add("on"); hint.textContent = " · esc to leave"; app.focus && app.focus(true); draw(); });
    pre.addEventListener("blur", () => { fig.classList.remove("on"); hint.textContent = coarse ? " · tap to try" : " · click to try"; draw(); });
    pre.addEventListener("keydown", e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (app.key(e.key, e, pre)) { e.preventDefault(); e.stopPropagation(); draw(); }
    });
    pre.addEventListener("click", e => {
      const kb = e.target.closest(".kb");
      if (kb) { if (app.key(kb.dataset.k, e, pre)) draw(); return; }
      if (app.click && app.click(e)) draw();
    });
    app.redraw = draw;
    app.pre = pre;
    app.fig = fig;
    draw();
  }

  /* ---------------- todoterm ---------------- */
  function todoterm(pre) {
    const SEED = () => [
      { t: "finish the jot readme", p: 3, d: "today", x: 0 },
      { t: "reply to the landlord about the heater", p: 2, d: "tomorrow", x: 0 },
      { t: "renew library books", p: 1, d: "wed", x: 0 },
      { t: "book a dentist appointment", p: 0, d: "fri", x: 0 },
      { t: "try the new omarchy theme", p: 0, d: "", x: 0 },
      { t: "read chapter 16 of the rust book", p: 0, d: "nov 03", x: 0 },
      { t: "back up dotfiles", p: 2, d: "", x: 1 },
      { t: "buy coffee beans", p: 0, d: "", x: 1 },
    ];
    let st = load("gw.todo");
    if (!st || !Array.isArray(st.tasks)) st = { tasks: SEED(), sel: 3 };
    let mode = "", buf = "", filter = "", prevFilter = "", help = false, top = 0, undo = [];
    const ROWS = 9;
    const persist = () => save("gw.todo", st);
    const snap = () => { undo.push(JSON.stringify(st)); if (undo.length > 30) undo.shift(); };
    const vis = () => st.tasks.map((_, i) => i).filter(i => !filter || st.tasks[i].t.toLowerCase().includes(filter.toLowerCase()));
    const parse = s => {
      let p = 0, due = "";
      let t = s.replace(/(^|\s)(!{1,3})(?=\s|$)/, (_, a, b) => { p = b.length; return a; });
      t = t.replace(/(^|\s)@(\S+)/, (_, a, b) => { due = b.replace(/_/g, " "); return a; });
      return { t: t.replace(/\s+/g, " ").trim(), p, d: due };
    };
    const unparse = t => [t.t, "!".repeat(t.p), t.d ? "@" + t.d.replace(/ /g, "_") : ""].filter(Boolean).join(" ");
    const row = (t, i, sel) => {
      const pri = t.p ? "!".repeat(t.p) + " " : "";
      const due = t.d ? clip(t.d, 10) : "";
      const avail = 75 - len(pri) - (due ? len(due) + 1 : 0);
      const text = clip(t.t, avail);
      const gap = due ? " ".repeat(75 - len(pri) - len(text) - len(due)) : "";
      const dueHtml = due ? `<span class="${due === "today" ? "" : "m"}">${esc(due)}</span>` : "";
      return `<span class="ln t${sel ? " sel" : ""}${t.x ? " done" : ""}" data-i="${i}"><span class="gut">${sel ? " › " : "   "}</span><span class="box m">${t.x ? "[x] " : "[ ] "}</span>${pri ? `<span class="b">${pri.trim()}</span> ` : ""}<span class="tx">${esc(text)}</span>${gap}${dueHtml}</span>`;
    };
    const kb = (k, key, label) => `<span class="kb" data-k="${k}"><span class="b"> ${key}</span><span class="m"> ${label} </span></span>`;
    const rule = `<span class="ln"> <span class="m">${"─".repeat(82)}</span></span>`;
    const HELP = [
      " <span class=\"b\">keys</span>",
      "",
      "   <span class=\"b\">j k</span> <span class=\"m\">or</span> <span class=\"b\">↑ ↓</span>   <span class=\"m\">move</span>            <span class=\"b\">a</span>   <span class=\"m\">add a task</span>",
      "   <span class=\"b\">spc</span>         <span class=\"m\">done</span>            <span class=\"b\">e</span>   <span class=\"m\">edit</span>",
      "   <span class=\"b\">d</span>           <span class=\"m\">delete</span>          <span class=\"b\">u</span>   <span class=\"m\">undo</span>",
      "   <span class=\"b\">p</span>           <span class=\"m\">priority</span>        <span class=\"b\">/</span>   <span class=\"m\">filter</span>",
      "   <span class=\"b\">J K</span>         <span class=\"m\">reorder</span>         <span class=\"b\">R</span>   <span class=\"m\">reset the demo</span>",
      "",
      " <span class=\"m\">write it like the real thing: buy milk !! @fri</span>",
    ];
    const app = {
      render() {
        const v = vis();
        if (!v.includes(st.sel)) st.sel = v.length ? v[0] : 0;
        const pos = Math.max(0, v.indexOf(st.sel));
        if (pos < top) top = pos;
        if (pos >= top + ROWS) top = pos - ROWS + 1;
        if (top > Math.max(0, v.length - ROWS)) top = Math.max(0, v.length - ROWS);
        const focused = d.activeElement === pre;
        const done = st.tasks.filter(t => t.x).length;
        const right = `${done}/${st.tasks.length}`;
        const head = ` <span class="b"> ~ todo list ~</span>  (=^<span class="g">･</span>ω<span class="g">･</span>^=)` + (filter && mode !== "filter" ? `<span class="m">  / ${esc(clip(filter, 20))}</span>` : "") + " ".repeat(Math.max(1, 83 - 26 - right.length - (filter && mode !== "filter" ? 4 + len(clip(filter, 20)) : 0))) + right;
        const lines = [`<span class="ln">${head}</span>`, rule];
        if (help) HELP.forEach(l => lines.push(`<span class="ln">${l || " "}</span>`));
        else {
          const slice = v.slice(top, top + ROWS);
          slice.forEach(i => lines.push(row(st.tasks[i], i, focused ? i === st.sel : i === st.sel)));
          if (!v.length) lines.push(`<span class="ln m">    ${filter ? "no matches." : "nothing here."} ${filter ? "esc clears the filter." : "press a to add a task."}</span>`);
          for (let n = Math.max(slice.length, v.length ? 0 : 1); n < ROWS; n++) lines.push('<span class="ln"> </span>');
        }
        lines.push(rule);
        if (mode) {
          const label = mode;
          const shown = clip(buf, 52);
          const used = 1 + 1 + len(label) + 3 + len(shown) + 1;
          const tip = "⏎ ok · esc cancel";
          lines.push(`<span class="ln"> <span class="b"> ${label}</span><span class="m"> › </span>${esc(shown)}<span class="cur2"> </span>${83 - used > len(tip) + 2 ? " ".repeat(83 - used - len(tip)) + `<span class="m">${tip}</span>` : ""}</span>`);
        } else {
          lines.push(`<span class="ln">${kb("a", "a", "add")}${kb(" ", "spc", "done")}${kb("e", "e", "edit")}${kb("d", "d", "delete")}${kb("u", "u", "undo")}${kb("/", "/", "filter")}${kb("J", "J/K", "move")}${kb("p", "p", "priority")}${kb("?", "?", "help")}</span>`);
        }
        return lines.join("");
      },
      key(k, e) {
        if (mode) {
          if (k === "Enter") {
            const text = buf.trim();
            if (mode === "filter") { filter = text; mode = ""; return true; }
            if (text) {
              snap();
              if (mode === "add") { st.tasks.push({ ...parse(text), x: 0 }); st.sel = st.tasks.length - 1; filter = ""; }
              else { const o = st.tasks[st.sel]; st.tasks[st.sel] = { ...parse(text), x: o.x }; }
              persist();
            }
            mode = "";
          } else if (k === "Escape") { if (mode === "filter") filter = prevFilter; mode = ""; }
          else if (k === "Backspace") { buf = Array.from(buf).slice(0, -1).join(""); if (mode === "filter") filter = buf; }
          else if (len(k) === 1) { buf += k; if (mode === "filter") filter = buf; }
          else return false;
          return true;
        }
        const v = vis();
        const pos = v.indexOf(st.sel);
        const t = st.tasks[st.sel];
        const begin = (m, text) => { mode = m; buf = text; prevFilter = filter; };
        if (help) { if (k === "?" || k === "Escape" || k === "q") { help = false; return true; } return k.length === 1 || k.startsWith("Arrow"); }
        switch (k) {
          case "j": case "ArrowDown": if (v.length) st.sel = v[Math.min(v.length - 1, pos + 1)]; break;
          case "k": case "ArrowUp": if (v.length) st.sel = v[Math.max(0, pos - 1)]; break;
          case "g": if (v.length) st.sel = v[0]; break;
          case "G": if (v.length) st.sel = v[v.length - 1]; break;
          case " ": case "x": if (t) { snap(); t.x = t.x ? 0 : 1; } break;
          case "p": if (t) { snap(); t.p = (t.p + 1) % 4; } break;
          case "a": {
            const r = ask("new task (try: buy milk !! @fri)");
            if (coarse) { if (r && r.trim()) { snap(); st.tasks.push({ ...parse(r), x: 0 }); st.sel = st.tasks.length - 1; filter = ""; } } else begin("add", "");
            break;
          }
          case "e": if (t) { const r = ask("edit task", unparse(t)); if (coarse) { if (r && r.trim()) { snap(); st.tasks[st.sel] = { ...parse(r), x: t.x }; } } else begin("edit", unparse(t)); } break;
          case "d": if (t) { snap(); st.tasks.splice(st.sel, 1); st.sel = Math.min(st.sel, st.tasks.length - 1); if (st.sel < 0) st.sel = 0; toast("task deleted · u to undo"); } break;
          case "u": if (undo.length) { st = JSON.parse(undo.pop()); toast("undone"); } else toast("nothing to undo"); break;
          case "J": if (t && !filter && st.sel < st.tasks.length - 1) { snap(); [st.tasks[st.sel], st.tasks[st.sel + 1]] = [st.tasks[st.sel + 1], st.tasks[st.sel]]; st.sel++; } break;
          case "K": if (t && !filter && st.sel > 0) { snap(); [st.tasks[st.sel], st.tasks[st.sel - 1]] = [st.tasks[st.sel - 1], st.tasks[st.sel]]; st.sel--; } break;
          case "/": { const r = ask("filter tasks", filter); if (coarse) { if (r !== null) filter = r.trim(); } else begin("filter", filter); break; }
          case "?": help = true; break;
          case "R": snap(); st = { tasks: SEED(), sel: 3 }; filter = ""; toast("demo reset"); break;
          case "Escape": if (filter) filter = ""; else app.pre.blur(); break;
          default: return false;
        }
        persist();
        return true;
      },
      click(e) {
        const r = e.target.closest(".t");
        if (!r) return false;
        const i = +r.dataset.i;
        if (e.target.closest(".box")) { snap(); st.tasks[i].x = st.tasks[i].x ? 0 : 1; }
        st.sel = i;
        persist();
        return true;
      },
    };
    mount(pre, app);
  }

  /* ---------------- jot ---------------- */
  function jot(pre) {
    const MIN = 60000, now = Date.now();
    const SEED = () => [
      { id: 1, pin: 1, ts: now - 4320 * MIN, body: "# omarchy setup\nafter a fresh install\n\n## packages\n- [x] neovim, tmux, ripgrep\n- [x] rust via rustup\n- [ ] syncthing for ~/Notes\n\n## keys\n- super + alt + t → todoterm\n- super + alt + n → jot\n\n> dotfiles live in git, not in the cloud." },
      { id: 2, pin: 0, ts: now - 14 * MIN, body: "# ideas\nthings to build someday\n\n- a tiny habit tracker\n- clipboard history for the terminal\n- a lock screen clock that follows the theme" },
      { id: 3, pin: 0, ts: now - 120 * MIN, body: "# groceries\noat milk\n\n- [x] coffee beans\n- [ ] oat milk\n- [ ] lemons\n- [ ] rye bread" },
      { id: 4, pin: 0, ts: now - 1440 * MIN, body: "# reading list\nto finish this winter\n\n- [x] the pragmatic programmer\n- [ ] a philosophy of software design\n- [ ] the rust book, chapter 16" },
      { id: 5, pin: 0, ts: now - 7200 * MIN, body: "# rust notes\nsmall things i forget\n\n- `cargo watch -x test` re-runs tests on save\n- prefer &str in arguments\n\n> if the borrow checker complains, the design is usually wrong." },
    ];
    let st = load("gw.jot");
    if (!st || !Array.isArray(st.notes) || !st.notes.length) st = { notes: SEED(), sel: 1, next: 6 };
    let mode = "", buf = "", q = "", prevQ = "", help = false, editing = false, gone = null;
    const persist = () => save("gw.jot", st);
    const titleOf = n => (n.body.split("\n")[0] || "").replace(/^#+\s*/, "").trim() || "untitled";
    const subOf = n => { const ls = n.body.split("\n").slice(1); const s = ls.find(l => l.trim() && !/^(#|- |> )/.test(l.trim())); return s ? s.trim() : ""; };
    const rel = ts => { const m = Math.floor((Date.now() - ts) / MIN); return m < 1 ? "now" : m < 60 ? m + "m" : m < 1440 ? Math.floor(m / 60) + "h" : Math.floor(m / 1440) + "d"; };
    const list = () => st.notes.filter(n => !q || n.body.toLowerCase().includes(q.toLowerCase())).sort((a, b) => (b.pin - a.pin) || (b.ts - a.ts));
    const cur = () => st.notes.find(n => n.id === st.sel);
    const vlen = parts => parts.reduce((n, p) => n + len(p[1]), 0);
    const html = parts => parts.map(([c, t]) => c ? `<span class="${c}">${esc(t)}</span>` : esc(t)).join("");
    const wrap = (text, w) => {
      const out = []; let line = "";
      text.split(/\s+/).filter(Boolean).forEach(word => {
        if (line && len(line) + 1 + len(word) > w) { out.push(line); line = word; } else line = line ? line + " " + word : word;
      });
      if (line) out.push(line);
      return out.length ? out : [""];
    };
    const md = (body, W) => {
      const out = [];
      body.split("\n").forEach(ln => {
        let m;
        if (/^#{1,3}\s/.test(ln)) wrap(ln.replace(/^#+\s*/, ""), W).forEach(w => out.push([["b", w]]));
        else if ((m = ln.match(/^- \[( |x)\]\s+(.*)/i))) wrap(m[2], W - 2).forEach((w, k) => out.push(k ? [["", "  "], [m[1] === " " ? "" : "s m", w]] : [[m[1] === " " ? "" : "m", m[1] === " " ? "□ " : "■ "], [m[1] === " " ? "" : "s m", w]]));
        else if ((m = ln.match(/^- (.*)/))) wrap(m[1], W - 2).forEach((w, k) => out.push([["", k ? "  " : "• "], ["", w]]));
        else if ((m = ln.match(/^> (.*)/))) wrap(m[1], W - 2).forEach(w => out.push([["", "▎ "], ["i m", w]]));
        else if (!ln.trim()) out.push([]);
        else wrap(ln, W).forEach(w => out.push([["", w]]));
      });
      return out;
    };
    const kb = (k, key, label) => `<span class="kb" data-k="${k}">${key}<span class="m"> ${label}   </span></span>`;
    const HELP = [
      [["b", "keys"]], [],
      [["b", "j k"], ["m", "   move"]], [["b", "n"], ["m", "     new note"]], [["b", "⏎ e"], ["m", "   edit (esc saves)"]],
      [["b", "/"], ["m", "     search"]], [["b", "p"], ["m", "     pin"]], [["b", "d"], ["m", "     delete, u to undo"]],
      [["b", "y"], ["m", "     copy the note"]], [["b", "R"], ["m", "     reset the demo"]], [], [["m", "notes are saved in this browser."]],
    ];
    const L = 33;
    const app = {
      focus() {},
      render() {
        const ls = list();
        if (!ls.some(n => n.id === st.sel) && ls.length) st.sel = ls[0].id;
        const n = ls.find(x => x.id === st.sel);
        const focused = d.activeElement === pre;
        const lines = [];
        const total = `${st.notes.length} note${st.notes.length === 1 ? "" : "s"}`;
        lines.push(`<span class="ln">  ◆ <span class="b">jot</span><span class="m">  ·  ${total}${" ".repeat(Math.max(1, 82 - 2 - 2 - 3 - 5 - len(total) - 7))}~/Notes</span></span>`);
        lines.push(`<span class="ln">  <span class="m">${"─".repeat(80)}</span></span>`);
        lines.push('<span class="ln"> </span>');
        /* left column: 16 lines */
        const left = [];
        if (mode === "search") left.push([["", "  / " + clip(buf, 26)], ["cur2", " "]]);
        else if (q) left.push([["m", "  / "], ["", clip(q, 26)]]);
        else left.push([["m", "  / search"]]);
        left.push([]);
        const idx = Math.max(0, ls.findIndex(x => x.id === st.sel));
        const first = Math.min(Math.max(0, idx - 4), Math.max(0, ls.length - 5));
        const own = [];
        ls.slice(first, first + 5).forEach((x, k) => {
          const s = x.id === st.sel, tl = rel(x.ts);
          const title = clip((x.pin ? "* " : "") + titleOf(x), 27 - len(tl) - 1);
          const bar = s ? "▌" : " ";
          left.push({ id: x.id, parts: [["", "  " + bar + " "], [s ? "b" : "", title], ["", " ".repeat(27 - len(title) - len(tl))], ["m", tl]] });
          left.push({ id: x.id, parts: [["", "  " + bar + " "], ["m", clip(subOf(x), 27)]] });
          left.push([]);
        });
        if (!ls.length) left.push([["m", "    no notes"]]);
        /* right column: 16 lines */
        const right = [];
        if (n) {
          const words = n.body.trim().split(/\s+/).filter(Boolean).length;
          right.push(editing ? [["m", "editing · esc saves and closes"]] : [["m", `edited ${rel(n.ts)} ago · ${words} words${n.pin ? " · " : ""}`], ...(n.pin ? [["", "pinned"]] : [])]);
          right.push([]);
          if (help) HELP.forEach(h => right.push(h));
          else if (!editing) { const body = md(n.body, 44); body.slice(0, 14).forEach(b => right.push(b)); if (body.length > 14) right[right.length - 1] = [["m", "…"]]; }
        } else if (help) { right.push([]); right.push([]); HELP.forEach(h => right.push(h)); }
        for (let i = 0; i < 16; i++) {
          const l = left[i] || [];
          const lp = Array.isArray(l) ? l : l.parts;
          const id = Array.isArray(l) ? "" : ` data-n="${l.id}"`;
          const pad = " ".repeat(Math.max(0, L - vlen(lp)));
          lines.push(`<span class="ln${id ? " jr" : ""}"${id}>${html(lp)}${pad}<span class="m">│</span>   ${html(right[i] || [])}</span>`);
        }
        lines.push('<span class="ln"> </span>');
        lines.push(`<span class="ln">  ${kb("n", "n", "new")}${kb("Enter", "⏎", "edit")}${kb("/", "/", "search")}${kb("p", "p", "pin")}${kb("d", "d", "delete")}${kb("y", "y", "copy")}${kb("q", "q", "quit")}${kb("?", "?", "help")}</span>`);
        return lines.join("");
      },
      key(k, e) {
        const ls = list(), i = ls.findIndex(x => x.id === st.sel), n = cur();
        if (mode === "search") {
          if (k === "Enter") mode = "";
          else if (k === "Escape") { q = prevQ; mode = ""; }
          else if (k === "Backspace") { buf = Array.from(buf).slice(0, -1).join(""); q = buf; }
          else if (len(k) === 1) { buf += k; q = buf; }
          else return false;
          return true;
        }
        if (help) { if (k === "?" || k === "Escape" || k === "q") { help = false; return true; } return k.length === 1; }
        switch (k) {
          case "j": case "ArrowDown": if (ls.length) st.sel = ls[Math.min(ls.length - 1, i + 1)].id; break;
          case "k": case "ArrowUp": if (ls.length) st.sel = ls[Math.max(0, i - 1)].id; break;
          case "Enter": case "e": if (n) edit(n); break;
          case "n": { const nn = { id: st.next++, pin: 0, ts: Date.now(), body: "" }; st.notes.push(nn); st.sel = nn.id; q = ""; edit(nn, true); break; }
          case "p": if (n) { n.pin = n.pin ? 0 : 1; } break;
          case "d": if (n) { gone = n; st.notes = st.notes.filter(x => x !== n); if (!st.notes.length) st.notes.push({ id: st.next++, pin: 0, ts: Date.now(), body: "# welcome\npress n to write a note" }); toast("note deleted · u to undo"); st.sel = (list()[Math.min(i, list().length - 1)] || st.notes[0]).id; } break;
          case "u": if (gone) { st.notes.push(gone); st.sel = gone.id; gone = null; toast("note restored"); } else toast("nothing to undo"); break;
          case "y": if (n) navigator.clipboard.writeText(n.body).then(() => toast("note copied"), () => toast("copy blocked by the browser")); break;
          case "/": { const r = coarse ? prompt("search notes", q) : null; if (coarse) { if (r !== null) q = r.trim(); } else { mode = "search"; buf = q; prevQ = q; } break; }
          case "?": help = true; break;
          case "R": st = { notes: SEED(), sel: 1, next: 6 }; q = ""; toast("demo reset"); break;
          case "q": case "Escape": if (q) q = ""; else app.pre.blur(); break;
          default: return false;
        }
        persist();
        return true;
      },
      click(e) {
        const r = e.target.closest(".jr");
        if (!r) return false;
        st.sel = +r.dataset.n;
        persist();
        return true;
      },
    };

    /* the editor is a real textarea laid over the right pane */
    const ta = el("textarea", "jta");
    ta.spellcheck = false;
    ta.setAttribute("aria-label", "note");
    mount(pre, app);
    pre.parentElement.append(ta);
    let target = null, fresh = false;
    function place() {
      const fs = parseFloat(getComputedStyle(pre).fontSize);
      ta.style.fontSize = fs + "px";
      ta.style.left = "37ch";
      ta.style.top = pre.offsetTop + 12 + 5 * fs * 1.3 + "px";
      ta.style.width = "44ch";
      ta.style.height = 14 * fs * 1.3 + "px";
    }
    function edit(n, isNew) {
      target = n; fresh = !!isNew; editing = true;
      ta.value = n.body;
      ta.style.display = "block";
      place();
      app.redraw();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    function close() {
      if (!editing) return;
      editing = false;
      ta.style.display = "none";
      const body = ta.value.replace(/\s+$/, "");
      if (target) {
        if (!body.replace(/^#+\s*/, "").trim()) st.notes = st.notes.filter(x => x !== target);
        else if (body !== target.body.replace(/\s+$/, "") || fresh) { target.body = body + "\n"; target.ts = Date.now(); }
        if (!st.notes.length) st.notes.push({ id: st.next++, pin: 0, ts: Date.now(), body: "# welcome\npress n to write a note" });
        if (!st.notes.some(x => x.id === st.sel)) st.sel = list()[0].id;
      }
      target = null;
      persist();
      app.redraw();
    }
    ta.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); pre.focus(); }
      else e.stopPropagation();
    });
    ta.addEventListener("blur", () => { if (editing) close(); });
    addEventListener("resize", () => { if (editing) place(); });
  }

  const t = $("#todoterm .tui"), j = $("#jot .tui");
  if (t) todoterm(t);
  if (j) jot(j);
})();
