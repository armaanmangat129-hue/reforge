/* Reforge Study: the study hub, flashcard reviews (SM-2), quizzes and exam-style practice. */

const Study = (() => {
  const { esc, icon, plural, subjectVar, toast, openSheet, emptyState, skeleton, inline, view } = R;

  /* ---------- Card editor ---------- */
  function cardSheet(card) {
    return openSheet(
      `<div class="sheet-body">
        <h2 id="sheet-title">${card ? "Edit card" : "New card"}</h2>
        <div class="field">
          <label class="label" for="card-front">Question</label>
          <textarea class="textarea textarea-short" id="card-front" name="front" required>${esc(card ? card.front : "")}</textarea>
        </div>
        <div class="field">
          <label class="label" for="card-back">Answer</label>
          <textarea class="textarea textarea-short" id="card-back" name="back" required>${esc(card ? card.back : "")}</textarea>
        </div>
      </div>
      <div class="sheet-foot">
        ${card ? `<button class="btn btn-quiet sheet-foot-left" value="delete" formnovalidate>${icon("trash")}Delete</button>` : ""}
        <button class="btn" type="button" data-close>Cancel</button>
        <button class="btn btn-primary" value="save">${card ? "Save card" : "Add card"}</button>
      </div>`,
      {
        onOpen: (form) => {
          form.querySelector("#card-front").focus();
          // the delete button must skip validation
          form.querySelector('[value="delete"]')?.addEventListener("click", () => form.querySelectorAll("[required]").forEach((el) => el.removeAttribute("required")));
        },
      }
    ).then((data) => {
      if (!data) return null;
      if (data.submitter === "delete") return { delete: true };
      return { front: data.get("front").trim(), back: data.get("back").trim() };
    });
  }

  const pct = (score, total) => (total ? Math.round((score / total) * 100) : 0);

  /* ---------- Hub ---------- */
  async function renderHub() {
    const [subjects, due, attempts, cards] = await Promise.all([DB.listSubjects(), SRS.dueCountsBySubject(), DB.all("attempts"), DB.all("cards")]);
    const totalDue = Object.values(due).reduce((a, b) => a + b, 0);
    const notes = await DB.listNotes();
    const subjectsWithNotes = subjects.filter((s) => notes.some((n) => n.subjectId === s.id));

    if (!subjectsWithNotes.length) {
      return `<div class="page-head"><div><span class="eyebrow">Practice</span><h1>Study</h1>
          <p class="lead">Flashcards and quizzes made from your notes, scheduled so you review each card just before you'd forget it.</p></div></div>
        ${emptyState({ mark: "study", title: "Nothing to review yet", body: "Add notes to a subject and generate a study set. Your flashcards and quizzes will appear here.", action: `<a class="btn btn-primary" href="#/library">Go to Library</a>` })}`;
    }

    const nextDue = cards.filter((c) => c.due > R.endOfToday()).sort((a, b) => a.due - b.due)[0];
    const history = (subjectId) => attempts.filter((a) => a.subjectId === subjectId).sort((a, b) => b.at - a.at).slice(0, 8).reverse();

    return `
      <div class="page-head"><div><span class="eyebrow">Practice</span><h1>Study</h1></div></div>

      <section class="card due-hero reveal">
        <div>
          <span class="due-number">${totalDue}</span>
          <div>
            <h2>${totalDue === 1 ? "card due today" : "cards due today"}</h2>
            <p>${totalDue ? "Mixed across all your subjects." : nextDue ? `You're up to date. Next card is due ${R.prettyDay(R.dayKey(nextDue.due)).toLowerCase()}.` : "Generate flashcards from a note to start reviewing."}</p>
          </div>
        </div>
        ${totalDue ? `<a class="btn btn-primary btn-gold" href="#/review/all">${icon("study")}Start review</a>` : ""}
      </section>

      <div class="section-head section"><h2>By subject</h2></div>
      <ul class="subject-study-list">
        ${subjectsWithNotes
          .map((s) => {
            const h = history(s.id);
            const avg = h.length ? Math.round(h.reduce((a, x) => a + pct(x.score, x.total), 0) / h.length) : null;
            return `<li class="card subject-study reveal" style="${subjectVar(s.color)}">
              <div class="ss-head">
                <h3><span class="dot"></span>${esc(s.name)}</h3>
                <span class="count">${due[s.id] ? `<span class="due-pill">${due[s.id]} due</span>` : "Nothing due"}</span>
              </div>
              ${h.length ? `<div class="spark" aria-label="Recent scores, average ${avg}%">${h.map((a) => `<span title="${a.kind === "exam" ? "Exam" : "Quiz"} ${pct(a.score, a.total)}%" style="height:${Math.max(6, pct(a.score, a.total))}%" class="${a.kind}"></span>`).join("")}</div>
                <p class="ss-meta">Average ${avg}% over the last ${plural(h.length, "attempt")}</p>` : `<p class="ss-meta">No quiz scores yet.</p>`}
              <div class="ss-actions">
                <a class="btn btn-small ${due[s.id] ? "btn-primary" : ""}" href="#/review/subject/${encodeURIComponent(s.id)}" ${due[s.id] ? "" : 'aria-disabled="true"'}>Review cards</a>
                <a class="btn btn-small" href="#/quiz/subject/${encodeURIComponent(s.id)}">Fresh quiz</a>
                <a class="btn btn-small" href="#/exam/subject/${encodeURIComponent(s.id)}">Exam practice</a>
              </div>
            </li>`;
          })
          .join("")}
      </ul>`;
  }

  /* ---------- Flashcard review ---------- */
  async function loadReviewCards(scope, id) {
    if (scope === "note") {
      const all = await DB.all("cards", "noteId", id);
      const due = all.filter((c) => c.due <= R.endOfToday());
      return { cards: R.shuffle(due.length ? due : all), label: (await DB.getNote(id))?.title || "Note", back: `#/note/${encodeURIComponent(id)}`, practice: !due.length };
    }
    if (scope === "subject") {
      const s = await DB.getSubject(id);
      return { cards: R.shuffle(await SRS.dueCards(id)), label: s ? s.name : "Subject", back: "#/study" };
    }
    return { cards: R.shuffle(await SRS.dueCards()), label: "All subjects", back: "#/study" };
  }

  async function renderReview(scope, id) {
    const { cards, label, back } = await loadReviewCards(scope, id);
    return `
      <a class="back" href="${back}">${icon("back")}Back</a>
      <div class="page-head session-head"><div><span class="eyebrow">Flashcards</span><h1>${esc(label)}</h1></div>
        <span class="session-count" id="session-count"></span></div>
      <div class="bar session-bar"><span id="session-progress" style="width:0%"></span></div>
      <div id="review-slot">${cards.length ? "" : emptyState({ mark: "check", title: "Nothing due", body: "You've reviewed everything due today. Come back tomorrow, or take a quiz.", action: `<a class="btn btn-primary" href="#/study">Back to Study</a>` })}</div>`;
  }

  renderReview.mount = async (scope, id) => {
    const { cards, practice, back } = await loadReviewCards(scope, id);
    if (!cards.length) return;
    const slot = view.querySelector("#review-slot");
    const countEl = view.querySelector("#session-count");
    const bar = view.querySelector("#session-progress");
    const queue = cards.slice();
    const total = cards.length;
    let done = 0, xp = 0, reviewed = 0, flipped = false, current = null, busy = false;

    function draw() {
      current = queue[0];
      flipped = false;
      countEl.textContent = `${Math.min(done + 1, total)} / ${total}`;
      bar.style.width = `${(done / total) * 100}%`;
      if (!current) return finish();
      slot.innerHTML = `
        <div class="flashcard" tabindex="0" role="button" aria-label="Flashcard. Press space to show the answer." id="flashcard">
          <div class="flashcard-inner">
            <div class="face front"><span class="face-label">Question</span><p>${inline(current.front)}</p></div>
            <div class="face back"><span class="face-label">Answer</span><p>${inline(current.back)}</p></div>
          </div>
        </div>
        <div class="review-controls" id="controls">
          <button class="btn btn-primary btn-wide" type="button" data-flip>Show answer <kbd>Space</kbd></button>
        </div>
        <div class="review-tools">
          <button class="btn btn-quiet btn-small" type="button" data-edit>${icon("edit")}Edit card</button>
          <span class="hint hide-touch">Space to flip · 1-4 to rate</span>
          <span class="hint show-touch">Tap to flip · swipe right for Good, left for Again</span>
        </div>`;
      wireCard();
    }

    function flip() {
      if (flipped || !current) return;
      flipped = true;
      slot.querySelector(".flashcard").classList.add("is-flipped");
      slot.querySelector(".flashcard").setAttribute("aria-label", "Flashcard showing the answer.");
      slot.querySelector("#controls").innerHTML = `<div class="ratings">${SRS.RATINGS.map(
        (r) => `<button class="btn rating rating-${r.id}" type="button" data-rate="${r.q}">
          <strong>${r.label}</strong><span>${practice ? "&nbsp;" : SRS.previewInterval(current, r.q)}</span><kbd>${r.key}</kbd></button>`
      ).join("")}</div>`;
      slot.querySelector("[data-rate]").focus({ preventScroll: true });
    }

    async function rate(q) {
      if (!flipped || busy) return;
      busy = true;
      const card = current;
      queue.shift();
      // practice mode (nothing due on this note) doesn't change the schedule
      const next = practice ? card : SRS.schedule(card, q);
      if (!practice) await DB.put("cards", next);
      if (q < 3) queue.push(next); // see it again this session
      else done++;
      reviewed++;
      const gained = q >= 4 ? SRS.XP.reviewGood : SRS.XP.review;
      xp += gained;
      await SRS.award(gained, "review");
      busy = false;
      draw();
    }

    function finish() {
      bar.style.width = "100%";
      countEl.textContent = "";
      slot.innerHTML = `<div class="card empty finish reveal is-visible">
        <div class="empty-mark gold">${icon("check")}</div>
        <h2>Session complete</h2>
        <p>You reviewed ${plural(reviewed, "card")} and earned <strong class="gold-text">${xp} XP</strong>.</p>
        <div class="finish-actions"><a class="btn btn-primary" href="#/study">Back to Study</a>${back !== "#/study" ? `<a class="btn" href="${back}">Back to note</a>` : ""}</div>
      </div>`;
    }

    function wireCard() {
      const el = slot.querySelector(".flashcard");
      el.addEventListener("click", () => (flipped ? null : flip()));
      slot.querySelector("[data-flip]")?.addEventListener("click", flip);
      slot.querySelector("#controls").addEventListener("click", (e) => {
        const b = e.target.closest("[data-rate]");
        if (b) rate(Number(b.dataset.rate));
      });
      slot.querySelector("[data-edit]").addEventListener("click", async () => {
        const data = await cardSheet(current);
        if (!data) return;
        if (data.delete) {
          await DB.del("cards", current.id);
          queue.shift();
          done++;
          toast("Card deleted");
        } else {
          Object.assign(current, data);
          await DB.put("cards", current);
          toast("Card updated");
        }
        draw();
      });

      // swipe on touch screens
      let startX = null, dx = 0;
      el.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") { startX = e.clientX; dx = 0; } });
      el.addEventListener("pointermove", (e) => {
        if (startX === null) return;
        dx = e.clientX - startX;
        if (flipped) el.style.transform = `translateX(${dx}px) rotate(${dx / 30}deg)`;
      });
      const end = () => {
        if (startX === null) return;
        el.style.transform = "";
        if (Math.abs(dx) > 80) {
          if (!flipped) flip();
          else rate(dx > 0 ? 4 : 1);
        }
        startX = null;
      };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    }

    const onKey = (e) => {
      if (e.target.closest?.("input, textarea, select, dialog")) return;
      if (e.key === " " || e.key === "Enter") {
        if (!flipped) { e.preventDefault(); flip(); }
      } else if (["1", "2", "3", "4"].includes(e.key)) {
        rate(SRS.RATINGS[Number(e.key) - 1].q);
      } else if (e.key.toLowerCase() === "e" && current) {
        slot.querySelector("[data-edit]")?.click();
      }
    };
    document.addEventListener("keydown", onKey);
    draw();
    return () => document.removeEventListener("keydown", onKey);
  };

  /* ---------- Quiz ---------- */
  async function renderQuiz(scope, id) {
    const label = scope === "note" ? (await DB.getNote(id))?.title : (await DB.getSubject(id))?.name;
    if (!label) { location.hash = "#/study"; return; }
    return `
      <a class="back" href="${scope === "note" ? `#/note/${encodeURIComponent(id)}` : "#/study"}">${icon("back")}Back</a>
      <div class="page-head session-head"><div><span class="eyebrow">${scope === "note" ? "Quiz" : "Fresh quiz"}</span><h1>${esc(label)}</h1></div>
        <span class="session-count" id="session-count"></span></div>
      <div class="bar session-bar"><span id="session-progress" style="width:0%"></span></div>
      <div id="quiz-slot"><div class="card panel">${skeleton(5)}<p class="hint loading-note">${scope === "subject" ? "Writing 10 new questions from your notes…" : ""}</p></div></div>`;
  }

  renderQuiz.mount = async (scope, id) => {
    const slot = view.querySelector("#quiz-slot");
    const countEl = view.querySelector("#session-count");
    const bar = view.querySelector("#session-progress");
    let questions, subjectId, noteId = null;

    async function load() {
      if (scope === "note") {
        const note = await DB.getNote(id);
        subjectId = note.subjectId;
        noteId = id;
        questions = note.outputs?.quiz?.questions || [];
        if (!questions.length) throw new Error("This note doesn't have a quiz yet. Generate its study set first.");
      } else {
        const subject = await DB.getSubject(id);
        subjectId = id;
        const notes = (await DB.listNotes(id)).filter((n) => (n.rawText || "").trim());
        if (!notes.length) throw new Error("Add notes to this subject first.");
        if (!Gemini.getKey()) throw new Error("Fresh quizzes use Gemini. Add your key in Settings.");
        questions = await AI.freshQuiz(subject, notes);
      }
    }

    try {
      await load();
    } catch (err) {
      slot.innerHTML = emptyState({ mark: "alert", title: "Couldn't start the quiz", body: err.message, action: `<button class="btn btn-primary" type="button" data-retry>Try again</button>` });
      slot.querySelector("[data-retry]").addEventListener("click", () => R.render());
      return;
    }

    let i = 0, score = 0, answered = false;
    const wrong = [];

    function draw() {
      const q = questions[i];
      answered = false;
      countEl.textContent = `${i + 1} / ${questions.length}`;
      bar.style.width = `${(i / questions.length) * 100}%`;
      slot.innerHTML = `<div class="card panel quiz-card">
        ${q.topic ? `<span class="chip">${esc(q.topic)}</span>` : ""}
        <h2 class="quiz-q">${inline(q.question)}</h2>
        <div class="options" role="group" aria-label="Answers">
          ${q.options.map((o, k) => `<button class="option" type="button" data-k="${k}"><kbd>${k + 1}</kbd><span>${inline(o)}</span></button>`).join("")}
        </div>
        <div id="feedback" aria-live="polite"></div>
      </div>`;
      slot.querySelectorAll(".option").forEach((b) => b.addEventListener("click", () => choose(Number(b.dataset.k))));
    }

    function choose(k) {
      if (answered) return;
      answered = true;
      const q = questions[i];
      const right = k === q.answerIndex;
      if (right) score++;
      else wrong.push({ question: q.question, chosen: q.options[k], correct: q.options[q.answerIndex], explanation: q.explanation, topic: q.topic });
      slot.querySelectorAll(".option").forEach((b, idx) => {
        b.disabled = true;
        if (idx === q.answerIndex) b.classList.add("is-correct");
        else if (idx === k) b.classList.add("is-wrong");
      });
      slot.querySelector("#feedback").innerHTML = `<div class="feedback ${right ? "ok" : "bad"}">
        <strong>${right ? "Correct" : "Not quite"}</strong>
        ${q.explanation ? `<p>${inline(q.explanation)}</p>` : ""}
      </div>
      <button class="btn btn-primary" type="button" data-next>${i + 1 < questions.length ? "Next question" : "See results"} <kbd>Enter</kbd></button>`;
      const next = slot.querySelector("[data-next]");
      next.addEventListener("click", advance);
      next.focus({ preventScroll: true });
    }

    async function advance() {
      i++;
      if (i < questions.length) return draw();
      await finish();
    }

    async function finish() {
      bar.style.width = "100%";
      countEl.textContent = "";
      const total = questions.length;
      await DB.put("attempts", { id: DB.uid(), subjectId, noteId, kind: "quiz", score, total, wrong: wrong.map((w) => ({ question: w.question, topic: w.topic })), at: Date.now() });
      const gained = SRS.XP.quiz + score * SRS.XP.quizCorrect;
      await SRS.award(gained, "quiz");
      slot.innerHTML = `<div class="card panel result">
        <div class="result-score"><span class="big">${score}<small>/${total}</small></span><span>${pct(score, total)}% · <strong class="gold-text">+${gained} XP</strong></span></div>
        ${wrong.length
          ? `<h3>Questions to revisit</h3>
             <ul class="mistakes">${wrong.map((w) => `<li><p class="m-q">${inline(w.question)}</p><p class="m-a"><span class="bad-text">You chose: ${inline(w.chosen)}</span><span class="ok-text">Answer: ${inline(w.correct)}</span></p>${w.explanation ? `<p class="m-e">${inline(w.explanation)}</p>` : ""}</li>`).join("")}</ul>`
          : `<p class="lead">Every answer right.</p>`}
        <div class="finish-actions">
          ${wrong.length ? `<button class="btn btn-primary" type="button" data-mistakes>${icon("layers")}Make flashcards from my mistakes</button>` : ""}
          <button class="btn" type="button" data-again>Try again</button>
          <a class="btn btn-quiet" href="#/study">Back to Study</a>
        </div>
      </div>`;
      slot.querySelector("[data-again]").addEventListener("click", () => R.render());
      slot.querySelector("[data-mistakes]")?.addEventListener("click", async (e) => {
        const cards = wrong.map((w) => SRS.newCard({ subjectId, noteId, front: w.question, back: w.correct + (w.explanation ? ` — ${w.explanation}` : ""), source: "mistake" }));
        const btn = e.currentTarget; // currentTarget is cleared once we await
        btn.disabled = true;
        await DB.putMany("cards", cards);
        btn.textContent = `${plural(cards.length, "card")} added`;
        toast(`${plural(cards.length, "flashcard")} added. They're due today.`);
      });
    }

    const onKey = (e) => {
      if (e.target.closest?.("input, textarea, select, dialog")) return;
      if (!answered && ["1", "2", "3", "4"].includes(e.key)) choose(Number(e.key) - 1);
      else if (answered && e.key === "Enter" && !e.target.closest?.("button")) { e.preventDefault(); advance(); }
    };
    document.addEventListener("keydown", onKey);
    draw();
    return () => document.removeEventListener("keydown", onKey);
  };

  /* ---------- Exam-style questions ---------- */
  async function loadExam(scope, id) {
    if (scope === "note") {
      const note = await DB.getNote(id);
      return { subjectId: note.subjectId, noteId: id, label: note.title, back: `#/note/${encodeURIComponent(id)}`, questions: note.outputs?.exam?.questions || [] };
    }
    const subject = await DB.getSubject(id);
    const notes = await DB.listNotes(id);
    const pool = notes.flatMap((n) => (n.outputs?.exam?.questions || []).map((q) => ({ ...q, noteId: n.id })));
    return { subjectId: id, noteId: null, label: subject?.name || "Subject", back: "#/study", questions: R.shuffle(pool).slice(0, 5) };
  }

  async function renderExam(scope, id) {
    const { label, back, questions } = await loadExam(scope, id);
    return `
      <a class="back" href="${back}">${icon("back")}Back</a>
      <div class="page-head session-head"><div><span class="eyebrow">Exam practice</span><h1>${esc(label)}</h1></div>
        <span class="session-count" id="session-count"></span></div>
      <div class="bar session-bar"><span id="session-progress" style="width:0%"></span></div>
      <div id="exam-slot">${questions.length ? "" : emptyState({ mark: "note", title: "No exam questions yet", body: "Generate a study set for a note in this subject to get exam-style questions.", action: `<a class="btn btn-primary" href="#/library">Go to Library</a>` })}</div>`;
  }

  renderExam.mount = async (scope, id) => {
    const { subjectId, noteId, questions } = await loadExam(scope, id);
    if (!questions.length) return;
    const slot = view.querySelector("#exam-slot");
    const countEl = view.querySelector("#session-count");
    const bar = view.querySelector("#session-progress");
    const results = [];
    let i = 0;

    function draw() {
      const q = questions[i];
      countEl.textContent = `${i + 1} / ${questions.length}`;
      bar.style.width = `${(i / questions.length) * 100}%`;
      slot.innerHTML = `<div class="card panel quiz-card">
        <div class="exam-meta">${q.topic ? `<span class="chip">${esc(q.topic)}</span>` : "<span></span>"}<span class="marks">${plural(q.marks, "mark")}</span></div>
        <h2 class="quiz-q">${inline(q.question)}</h2>
        <label class="visually-hidden" for="exam-answer">Your answer</label>
        <textarea class="textarea" id="exam-answer" placeholder="Write your answer as you would in the exam"></textarea>
        <div class="exam-actions">
          <button class="btn btn-quiet" type="button" data-skip>Show model answer</button>
          <button class="btn btn-primary" type="button" data-mark>${icon("check")}Mark my answer</button>
        </div>
        <div id="feedback" aria-live="polite"></div>
      </div>`;
      const area = slot.querySelector("#exam-answer");
      area.focus({ preventScroll: true });
      slot.querySelector("[data-mark]").addEventListener("click", () => mark(area.value.trim()));
      slot.querySelector("[data-skip]").addEventListener("click", () => show(q, { score: 0, missing: "You skipped this one.", good: "" }, ""));
    }

    async function mark(answer) {
      const q = questions[i];
      if (!answer) return toast("Write an answer first, or show the model answer");
      if (!Gemini.getKey()) return toast("Add your Gemini key in Settings to mark answers");
      const btn = slot.querySelector("[data-mark]");
      btn.disabled = true;
      slot.querySelector("[data-skip]").disabled = true;
      slot.querySelector("#feedback").innerHTML = `<div class="feedback">${skeleton(2)}<p class="hint">Marking against the model answer…</p></div>`;
      try {
        const res = await AI.markExam({ question: q.question, marks: q.marks, modelAnswer: q.modelAnswer, answer });
        show(q, res, answer);
        await SRS.award(SRS.XP.exam, "exam");
      } catch (err) {
        btn.disabled = false;
        slot.querySelector("[data-skip]").disabled = false;
        slot.querySelector("#feedback").innerHTML = `<div class="feedback bad"><strong>Couldn't mark it</strong><p>${esc(err.message)}</p></div>`;
      }
    }

    function show(q, res, answer) {
      results[i] = { q, answer, ...res };
      slot.querySelector("#exam-answer").readOnly = true;
      slot.querySelector(".exam-actions").remove();
      const full = res.score === q.marks;
      slot.querySelector("#feedback").innerHTML = `<div class="feedback ${full ? "ok" : res.score > 0 ? "mid" : "bad"}">
          <strong>${res.score} / ${q.marks} ${q.marks === 1 ? "mark" : "marks"}</strong>
          ${res.good ? `<p>${inline(res.good)}</p>` : ""}
          ${res.missing ? `<p><span class="m-label">Missing:</span> ${inline(res.missing)}</p>` : ""}
        </div>
        <details class="model" ${answer ? "" : "open"}><summary>Model answer</summary><div>${R.md(q.modelAnswer)}</div></details>
        <button class="btn btn-primary" type="button" data-next>${i + 1 < questions.length ? "Next question" : "See results"}</button>`;
      slot.querySelector("[data-next]").addEventListener("click", () => { i++; i < questions.length ? draw() : finish(); });
      slot.querySelector("[data-next]").focus({ preventScroll: true });
    }

    async function finish() {
      bar.style.width = "100%";
      countEl.textContent = "";
      const score = results.reduce((a, r) => a + r.score, 0);
      const total = results.reduce((a, r) => a + r.q.marks, 0);
      const dropped = results.filter((r) => r.score < r.q.marks);
      await DB.put("attempts", {
        id: DB.uid(), subjectId, noteId, kind: "exam", score, total,
        wrong: results.filter((r) => r.score < r.q.marks / 2).map((r) => ({ question: r.q.question, topic: r.q.topic })),
        at: Date.now(),
      });
      slot.innerHTML = `<div class="card panel result">
        <div class="result-score"><span class="big">${score}<small>/${total}</small></span><span>${pct(score, total)}% of marks</span></div>
        <ul class="mistakes">${results.map((r) => `<li><p class="m-q">${inline(r.q.question)}</p><p class="m-a"><span class="${r.score === r.q.marks ? "ok-text" : "bad-text"}">${r.score}/${r.q.marks}</span>${r.missing ? `<span>${inline(r.missing)}</span>` : ""}</p></li>`).join("")}</ul>
        <div class="finish-actions">
          ${dropped.length ? `<button class="btn btn-primary" type="button" data-mistakes>${icon("layers")}Make flashcards from my mistakes</button>` : ""}
          <a class="btn btn-quiet" href="#/study">Back to Study</a>
        </div>
      </div>`;
      slot.querySelector("[data-mistakes]")?.addEventListener("click", async (e) => {
        const cards = dropped.map((r) => SRS.newCard({ subjectId, noteId: r.q.noteId || noteId, front: r.q.question, back: r.q.modelAnswer, source: "mistake" }));
        const btn = e.currentTarget; // currentTarget is cleared once we await
        btn.disabled = true;
        await DB.putMany("cards", cards);
        btn.textContent = `${plural(cards.length, "card")} added`;
        toast(`${plural(cards.length, "flashcard")} added. They're due today.`);
      });
    }

    draw();
  };

  R.route(/^\/study$/, "study", renderHub);
  R.route(/^\/review\/(all)$/, "study", renderReview);
  R.route(/^\/review\/(subject|note)\/([^/]+)$/, "study", renderReview);
  R.route(/^\/quiz\/(note|subject)\/([^/]+)$/, "study", renderQuiz);
  R.route(/^\/exam\/(note|subject)\/([^/]+)$/, "study", renderExam);

  return { cardSheet };
})();
