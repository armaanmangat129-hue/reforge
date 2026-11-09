/* Reforge Master Mode: take advanced notes from "where am I?" to "mastered".
   1. Diagnostic  – the AI lists the concepts (with any basics the notes assume) and asks
                    5-10 questions, with an "I don't know" option, to find your level.
   2. Gap map     – each concept marked Known / Shaky / Missing, with a mastery %.
   3. Build-up    – for each weak concept, basics first: a short explanation, a worked example,
                    then practice questions of rising difficulty.
   4. Mastery     – a final check at the notes' level, plus optional "beyond" questions.
   Mastery % per concept is saved in IndexedDB ("mastery" store), so sessions resume.
   Unlike the rest of the app, Master Mode may use general knowledge to teach basics and set
   harder questions; anything not in the notes is labelled "Not in your notes". */

const Master = (() => {
  const { esc, icon, plural, toast, emptyState, skeleton, inline, view, subjectVar } = R;

  /* ---------- Schemas ---------- */
  const STR = { type: "STRING" };
  const INT = { type: "INTEGER" };
  const BOOL = { type: "BOOLEAN" };
  const arr = (items) => ({ type: "ARRAY", items });
  const obj = (properties, required = Object.keys(properties)) => ({ type: "OBJECT", properties, required });
  const QUESTION = obj({ conceptIndex: INT, concept: STR, difficulty: INT, question: STR, options: arr(STR), answerIndex: INT, explanation: STR, inNotes: BOOL });

  const SCHEMAS = {
    concepts: obj({ concepts: arr(obj({ name: STR, summary: STR, level: { type: "STRING", enum: ["foundation", "core", "advanced"] }, inNotes: BOOL })) }),
    questions: obj({ questions: arr(QUESTION) }),
    lesson: obj({
      explanation: arr(STR),
      example: obj({ problem: STR, steps: arr(STR), answer: STR }),
      practice: arr(obj({ difficulty: INT, question: STR, options: arr(STR), answerIndex: INT, explanation: STR })),
      inNotes: BOOL,
    }),
  };

  const SYSTEM =
    "You are an expert tutor helping a high-school student master advanced notes. " +
    "Base everything on the student's notes. You MAY use general knowledge to teach basics the notes assume, and for questions beyond the notes, " +
    "but whenever something is not covered by the notes, set inNotes to false. Be accurate: never invent facts or formulas. " +
    "Write in short, clear sentences for a 15-18 year old. Use the notes' terminology and units.";

  /* ---------- Validation ---------- */
  const s = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  const list = (v) => (Array.isArray(v) ? v : []);
  const norm = (t) => String(t || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  function cleanQuestion(q, concepts) {
    const options = list(q.options).map(s).filter(Boolean);
    const idx = Number(q.answerIndex);
    if (!s(q.question) || options.length !== 4 || !Number.isInteger(idx) || idx < 0 || idx > 3) return null;
    if (new Set(options.map((o) => o.toLowerCase())).size !== 4) return null; // repeated options
    const ci = Number(q.conceptIndex);
    const name = norm(q.concept);
    const concept =
      (Number.isInteger(ci) && concepts[ci]) ||
      concepts.find((c) => norm(c.name) === name) ||
      (name.length >= 4 ? concepts.find((c) => norm(c.name).length >= 4 && (norm(c.name).includes(name) || name.includes(norm(c.name)))) : null);
    if (!concept) return null; // can't tell which concept it tests: leave it out
    return {
      conceptId: concept.id,
      difficulty: Math.max(1, Math.min(3, Math.round(Number(q.difficulty) || 2))),
      question: s(q.question), options, answerIndex: idx, explanation: s(q.explanation),
      inNotes: q.inNotes !== false,
    };
  }

  const validate = {
    concepts(v) {
      const seen = new Set();
      const concepts = list(v.concepts)
        .map((c) => ({ name: s(c.name), summary: s(c.summary), level: ["foundation", "core", "advanced"].includes(c.level) ? c.level : "core", inNotes: c.inNotes !== false }))
        .filter((c) => c.name && norm(c.name) && !seen.has(norm(c.name)) && seen.add(norm(c.name)))
        .slice(0, 8)
        .map((c, i) => ({ ...c, id: `c${i}`, order: i }));
      if (concepts.length < 2) throw new Error("too few concepts");
      return { concepts };
    },
    questions(concepts, min) {
      return (v) => {
        const seen = new Set();
        const questions = list(v.questions)
          .map((q) => cleanQuestion(q, concepts))
          .filter((q) => q && !seen.has(norm(q.question)) && seen.add(norm(q.question)));
        if (questions.length < min) throw new Error("too few questions");
        return { questions };
      };
    },
    lesson(v) {
      const practice = list(v.practice)
        .map((q) => {
          const options = list(q.options).map(s).filter(Boolean);
          const idx = Number(q.answerIndex);
          if (!s(q.question) || options.length !== 4 || !Number.isInteger(idx) || idx < 0 || idx > 3) return null;
          if (new Set(options.map((o) => o.toLowerCase())).size !== 4) return null;
          return { difficulty: Math.max(1, Math.min(3, Math.round(Number(q.difficulty) || 2))), question: s(q.question), options, answerIndex: idx, explanation: s(q.explanation) };
        })
        .filter(Boolean)
        .sort((a, b) => a.difficulty - b.difficulty)
        .slice(0, 4);
      const explanation = list(v.explanation).map(s).filter(Boolean).slice(0, 6);
      if (!explanation.length || practice.length < 2) throw new Error("lesson incomplete");
      return {
        explanation,
        example: { problem: s(v.example?.problem), steps: list(v.example?.steps).map(s).filter(Boolean).slice(0, 8), answer: s(v.example?.answer) },
        practice,
        inNotes: v.inNotes !== false,
      };
    },
  };

  /* ---------- AI calls ---------- */
  async function notesText(session) {
    const notes = (await Promise.all(session.noteIds.map((id) => DB.getNote(id)))).filter(Boolean);
    let out = "";
    const limit = AI.contextChars();
    for (const n of notes) {
      const block = `=== NOTE: ${n.title} ===\n${(n.rawText || "").trim()}\n\n`;
      if (out.length + block.length > limit) { out += block.slice(0, Math.max(0, limit - out.length)); break; }
      out += block;
    }
    return out.trim();
  }

  const conceptList = (concepts) => concepts.map((c, i) => `${i}. ${c.name} (${c.level}${c.inNotes ? "" : ", not in notes"})`).join("\n");

  async function findConcepts(session, onStatus) {
    const text = await notesText(session);
    return AI.json({
      system: SYSTEM,
      prompt: `STUDENT'S NOTES:\n"""\n${text}\n"""\n\nList the 4-8 key concepts a student must master for these notes, in the order they should be learned.
- Start with up to 2 "foundation" concepts the notes ASSUME but don't explain (set inNotes false for those).
- Then the notes' own concepts ("core"), ending with the hardest ("advanced").
- name: 2-6 words. summary: one sentence.`,
      schema: SCHEMAS.concepts,
      validate: validate.concepts,
      temperature: 0.2,
      maxTokens: 900,
      onStatus,
    });
  }

  async function makeDiagnostic(session, onStatus) {
    const text = await notesText(session);
    const n = Math.max(5, Math.min(10, session.concepts.length * 2));
    return AI.json({
      system: SYSTEM,
      prompt: `STUDENT'S NOTES:\n"""\n${text}\n"""\n\nCONCEPTS:\n${conceptList(session.concepts)}\n\nWrite a ${n}-question diagnostic test that finds the student's current level on each concept.
- At least one question per concept, two where you can. Set conceptIndex to the concept's number above and "concept" to its exact name.
- Mix difficulty 1 (basic recall), 2 (apply), 3 (the notes' hardest level).
- Multiple choice: exactly 4 options, answerIndex is 0-based. Wrong options are realistic mistakes.
- explanation: one line saying why the answer is right.`,
      schema: SCHEMAS.questions,
      validate: validate.questions(session.concepts, 5),
      cache: false,
      temperature: 0.4,
      maxTokens: 2600,
      onStatus,
    });
  }

  async function makeLesson(session, concept, onStatus) {
    const text = await notesText(session);
    const stage = session.lessons?.[concept.id]?.round || 0; // set before calling for a new practice set
    return AI.json({
      system: SYSTEM,
      prompt: `STUDENT'S NOTES:\n"""\n${text}\n"""\n\nTeach the concept "${concept.name}" (${concept.summary}) to a student who is ${statusOf(concept, session) === "missing" ? "new to it" : "shaky on it"}.
- explanation: 3-5 short steps that build the idea from the basics. No paragraphs. Use **bold** for key terms.
- example: one fully worked example with real numbers or a concrete case: problem, the steps, and the answer.
- practice: 3 multiple-choice questions rising from difficulty 1 to 3, the last at the level of the notes. Exactly 4 options, answerIndex 0-based, one-line explanation.${stage ? "\n- These must be NEW questions, different from earlier practice sets." : ""}
- inNotes: false if this concept or your explanation goes beyond the notes.`,
      schema: SCHEMAS.lesson,
      validate: validate.lesson,
      maxTokens: 2200,
      cache: false,
      temperature: stage ? 0.8 : 0.4,
      onStatus,
    });
  }

  async function makeCheck(session, beyond, onStatus) {
    const text = await notesText(session);
    return AI.json({
      system: SYSTEM,
      prompt: `STUDENT'S NOTES:\n"""\n${text}\n"""\n\nCONCEPTS:\n${conceptList(session.concepts)}\n\n${beyond
        ? `Write 4 "beyond" questions that are HARDER than the notes: they extend or combine the concepts in new situations. Set inNotes false. Difficulty 3.`
        : `Write an 8-question mastery check at the level of the notes (mostly difficulty 2-3), covering every concept at least once.`}
- Set conceptIndex to the concept's number above and "concept" to its exact name.
- Multiple choice: exactly 4 options, answerIndex 0-based, realistic wrong options, one-line explanation.`,
      schema: SCHEMAS.questions,
      validate: validate.questions(session.concepts, beyond ? 2 : 5),
      cache: false,
      temperature: 0.5,
      maxTokens: 2600,
      onStatus,
    });
  }

  /* ---------- Mastery maths ---------- */
  const STATUS = { known: "Known", shaky: "Shaky", missing: "Missing" };
  const statusOf = (c, session) => {
    const m = session.mastery[c.id] ?? 0;
    return m >= 75 ? "known" : m >= 35 ? "shaky" : "missing";
  };
  const overall = (session) => {
    const vals = session.concepts.map((c) => session.mastery[c.id] ?? 0);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  };
  const clamp = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0);

  // Diagnostic: harder questions count more; "I don't know" counts as wrong. On its own it caps
  // mastery at 80%, and at 60% when a concept had a single question (one lucky guess isn't Known).
  function scoreDiagnostic(session) {
    const qs = session.diagnostic.questions;
    session.concepts.forEach((c) => {
      const mine = qs.map((q, i) => ({ q, a: session.diagnostic.answers[i] })).filter((x) => x.q.conceptId === c.id);
      if (!mine.length) { session.mastery[c.id] = 20; return; } // untested: treat as a gap to teach
      const total = mine.reduce((t, x) => t + x.q.difficulty, 0);
      const got = mine.reduce((t, x) => t + (x.a === x.q.answerIndex ? x.q.difficulty : 0), 0);
      session.mastery[c.id] = clamp((got / total) * (mine.length > 1 ? 80 : 60));
    });
  }
  // Practice: right answers move mastery up (more for harder ones), wrong ones down a little.
  // Practice alone can't reach Known unless a hardest-level question is right; the check decides.
  function practiceUpdate(session, conceptId, correct, difficulty) {
    const m = session.mastery[conceptId] ?? 0;
    const cap = difficulty >= 3 ? 85 : 74;
    session.mastery[conceptId] = correct ? clamp(m >= cap ? m : Math.min(cap, m + (100 - m) * (0.12 + 0.06 * difficulty))) : clamp(m - 6);
  }
  // Check: weigh the result by how many questions the concept had, so one miss doesn't erase it
  function scoreCheck(session, part) {
    const qs = session[part].questions;
    session.concepts.forEach((c) => {
      const mine = qs.map((q, i) => ({ q, a: session[part].answers[i] })).filter((x) => x.q.conceptId === c.id);
      if (!mine.length) return;
      const r = mine.filter((x) => x.a === x.q.answerIndex).length / mine.length;
      const m = session.mastery[c.id] ?? 0;
      const w = Math.min(0.6, 0.3 * mine.length);
      session.mastery[c.id] = part === "beyond" ? clamp(m + r * 6) : clamp(m * (1 - w) + r * 100 * w);
    });
  }

  /* ---------- Sessions ---------- */
  const save = (session) => DB.put("mastery", { ...session, updatedAt: Date.now() });
  // fill in anything a session saved by an older version (or restored from a backup) lacks
  const normalize = (x) => x && { concepts: [], mastery: {}, lessons: {}, noteIds: [], history: [], diagnostic: null, check: null, beyond: null, stage: "setup", ...x };
  const sessionsFor = async (subjectId) => (subjectId ? DB.all("mastery", "subjectId", subjectId) : DB.all("mastery")).then((l) => l.map(normalize).sort((a, b) => b.updatedAt - a.updatedAt));

  async function start(noteIds) {
    const first = await DB.getNote(noteIds[0]);
    const existing = (await sessionsFor(first.subjectId)).find((x) => x.noteIds.join() === noteIds.join());
    if (existing) return (location.hash = `#/master/${existing.id}`);
    const id = DB.uid();
    await save({
      id, subjectId: first.subjectId, noteIds, title: first.title, stage: "setup",
      concepts: [], mastery: {}, diagnostic: null, lessons: {}, check: null, beyond: null, createdAt: Date.now(),
    });
    location.hash = `#/master/${id}`;
  }

  /* ---------- Shared question runner ---------- */
  // Renders one multiple-choice question. mode "test" hides feedback until the end.
  function questionHTML(q, i, total, { mode, label, conceptName, idk }) {
    return `<div class="card panel quiz-card master-q">
      <div class="exam-meta">
        <span class="chip">${esc(conceptName || "")}</span>
        <span class="mq-meta">${label} ${i + 1} of ${total}${q.inNotes === false ? ' · <span class="tag-beyond">Not in your notes</span>' : ""}</span>
      </div>
      <h2 class="quiz-q" tabindex="-1">${inline(q.question)}</h2>
      <div class="options" role="group" aria-label="Answers">
        ${q.options.map((o, k) => `<button class="option" type="button" data-k="${k}"><kbd>${k + 1}</kbd><span>${inline(o)}</span></button>`).join("")}
        ${idk ? `<button class="option option-idk" type="button" data-k="-1"><kbd>0</kbd><span>I don't know</span></button>` : ""}
      </div>
      <div class="mq-feedback" aria-live="polite"></div>
    </div>`;
  }

  /* Runs a list of questions in `slot`. Resolves with the answers (index, or -1 for "I don't know").
     Stops listening as soon as `signal` aborts (the user left the screen). */
  function runQuestions(slot, { questions, answers = [], mode, label, conceptName, idk, onAnswer, signal }) {
    return new Promise((resolve) => {
      let i = answers.length;
      let locked = false;
      const keyHandler = (e) => {
        if (!slot.isConnected || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
        if (e.target.closest?.("input, textarea, select, dialog")) return;
        if (/^[0-4]$/.test(e.key)) {
          const btn = slot.querySelector(`[data-k="${e.key === "0" ? -1 : Number(e.key) - 1}"]`);
          if (btn && !btn.disabled) btn.click();
        } else if (e.key === "Enter" && !e.target.closest?.("a, button")) {
          slot.querySelector("[data-next]")?.click();
        }
      };
      document.addEventListener("keydown", keyHandler, { signal });
      const finish = () => { document.removeEventListener("keydown", keyHandler); resolve(answers); };
      const draw = () => {
        if (signal?.aborted || !slot.isConnected) return;
        if (i >= questions.length) return finish();
        const q = questions[i];
        locked = false;
        slot.innerHTML = questionHTML(q, i, questions.length, { mode, label, conceptName: conceptName(q), idk });
        slot.querySelectorAll(".option").forEach((b) => b.addEventListener("click", () => choose(Number(b.dataset.k))));
        slot.querySelector(".quiz-q").focus({ preventScroll: true });
      };
      const choose = async (k) => {
        if (locked) return; // a double click or key repeat must not count twice
        locked = true;
        slot.querySelectorAll(".option").forEach((b) => (b.disabled = true));
        const q = questions[i];
        answers[i] = k;
        await onAnswer?.(i, k, q);
        if (signal?.aborted) return;
        if (mode === "test") { i++; return draw(); }
        // practice: show the answer before moving on
        slot.querySelectorAll(".option").forEach((b) => {
          const idx = Number(b.dataset.k);
          if (idx === q.answerIndex) b.classList.add("is-correct");
          else if (idx === k) b.classList.add("is-wrong");
        });
        const right = k === q.answerIndex;
        slot.querySelector(".mq-feedback").innerHTML = `<div class="feedback ${right ? "ok" : "bad"}"><strong>${right ? "Correct" : "Not quite"}</strong>${q.explanation ? `<p>${inline(q.explanation)}</p>` : ""}</div>
          <button class="btn btn-primary" type="button" data-next>${i + 1 < questions.length ? "Next question" : "Finish"}</button>`;
        const next = slot.querySelector("[data-next]");
        next.addEventListener("click", () => { i++; draw(); }, { once: true });
        next.focus({ preventScroll: true });
      };
      draw();
    });
  }

  /* ---------- Screens ---------- */
  const STAGES = [
    { id: "diagnostic", label: "Diagnostic" },
    { id: "gap", label: "Gap map" },
    { id: "path", label: "Build-up" },
    { id: "check", label: "Mastery check" },
  ];
  const stageIndex = (stage) => ({ setup: 0, diagnostic: 0, gap: 1, path: 2, check: 3, done: 4 }[stage] ?? 0);

  function stepper(session) {
    const at = stageIndex(session.stage);
    return `<ol class="m-steps" aria-label="Master Mode steps">${STAGES.map((st, i) => `<li class="${i < at ? "done" : i === at ? "now" : ""}">
      ${i < at && st.id !== "diagnostic" ? `<a href="#/master/${session.id}?view=${st.id}">` : "<span>"}<b>${i < at ? icon("check") : i + 1}</b>${st.label}${i < at && st.id !== "diagnostic" ? "</a>" : "</span>"}</li>`).join("")}</ol>`;
  }

  function masteryBar(pct, cls = "", label = "Mastery") {
    return `<div class="m-bar ${cls}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(label)}"><span style="width:${pct}%"></span></div>`;
  }

  function gapMap(session, { compact = false } = {}) {
    const groups = { missing: [], shaky: [], known: [] };
    session.concepts.forEach((c) => groups[statusOf(c, session)].push(c));
    const row = (c) => `<li class="gap-row ${statusOf(c, session)}">
      <div class="gap-name"><span class="gap-dot"></span><strong>${esc(c.name)}</strong>${c.inNotes ? "" : '<span class="tag-beyond">Not in your notes</span>'}<span class="gap-level">${esc(c.level)}</span></div>
      ${compact ? "" : `<p class="gap-sum">${inline(c.summary)}</p>`}
      <div class="gap-pct">${masteryBar(session.mastery[c.id] ?? 0, "", `${c.name} mastery`)}<span>${session.mastery[c.id] ?? 0}%</span></div>
    </li>`;
    return `<div class="gap-map">${["missing", "shaky", "known"].map((k) => groups[k].length ? `<section class="gap-group ${k}">
      <h3>${STATUS[k]} <span class="count">${groups[k].length}</span></h3><ul>${groups[k].map(row).join("")}</ul></section>` : "").join("")}</div>`;
  }

  async function renderSession(id) {
    const session = normalize(await DB.get("mastery", id));
    if (!session) { location.hash = "#/master"; return; }
    const subject = await DB.getSubject(session.subjectId);
    return `
      <a class="back" href="#/master">${icon("back")}Master Mode</a>
      <div class="page-head master-head">
        <div><span class="eyebrow">Master Mode${subject ? ` · ${esc(subject.name)}` : ""}</span><h1>${esc(session.title)}</h1></div>
        ${session.concepts.length && session.diagnostic?.done ? `<div class="m-overall"><strong>${overall(session)}%</strong><span>mastered</span></div>` : ""}
      </div>
      ${stepper(session)}
      <div id="m-slot"><div class="card panel">${skeleton(5)}</div></div>`;
  }

  renderSession.mount = async (id) => {
    const slot = view.querySelector("#m-slot");
    let session = normalize(await DB.get("mastery", id));
    if (!session) return;
    // Everything below stops when the user leaves: no stale saves, key presses or XP
    const ctrl = new AbortController();
    const signal = ctrl.signal;
    const alive = () => !signal.aborted && slot.isConnected;
    const persist = async () => { if (alive()) await save(session); };
    const viewParam = R.query().get("view");
    const conceptName = (q) => session.concepts.find((c) => c.id === q.conceptId)?.name || "";
    const status = (msg) => { const p = slot.querySelector(".m-wait p"); if (p) p.textContent = msg; };
    const waiting = (title, msg) => alive() && (slot.innerHTML = `<div class="card panel m-wait" aria-live="polite"><h2>${esc(title)}</h2>${skeleton(4)}<p class="hint">${esc(msg)}</p></div>`);
    const failed = (err, retry) => {
      if (!alive()) return;
      slot.innerHTML = emptyState({ mark: "alert", title: "That didn't work", body: err.message || "Something went wrong.", action: `<button class="btn btn-primary" type="button" data-retry>${icon("refresh")}Try again</button>` });
      slot.querySelector(".empty").classList.remove("reveal"); // drawn after the reveal pass: show it now
      slot.querySelector("[data-retry]").addEventListener("click", retry);
    };
    const go = (v) => { if (alive()) location.hash = `#/master/${session.id}${v ? `?view=${v}` : ""}`; };
    const bail = () => !alive(); // after any await: stop if the user has left
    const refreshHead = () => {
      const o = view.querySelector(".m-overall strong");
      if (o) o.textContent = `${overall(session)}%`;
    };

    if (!AI.getKey()) {
      slot.innerHTML = emptyState({ mark: "alert", title: "Add your Groq key", body: "Master Mode uses the AI to find your level and teach you. Add your free key in Settings.", action: `<a class="btn btn-primary" href="#/settings">Open Settings</a>` });
      return;
    }

    /* 1. Setup + diagnostic */
    async function diagnostic() {
      if (!session.concepts.length) {
        waiting("Reading your notes", "Finding the key concepts and the basics they rely on…");
        try {
          session.concepts = (await findConcepts(session, status)).concepts;
          if (bail()) return;
          await persist();
        } catch (err) { return failed(err, diagnostic); }
      }
      if (!session.diagnostic) {
        waiting("Building your diagnostic", "A short test to find your level on each concept…");
        try {
          session.diagnostic = { questions: (await makeDiagnostic(session, status)).questions, answers: [], done: false };
          if (bail()) return;
          session.stage = "diagnostic";
          await persist();
        } catch (err) { return failed(err, diagnostic); }
      }
      if (!session.diagnostic.answers.length) {
        slot.innerHTML = `<section class="card panel m-intro">
          <h2>Diagnostic</h2>
          <p>${plural(session.diagnostic.questions.length, "question")} across ${plural(session.concepts.length, "concept")}. There's no score to worry about: answers aren't shown until the end, and "I don't know" is a perfectly good answer.</p>
          <ul class="m-concepts">${session.concepts.map((c) => `<li><span class="gap-level">${esc(c.level)}</span>${esc(c.name)}${c.inNotes ? "" : ' <span class="tag-beyond">Not in your notes</span>'}</li>`).join("")}</ul>
          <button class="btn btn-primary btn-big" type="button" data-begin>${icon("target")}Start the diagnostic</button>
        </section>`;
        await new Promise((r) => slot.querySelector("[data-begin]").addEventListener("click", r, { signal }));
        if (bail()) return;
      }
      const answers = await runQuestions(slot, { signal,
        questions: session.diagnostic.questions, answers: session.diagnostic.answers, mode: "test", label: "Question", conceptName, idk: true,
        onAnswer: async () => persist(),
      });
      if (bail()) return;
      session.diagnostic.answers = answers;
      session.diagnostic.done = true;
      scoreDiagnostic(session);
      session.stage = "gap";
      await persist();
      await SRS.award(15, "master");
      go("gap");
    }

    /* 2. Gap map */
    function gap() {
      const weak = session.concepts.filter((c) => statusOf(c, session) !== "known");
      const diag = session.diagnostic;
      const right = diag.questions.filter((q, i) => diag.answers[i] === q.answerIndex).length;
      slot.innerHTML = `<section class="card panel">
          <div class="card-head"><h2>Your gap map</h2><span class="count">${right}/${diag.questions.length} right in the diagnostic</span></div>
          ${gapMap(session)}
          <div class="m-actions">
            ${weak.length
              ? `<button class="btn btn-primary btn-big" type="button" data-path>${icon("layers")}Start the build-up path (${plural(weak.length, "concept")})</button>`
              : `<p class="lead">You already know every concept. Prove it in the mastery check.</p>`}
            <button class="btn ${weak.length ? "btn-quiet" : "btn-primary btn-big"}" type="button" data-check>${weak.length ? "Skip to the mastery check" : "Take the mastery check"}</button>
          </div>
        </section>
        <details class="card panel m-review"><summary>Review diagnostic answers</summary>
          <ol class="mistakes">${diag.questions.map((q, i) => `<li><p class="m-q">${inline(q.question)}</p><p class="m-a">${diag.answers[i] === q.answerIndex ? `<span class="ok-text">Right</span>` : `<span class="bad-text">${diag.answers[i] === -1 ? "Didn't know" : "You chose: " + inline(q.options[diag.answers[i]] || "")}</span><span class="ok-text">Answer: ${inline(q.options[q.answerIndex])}</span>`}</p>${q.explanation ? `<p class="m-e">${inline(q.explanation)}</p>` : ""}</li>`).join("")}</ol>
        </details>`;
      slot.querySelector("[data-path]")?.addEventListener("click", async () => { session.stage = "path"; await persist(); go("path"); });
      slot.querySelector("[data-check]").addEventListener("click", async () => { session.stage = "check"; await persist(); go("check"); });
    }

    /* 3. Build-up path */
    async function path() {
      const weak = session.concepts.filter((c) => statusOf(c, session) !== "known" || session.lessons[c.id]?.started && !session.lessons[c.id]?.done);
      const todo = session.concepts.filter((c) => !session.lessons[c.id]?.done && statusOf(c, session) !== "known");
      const pathConcepts = session.concepts.filter((c) => session.lessons[c.id] || statusOf(c, session) !== "known");
      const current = todo[0];
      const listHTML = `<ol class="m-path">${pathConcepts.map((c) => {
        const done = session.lessons[c.id]?.done;
        return `<li class="${done ? "done" : c === current ? "now" : ""}"><b>${done ? icon("check") : ""}</b><span>${esc(c.name)}</span><em>${session.mastery[c.id] ?? 0}%</em></li>`;
      }).join("")}</ol>`;
      if (!current) {
        slot.innerHTML = `<section class="card panel">
          <h2>Build-up complete</h2>${listHTML}
          <p class="lead">Every weak concept has been worked through. Time to prove it.</p>
          <div class="m-actions"><button class="btn btn-primary btn-big" type="button" data-check>${icon("target")}Take the mastery check</button></div>
        </section>`;
        slot.querySelector("[data-check]").addEventListener("click", async () => { session.stage = "check"; await persist(); go("check"); });
        return;
      }
      await lesson(current, listHTML, weak);
    }

    async function lesson(concept, listHTML, weak, fresh = false) {
      let L = session.lessons[concept.id];
      if (fresh && L) L.round = (L.round || 0) + 1; // so the prompt asks for NEW questions
      if (!L?.content || fresh) {
        waiting(`Preparing: ${concept.name}`, "Writing a short explanation, a worked example and practice questions…");
        try {
          const made = await makeLesson(session, concept, status);
          if (bail()) return;
          // a new practice set keeps the explanation you've read and goes straight to the questions
          const content = fresh && L?.content ? { ...L.content, practice: made.practice } : made;
          L = session.lessons[concept.id] = { ...(L || {}), content, answers: [], scored: {}, round: L?.round || 0, started: true, step: fresh ? "practice" : "explain" };
          await persist();
        } catch (err) { return failed(err, () => lesson(concept, listHTML, weak, fresh)); }
      }
      const C = L.content;
      const step = L.step || "explain";
      const notesTag = C.inNotes && concept.inNotes ? "" : '<span class="tag-beyond">Not in your notes</span>';
      const header = `<div class="m-lesson-head"><span class="eyebrow">${concept.level} · ${session.mastery[concept.id] ?? 0}% mastered</span><h2>${esc(concept.name)} ${notesTag}</h2></div>`;
      const tabs = `<div class="m-substeps">${["explain", "example", "practice"].map((st, i) => `<span class="${st === step ? "now" : ["explain", "example", "practice"].indexOf(step) > i ? "done" : ""}">${i + 1}. ${{ explain: "Explanation", example: "Worked example", practice: "Practice" }[st]}</span>`).join("")}</div>`;

      if (step === "explain" || step === "example") {
        slot.innerHTML = `<div class="m-lesson-grid"><aside class="card panel m-side"><h3>Your path</h3>${listHTML}</aside>
          <section class="card panel m-lesson">${header}${tabs}
            ${step === "explain"
              ? `<ol class="m-explain">${C.explanation.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>
                 <button class="btn btn-primary" type="button" data-step="example">See a worked example ${icon("arrow")}</button>`
              : `<div class="ref-example m-example"><p class="ref-problem">${inline(C.example.problem)}</p>${C.example.steps.map((x) => `<p class="ref-line">${inline(x)}</p>`).join("")}${C.example.answer ? `<p class="ref-answer">${inline(C.example.answer)}</p>` : ""}</div>
                 <div class="m-actions"><button class="btn btn-quiet" type="button" data-step="explain">${icon("back")}Explanation</button><button class="btn btn-primary" type="button" data-step="practice">Practice (${C.practice.length} questions) ${icon("arrow")}</button></div>`}
          </section></div>`;
        slot.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", async () => { L.step = b.dataset.step; await persist(); lesson(concept, listHTML, weak); }));
        return;
      }

      // practice
      slot.innerHTML = `<div class="m-lesson-grid"><aside class="card panel m-side"><h3>Your path</h3>${listHTML}</aside><section class="m-lesson-main">${`<div class="card panel m-lesson m-lesson-compact">${header}${tabs}</div>`}<div id="m-q"></div></section></div>`;
      const qslot = slot.querySelector("#m-q");
      const answers = await runQuestions(qslot, { signal,
        questions: C.practice, answers: L.answers || [], mode: "practice", label: "Practice", conceptName: () => concept.name, idk: false,
        onAnswer: async (i, k, q) => {
          // only the first try at each question counts, so re-reading can't farm mastery or XP
          L.scored = L.scored || {};
          if (!L.scored[i]) {
            L.scored[i] = true;
            practiceUpdate(session, concept.id, k === q.answerIndex, q.difficulty);
            if (k === q.answerIndex) SRS.award(2 + q.difficulty, "master");
          }
          L.answers = [...(L.answers || [])]; L.answers[i] = k;
          await persist();
          refreshHead();
          const em = slot.querySelector(".m-path li.now em");
          if (em) em.textContent = `${session.mastery[concept.id]}%`;
        },
      });
      if (bail()) return;
      const right = C.practice.filter((q, i) => answers[i] === q.answerIndex).length;
      const passed = right >= Math.ceil(C.practice.length * 0.67);
      qslot.innerHTML = `<div class="card panel result">
        <div class="result-score"><span class="big">${right}<small>/${C.practice.length}</small></span><span>${esc(concept.name)} is now <strong>${session.mastery[concept.id]}%</strong> mastered</span></div>
        <p class="lead">${passed ? "Good. You're ready for the next concept." : "Not there yet. Try a fresh practice set, or read the explanation again."}</p>
        <div class="finish-actions">
          ${passed ? `<button class="btn btn-primary" type="button" data-next-concept>Next ${icon("arrow")}</button>` : ""}
          <button class="btn ${passed ? "" : "btn-primary"}" type="button" data-new-set>${icon("refresh")}New practice set</button>
          <button class="btn btn-quiet" type="button" data-reread>Read the explanation again</button>
          ${passed ? "" : `<button class="btn btn-quiet" type="button" data-next-concept>Move on anyway</button>`}
        </div>
      </div>`;
      qslot.querySelector("[data-new-set]").addEventListener("click", () => lesson(concept, listHTML, weak, true));
      qslot.querySelector("[data-reread]").addEventListener("click", async () => { L.step = "explain"; L.answers = []; await persist(); lesson(concept, listHTML, weak); });
      qslot.querySelectorAll("[data-next-concept]").forEach((b) => b.addEventListener("click", async () => {
        L.done = true;
        await persist();
        SRS.award(10, "master");
        path();
      }));
    }

    /* 4. Mastery check (+ beyond) */
    async function check(part = "check") {
      if (!session[part]?.questions) {
        waiting(part === "beyond" ? "Writing harder questions" : "Building your mastery check", part === "beyond" ? "Questions that stretch past your notes…" : "8 questions at the level of your notes…");
        try {
          session[part] = { questions: (await makeCheck(session, part === "beyond", status)).questions, answers: [], done: false };
          if (bail()) return;
          await persist();
        } catch (err) { return failed(err, () => check(part)); }
      }
      if (!session[part].done) {
        const answers = await runQuestions(slot, { signal,
          questions: session[part].questions, answers: session[part].answers, mode: "practice", label: part === "beyond" ? "Beyond" : "Check", conceptName, idk: false,
          onAnswer: async () => persist(),
        });
        if (bail()) return;
        session[part].answers = answers;
        session[part].done = true;
        scoreCheck(session, part);
        if (part === "check") session.stage = "done";
        await persist();
        const right = session[part].questions.filter((q, i) => answers[i] === q.answerIndex).length;
        await SRS.award(part === "beyond" ? 10 + right * 4 : 20 + right * 2, "master");
      }
      results();
    }

    // keep finished checks in the session's history before starting a new one
    function archive() {
      if (session.check?.done || session.beyond?.done) session.history = [...(session.history || []), { at: Date.now(), check: session.check, beyond: session.beyond }].slice(-10);
      session.check = null;
      session.beyond = null;
    }

    function results() {
      const c = session.check;
      const b = session.beyond;
      const right = (p) => p.questions.filter((q, i) => p.answers[i] === q.answerIndex).length;
      slot.innerHTML = `<section class="card panel result">
          <div class="result-score"><span class="big">${overall(session)}<small>%</small></span><span>overall mastery${c?.done ? ` · check ${right(c)}/${c.questions.length}` : ""}${b?.done ? ` · beyond ${right(b)}/${b.questions.length}` : ""}${(() => { const last = (session.history || []).filter((h) => h.check?.done).at(-1); return last ? ` · last time ${right(last.check)}/${last.check.questions.length}` : ""; })()}</span></div>
          ${gapMap(session, { compact: true })}
          <div class="finish-actions">
            ${b?.done ? "" : `<button class="btn btn-gold" type="button" data-beyond>${icon("spark")}Try "beyond" questions</button>`}
            <button class="btn" type="button" data-retake>${icon("refresh")}Retake the mastery check</button>
            ${session.concepts.some((x) => statusOf(x, session) !== "known") ? `<button class="btn btn-quiet" type="button" data-more-path>Work on weak concepts</button>` : ""}
          </div>
        </section>`;
      slot.querySelector("[data-beyond]")?.addEventListener("click", () => check("beyond"));
      slot.querySelector("[data-retake]").addEventListener("click", async () => { archive(); await persist(); check("check"); });
      slot.querySelector("[data-more-path]")?.addEventListener("click", async () => {
        // reopen weak concepts at the explanation (practice scores already counted stay counted),
        // and file the last check away so the next one starts fresh
        session.concepts.forEach((x) => {
          const L = session.lessons[x.id];
          if (statusOf(x, session) !== "known" && L) Object.assign(L, { done: false, step: "explain", answers: [] });
        });
        archive();
        session.stage = "path";
        await persist();
        go("path");
      });
    }

    const wanted = viewParam || { setup: "diagnostic", diagnostic: "diagnostic", gap: "gap", path: "path", check: "check", done: "check" }[session.stage];
    const run = () => {
      if (!session.diagnostic?.done) return diagnostic();
      if (wanted === "gap") return gap();
      if (wanted === "path") return path();
      if (wanted === "check") return session.check?.done && !viewParam ? results() : check("check");
      return gap();
    };
    Promise.resolve(run()).catch((err) => { console.error("Reforge: Master Mode", err); failed(err, () => R.render()); });
    return () => ctrl.abort();
  };

  /* ---------- Hub ---------- */
  async function renderHub() {
    const [sessions, subjects, notes] = await Promise.all([sessionsFor(), DB.listSubjects(), DB.listNotes()]);
    const byId = Object.fromEntries(subjects.map((s) => [s.id, s]));
    const cards = sessions.filter((x) => byId[x.subjectId]).map((x) => {
      const pct = x.diagnostic?.done ? overall(x) : 0;
      const next = { setup: "Start the diagnostic", diagnostic: "Finish the diagnostic", gap: "See your gap map", path: "Continue the build-up", check: "Take the mastery check", done: "Mastered: review" }[x.stage];
      return `<a class="card m-card reveal" href="#/master/${x.id}" style="${subjectVar(byId[x.subjectId].color)}">
        <div class="m-card-top"><span class="tag"><span class="dot"></span>${esc(byId[x.subjectId].name)}</span><strong>${pct}%</strong></div>
        <h3>${esc(x.title)}</h3>
        ${masteryBar(pct, "m-bar-gold")}
        <span class="m-card-next">${esc(next)} ${icon("arrow")}</span>
      </a>`;
    });
    return `
      <div class="page-head"><div><span class="eyebrow">Study</span><h1>Master Mode</h1>
        <p class="lead">Find your level, fill the gaps from the basics up, then prove you've mastered your notes.</p></div>
        <div class="head-actions">${subjects.length ? `<button class="btn btn-primary" type="button" data-new>${icon("plus")}Paste or upload notes</button>` : ""}</div>
      </div>
      ${cards.length ? `<div class="m-grid">${cards.join("")}</div>` : ""}
      ${notes.length ? `<section class="section"><div class="section-head"><h2>Start from a note</h2></div>
        <ul class="card note-list">${notes.slice(0, 12).map((n) => `<li><button class="note-row note-row-btn" type="button" data-start="${n.id}">
          <div>${byId[n.subjectId] ? `<span class="tag" style="${subjectVar(byId[n.subjectId].color)}"><span class="dot"></span>${esc(byId[n.subjectId].name)}</span>` : ""}<h3>${esc(n.title)}</h3></div>
          <span class="when">Master this ${icon("arrow")}</span></button></li>`).join("")}</ul></section>`
        : emptyState({ mark: "target", title: "Add notes to begin", body: "Paste or upload your advanced notes, and Master Mode builds you a path from where you are to mastery.", action: subjects.length ? `<button class="btn btn-primary" type="button" data-new>Paste or upload notes</button>` : `<a class="btn btn-primary" href="#/library">Create a subject first</a>` })}`;
  }

  renderHub.mount = () => {
    view.querySelectorAll("[data-start]").forEach((b) => b.addEventListener("click", () => start([b.dataset.start])));
    view.querySelectorAll("[data-new]").forEach((b) => b.addEventListener("click", async () => {
      const subjects = await DB.listSubjects();
      let subject = subjects[0];
      if (subjects.length > 1) {
        const data = await R.openSheet(`<div class="sheet-body"><h2 id="sheet-title">Which subject?</h2><p>Your notes are saved to this subject.</p>
          <div class="field"><label class="label" for="m-subject">Subject</label><select class="select" id="m-subject" name="subject">${subjects.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select></div></div>
          <div class="sheet-foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" value="ok">Next</button></div>`);
        if (!data) return;
        subject = subjects.find((s) => s.id === data.get("subject"));
      }
      const data = await Library.noteSheet(subject, { master: true });
      if (!data) return;
      const note = await DB.saveNote({ subjectId: subject.id, title: data.get("title").trim(), rawText: data.get("rawText") });
      SRS.track("notes");
      start([note.id]);
    }));
  };

  R.route(/^\/master$/, "study", renderHub);
  R.route(/^\/master\/([^/]+)$/, "study", renderSession);

  return { start, sessionsFor, overall };
})();
