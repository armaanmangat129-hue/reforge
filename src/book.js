/* Reforge Reference Book: one book per subject, one A4 page per topic.
   - make(noteId): Gemini splits the note into topics (chunked for long notes), the app merges
     them with existing pages by topic, and you review the changes before anything is saved.
   - Pages are structured JSON (see db.js) and drawn as A4 sheets. A page that runs past one
     sheet is split into Part 1 and Part 2 by measuring it.
   - The book view: contents with drag-to-reorder, inline editing, search, per-page regenerate,
     and printing (contents first, page numbers and subject title on every sheet). */

const Book = (() => {
  const { esc, icon, plural, toast, openSheet, confirmSheet, emptyState, inline, view } = R;

  /* ---------- Schema ---------- */
  const STR = { type: "STRING" };
  const NUM = { type: "NUMBER" };
  const INT = { type: "INTEGER" };
  const arr = (items) => ({ type: "ARRAY", items });
  const obj = (properties, required = Object.keys(properties)) => ({ type: "OBJECT", properties, required });

  const DIAGRAM_KINDS = ["graph", "right_triangle", "triangle", "circle", "number_line", "timeline", "flow", "cycle", "labelled", "bar", "none"];

  const EXTRAS = {
    maths: obj({ formulas: arr(obj({ name: STR, formula: STR })), howToSolve: arr(STR), cas: arr(obj({ step: STR, keys: STR })) }),
    science: obj(
      { formulas: arr(obj({ name: STR, formula: STR, units: STR })), practical: obj({ aim: STR, method: arr(STR), result: STR }, []) },
      ["formulas"]
    ),
    english: obj({
      quotes: arr(obj({ quote: STR, technique: STR, shows: STR })),
      themes: arr(STR),
      characters: arr(obj({ name: STR, note: STR })),
      teel: obj({ topic: STR, evidence: STR, explain: STR, link: STR }, []),
    }, ["quotes", "themes", "characters"]),
    history: obj({ timeline: arr(obj({ date: STR, event: STR })), people: arr(obj({ name: STR, role: STR })), causes: arr(STR), effects: arr(STR) }),
  };

  function pageSchema(kind) {
    const props = {
      title: STR,
      sameAsExisting: STR,
      keyIdeas: arr(STR),
      diagram: obj(
        {
          kind: { type: "STRING", enum: DIAGRAM_KINDS },
          caption: STR,
          title: STR,
          expressions: arr(STR),
          xMin: NUM, xMax: NUM, yMin: NUM, yMax: NUM,
          points: arr(obj({ x: NUM, y: NUM, label: STR }, ["x", "label"])),
          labels: arr(STR),
          items: arr(obj({ label: STR, value: NUM, detail: STR }, ["label"])),
        },
        ["kind", "caption"]
      ),
      terms: arr(obj({ term: STR, meaning: STR })),
      example: obj({ title: STR, lines: arr(STR), answer: STR }, ["title", "lines"]),
      examTip: STR,
      missing: arr(STR),
    };
    if (EXTRAS[kind]) props.extras = EXTRAS[kind];
    return obj({ pages: arr(obj(props, Object.keys(props).filter((k) => k !== "sameAsExisting"))) });
  }

  /* ---------- Prompts ---------- */
  const KIND_RULES = {
    maths:
      `extras (Maths):
- formulas: every formula for this topic that appears in the notes, plain text like "y = a(x - h)^2 + k".
- howToSolve: 3-5 short steps. No paragraphs.
- cas: the easiest TI-Nspire CX CAS keystrokes, e.g. {"step": "Solve", "keys": "menu 3 1 → solve(0=-3x+10,x) → enter"}. If you are not completely sure of a keystroke or menu number, write "check on calculator" in keys. Never guess.
- example: a worked example with real numbers, one line of working per entry in lines, and the final answer.
- diagram: prefer "graph" (expressions in x using + - * / ^ sqrt sin cos tan ln log abs exp pi; give xMin/xMax and labelled key points with real numbers), "right_triangle" (labels = [vertical side, horizontal side, hypotenuse, angle]), "triangle" (labels = [a, b, c, A, B, C]), "circle" (labels = [radius, centre]) or "number_line" (points).`,
    science:
      `extras (Science):
- formulas: each formula from the notes with its units, e.g. {"name": "Density", "formula": "ρ = m / V", "units": "kg/m³"}. Leave units empty only if the notes give none, and then add that to missing.
- practical: only if the notes describe an experiment: aim, method steps (max 5) and result. Otherwise leave it empty.
- terms: these are shown as the definitions table.
- diagram: prefer "labelled" (title = the thing, items = its labelled parts with a short detail), "flow" or "cycle" (items = stages in order), "bar" (items with numeric value and unit in detail) or "graph".`,
    english:
      `extras (English):
- quotes: up to 4 key quotes copied exactly from the notes, each with the technique used and what it shows.
- themes: up to 5 themes, a few words each.
- characters: up to 5, each with a one-line note.
- teel: a short essay paragraph plan for this topic: topic sentence, evidence, explanation, link.
- diagram: usually "none", or "flow" for plot structure.`,
    history:
      `extras (History / Humanities):
- timeline: key dates and events from the notes in order, short.
- people: key people with their role.
- causes and effects: short lines.
- diagram: use "timeline" with items = {label: date, detail: event} (up to 8), or "flow" for cause-and-effect chains.`,
    other: `- diagram: use "flow", "cycle", "labelled", "bar" or "timeline" where it genuinely helps, otherwise "none".`,
  };

  const SYSTEM =
    "You make one-page reference sheets for a high-school student, like a hand-written study book. " +
    "Use ONLY information in the student's notes. Never add facts, dates, quotes, formulas or definitions that aren't in the notes. " +
    "If something important to the topic seems to be missing from the notes, don't fill it in: add a short description of the gap to missing (e.g. \"units for specific heat\"). " +
    "Keep everything short and easy to copy by hand. Bullets are under 15 words. No paragraphs.";

  function makePrompt(kind, noteTitle, text, existingTitles, onlyTopic) {
    return `NOTE: ${noteTitle}
"""
${text}
"""

${onlyTopic ? `Make ONE reference page about the topic "${onlyTopic}" from these notes.` : "Split these notes into topics and make one reference page per topic, in the order they appear (at most 10 pages). Merge tiny topics together."}
${existingTitles.length ? `The book already has these pages: ${JSON.stringify(existingTitles)}. If a topic is the same as one of them, set sameAsExisting to that exact title, otherwise set it to "".` : 'Set sameAsExisting to "".'}

Every page has:
- title: the topic name.
- keyIdeas: 3-6 short bullet points. Put the key word in **bold**.
- diagram: a simple diagram with real labels and numbers from the notes, or kind "none" if it wouldn't help. caption is one short line.
- terms: up to 6 key terms with a one-line meaning.
- example: one worked or applied example: title, lines (max 6) and answer.
- examTip: one line on how this topic is usually tested.
- missing: short notes on anything important the notes don't cover (empty if nothing).
${KIND_RULES[kind]}
Keep each page small enough to fit on one A4 sheet.`;
  }

  /* ---------- Validation ---------- */
  const s = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  const list = (v) => (Array.isArray(v) ? v : []);
  const num = (x) => (typeof x === "number" && isFinite(x) ? x : undefined);

  function cleanDiagram(d = {}) {
    return {
      kind: DIAGRAM_KINDS.includes(d.kind) ? d.kind : "none",
      caption: s(d.caption),
      title: s(d.title),
      expressions: list(d.expressions).map(s).filter(Boolean).slice(0, 3),
      xMin: num(d.xMin), xMax: num(d.xMax), yMin: num(d.yMin), yMax: num(d.yMax),
      points: list(d.points).filter((p) => num(p.x) !== undefined).map((p) => ({ x: p.x, y: num(p.y), label: s(p.label) })).slice(0, 8),
      labels: list(d.labels).map(s).slice(0, 6),
      items: list(d.items).map((it) => ({ label: s(it.label), value: num(it.value), detail: s(it.detail) })).filter((it) => it.label).slice(0, 8),
    };
  }

  function cleanExtras(kind, e = {}) {
    switch (kind) {
      case "maths":
        return {
          formulas: list(e.formulas).map((f) => ({ name: s(f.name), formula: s(f.formula) })).filter((f) => f.formula).slice(0, 6),
          howToSolve: list(e.howToSolve).map(s).filter(Boolean).slice(0, 5),
          cas: list(e.cas).map((c) => ({ step: s(c.step), keys: s(c.keys) })).filter((c) => c.keys).slice(0, 4),
        };
      case "science": {
        const p = e.practical || {};
        const practical = { aim: s(p.aim), method: list(p.method).map(s).filter(Boolean).slice(0, 5), result: s(p.result) };
        return {
          formulas: list(e.formulas).map((f) => ({ name: s(f.name), formula: s(f.formula), units: s(f.units) })).filter((f) => f.formula).slice(0, 6),
          practical: practical.aim || practical.method.length ? practical : null,
        };
      }
      case "english": {
        const t = e.teel || {};
        const teel = { topic: s(t.topic), evidence: s(t.evidence), explain: s(t.explain), link: s(t.link) };
        return {
          quotes: list(e.quotes).map((q) => ({ quote: s(q.quote).replace(/^["“”']+|["“”']+$/g, ""), technique: s(q.technique), shows: s(q.shows) })).filter((q) => q.quote).slice(0, 4),
          themes: list(e.themes).map(s).filter(Boolean).slice(0, 5),
          characters: list(e.characters).map((c) => ({ name: s(c.name), note: s(c.note) })).filter((c) => c.name).slice(0, 5),
          teel: teel.topic || teel.evidence ? teel : null,
        };
      }
      case "history":
        return {
          timeline: list(e.timeline).map((t) => ({ date: s(t.date), event: s(t.event) })).filter((t) => t.date && t.event).slice(0, 8),
          people: list(e.people).map((p) => ({ name: s(p.name), role: s(p.role) })).filter((p) => p.name).slice(0, 5),
          causes: list(e.causes).map(s).filter(Boolean).slice(0, 4),
          effects: list(e.effects).map(s).filter(Boolean).slice(0, 4),
        };
    }
    return {};
  }

  function cleanPage(kind, p) {
    const page = {
      title: s(p.title),
      sameAsExisting: s(p.sameAsExisting),
      keyIdeas: list(p.keyIdeas).map(s).filter(Boolean).slice(0, 6),
      diagram: cleanDiagram(p.diagram),
      terms: list(p.terms).map((t) => ({ term: s(t.term), meaning: s(t.meaning) })).filter((t) => t.term && t.meaning).slice(0, 6),
      example: { title: s(p.example?.title), lines: list(p.example?.lines).map(s).filter(Boolean).slice(0, 6), answer: s(p.example?.answer) },
      examTip: s(p.examTip),
      missing: list(p.missing).map(s).filter(Boolean).slice(0, 4),
      extras: cleanExtras(kind, p.extras),
    };
    // History: draw the timeline from the extras when Gemini didn't pick a diagram
    if (kind === "history" && page.diagram.kind === "none" && page.extras.timeline?.length >= 2) {
      page.diagram = { ...cleanDiagram({ kind: "timeline", caption: "Timeline" }), items: page.extras.timeline.map((t) => ({ label: t.date, detail: t.event })) };
    }
    return page;
  }

  function validate(kind) {
    return (v) => {
      const pages = list(v.pages).map((p) => cleanPage(kind, p)).filter((p) => p.title && p.keyIdeas.length);
      if (!pages.length) throw new Error("no pages");
      return { pages };
    };
  }

  /* ---------- Merging ---------- */
  const norm = (t) => String(t || "").toLowerCase().replace(/\*\*/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const LIST_KEYS = { keyIdeas: (x) => x, terms: (x) => x.term, missing: (x) => x };
  const EXTRA_LIST_KEYS = {
    formulas: (x) => x.formula, howToSolve: (x) => x, cas: (x) => x.keys, quotes: (x) => x.quote, themes: (x) => x,
    characters: (x) => x.name, timeline: (x) => x.date + x.event, people: (x) => x.name, causes: (x) => x, effects: (x) => x,
  };

  function union(a = [], b = [], key) {
    const seen = new Set(a.map((x) => norm(key(x))));
    const added = b.filter((x) => { const k = norm(key(x)); if (!k || seen.has(k)) return false; seen.add(k); return true; });
    return { merged: [...a, ...added], added };
  }

  /* Merge `incoming` into `base`. Returns the merged page and a list of what was added. */
  function mergeInto(base, incoming) {
    const page = JSON.parse(JSON.stringify(base));
    const changes = [];
    for (const [k, key] of Object.entries(LIST_KEYS)) {
      const { merged, added } = union(page[k], incoming[k], key);
      page[k] = merged;
      added.forEach((x) => changes.push({ field: k, text: k === "terms" ? `${x.term}: ${x.meaning}` : x }));
    }
    page.extras = page.extras || {};
    for (const [k, v] of Object.entries(incoming.extras || {})) {
      if (Array.isArray(v)) {
        const { merged, added } = union(page.extras[k] || [], v, EXTRA_LIST_KEYS[k] || ((x) => JSON.stringify(x)));
        page.extras[k] = merged;
        added.forEach((x) => changes.push({ field: k, text: describe(k, x) }));
      } else if (v && !page.extras[k]) {
        page.extras[k] = v;
        changes.push({ field: k, text: k === "practical" ? `Practical: ${v.aim || "experiment"}` : "TEEL paragraph plan" });
      }
    }
    if (!page.example?.lines?.length && incoming.example?.lines?.length) { page.example = incoming.example; changes.push({ field: "example", text: incoming.example.title || "Worked example" }); }
    if (!page.examTip && incoming.examTip) { page.examTip = incoming.examTip; changes.push({ field: "examTip", text: incoming.examTip }); }
    if ((!page.diagram || page.diagram.kind === "none") && incoming.diagram?.kind !== "none") { page.diagram = incoming.diagram; changes.push({ field: "diagram", text: incoming.diagram.caption || "Diagram" }); }
    return { page, changes };
  }

  function describe(k, x) {
    if (typeof x === "string") return x;
    if (k === "formulas") return `${x.name ? x.name + ": " : ""}${x.formula}${x.units ? ` (${x.units})` : ""}`;
    if (k === "cas") return `${x.step}: ${x.keys}`;
    if (k === "quotes") return `“${x.quote}” — ${x.technique}`;
    if (k === "characters") return `${x.name}: ${x.note}`;
    if (k === "timeline") return `${x.date}: ${x.event}`;
    if (k === "people") return `${x.name}: ${x.role}`;
    return JSON.stringify(x);
  }

  const FIELD_LABELS = {
    keyIdeas: "Key idea", terms: "Key term", missing: "Missing from notes", formulas: "Formula", howToSolve: "Step", cas: "CAS",
    quotes: "Quote", themes: "Theme", characters: "Character", timeline: "Date", people: "Person", causes: "Cause", effects: "Effect",
    practical: "Practical", teel: "TEEL", example: "Example", examTip: "Exam tip", diagram: "Diagram",
  };

  /* Pages of a topic (Part 1 / Part 2) joined back into one, for merging or regenerating. */
  function joinParts(parts) {
    const sorted = parts.slice().sort((a, b) => (a.part || 0) - (b.part || 0));
    let page = JSON.parse(JSON.stringify(sorted[0]));
    for (const p of sorted.slice(1)) page = mergeInto(page, p).page;
    page.part = 0;
    return page;
  }

  /* ---------- A4 fitting ---------- */
  let measureBox;
  function overflows(page, subject, kind) {
    if (!measureBox) {
      measureBox = document.createElement("div");
      measureBox.className = "book-measure";
      measureBox.setAttribute("aria-hidden", "true");
      document.body.appendChild(measureBox);
    }
    measureBox.innerHTML = sheetHTML(page, { subject, kind, number: 99, editable: false, paper: true });
    const sheet = measureBox.querySelector(".book-sheet");
    const body = sheet.querySelector(".pg-body");
    return body.scrollHeight > body.clientHeight + 1;
  }

  /* Returns one page, or Part 1 + Part 2 if it doesn't fit on one A4 sheet. */
  function fit(page, subject, kind) {
    const whole = { ...page, part: 0 };
    if (!overflows(whole, subject, kind)) return [whole];
    const emptyExtras = Object.fromEntries(Object.entries(page.extras || {}).map(([k, v]) => [k, Array.isArray(v) ? [] : null]));
    // Part 1: ideas, diagram, terms, tip. Part 2: example and subject extras.
    let p1 = { ...page, part: 1, example: { title: "", lines: [], answer: "" }, extras: emptyExtras, missing: page.missing };
    let p2 = { ...page, part: 2, keyIdeas: [], terms: [], examTip: "", missing: [], diagram: { kind: "none", caption: "" } };
    if (overflows(p1, subject, kind)) {
      p2.terms = page.terms;
      p1 = { ...p1, terms: [] };
    }
    return [p1, p2];
  }

  /* ---------- Rendering one sheet ---------- */
  function edit(path, value, editable, tag = "span", cls = "") {
    const html = inline(value || "");
    return editable
      ? `<${tag} class="ed ${cls}" contenteditable="true" spellcheck="true" data-path="${path}" data-raw="${esc(value || "")}">${html}</${tag}>`
      : `<${tag} class="${cls}">${html}</${tag}>`;
  }
  const items = (arr, path, editable, render) => arr.map((x, i) => render(x, `${path}.${i}`, i)).join("");

  function sheetHTML(page, { subject, kind, number, editable = true, paper = false }) {
    const e = page.extras || {};
    const ed = (p, v, tag, cls) => edit(p, v, editable, tag, cls);
    const diagram = Diagrams.render(page.diagram);
    const blocks = [];

    if (page.keyIdeas.length) blocks.push(`<section class="sb"><h4>Key ideas</h4><ul>${items(page.keyIdeas, "keyIdeas", editable, (x, p) => `<li>${ed(p, x)}</li>`)}</ul></section>`);
    if (kind === "maths" && e.formulas?.length) blocks.push(`<section class="sb formula"><h4>Formulas</h4><ul>${items(e.formulas, "extras.formulas", editable, (f, p) => `<li>${f.name ? ed(p + ".name", f.name, "span", "f-name") : ""}${ed(p + ".formula", f.formula, "code")}</li>`)}</ul></section>`);
    if (kind === "science" && e.formulas?.length) blocks.push(`<section class="sb formula"><h4>Formulas</h4><ul>${items(e.formulas, "extras.formulas", editable, (f, p) => `<li>${f.name ? ed(p + ".name", f.name, "span", "f-name") : ""}${ed(p + ".formula", f.formula, "code")}${f.units ? `<span class="units">${ed(p + ".units", f.units)}</span>` : `<span class="units missing-units">units not in notes</span>`}</li>`)}</ul></section>`);
    if (diagram) blocks.push(`<figure class="sb fig">${diagram}${page.diagram.caption ? `<figcaption>${ed("diagram.caption", page.diagram.caption)}</figcaption>` : ""}</figure>`);
    if (kind === "maths" && e.howToSolve?.length) blocks.push(`<section class="sb"><h4>How to solve</h4><ol>${items(e.howToSolve, "extras.howToSolve", editable, (x, p) => `<li>${ed(p, x)}</li>`)}</ol></section>`);
    if (page.terms.length) {
      blocks.push(kind === "science"
        ? `<section class="sb"><h4>Definitions</h4><table class="defs"><tbody>${items(page.terms, "terms", editable, (t, p) => `<tr><th>${ed(p + ".term", t.term)}</th><td>${ed(p + ".meaning", t.meaning)}</td></tr>`)}</tbody></table></section>`
        : `<section class="sb"><h4>Key terms</h4><dl class="terms-dl">${items(page.terms, "terms", editable, (t, p) => `<div><dt>${ed(p + ".term", t.term)}</dt><dd>${ed(p + ".meaning", t.meaning)}</dd></div>`)}</dl></section>`);
    }
    if (kind === "maths" && e.cas?.length) blocks.push(`<section class="sb cas"><h4>TI-Nspire CX CAS</h4><ol>${items(e.cas, "extras.cas", editable, (c, p) => `<li>${c.step ? ed(p + ".step", c.step, "span", "cas-step") : ""}${ed(p + ".keys", c.keys, "kbd", /check on calculator/i.test(c.keys) ? "unsure" : "")}</li>`)}</ol></section>`);
    if (kind === "science" && e.practical) blocks.push(`<section class="sb practical"><h4>Practical</h4>${e.practical.aim ? `<p><b>Aim</b> ${ed("extras.practical.aim", e.practical.aim)}</p>` : ""}${e.practical.method.length ? `<ol>${items(e.practical.method, "extras.practical.method", editable, (x, p) => `<li>${ed(p, x)}</li>`)}</ol>` : ""}${e.practical.result ? `<p><b>Result</b> ${ed("extras.practical.result", e.practical.result)}</p>` : ""}</section>`);
    if (kind === "english" && e.themes?.length) blocks.push(`<section class="sb"><h4>Themes</h4><ul class="themes">${items(e.themes, "extras.themes", editable, (x, p) => `<li>${ed(p, x)}</li>`)}</ul></section>`);
    if (kind === "english" && e.characters?.length) blocks.push(`<section class="sb"><h4>Characters</h4><dl class="terms-dl">${items(e.characters, "extras.characters", editable, (c, p) => `<div><dt>${ed(p + ".name", c.name)}</dt><dd>${ed(p + ".note", c.note)}</dd></div>`)}</dl></section>`);
    if (kind === "english" && e.teel) blocks.push(`<section class="sb teel"><h4>Paragraph plan (TEEL)</h4>${["topic", "evidence", "explain", "link"].map((k) => e.teel[k] ? `<p><b>${k[0].toUpperCase()}</b> ${ed("extras.teel." + k, e.teel[k])}</p>` : "").join("")}</section>`);
    if (kind === "history" && e.people?.length) blocks.push(`<section class="sb"><h4>Key people</h4><dl class="terms-dl">${items(e.people, "extras.people", editable, (x, p) => `<div><dt>${ed(p + ".name", x.name)}</dt><dd>${ed(p + ".role", x.role)}</dd></div>`)}</dl></section>`);
    if (kind === "history" && (e.causes?.length || e.effects?.length)) blocks.push(`<section class="sb ce"><div><h4>Causes</h4><ul>${items(e.causes || [], "extras.causes", editable, (x, p) => `<li>${ed(p, x)}</li>`)}</ul></div><div><h4>Effects</h4><ul>${items(e.effects || [], "extras.effects", editable, (x, p) => `<li>${ed(p, x)}</li>`)}</ul></div></section>`);
    if (kind === "history" && e.timeline?.length && page.diagram?.kind !== "timeline") blocks.push(`<section class="sb"><h4>Dates</h4><dl class="terms-dl">${items(e.timeline, "extras.timeline", editable, (x, p) => `<div><dt>${ed(p + ".date", x.date)}</dt><dd>${ed(p + ".event", x.event)}</dd></div>`)}</dl></section>`);

    const quotes = kind === "english" && e.quotes?.length
      ? `<section class="sb wide"><h4>Key quotes</h4><table class="quotes"><thead><tr><th>Quote</th><th>Technique</th><th>What it shows</th></tr></thead><tbody>${items(e.quotes, "extras.quotes", editable, (q, p) => `<tr><td>“${ed(p + ".quote", q.quote)}”</td><td>${ed(p + ".technique", q.technique)}</td><td>${ed(p + ".shows", q.shows)}</td></tr>`)}</tbody></table></section>`
      : "";
    const ex = page.example;
    const example = ex && (ex.lines.length || ex.answer)
      ? `<section class="sb wide example"><h4>${kind === "maths" ? "Worked example" : "Example"}</h4>${ex.title ? `<p class="ex-title">${ed("example.title", ex.title)}</p>` : ""}${items(ex.lines, "example.lines", editable, (l, p) => `<p class="ex-line">${ed(p, l)}</p>`)}${ex.answer ? `<p class="ex-answer">${ed("example.answer", ex.answer)}</p>` : ""}</section>`
      : "";
    const tip = page.examTip ? `<section class="sb wide tip"><h4>Exam tip</h4><p>${ed("examTip", page.examTip)}</p></section>` : "";
    const partLabel = page.part ? ` <span class="part">Part ${page.part}</span>` : "";

    return `<article class="book-sheet ${paper ? "paper" : ""}" data-kind="${kind}">
      <header class="pg-head"><span>${esc(subject.name)}</span><span>Reference book</span></header>
      <div class="pg-body">
        <h2 class="pg-title">${edit("title", page.title, editable, "span")}${partLabel}</h2>
        ${page.missing?.length ? `<p class="missing">${page.missing.map((m, i) => `<span class="tag-missing" title="Not in your notes">${icon("alert")}Missing from notes: ${edit(`missing.${i}`, m, editable)}</span>`).join("")}</p>` : ""}
        <div class="pg-cols">${blocks.join("")}</div>
        ${quotes}${example}${tip}
      </div>
      <footer class="pg-foot"><span>${esc(page.title)}${page.part ? ` · Part ${page.part}` : ""}</span><span>${number}</span></footer>
    </article>`;
  }

  /* ---------- Data helpers ---------- */
  async function pagesOf(subjectId) {
    return (await DB.all("pages", "subjectId", subjectId)).sort((a, b) => a.order - b.order || (a.part || 0) - (b.part || 0));
  }
  function groups(pages) {
    const map = new Map();
    pages.forEach((p) => { if (!map.has(p.group)) map.set(p.group, []); map.get(p.group).push(p); });
    return [...map.values()];
  }

  /* Converts reference sheets made before the Reference Book existed (maths-only, stored on notes). */
  async function migrate(subject) {
    if ((await DB.all("pages", "subjectId", subject.id)).length) return;
    const notes = (await DB.listNotes(subject.id)).filter((n) => n.outputs?.reference?.topics?.length).sort((a, b) => a.createdAt - b.createdAt);
    let order = 0;
    for (const n of notes) {
      for (const t of n.outputs.reference.topics) {
        const id = DB.uid();
        await DB.put("pages", {
          id, group: id, subjectId: subject.id, order: order++, part: 0, title: t.title, keyIdeas: [],
          diagram: { ...cleanDiagram(t.diagram) }, terms: [], example: { title: t.example?.problem || "", lines: t.example?.working || [], answer: t.example?.answer || "" },
          examTip: "", missing: [], extras: { formulas: [], howToSolve: t.steps || [], cas: t.cas || [] }, sourceNoteIds: [n.id], updatedAt: Date.now(),
        });
      }
      const fresh = await DB.getNote(n.id);
      delete fresh.outputs.reference;
      delete fresh.status?.reference;
      await DB.put("notes", fresh);
    }
  }

  async function savePages(subject, kind, topicPages, { group, order, sourceNoteIds }) {
    const old = group ? (await DB.all("pages", "subjectId", subject.id)).filter((p) => p.group === group) : [];
    for (const p of old) await DB.del("pages", p.id);
    const g = group || DB.uid();
    const parts = fit(topicPages, subject, kind);
    const saved = [];
    for (const part of parts) {
      const { sameAsExisting, ...clean } = part;
      const rec = {
        ...clean,
        id: part.part === 2 ? DB.uid() : g === group && old[0] ? old[0].id : g,
        group: g, subjectId: subject.id, order, sourceNoteIds, status: null,
        diagramSvg: Diagrams.render(part.diagram) || "",
        updatedAt: Date.now(),
      };
      await DB.put("pages", rec);
      saved.push(rec);
    }
    return saved;
  }

  /* ---------- Making pages from a note ---------- */
  async function runChunk(kind, note, chunkText, part, parts, existingTitles) {
    const title = parts > 1 ? `${note.title} (part ${part + 1} of ${parts})` : note.title;
    return Gemini.json({
      system: SYSTEM,
      prompt: makePrompt(kind, title, chunkText, existingTitles),
      schema: pageSchema(kind),
      validate: validate(kind),
      temperature: 0.3,
    });
  }

  /* Builds proposed changes for a note without saving anything. */
  async function propose(noteId, onStatus = () => {}) {
    const note = await DB.getNote(noteId);
    const subject = await DB.getSubject(note.subjectId);
    const kind = R.subjectKind(subject);
    await migrate(subject);
    const existing = groups(await pagesOf(subject.id)).map(joinParts);
    const existingTitles = existing.map((p) => p.title);
    const chunks = AI.chunk((note.rawText || "").trim());
    if (!chunks[0]) throw new Error("Add some notes first.");

    const results = [], failures = [];
    for (let i = 0; i < chunks.length; i++) {
      onStatus(chunks.length > 1 ? `Reading part ${i + 1} of ${chunks.length}…` : "Reading your notes…");
      try {
        results.push(...(await runChunk(kind, note, chunks[i], i, chunks.length, existingTitles)).pages);
      } catch (err) {
        failures.push({ index: i, error: err.message });
      }
    }
    return { note, subject, kind, chunks, existing, results, failures };
  }

  /* Turns raw topic pages into changes against the existing book. */
  function diff(proposal) {
    const { existing, results, note } = proposal;
    const byTitle = new Map(existing.map((p) => [norm(p.title), p]));
    const topics = new Map(); // merge pages from different chunks that share a topic
    for (const p of results) {
      const match = (p.sameAsExisting && byTitle.get(norm(p.sameAsExisting))) || byTitle.get(norm(p.title));
      const key = match ? "existing:" + match.group : "new:" + norm(p.title);
      const prev = topics.get(key);
      topics.set(key, { page: prev ? mergeInto(prev.page, p).page : p, match });
    }
    const changes = [];
    for (const [key, { page, match }] of topics) {
      if (match) {
        const { page: merged, changes: added } = mergeInto(match, page);
        changes.push({ key, type: added.length ? "update" : "same", title: match.title, page: merged, match, added, sourceNoteIds: [...new Set([...(match.sourceNoteIds || []), note.id])] });
      } else {
        changes.push({ key, type: "new", title: page.title, page, sourceNoteIds: [note.id] });
      }
    }
    return changes;
  }

  async function make(noteId) {
    const status = { el: null };
    toast("Making reference pages…");
    let proposal;
    try {
      proposal = await propose(noteId, (m) => status.el && (status.el.textContent = m));
    } catch (err) {
      toast(err.message);
      return;
    }
    if (!proposal.results.length && proposal.failures.length) {
      toast(proposal.failures[0].error);
    }
    return review(proposal);
  }

  /* Shows what will change, with Retry on failed parts, and saves the ticked changes. */
  async function review(proposal) {
    const render = () => {
      const changes = diff(proposal);
      const { failures, chunks } = proposal;
      const fresh = changes.filter((c) => c.type === "new");
      const updates = changes.filter((c) => c.type === "update");
      const same = changes.filter((c) => c.type === "same");
      return { changes, html: `<div class="sheet-body">
        <h2 id="sheet-title">Reference pages</h2>
        <p>${plural(fresh.length, "new page")}, ${plural(updates.length, "update")}${same.length ? `, ${same.length} unchanged` : ""}. Untick anything you don't want, then save.</p>
        ${failures.map((f) => `<div class="rv-fail"><span>${icon("alert")}${chunks.length > 1 ? `Part ${f.index + 1} of your notes` : "Your notes"} couldn't be turned into pages: ${esc(f.error)}</span><button class="btn btn-small" type="button" data-retry-chunk="${f.index}">${icon("refresh")}Retry</button></div>`).join("")}
        <ul class="rv-list">
          ${fresh.map((c) => `<li class="rv-item"><label><input type="checkbox" name="pick" value="${esc(c.key)}" checked><span class="rv-badge new">New page</span><strong>${esc(c.title)}</strong></label>
            <ul class="rv-adds">${c.page.keyIdeas.slice(0, 3).map((k) => `<li>${inline(k)}</li>`).join("")}${c.page.keyIdeas.length > 3 ? `<li class="more">and ${c.page.keyIdeas.length - 3} more</li>` : ""}</ul></li>`).join("")}
          ${updates.map((c) => `<li class="rv-item"><label><input type="checkbox" name="pick" value="${esc(c.key)}" checked><span class="rv-badge upd">Update</span><strong>${esc(c.title)}</strong></label>
            <ul class="rv-adds">${c.added.map((a) => `<li class="plus"><span>${esc(FIELD_LABELS[a.field] || a.field)}</span>${inline(a.text)}</li>`).join("")}</ul></li>`).join("")}
          ${same.map((c) => `<li class="rv-item rv-same"><span class="rv-badge">No change</span><strong>${esc(c.title)}</strong><span class="hint">already covered</span></li>`).join("")}
        </ul>
      </div>
      <div class="sheet-foot">
        <button class="btn" type="button" data-close>Cancel</button>
        <button class="btn btn-primary" value="save" ${fresh.length + updates.length ? "" : "disabled"}>Save to book</button>
      </div>` };
    };

    let current = render();
    const data = await openSheet(current.html, {
      wide: true,
      onOpen: (form) => {
        form.addEventListener("click", async (e) => {
          const b = e.target.closest("[data-retry-chunk]");
          if (!b) return;
          const i = Number(b.dataset.retryChunk);
          b.disabled = true;
          b.innerHTML = '<span class="spinner" aria-hidden="true"></span>Retrying';
          try {
            const res = await runChunk(proposal.kind, proposal.note, proposal.chunks[i], i, proposal.chunks.length, proposal.existing.map((p) => p.title));
            proposal.results.push(...res.pages);
            proposal.failures = proposal.failures.filter((f) => f.index !== i);
          } catch (err) {
            proposal.failures = proposal.failures.map((f) => (f.index === i ? { ...f, error: err.message } : f));
          }
          current = render();
          form.innerHTML = current.html;
          form.querySelectorAll("[data-close]").forEach((x) => x.addEventListener("click", () => form.closest("dialog").close()));
        });
      },
    });
    if (!data) return null;
    const picked = new Set(data.getAll("pick"));
    const chosen = current.changes.filter((c) => picked.has(c.key));
    let order = (await DB.all("pages", "subjectId", proposal.subject.id)).reduce((m, p) => Math.max(m, p.order), -1) + 1;
    for (const c of chosen) {
      await savePages(proposal.subject, proposal.kind, c.page, {
        group: c.match ? c.match.group : null,
        order: c.match ? c.match.order : order++,
        sourceNoteIds: c.sourceNoteIds,
      });
    }
    toast(chosen.length ? `${plural(chosen.length, "page")} saved to the ${proposal.subject.name} book` : "Nothing saved");
    return chosen.length;
  }

  /* Regenerates one topic (all its parts) from its source notes. */
  async function regenerate(group, subjectId) {
    const subject = await DB.getSubject(subjectId);
    const kind = R.subjectKind(subject);
    const parts = (await pagesOf(subjectId)).filter((p) => p.group === group);
    const page = joinParts(parts);
    const notes = (await Promise.all((page.sourceNoteIds || []).map((id) => DB.getNote(id)))).filter(Boolean);
    const setStatus = async (status) => { for (const p of parts) await DB.put("pages", { ...p, status }); };
    if (!notes.length) {
      await setStatus({ state: "error", error: "The notes this page came from were deleted." });
      return false;
    }
    await setStatus({ state: "working" });
    try {
      const text = notes.map((n) => `=== ${n.title} ===\n${n.rawText}`).join("\n\n").slice(0, 60000);
      const res = await Gemini.json({
        system: SYSTEM,
        prompt: makePrompt(kind, notes.map((n) => n.title).join(", "), text, [], page.title),
        schema: pageSchema(kind),
        validate: validate(kind),
        cache: false,
        temperature: 0.5,
      });
      const fresh = res.pages[0];
      fresh.title = page.title;
      await savePages(subject, kind, fresh, { group, order: page.order, sourceNoteIds: page.sourceNoteIds });
      return true;
    } catch (err) {
      await setStatus({ state: "error", error: err.message });
      return false;
    }
  }

  /* ---------- Book view ---------- */
  function setPath(obj, path, value) {
    const keys = path.split(".");
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    const last = keys[keys.length - 1];
    if (Array.isArray(o) && value === "") o.splice(Number(last), 1);
    else o[last] = value;
  }

  async function renderBook(subjectId) {
    const subject = await DB.getSubject(subjectId);
    if (!subject) { location.hash = "#/library"; return; }
    await migrate(subject);
    const kind = R.subjectKind(subject);
    const pages = await pagesOf(subjectId);
    const notes = await DB.listNotes(subjectId);
    const kindLabel = R.KINDS.find((k) => k.id === kind).label;

    if (!pages.length) {
      return `<a class="back" href="#/subject/${encodeURIComponent(subjectId)}">${icon("back")}${esc(subject.name)}</a>
        <div class="page-head"><div><span class="eyebrow">Reference book · ${esc(kindLabel)} style</span><h1>${esc(subject.name)}</h1></div></div>
        ${emptyState({
          mark: "layers",
          title: "No pages yet",
          body: notes.length ? "Open a note and press “Make reference pages”. Each topic becomes one A4 page you can copy by hand." : "Add notes to this subject first, then make reference pages from them.",
          action: notes.length ? `<a class="btn btn-primary" href="#/note/${encodeURIComponent(notes[0].id)}">Open ${esc(notes[0].title)}</a>` : `<a class="btn btn-primary" href="#/subject/${encodeURIComponent(subjectId)}">Add notes</a>`,
        })}`;
    }

    const gs = groups(pages);
    let n = 1; // page 1 is the contents
    const numbered = gs.map((g) => g.map((p) => ({ p, num: ++n })));

    return `
      <div class="book-top no-print">
        <a class="back" href="#/subject/${encodeURIComponent(subjectId)}">${icon("back")}${esc(subject.name)}</a>
        <div class="page-head">
          <div><span class="eyebrow">Reference book · ${esc(kindLabel)} style</span><h1>${esc(subject.name)}</h1>
            <p class="lead">${plural(gs.length, "topic")} · ${plural(n, "page")} including contents</p></div>
          <div class="head-actions">
            <button class="btn" type="button" data-action="export">${icon("download")}Export PDF</button>
            <button class="btn btn-primary" type="button" data-action="print">${icon("print")}Print book</button>
          </div>
        </div>
        <div class="search book-search" role="search">${icon("search")}
          <label class="visually-hidden" for="book-search">Search this book</label>
          <input class="input" id="book-search" type="search" placeholder="Search this book" autocomplete="off">
        </div>
        <p class="hint search-count" id="search-count" hidden></p>
      </div>

      <div class="book" id="book">
        <section class="card contents-card no-print" aria-labelledby="contents-h">
          <div class="contents-head"><h2 id="contents-h">Contents</h2><span class="hint">Drag to reorder</span></div>
          <ol class="toc" id="toc">
            ${numbered.map((g, i) => `<li class="toc-item" draggable="true" data-group="${g[0].p.group}">
              <span class="toc-grip" aria-hidden="true">⋮⋮</span>
              <a href="#sheet-${g[0].p.id}" data-jump="${g[0].p.id}">${esc(g[0].p.title)}${g.length > 1 ? ` <span class="hint">(${g.length} parts)</span>` : ""}</a>
              <span class="toc-dots"></span><span class="toc-num">${g[0].num}</span>
              <span class="toc-move">
                <button class="btn btn-quiet btn-icon btn-small" type="button" data-move="-1" aria-label="Move ${esc(g[0].p.title)} up" ${i === 0 ? "disabled" : ""}>↑</button>
                <button class="btn btn-quiet btn-icon btn-small" type="button" data-move="1" aria-label="Move ${esc(g[0].p.title)} down" ${i === gs.length - 1 ? "disabled" : ""}>↓</button>
              </span>
            </li>`).join("")}
          </ol>
        </section>

        <article class="book-sheet contents-sheet print-only">
          <header class="pg-head"><span>${esc(subject.name)}</span><span>Reference book</span></header>
          <div class="pg-body">
            <h2 class="pg-title">${esc(subject.name)}</h2>
            <p class="contents-sub">Reference book · ${plural(gs.length, "topic")}</p>
            <h3>Contents</h3>
            <ol class="toc-print">${numbered.map((g) => `<li><span>${esc(g[0].p.title)}</span><span class="toc-dots"></span><span>${g[0].num}</span></li>`).join("")}</ol>
          </div>
          <footer class="pg-foot"><span>Contents</span><span>1</span></footer>
        </article>

        ${numbered.flat().map(({ p, num }) => `
          <div class="sheet-wrap" id="sheet-${p.id}" data-id="${p.id}" data-group="${p.group}">
            <div class="sheet-tools no-print">
              <span class="sheet-num">Page ${num}</span>
              ${p.status?.state === "error" ? `<span class="sheet-error">${icon("alert")}${esc(p.status.error)}</span>` : ""}
              ${p.status?.state === "working" ? `<span class="sheet-busy"><span class="spinner" aria-hidden="true"></span>Regenerating…</span>` : ""}
              <span class="sheet-overflow" hidden>${icon("alert")}Runs past one A4 page <button class="btn btn-small" type="button" data-split>Split into two pages</button></span>
              <span class="spacer"></span>
              <button class="btn btn-quiet btn-small" type="button" data-regen>${icon("refresh")}${p.status?.state === "error" ? "Retry" : "Regenerate"}</button>
              <button class="btn btn-quiet btn-icon btn-small" type="button" data-delete aria-label="Delete page ${num}">${icon("trash")}</button>
            </div>
            ${sheetHTML(p, { subject, kind, number: num, editable: true })}
          </div>`).join("")}
      </div>`;
  }

  renderBook.mount = async (subjectId) => {
    const book = view.querySelector("#book");
    if (!book) return;
    const subject = await DB.getSubject(subjectId);
    const kind = R.subjectKind(subject);
    const rerender = () => R.render();

    // paper mode when there's room for a real A4 width, reflowed otherwise
    const setPaper = () => {
      const paper = book.clientWidth >= 794;
      book.querySelectorAll(".sheet-wrap .book-sheet").forEach((s) => s.classList.toggle("paper", paper));
      checkOverflow();
    };
    const checkOverflow = () => {
      book.querySelectorAll(".sheet-wrap").forEach(async (w) => {
        const p = await DB.get("pages", w.dataset.id);
        if (!p) return;
        w.querySelector(".sheet-overflow").hidden = !overflows(p, subject, kind);
      });
    };
    const ro = new ResizeObserver(setPaper);
    ro.observe(book);

    // inline editing: show raw text while editing, save on blur
    book.addEventListener("focusin", (e) => {
      const el = e.target.closest(".ed");
      if (el) el.textContent = el.dataset.raw;
    });
    book.addEventListener("keydown", (e) => {
      if (e.target.closest(".ed") && e.key === "Enter") { e.preventDefault(); e.target.blur(); }
    });
    book.addEventListener("focusout", async (e) => {
      const el = e.target.closest(".ed");
      if (!el) return;
      const wrap = el.closest(".sheet-wrap");
      const value = el.textContent.replace(/\s+/g, " ").trim();
      if (value === el.dataset.raw) { el.innerHTML = inline(value); return; }
      const page = await DB.get("pages", wrap.dataset.id);
      if (el.dataset.path === "title" && !value) { el.innerHTML = inline(el.dataset.raw); return; }
      setPath(page, el.dataset.path, value);
      page.updatedAt = Date.now();
      page.diagramSvg = Diagrams.render(page.diagram) || "";
      if (el.dataset.path === "title") {
        // keep every part of the topic under the same title
        for (const p of (await DB.all("pages", "subjectId", subjectId)).filter((x) => x.group === page.group && x.id !== page.id)) await DB.put("pages", { ...p, title: value });
      }
      await DB.put("pages", page);
      el.dataset.raw = value;
      el.innerHTML = inline(value);
      if (/^(title|keyIdeas\.\d+|terms\.\d+\.term)$/.test(el.dataset.path) && value === "") rerender();
      else if (el.dataset.path === "title" || !value) rerender();
      else wrap.querySelector(".sheet-overflow").hidden = !overflows(page, subject, kind);
    });

    // page tools
    book.addEventListener("click", async (e) => {
      const wrap = e.target.closest(".sheet-wrap");
      const jump = e.target.closest("[data-jump]");
      if (jump) { e.preventDefault(); document.getElementById("sheet-" + jump.dataset.jump)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); return; }
      const move = e.target.closest("[data-move]");
      if (move) return reorder(move.closest(".toc-item").dataset.group, Number(move.dataset.move));
      if (!wrap) return;
      if (e.target.closest("[data-delete]")) {
        const page = await DB.get("pages", wrap.dataset.id);
        if (!(await confirmSheet({ title: `Delete “${page.title}${page.part ? ` · Part ${page.part}` : ""}”?`, body: "This removes the page from the book. Your notes aren't changed.", action: "Delete page" }))) return;
        await DB.del("pages", page.id);
        const rest = (await DB.all("pages", "subjectId", subjectId)).filter((p) => p.group === page.group);
        if (rest.length === 1) await DB.put("pages", { ...rest[0], part: 0 });
        toast("Page deleted");
        return rerender();
      }
      if (e.target.closest("[data-regen]")) {
        if (!Gemini.getKey()) return toast("Add your Gemini key in Settings first");
        const btn = e.target.closest("[data-regen]");
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>Working';
        const ok = await regenerate(wrap.dataset.group, subjectId);
        toast(ok ? "Page regenerated" : "Couldn't regenerate. Press Retry on the page.");
        return rerender();
      }
      if (e.target.closest("[data-split]")) {
        const parts = (await DB.all("pages", "subjectId", subjectId)).filter((p) => p.group === wrap.dataset.group);
        const page = joinParts(parts);
        await savePages(subject, kind, page, { group: page.group, order: page.order, sourceNoteIds: page.sourceNoteIds });
        toast("Split into two pages");
        return rerender();
      }
    });

    // contents: drag to reorder
    const toc = book.querySelector("#toc");
    let dragging = null;
    toc.addEventListener("dragstart", (e) => { dragging = e.target.closest(".toc-item"); dragging?.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
    toc.addEventListener("dragover", (e) => {
      if (!dragging) return;
      e.preventDefault();
      const over = e.target.closest(".toc-item");
      if (!over || over === dragging) return;
      const after = e.clientY > over.getBoundingClientRect().top + over.offsetHeight / 2;
      over.parentNode.insertBefore(dragging, after ? over.nextSibling : over);
    });
    toc.addEventListener("dragend", async () => {
      if (!dragging) return;
      dragging.classList.remove("dragging");
      dragging = null;
      await saveOrder([...toc.querySelectorAll(".toc-item")].map((li) => li.dataset.group));
      rerender();
    });

    async function saveOrder(groupIds) {
      const all = await DB.all("pages", "subjectId", subjectId);
      for (const p of all) {
        const order = groupIds.indexOf(p.group);
        if (order >= 0 && order !== p.order) await DB.put("pages", { ...p, order });
      }
    }
    async function reorder(group, delta) {
      const ids = [...toc.querySelectorAll(".toc-item")].map((li) => li.dataset.group);
      const i = ids.indexOf(group), j = i + delta;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await saveOrder(ids);
      await R.render();
      view.querySelector(`.toc-item[data-group="${group}"] [data-move="${delta}"]:not([disabled])`)?.focus();
    }

    // search
    const search = view.querySelector("#book-search");
    const count = view.querySelector("#search-count");
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      let hits = 0;
      book.querySelectorAll(".sheet-wrap").forEach((w) => {
        const match = !q || w.textContent.toLowerCase().includes(q);
        w.hidden = !match;
        if (match && q) hits++;
      });
      toc.querySelectorAll(".toc-item").forEach((li) => {
        li.classList.toggle("dim", !!q && ![...book.querySelectorAll(`.sheet-wrap[data-group="${li.dataset.group}"]`)].some((w) => !w.hidden));
      });
      count.hidden = !q;
      count.textContent = q ? (hits ? `${plural(hits, "page")} match “${search.value.trim()}”` : `No pages match “${search.value.trim()}”`) : "";
    });

    const print = () => {
      if (search.value) { search.value = ""; search.dispatchEvent(new Event("input")); }
      window.print();
    };
    view.querySelector('[data-action="print"]').addEventListener("click", print);
    view.querySelector('[data-action="export"]').addEventListener("click", () => {
      toast("In the print window, choose “Save as PDF” as the destination");
      setTimeout(print, 600);
    });

    setPaper();
    return () => ro.disconnect();
  };

  // Print styling hooks: black on white, sheets only.
  window.addEventListener("beforeprint", () => document.documentElement.classList.add("printing"));
  window.addEventListener("afterprint", () => document.documentElement.classList.remove("printing"));

  R.route(/^\/book\/([^/]+)$/, "library", renderBook);

  return { make, pagesOf, groups, migrate, sheetHTML, fit, overflows, mergeInto, diff, regenerate };
})();
