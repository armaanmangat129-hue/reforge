/* Reforge AI: the one place every AI feature goes through.
   - Groq's OpenAI-compatible API, with the key the user pastes in Settings (localStorage only).
   - Model names come from Groq's live model list: the largest text model is the default,
     and a vision model (if the list has one) reads photos.
   - Free-tier friendly: one call at a time with a 3-second gap, waits for the per-minute token
     budget, retries 429s after Groq's retry-after (up to 3 times) with a countdown, and caches
     results in IndexedDB so nothing is regenerated unless you press Retry or Regenerate.
   - Every prompt is grounded: the model may only use what's in the student's notes. */

const AI = (() => {
  const BASE = "https://api.groq.com/openai/v1";
  const KEY_STORE = "reforge.groqKey";
  const MODEL_STORE = "reforge.groqModel";
  const MODELS_STORE = "reforge.groqModels";
  const GAP_MS = 3000;
  const MAX_RETRIES = 3;
  const MAX_OUTPUT = 4096;
  const MAX_CHARS = 400000;

  const MSG = {
    key: "Your Groq key isn't working. Check Settings.",
    noKey: "Add your Groq key in Settings first.",
    down: "Groq is down or you're offline. Try again soon.",
    json: "Couldn't read the AI's answer. Press Retry.",
    model: "The chosen model isn't available any more. Pick another in Settings.",
    tooLong: "That's too much text for one request. Split it into smaller notes.",
    limit: "Free limit hit. Wait a minute, then press Retry.",
  };

  class AIError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* storage blocked */ } },
  };
  const getKey = () => store.get(KEY_STORE);
  const setKey = (k) => { store.set(KEY_STORE, (k || "").trim()); store.set(MODELS_STORE, ""); modelsCache = null; };
  const getModel = () => store.get(MODEL_STORE);
  const setModel = (m) => store.set(MODEL_STORE, m);

  /* ---------- Models (from Groq's list, never hard-coded) ---------- */
  const NOT_TEXT = /whisper|tts|playai|orpheus|guard|embed|distil|compound|transcri|speech|audio/i;
  const VISION = /vision|llama-4|scout|maverick|llava|vl\b|-vl-|pixtral|gemma-3/i;
  const sizeOf = (id) => { const m = String(id).match(/(\d+(?:\.\d+)?)b\b/i); return m ? parseFloat(m[1]) : 0; };

  let modelsCache = null;
  async function listModels({ key = getKey(), force = false } = {}) {
    if (!key) throw new AIError(MSG.noKey, 0);
    if (!force && modelsCache && modelsCache.key === key) return modelsCache.models;
    if (!force) {
      try {
        const saved = JSON.parse(store.get(MODELS_STORE) || "null");
        if (saved && Date.now() - saved.at < 24 * 3600 * 1000) return (modelsCache = { key, models: saved.models }).models;
      } catch { /* refetch */ }
    }
    let res;
    try {
      res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
    } catch {
      throw new AIError(MSG.down, 0);
    }
    if (res.status === 401 || res.status === 403) throw new AIError(MSG.key, res.status);
    if (!res.ok) throw new AIError(MSG.down, res.status);
    const body = await res.json();
    const models = (body.data || [])
      .filter((m) => m.active !== false && !NOT_TEXT.test(m.id))
      .map((m) => ({ id: m.id, context: m.context_window || 0, owner: m.owned_by || "", vision: VISION.test(m.id), size: sizeOf(m.id) }))
      .sort((a, b) => b.size - a.size || b.context - a.context || a.id.localeCompare(b.id));
    store.set(MODELS_STORE, JSON.stringify({ at: Date.now(), models }));
    modelsCache = { key, models };
    return models;
  }

  // The biggest text model is the default; vision models are kept for photos.
  const pickDefault = (models) => (models.find((m) => !m.vision) || models[0] || {}).id;
  const pickVision = (models) => (models.find((m) => m.vision) || {}).id || null;

  async function currentModel() {
    const models = await listModels();
    const saved = getModel();
    if (saved && models.some((m) => m.id === saved)) return saved;
    const def = pickDefault(models);
    if (!def) throw new AIError(MSG.model, 404);
    return def;
  }
  async function visionModel() {
    try { return pickVision(await listModels()); } catch { return null; }
  }

  /* ---------- Rate limits ---------- */
  // Learned from Groq's x-ratelimit-* headers; start cautious
  const limits = { tpm: 6000, remaining: 6000, resetAt: 0 };
  function parseDuration(v) {
    if (!v) return 0;
    let ms = 0;
    String(v).replace(/(\d+(?:\.\d+)?)(ms|h|m|s)/g, (_, n, u) => (ms += parseFloat(n) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[u]));
    return ms || parseFloat(v) * 1000 || 0;
  }
  function readLimits(res) {
    const tpm = Number(res.headers.get("x-ratelimit-limit-tokens"));
    const rem = Number(res.headers.get("x-ratelimit-remaining-tokens"));
    if (tpm) limits.tpm = tpm;
    if (Number.isFinite(rem) && res.headers.get("x-ratelimit-remaining-tokens") !== null) {
      limits.remaining = rem;
      limits.resetAt = Date.now() + parseDuration(res.headers.get("x-ratelimit-reset-tokens"));
    }
  }
  const estimateTokens = (body) => Math.ceil(JSON.stringify(body.messages).length / 3.6) + (body.max_tokens || MAX_OUTPUT) / 2;

  // Notes are split so each request fits comfortably inside one minute's token budget
  const chunkChars = () => Math.max(4000, Math.min(24000, Math.floor(limits.tpm * 0.35) * 4));
  const contextChars = () => Math.max(6000, Math.min(40000, Math.floor(limits.tpm * 0.45) * 4));

  async function countdown(ms, onStatus, label) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const left = Math.ceil((end - Date.now()) / 1000);
      onStatus && onStatus(label(left), left);
      await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())));
    }
  }

  /* ---------- Queue: one call at a time, 3 seconds apart ---------- */
  let chain = Promise.resolve();
  let lastCall = 0;
  function enqueue(fn) {
    const run = chain.then(async () => {
      const wait = lastCall + GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try { return await fn(); } finally { lastCall = Date.now(); }
    });
    chain = run.catch(() => {});
    return run;
  }

  /* One chat completion. Handles 401/429/5xx/network in plain words. */
  function complete(body, { key = getKey(), onStatus } = {}) {
    if (!key) return Promise.reject(new AIError(MSG.noKey, 0));
    return enqueue(async () => {
      for (let attempt = 0; ; attempt++) {
        // wait if this request won't fit in what's left of this minute's tokens
        const need = estimateTokens(body);
        if (need > limits.remaining && limits.resetAt > Date.now()) {
          await countdown(limits.resetAt - Date.now() + 250, onStatus, (s) => `Waiting for the free limit: ${s}s`);
          limits.remaining = limits.tpm;
        }
        let res, data;
        try {
          res = await fetch(`${BASE}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
          });
          data = await res.json().catch(() => null);
        } catch {
          throw new AIError(MSG.down, 0);
        }
        readLimits(res);
        if (res.status === 429) {
          if (attempt >= MAX_RETRIES) throw new AIError(MSG.limit, 429);
          const ms = parseDuration(res.headers.get("retry-after") + "s") || (attempt + 1) * 8000;
          limits.remaining = 0;
          limits.resetAt = Date.now() + ms;
          await countdown(ms, onStatus, (s) => `Free limit hit, retrying in ${s}s`);
          onStatus && onStatus("Retrying…", 0);
          continue;
        }
        if (res.status === 401 || res.status === 403) throw new AIError(MSG.key, res.status);
        if (res.status >= 500) throw new AIError(MSG.down, res.status);
        if (!res.ok) {
          const err = data && data.error ? data.error : {};
          if (err.code === "json_validate_failed") throw new AIError(MSG.json, 422);
          if (res.status === 404 || /model/i.test(err.code || "") || /model.*(not|decommission)/i.test(err.message || "")) throw new AIError(MSG.model, res.status);
          if (res.status === 413 || /context|too (large|long)|tokens/i.test(err.message || "")) throw new AIError(MSG.tooLong, res.status);
          throw new AIError(err.message || `Groq returned an error (${res.status}).`, res.status);
        }
        const text = data?.choices?.[0]?.message?.content || "";
        if (!text.trim()) throw new AIError(MSG.json, 200);
        return text;
      }
    });
  }

  /* ---------- JSON calls ---------- */
  // Turn a schema into a compact example shape for the prompt (Groq's JSON mode has no schema field)
  function shapeOf(sch) {
    if (!sch) return "";
    if (sch.enum) return `one of: ${sch.enum.join(" | ")}`;
    switch (sch.type) {
      case "STRING": return "string";
      case "INTEGER": return 0;
      case "NUMBER": return 0.0;
      case "BOOLEAN": return true;
      case "ARRAY": return [shapeOf(sch.items)];
      case "OBJECT": return Object.fromEntries(Object.entries(sch.properties).map(([k, v]) => [k, shapeOf(v)]));
    }
    return null;
  }

  async function hash(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function parseJSON(text) {
    const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    try { return JSON.parse(clean); } catch { /* fall through */ }
    const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
    return JSON.parse(clean.slice(a, b + 1));
  }

  function userContent(prompt, images = []) {
    if (!images.length) return prompt;
    return [{ type: "text", text: prompt }, ...images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } }))];
  }

  /* Ask for JSON shaped like `schema`, then `validate` it (returns the clean value or throws).
     Malformed JSON is retried once automatically. */
  async function json({ system, prompt, schema, validate, images = [], model, cache = true, fresh = false, temperature = 0.3, onStatus, maxTokens = MAX_OUTPUT }) {
    model = model || (await currentModel());
    const messages = [
      { role: "system", content: `${system || ""}\n\nReply with ONE JSON object only, no other text, shaped exactly like this:\n${JSON.stringify(shapeOf(schema))}` },
      { role: "user", content: userContent(prompt, images) },
    ];
    const body = { model, messages, temperature, max_tokens: maxTokens, response_format: { type: "json_object" } };
    const key = cache && !images.length ? "ai:" + (await hash(JSON.stringify({ model, messages }))) : null;
    if (key && !fresh) {
      const hit = await DB.get("cache", key).catch(() => null);
      if (hit) return hit.value;
    }
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await complete(attempt ? { ...body, temperature: Math.min(1, temperature + 0.2) } : body, { onStatus });
        let value;
        try {
          value = parseJSON(text);
        } catch {
          console.warn("Reforge: the AI's answer wasn't JSON:", text);
          throw new AIError(MSG.json, 422);
        }
        try {
          value = validate ? validate(value) : value;
        } catch (err) {
          console.warn("Reforge: the AI's JSON failed checks:", err.message, value);
          throw new AIError(MSG.json, 422);
        }
        if (key) DB.put("cache", { key, value, at: Date.now() }).catch(() => {});
        return value;
      } catch (err) {
        lastErr = err;
        if (err.status !== 422) throw err; // only bad JSON gets the automatic second try
        onStatus && onStatus("Answer was malformed, asking again…", 0);
      }
    }
    throw lastErr;
  }

  /* Plain text (e.g. reading a photo). */
  async function text({ system, prompt, images = [], model, temperature = 0.2, onStatus, maxTokens = MAX_OUTPUT }) {
    model = model || (await currentModel());
    const messages = [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: userContent(prompt, images) }];
    return complete({ model, messages, temperature, max_tokens: maxTokens }, { onStatus });
  }

  /* Checks a key: lists models, then sends one tiny request. Returns the default model. */
  async function testKey(key, onStatus) {
    const models = await listModels({ key, force: true });
    const model = pickDefault(models);
    if (!model) throw new AIError(MSG.model, 404);
    await complete({ model, messages: [{ role: "user", content: "Reply with the single word: ready" }], max_tokens: 5, temperature: 0 }, { key, onStatus });
    return { model, models, vision: pickVision(models) };
  }

  const GROUNDING =
    "You are a careful study assistant for a high-school student. " +
    "Use ONLY information that appears in the student's notes below. " +
    "Never add facts, definitions, dates, formulas or examples that are not in the notes. " +
    "If the notes don't cover something, leave it out rather than filling the gap. " +
    "Write in clear, plain English for a 15-18 year old. Keep the student's own terminology and units.";

  /* ---------- Schemas ---------- */
  const STR = { type: "STRING" };
  const INT = { type: "INTEGER" };
  const BOOL = { type: "BOOLEAN" };
  const arr = (items) => ({ type: "ARRAY", items });
  const obj = (properties, required = Object.keys(properties)) => ({ type: "OBJECT", properties, required });

  const SCHEMAS = {
    clean: obj(
      {
        sections: arr(obj({ heading: STR, bullets: arr(STR) })),
        keyTerms: arr(obj({ term: STR, definition: STR })),
        formulas: arr(obj({ name: STR, formula: STR })),
      },
      ["sections", "keyTerms", "formulas"]
    ),
    summary: obj({ points: arr(STR) }),
    flashcards: obj({ cards: arr(obj({ front: STR, back: STR })) }),
    quiz: obj({ questions: arr(obj({ question: STR, options: arr(STR), answerIndex: INT, explanation: STR, topic: STR })) }),
    exam: obj({ questions: arr(obj({ question: STR, marks: INT, modelAnswer: STR, topic: STR })) }),
    mark: obj({ score: INT, missing: STR, good: STR }),
    tutor: obj({ inNotes: BOOL, answer: STR, sources: arr(STR) }),
  };

  /* ---------- Validation ---------- */
  const s = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  const list = (v) => (Array.isArray(v) ? v : []);
  function need(cond, msg) {
    if (!cond) throw new Error(msg);
  }

  const VALIDATE = {
    clean(v) {
      const sections = list(v.sections)
        .map((x) => ({ heading: s(x.heading), bullets: list(x.bullets).map(s).filter(Boolean) }))
        .filter((x) => x.heading && x.bullets.length);
      need(sections.length, "no sections");
      return {
        sections,
        keyTerms: list(v.keyTerms).map((x) => ({ term: s(x.term), definition: s(x.definition) })).filter((x) => x.term && x.definition),
        formulas: list(v.formulas).map((x) => ({ name: s(x.name), formula: s(x.formula) })).filter((x) => x.formula),
      };
    },
    summary(v) {
      const points = list(v.points).map(s).filter(Boolean).slice(0, 5);
      need(points.length, "no points");
      return { points };
    },
    flashcards(v) {
      const cards = list(v.cards).map((c) => ({ front: s(c.front), back: s(c.back) })).filter((c) => c.front && c.back);
      need(cards.length >= 3, "too few cards");
      return { cards: cards.slice(0, 40) };
    },
    quiz(v) {
      const questions = list(v.questions)
        .map((q) => ({
          question: s(q.question),
          options: list(q.options).map(s).filter(Boolean),
          answerIndex: Number(q.answerIndex),
          explanation: s(q.explanation),
          topic: s(q.topic),
        }))
        .filter((q) => q.question && q.options.length === 4 && Number.isInteger(q.answerIndex) && q.answerIndex >= 0 && q.answerIndex < 4);
      need(questions.length >= 3, "too few valid questions");
      return { questions };
    },
    exam(v) {
      const questions = list(v.questions)
        .map((q) => ({ question: s(q.question), marks: Math.min(10, Math.max(1, Math.round(Number(q.marks) || 2))), modelAnswer: s(q.modelAnswer), topic: s(q.topic) }))
        .filter((q) => q.question && q.modelAnswer);
      need(questions.length >= 2, "too few questions");
      return { questions };
    },
    mark(max) {
      return (v) => {
        const score = Math.max(0, Math.min(max, Math.round(Number(v.score))));
        need(Number.isFinite(score), "no score");
        return { score, missing: s(v.missing), good: s(v.good) };
      };
    },
    tutor(v) {
      const answer = s(v.answer);
      need(answer, "no answer");
      return { inNotes: v.inNotes !== false, answer, sources: list(v.sources).map(s).filter(Boolean) };
    },
  };

  /* ---------- Prompts ---------- */
  const notesBlock = (title, text) => `NOTE TITLE: ${title}\n\nSTUDENT'S NOTES:\n"""\n${text}\n"""`;

  const PROMPTS = {
    clean: ({ title, text }) =>
      `${notesBlock(title, text)}

Rewrite these notes as clean study notes.
- Group them into short sections with clear headings, in a logical order.
- Each bullet is one short idea, under 20 words. Minimal writing, no paragraphs.
- Put the key term in each bullet in **bold** using double asterisks.
- keyTerms: the important terms and their definitions, worded as in the notes.
- formulas: every formula or equation in the notes, written in plain text (e.g. "y = a(x - h)^2 + k"). Use an empty list if there are none.`,

    summary: ({ title, text }) =>
      `${notesBlock(title, text)}

Summarise these notes in at most 5 bullet points. Each point is one sentence covering a main idea.`,

    flashcards: ({ title, text, count }) =>
      `${notesBlock(title, text)}

Write ${count} flashcards that together cover everything important in these notes.
- front: a specific question or prompt. Never a yes/no question.
- back: the answer in under 30 words, taken from the notes.
- Cover definitions, formulas, steps of methods and key facts. No duplicates.`,

    quiz: ({ title, text, count }) =>
      `${notesBlock(title, text)}

Write ${count} multiple-choice questions that test understanding of these notes.
- Exactly 4 options each. answerIndex is the 0-based index of the correct option.
- Wrong options must be plausible mistakes a student might make, not jokes.
- Vary which position holds the correct answer.
- explanation: one line saying why the answer is right, using the notes.
- topic: 1-4 words naming the topic the question tests.`,

    exam: ({ title, text, count }) =>
      `${notesBlock(title, text)}

Write ${count} exam-style short-answer questions on these notes, like a school assessment.
- marks: 1 to 5, matching how much the answer needs.
- modelAnswer: a full-mark answer using only the notes. For multi-mark questions, make each marking point clear.
- topic: 1-4 words naming the topic.`,

    condense: ({ points }) =>
      `These summary points come from different parts of the same notes:\n${points.map((p) => "- " + p).join("\n")}\n\nCombine them into at most 5 bullet points. Don't add anything new.`,
  };

  /* ---------- Chunking ---------- */
  function chunk(text, size = chunkChars()) {
    const CHUNK_CHARS = size;
    if (text.length <= CHUNK_CHARS) return [text];
    const paras = text.split(/\n\s*\n/);
    const chunks = [];
    let cur = "";
    for (const p of paras) {
      if ((cur + "\n\n" + p).length > CHUNK_CHARS && cur) {
        chunks.push(cur);
        cur = "";
      }
      if (p.length > CHUNK_CHARS) {
        for (let i = 0; i < p.length; i += CHUNK_CHARS) chunks.push(p.slice(i, i + CHUNK_CHARS));
      } else cur = cur ? cur + "\n\n" + p : p;
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  const uniqBy = (arr, key) => {
    const seen = new Set();
    return arr.filter((x) => {
      const k = key(x).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  /* ---------- Steps ---------- */
  const STEPS = [
    { id: "clean", label: "Clean notes" },
    { id: "summary", label: "Summary" },
    { id: "flashcards", label: "Flashcards" },
    { id: "quiz", label: "Quiz" },
    { id: "exam", label: "Exam questions" },
  ];
  const stepsFor = () => STEPS; // reference pages are made separately (book.js)

  async function runStep(id, title, chunks, onChunk, { fresh, onStatus }) {
    const n = chunks.length;
    const call = (name, vars) =>
      json({ system: GROUNDING, prompt: PROMPTS[name](vars), schema: SCHEMAS[name], validate: VALIDATE[name], fresh, onStatus });

    const results = [];
    for (let i = 0; i < n; i++) {
      onChunk(i, n);
      const count = { flashcards: Math.max(n > 1 ? 6 : 10, Math.ceil(20 / n)), quiz: Math.ceil(10 / n), exam: Math.ceil(5 / n) }[id];
      const label = n > 1 ? `${title} (part ${i + 1} of ${n})` : title;
      results.push(await call(id, { title: label, text: chunks[i], count: n === 1 && id === "flashcards" ? "15 to 25" : count }));
    }
    if (n === 1) return results[0];

    switch (id) {
      case "clean":
        return {
          sections: results.flatMap((r) => r.sections),
          keyTerms: uniqBy(results.flatMap((r) => r.keyTerms), (x) => x.term),
          formulas: uniqBy(results.flatMap((r) => r.formulas), (x) => x.formula),
        };
      case "summary": {
        const points = results.flatMap((r) => r.points);
        if (points.length <= 5) return { points };
        return json({ system: GROUNDING, prompt: PROMPTS.condense({ points }), schema: SCHEMAS.summary, validate: VALIDATE.summary, fresh, onStatus });
      }
      case "flashcards":
        return { cards: uniqBy(results.flatMap((r) => r.cards), (c) => c.front).slice(0, 40) };
      case "quiz":
        return { questions: results.flatMap((r) => r.questions).slice(0, 10) };
      case "exam":
        return { questions: results.flatMap((r) => r.questions).slice(0, 5) };
    }
  }

  /* ---------- Pipeline ---------- */
  const running = new Map(); // noteId -> promise

  function emit(note) {
    window.dispatchEvent(new CustomEvent("reforge:note", { detail: note }));
  }

  /* Runs the study-set steps. `fresh` skips the cache (Retry and Regenerate). */
  async function generate(noteId, only, { fresh = false } = {}) {
    if (running.has(noteId)) return running.get(noteId);
    const job = (async () => {
      let note = await DB.getNote(noteId);
      const subject = await DB.getSubject(note.subjectId);
      const text = (note.rawText || "").trim();
      if (!text) throw new Error("Add some notes first.");
      if (text.length > MAX_CHARS) throw new Error("These notes are too long to process at once. Split them into a few smaller notes.");
      const chunks = chunk(text);
      const ids = (only || stepsFor(subject).map((st) => st.id));

      note.status = { ...(note.status || {}) };
      ids.forEach((id) => (note.status[id] = { state: "queued" }));
      note = await DB.saveNote(note);
      emit(note);

      for (const id of ids) {
        note.status[id] = { state: "working", part: 0, parts: chunks.length };
        emit(note);
        try {
          let part = 0;
          const result = await runStep(id, note.title, chunks, (i, n) => {
            part = i;
            note.status[id] = { state: "working", part: i, parts: n };
            emit(note);
          }, {
            fresh,
            onStatus: (message) => {
              note.status[id] = { state: "working", part, parts: chunks.length, message };
              emit(note);
            },
          });
          note = (await DB.getNote(noteId)) || note; // pick up edits made meanwhile
          note.outputs = { ...(note.outputs || {}), [id]: { ...result, at: Date.now() } };
          note.status = { ...(note.status || {}), [id]: { state: "done" } };
          if (id === "flashcards") {
            await DB.replaceNoteCards(noteId, result.cards.map((c) => SRS.newCard({ subjectId: note.subjectId, noteId, front: c.front, back: c.back })));
          }
        } catch (err) {
          console.error(`Reforge: step "${id}" failed`, err);
          note = (await DB.getNote(noteId)) || note;
          note.status = { ...(note.status || {}), [id]: { state: "error", error: err.message || "Something went wrong." } };
        }
        note = await DB.saveNote(note);
        emit(note);
      }
      return note;
    })();
    running.set(noteId, job);
    let final;
    try {
      final = await job;
      return final;
    } finally {
      running.delete(noteId);
      // tell open screens the run is over, so the "Generating" badge clears
      const latest = final || (await DB.getNote(noteId));
      if (latest) emit(latest);
    }
  }

  const isRunning = (noteId) => running.has(noteId);

  /* ---------- Other AI tasks ---------- */

  function notesContext(notes, limit = contextChars()) {
    let out = "";
    for (const n of notes) {
      const block = `\n\n=== NOTE: ${n.title} ===\n${(n.rawText || "").trim()}`;
      if (out.length + block.length > limit) {
        out += block.slice(0, Math.max(0, limit - out.length));
        break;
      }
      out += block;
    }
    return out.trim();
  }

  async function freshQuiz(subject, notes) {
    const text = notesContext(R.shuffle(notes), chunkChars());
    const res = await json({
      system: GROUNDING,
      prompt: PROMPTS.quiz({ title: `${subject.name}: all notes`, text, count: 10 }),
      schema: SCHEMAS.quiz,
      validate: VALIDATE.quiz,
      cache: false,
      temperature: 0.8,
    });
    return res.questions.slice(0, 10);
  }

  async function markExam({ question, marks, modelAnswer, answer }) {
    return json({
      system:
        "You are a fair, encouraging examiner marking a high-school student's short answer. " +
        "Mark ONLY against the model answer given. Award a whole number of marks. Spelling doesn't matter; meaning does.",
      prompt: `QUESTION (${marks} marks): ${question}

MODEL ANSWER: ${modelAnswer}

STUDENT ANSWER: ${answer || "(no answer)"}

Return:
- score: marks awarded, 0 to ${marks}.
- missing: one or two short lines on what was missing or wrong. Empty if full marks.
- good: one short line on what they got right. Empty if nothing.`,
      schema: SCHEMAS.mark,
      validate: VALIDATE.mark(marks),
      cache: false,
      temperature: 0.1,
    });
  }

  const TUTOR_MODES = {
    explain: {
      label: "Explain simply",
      hint: "Ask about anything in your notes",
      rule: "Explain simply, in short sentences, with one small example from the notes where possible.",
    },
    quiz: {
      label: "Quiz me",
      hint: "Say “start” and answer each question",
      rule: "Quiz the student on their notes. Ask ONE question at a time. When they answer, say if they're right and why in one or two lines, then ask the next question.",
    },
    check: {
      label: "Check my working",
      hint: "Paste or photograph your working",
      rule: "The student is sharing their maths working (typed or as a photo). Find the FIRST mistake, quote the line, explain why it's wrong and how to fix it. Don't redo the whole question unless asked. If there's no mistake, say so.",
    },
    teach: {
      label: "Teach me like a tutor",
      hint: "Name a topic or question to work through",
      rule: "Teach like a patient tutor using questions. Never give the final answer straight away. Ask one guiding question at a time, wait for the reply, confirm or correct it, then move to the next step.",
    },
  };

  async function tutorReply({ subject, notes, mode, history, message, images = [] }) {
    const titles = notes.map((n) => n.title);
    let model;
    if (images.length) {
      model = await visionModel();
      if (!model) {
        // no vision model on this key: read the photo on the device and send the text
        const read = await Upload.ocr(images);
        message = `${message || "Check this working."}\n\nTEXT FROM THE STUDENT'S PHOTO:\n${read}`;
        images = [];
      }
    }
    const convo = history
      .slice(-12)
      .map((m) => `${m.role === "user" ? "STUDENT" : "TUTOR"}: ${m.text}`)
      .join("\n");
    return json({
      model,
      system:
        `You are a tutor for ${subject.name}. ${TUTOR_MODES[mode].rule}\n` +
        "Answer from the student's notes below whenever you can. " +
        "If the answer is NOT in the notes, set inNotes to false and begin your answer with \"This isn't in your notes, so here's a general answer:\" before answering from general knowledge. " +
        `sources: the exact titles of the notes you used, chosen from: ${JSON.stringify(titles)}. Empty if none. ` +
        "Format answer in short paragraphs or bullet lists (markdown with - bullets and **bold**). Keep it brief.\n\n" +
        `STUDENT'S NOTES:\n${notesContext(notes)}`,
      prompt: `${convo ? "CONVERSATION SO FAR:\n" + convo + "\n\n" : ""}STUDENT: ${message || "(see attached image)"}`,
      schema: SCHEMAS.tutor,
      validate: VALIDATE.tutor,
      images,
      cache: false,
      temperature: 0.4,
    });
  }

  /* Reads photos with Groq's vision model. Returns null when the key has no vision model. */
  async function transcribe(images, onStatus) {
    const model = await visionModel();
    if (!model) return null;
    return text({
      model,
      prompt:
        "Transcribe the study notes in these images into plain text, exactly as written. Keep headings, bullet points and line breaks. " +
        "Write maths in plain text (e.g. x^2, sqrt(x), a/b). Describe any diagram in one line in square brackets, e.g. [Diagram: right triangle with sides 3, 4, 5]. " +
        "Output only the transcription.",
      images,
      temperature: 0,
      onStatus,
    });
  }

  return {
    // client
    getKey, setKey, getModel, setModel, listModels, pickDefault, pickVision, currentModel, visionModel, testKey,
    json, text, AIError, MSG, chunkChars, contextChars, limits,
    // features
    STEPS, stepsFor, generate, isRunning, freshQuiz, markExam, TUTOR_MODES, tutorReply, transcribe, chunk, MAX_CHARS,
  };
})();
