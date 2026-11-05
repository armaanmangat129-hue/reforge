/* Reforge core: shared helpers, dialogs, toasts, markdown and the hash router.
   Screens register themselves with R.route(pattern, tab, render). */

const R = (() => {
  const view = document.getElementById("view");
  const sheet = document.getElementById("sheet");
  const toastRegion = document.querySelector(".toast-region");

  const esc = (s = "") =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const ICONS = {
    library: '<path d="M4 19.5V5a2 2 0 0 1 2-2h12v15H6a2 2 0 0 0-2 2Zm0 0A2 2 0 0 0 6 22h12v-4"/><path d="M8 7h6"/>',
    study: '<rect x="3" y="6" width="14" height="14" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v12"/>',
    tutor: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12Z"/><path d="M9 11h.01M13 11h.01M17 11h.01"/>',
    planner: '<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
    settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
    note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z"/><path d="M19 17v4M17 19h4"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.5" r="3.5"/>',
    print: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7Z"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.9-3.9L4 9M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.9 3.9L20 15M20 20v-5h-5"/>',
    send: '<path d="M4 12 20 4l-6 16-3-7Z"/><path d="m11 13 9-9"/>',
    flame: '<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-5 1-8.5Z"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/>',
    download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  };
  const icon = (name, cls = "icon") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;

  const SUBJECT_COLORS = [
    { key: "navy", label: "Navy" },
    { key: "sage", label: "Sage" },
    { key: "burgundy", label: "Burgundy" },
    { key: "ochre", label: "Ochre" },
    { key: "teal", label: "Teal" },
    { key: "plum", label: "Plum" },
    { key: "slate", label: "Slate" },
    { key: "terracotta", label: "Terracotta" },
  ];
  const subjectVar = (color) => `--subject: var(--subject-${SUBJECT_COLORS.some((c) => c.key === color) ? color : "navy"})`;
  /* Reference-book style per subject. Detected from the name; the subject's own setting wins. */
  const KINDS = [
    { id: "maths", label: "Maths", note: "Formula box, how to solve, worked example, TI-Nspire CAS steps" },
    { id: "science", label: "Science", note: "Labelled diagram, formulas with units, definitions table, practical box" },
    { id: "english", label: "English", note: "Key quotes with techniques, themes, characters, TEEL paragraph" },
    { id: "history", label: "History / Humanities", note: "Timeline, key people, causes and effects" },
    { id: "other", label: "Other", note: "The base page format" },
  ];
  const KIND_PATTERNS = {
    maths: /\bmath|maths|methods|specialist|calculus|algebra|statistics|further|mathematics|geometry|trig/i,
    science: /science|chem|physics|bio|psych|environment|earth|anatomy|physiology|health|forensic/i,
    english: /english|literature|\blit\b|literacy|language|drama|poetry|writing|eal/i,
    history: /history|humanities|geography|legal|law|politic|economics|business|society|civics|philosophy|religion|ancient|modern|sociology/i,
  };
  const detectKind = (name) => Object.keys(KIND_PATTERNS).find((k) => KIND_PATTERNS[k].test(name || "")) || "other";
  const subjectKind = (subject) => {
    if (!subject) return "other";
    if (KINDS.some((k) => k.id === subject.kind)) return subject.kind;
    if (subject.isMaths === true) return "maths"; // subjects saved before reference styles existed
    return detectKind(subject.name);
  };
  const looksLikeMaths = (name) => detectKind(name) === "maths";
  const isMaths = (subject) => subjectKind(subject) === "maths";

  const plural = (n, word, many) => `${n} ${n === 1 ? word : many || word + "s"}`;

  function when(ts) {
    const diff = Date.now() - ts;
    const min = 60 * 1000, hour = 60 * min, day = 24 * hour;
    if (diff < min) return "Just now";
    if (diff < hour) return `${Math.floor(diff / min)} min ago`;
    if (diff < day) return `${Math.floor(diff / hour)} h ago`;
    if (diff < 7 * day) return `${Math.floor(diff / day)} d ago`;
    return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  /* Local calendar day as YYYY-MM-DD */
  function dayKey(d = new Date()) {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  }
  function addDays(key, n) {
    const [y, m, d] = key.split("-").map(Number);
    return dayKey(new Date(y, m - 1, d + n));
  }
  function daysBetween(fromKey, toKey) {
    const [a, b] = [fromKey, toKey].map((k) => { const [y, m, d] = k.split("-").map(Number); return Date.UTC(y, m - 1, d); });
    return Math.round((b - a) / 86400000);
  }
  function endOfToday() {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }
  function prettyDay(key) {
    const today = dayKey();
    if (key === today) return "Today";
    if (key === addDays(today, 1)) return "Tomorrow";
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  }

  function snippet(text, query, len = 140) {
    const clean = (text || "").replace(/\s+/g, " ").trim();
    if (!query) return esc(clean.slice(0, len)) + (clean.length > len ? "…" : "");
    const i = clean.toLowerCase().indexOf(query.toLowerCase());
    const start = Math.max(0, i - 40);
    const piece = clean.slice(start, start + len);
    return highlight((start > 0 ? "…" : "") + piece + (start + len < clean.length ? "…" : ""), query);
  }
  function highlight(text, query) {
    if (!query) return esc(text);
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
    return esc(text).replace(re, "<mark>$1</mark>");
  }

  /* Inline markdown: **bold**, *italic*, `code`. Escapes first, so it's safe. */
  function inline(text) {
    return esc(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  /* Small block markdown: headings, bullet and numbered lists, paragraphs. */
  function md(text) {
    const lines = String(text || "").replace(/\r/g, "").split("\n");
    let html = "", list = null, para = [];
    const flushPara = () => { if (para.length) { html += `<p>${inline(para.join(" "))}</p>`; para = []; } };
    const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const raw of lines) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) { flushPara(); flushList(); continue; }
      if ((m = line.match(/^#{1,4}\s+(.*)/))) { flushPara(); flushList(); html += `<h4>${inline(m[1])}</h4>`; continue; }
      if ((m = line.match(/^\s*[-*•]\s+(.*)/))) {
        flushPara();
        if (list !== "ul") { flushList(); html += "<ul>"; list = "ul"; }
        html += `<li>${inline(m[1])}</li>`;
        continue;
      }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
        flushPara();
        if (list !== "ol") { flushList(); html += "<ol>"; list = "ol"; }
        html += `<li>${inline(m[1])}</li>`;
        continue;
      }
      flushList();
      para.push(line.trim());
    }
    flushPara();
    flushList();
    return html;
  }

  function toast(message) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    toastRegion.appendChild(el);
    setTimeout(() => {
      el.classList.add("leaving");
      el.addEventListener("animationend", () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 400);
    }, 2600);
  }

  /* Opens the dialog with a form. Resolves with FormData on submit, or null on cancel. */
  function openSheet(html, { onOpen, wide } = {}) {
    return new Promise((resolve) => {
      sheet.classList.toggle("sheet-wide", !!wide);
      sheet.innerHTML = `<form method="dialog" novalidate>${html}</form>`;
      const form = sheet.querySelector("form");
      let result = null;
      form.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => sheet.close()));
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (!form.reportValidity()) return;
        result = new FormData(form);
        result.submitter = e.submitter ? e.submitter.value : "";
        sheet.close();
      });
      sheet.addEventListener("close", () => resolve(result), { once: true });
      sheet.showModal();
      if (onOpen) onOpen(form, sheet);
    });
  }

  async function confirmSheet({ title, body, action, tone = "danger" }) {
    const data = await openSheet(`
      <div class="sheet-body">
        <h2 id="sheet-title">${esc(title)}</h2>
        <p>${esc(body)}</p>
      </div>
      <div class="sheet-foot">
        <button class="btn" type="button" data-close>Cancel</button>
        <button class="btn ${tone === "danger" ? "btn-danger" : "btn-primary"}" value="ok">${esc(action)}</button>
      </div>`);
    return !!data;
  }

  function emptyState({ mark, title, body, action }) {
    return `<div class="card empty reveal">
      <div class="empty-mark">${icon(mark)}</div>
      <h2>${esc(title)}</h2>
      <p>${esc(body)}</p>
      ${action || ""}
    </div>`;
  }

  function skeleton(lines = 4) {
    return `<div class="skeleton" aria-hidden="true">${Array.from({ length: lines }, (_, i) => `<span style="width:${[92, 78, 85, 64, 88, 70][i % 6]}%"></span>`).join("")}</div>`;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* ---------- Router ---------- */

  const routes = [];
  function route(re, tab, render) {
    routes.push({ re, tab, render });
  }

  function setActiveTab(tab) {
    document.querySelectorAll("[data-tab]").forEach((a) => {
      if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }

  let renderToken = 0;
  let cleanup = null;
  let query = new URLSearchParams();
  async function render() {
    const [path, qs = ""] = (location.hash.replace(/^#/, "") || "/library").split("?");
    query = new URLSearchParams(qs);
    const match = routes.find((r) => r.re.test(path));
    if (!match) return (location.hash = "#/library");
    const token = ++renderToken;
    const params = path.match(match.re).slice(1).map(decodeURIComponent);
    try {
      const html = await match.render(...params);
      if (token !== renderToken || html === undefined) return;
      if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
      document.body.classList.toggle("book-mode", path.startsWith("/book/"));
      setActiveTab(match.tab);
      view.innerHTML = html;
      if (match.render.mount) cleanup = (await match.render.mount(...params)) || null;
      Motion.reveal(view);
      window.scrollTo(0, 0);
      document.title = path === "/library" ? "Reforge | Notes into study tools" : `${view.querySelector("h1")?.textContent?.trim() || "Reforge"} | Reforge`;
    } catch (err) {
      console.error(err);
      view.innerHTML = emptyState({ mark: "alert", title: "Something went wrong", body: "Reforge couldn't open this screen. Reload the page to try again." });
    }
  }
  window.addEventListener("hashchange", render);

  return {
    view, esc, icon, SUBJECT_COLORS, subjectVar, isMaths, looksLikeMaths, KINDS, detectKind, subjectKind, plural, when, dayKey, addDays, daysBetween, endOfToday, prettyDay,
    snippet, highlight, inline, md, toast, openSheet, confirmSheet, emptyState, skeleton, shuffle, route, render,
    query: () => query,
  };
})();
