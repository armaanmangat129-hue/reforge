/* Reforge AI features: prompts, JSON schemas, validation and the generate pipeline.
   Every prompt is grounded: Gemini may only use what's in the student's notes. */

const AI = (() => {
  const CHUNK_CHARS = 24000;
  const MAX_CHARS = 400000;

  const GROUNDING =
    "You are a careful study assistant for a high-school student. " +
    "Use ONLY information that appears in the student's notes below. " +
    "Never add facts, definitions, dates, formulas or examples that are not in the notes. " +
    "If the notes don't cover something, leave it out rather than filling the gap. " +
    "Write in clear, plain English for a 15-18 year old. Keep the student's own terminology and units.";

  /* ---------- Schema helpers (Gemini OpenAPI subset) ---------- */
  const STR = { type: "STRING" };
  const NUM = { type: "NUMBER" };
  const INT = { type: "INTEGER" };
  const BOOL = { type: "BOOLEAN" };
  const arr = (items) => ({ type: "ARRAY", items });
  const obj = (properties, required = Object.keys(properties)) => ({ type: "OBJECT", properties, required });

  const DIAGRAM_KINDS = ["graph", "right_triangle", "triangle", "circle", "number_line", "none"];

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
    reference: obj({
      topics: arr(
        obj(
          {
            title: STR,
            diagram: obj(
              {
                kind: { type: "STRING", enum: DIAGRAM_KINDS },
                caption: STR,
                expressions: arr(STR),
                xMin: NUM,
                xMax: NUM,
                yMin: NUM,
                yMax: NUM,
                points: arr(obj({ x: NUM, y: NUM, label: STR }, ["x", "label"])),
                labels: arr(STR),
              },
              ["kind", "caption"]
            ),
            steps: arr(STR),
            example: obj({ problem: STR, working: arr(STR), answer: STR }),
            cas: arr(obj({ step: STR, keys: STR })),
          },
          ["title", "diagram", "steps", "example", "cas"]
        )
      ),
    }),
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
    reference(v) {
      const num = (x) => (typeof x === "number" && isFinite(x) ? x : undefined);
      const topics = list(v.topics)
        .map((t) => {
          const d = t.diagram || {};
          return {
            title: s(t.title),
            diagram: {
              kind: DIAGRAM_KINDS.includes(d.kind) ? d.kind : "none",
              caption: s(d.caption),
              expressions: list(d.expressions).map(s).filter(Boolean).slice(0, 3),
              xMin: num(d.xMin), xMax: num(d.xMax), yMin: num(d.yMin), yMax: num(d.yMax),
              points: list(d.points).filter((p) => num(p.x) !== undefined).map((p) => ({ x: p.x, y: num(p.y), label: s(p.label) })).slice(0, 8),
              labels: list(d.labels).map(s).slice(0, 6),
            },
            steps: list(t.steps).map(s).filter(Boolean).slice(0, 6),
            example: { problem: s(t.example?.problem), working: list(t.example?.working).map(s).filter(Boolean), answer: s(t.example?.answer) },
            cas: list(t.cas).map((c) => ({ step: s(c.step), keys: s(c.keys) })).filter((c) => c.keys),
          };
        })
        .filter((t) => t.title && t.steps.length);
      need(topics.length, "no topics");
      return { topics };
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

    reference: ({ title, text }) =>
      `${notesBlock(title, text)}

Make a maths reference sheet for each distinct topic or method in these notes (at most 8 topics).
For each topic:
- title: the topic name.
- diagram: a simple diagram that a student could copy by hand. Choose kind:
  - "graph": expressions are functions of x in plain text using x, numbers, + - * / ^, sqrt(), sin(), cos(), tan(), ln(), log(), abs(), exp(), pi. Example "-(x-1)^2+4". Give xMin and xMax, and yMin/yMax if helpful. points are the key points with real numbers, labelled like "(3, 0)" or "turning point (1, 4)".
  - "right_triangle": labels = [vertical side, horizontal side, hypotenuse, angle at the bottom-left], e.g. ["a = 3", "b = 4", "c = 5", "θ"].
  - "triangle": labels = [side a, side b, side c, angle A, angle B, angle C].
  - "circle": labels = [radius label, centre label].
  - "number_line": points on the line with labels, xMin and xMax.
  - "none" if no diagram helps.
  caption: one short line describing the diagram.
- steps: "How to solve" in 3-5 short steps. No paragraphs.
- example: one worked example with real numbers. Use a method that is in the notes. working is the lines of working, answer is the final answer.
- cas: the easiest TI-Nspire CX CAS keystrokes for this kind of problem, as short steps, e.g. {"step": "Solve", "keys": "menu 3 1 → solve(0=-3x+10,x) → enter"}.
  If you are not completely sure of a keystroke or menu number, write "check on calculator" in keys instead of guessing.`,

    condense: ({ points }) =>
      `These summary points come from different parts of the same notes:\n${points.map((p) => "- " + p).join("\n")}\n\nCombine them into at most 5 bullet points. Don't add anything new.`,
  };

  /* ---------- Chunking ---------- */
  function chunk(text) {
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
    { id: "reference", label: "Reference sheet", maths: true },
  ];
  const stepsFor = (subject) => STEPS.filter((st) => !st.maths || R.isMaths(subject));

  // flashcards and quizzes use the lighter model to save quota
  const MODEL_FOR = { summary: Gemini.LITE, flashcards: Gemini.LITE, quiz: Gemini.LITE };

  async function runStep(id, title, chunks, onChunk) {
    const n = chunks.length;
    const call = (name, vars) =>
      Gemini.json({ system: GROUNDING, prompt: PROMPTS[name](vars), schema: SCHEMAS[name], validate: VALIDATE[name], model: MODEL_FOR[name] });

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
        return Gemini.json({ system: GROUNDING, prompt: PROMPTS.condense({ points }), schema: SCHEMAS.summary, validate: VALIDATE.summary, model: Gemini.LITE });
      }
      case "flashcards":
        return { cards: uniqBy(results.flatMap((r) => r.cards), (c) => c.front).slice(0, 40) };
      case "quiz":
        return { questions: results.flatMap((r) => r.questions).slice(0, 10) };
      case "exam":
        return { questions: results.flatMap((r) => r.questions).slice(0, 5) };
      case "reference":
        return { topics: results.flatMap((r) => r.topics).slice(0, 12) };
    }
  }

  /* ---------- Pipeline ---------- */
  const running = new Map(); // noteId -> promise

  function emit(note) {
    window.dispatchEvent(new CustomEvent("reforge:note", { detail: note }));
  }

  async function generate(noteId, only) {
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
          const result = await runStep(id, note.title, chunks, (i, n) => {
            note.status[id] = { state: "working", part: i, parts: n };
            emit(note);
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

  function notesContext(notes, limit = 90000) {
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
    const text = notesContext(R.shuffle(notes), 60000);
    const res = await Gemini.json({
      system: GROUNDING,
      prompt: PROMPTS.quiz({ title: `${subject.name}: all notes`, text, count: 10 }),
      schema: SCHEMAS.quiz,
      validate: VALIDATE.quiz,
      model: Gemini.LITE,
      cache: false,
      temperature: 0.8,
    });
    return res.questions.slice(0, 10);
  }

  async function markExam({ question, marks, modelAnswer, answer }) {
    return Gemini.json({
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
    const convo = history
      .slice(-12)
      .map((m) => `${m.role === "user" ? "STUDENT" : "TUTOR"}: ${m.text}`)
      .join("\n");
    return Gemini.json({
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

  async function transcribe(images, onRetry) {
    return Gemini.text({
      prompt:
        "Transcribe the study notes in these images into plain text, exactly as written. Keep headings, bullet points and line breaks. " +
        "Write maths in plain text (e.g. x^2, sqrt(x), a/b). Describe any diagram in one line in square brackets, e.g. [Diagram: right triangle with sides 3, 4, 5]. " +
        "Output only the transcription.",
      images,
      temperature: 0,
      onRetry,
    });
  }

  return { STEPS, stepsFor, generate, isRunning, freshQuiz, markExam, TUTOR_MODES, tutorReply, transcribe, chunk, MAX_CHARS };
})();
