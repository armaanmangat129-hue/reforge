/* Reforge Library: subjects, notes and the generate pipeline UI. The Reference Book lives in book.js. */

const Library = (() => {
  const { esc, icon, plural, when, subjectVar, toast, openSheet, confirmSheet, emptyState, skeleton, inline, view } = R;

  /* ---------- Sheets ---------- */

  function subjectSheet(subject) {
    const current = subject ? subject.color : R.SUBJECT_COLORS[0].key;
    const kind = subject ? R.subjectKind(subject) : "other";
    return openSheet(
      `<div class="sheet-body">
        <h2 id="sheet-title">${subject ? "Edit subject" : "New subject"}</h2>
        <p>${subject ? "Change the name, colour or reference book style." : "Group your notes by class, like Maths Methods or Chemistry."}</p>
        <div class="field">
          <label class="label" for="subject-name">Name</label>
          <input class="input" id="subject-name" name="name" required maxlength="40" autocomplete="off"
            value="${esc(subject ? subject.name : "")}" placeholder="e.g. Maths Methods">
        </div>
        <div class="field">
          <span class="label" id="color-label">Colour</span>
          <fieldset class="swatches" aria-labelledby="color-label">
            ${R.SUBJECT_COLORS.map(
              (c) => `<label class="swatch" style="${subjectVar(c.key)}">
                <input type="radio" name="color" value="${c.key}" ${c.key === current ? "checked" : ""} aria-label="${c.label}">
                <span></span></label>`
            ).join("")}
          </fieldset>
        </div>
        <div class="field">
          <span class="label" id="kind-label">Reference book style</span>
          <span class="hint">Picked from the subject name. Change it if it's wrong.</span>
          <fieldset class="kind-options" aria-labelledby="kind-label">
            ${R.KINDS.map((k) => `<label class="radio-card"><input type="radio" name="kind" value="${k.id}" ${k.id === kind ? "checked" : ""}>
              <div><strong>${esc(k.label)}</strong><span>${esc(k.note)}</span></div></label>`).join("")}
          </fieldset>
        </div>
      </div>
      <div class="sheet-foot">
        <button class="btn" type="button" data-close>Cancel</button>
        <button class="btn btn-primary" value="save">${subject ? "Save changes" : "Create subject"}</button>
      </div>`,
      {
        onOpen: (form) => {
          const name = form.querySelector("#subject-name");
          let touched = !!subject;
          form.querySelectorAll('[name="kind"]').forEach((r) => r.addEventListener("change", () => (touched = true)));
          name.addEventListener("input", () => {
            if (touched) return;
            const k = R.detectKind(name.value);
            form.querySelector(`[name="kind"][value="${k}"]`).checked = true;
          });
          name.focus();
        },
      }
    );
  }

  function noteSheet(subject) {
    return openSheet(
      `<div class="sheet-body">
        <h2 id="sheet-title">Add notes</h2>
        <p>Paste your ${esc(subject.name)} notes, or upload a PDF, Word file or photos. Check the text, then generate.</p>
        <div class="field">
          <label class="label" for="note-title">Title</label>
          <input class="input" id="note-title" name="title" required maxlength="120" autocomplete="off" placeholder="e.g. Quadratic functions">
        </div>
        <div class="field">
          <div class="label-row">
            <label class="label" for="note-text">Your notes</label>
            <label class="btn btn-quiet btn-small upload-btn">
              ${icon("upload")}<span>Upload files</span>
              <input type="file" multiple accept="${Upload.ACCEPT}" class="visually-hidden" data-upload>
            </label>
          </div>
          <textarea class="textarea" id="note-text" name="rawText" required placeholder="Paste or type your notes here. Messy is fine."></textarea>
          <p class="status-line" data-upload-status hidden></p>
          <span class="hint">PDF, Word (.docx), text, or up to 12 photos of handwritten notes or textbook pages.</span>
        </div>
      </div>
      <div class="sheet-foot">
        <button class="btn" type="button" data-close>Cancel</button>
        <button class="btn" value="save">Save only</button>
        <button class="btn btn-primary" value="generate">${icon("spark")}Save and generate</button>
      </div>`,
      { wide: true, onOpen: (form) => { form.querySelector("#note-title").focus(); wireUpload(form); } }
    );
  }

  function wireUpload(form) {
    const input = form.querySelector("[data-upload]");
    const area = form.querySelector("#note-text");
    const title = form.querySelector("#note-title");
    const status = form.querySelector("[data-upload-status]");
    const buttons = form.querySelectorAll(".sheet-foot .btn");
    const say = (tone, text) => {
      status.hidden = false;
      status.dataset.tone = tone;
      status.innerHTML = `${tone === "error" ? icon("alert") : tone === "ok" ? icon("check") : '<span class="spinner" aria-hidden="true"></span>'}<span>${esc(text)}</span>`;
    };
    input.addEventListener("change", async () => {
      if (!input.files.length) return;
      const files = [...input.files];
      buttons.forEach((b) => (b.disabled = true));
      try {
        const results = await Upload.extract(files, (msg) => say("busy", msg));
        const text = results.map((r) => (results.length > 1 ? `# ${r.name}\n\n${r.text}` : r.text)).join("\n\n");
        area.value = area.value.trim() ? `${area.value.trim()}\n\n${text}` : text;
        if (!title.value.trim()) title.value = files[0].name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").slice(0, 120);
        say("ok", `Text added from ${plural(files.length, "file")}. Check it for mistakes before you generate.`);
        area.focus();
      } catch (err) {
        console.error(err);
        say("error", err.message || "That file couldn't be read.");
      } finally {
        buttons.forEach((b) => (b.disabled = false));
        input.value = "";
      }
    });
  }

  /* ---------- Library ---------- */

  async function renderLibrary() {
    const [subjects, counts, due] = await Promise.all([DB.listSubjects(), DB.countNotesBySubject(), SRS.dueCountsBySubject()]);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    const grid = subjects.length
      ? `<div class="subject-grid">
          ${subjects
            .map(
              (s) => `<a class="card subject-card reveal" href="#/subject/${encodeURIComponent(s.id)}" style="${subjectVar(s.color)}">
                <h3>${esc(s.name)}</h3>
                <div class="subject-meta">
                  <span>${plural(counts[s.id] || 0, "note")}${due[s.id] ? ` · <span class="due-pill">${due[s.id]} due</span>` : ""}</span>
                  ${icon("arrow", "icon arrow")}
                </div>
              </a>`
            )
            .join("")}
          <button class="add-card reveal" type="button" data-action="new-subject">${icon("plus")}<span>New subject</span></button>
        </div>`
      : emptyState({
          mark: "library",
          title: "Start with a subject",
          body: "Make a subject for each class, then paste your notes into it. Reforge keeps everything in this browser.",
          action: `<button class="btn btn-primary" type="button" data-action="new-subject">${icon("plus")}Create your first subject</button>`,
        });

    return `
      <div class="page-head">
        <div>
          <span class="eyebrow">Your notes</span>
          <h1>Library</h1>
          ${subjects.length ? `<p class="lead">${plural(subjects.length, "subject")} · ${plural(total, "note")}</p>` : ""}
        </div>
        ${subjects.length ? `<div class="head-actions"><button class="btn btn-primary" type="button" data-action="new-subject">${icon("plus")}New subject</button></div>` : ""}
      </div>
      ${total ? `<div class="search" role="search">
          ${icon("search")}
          <label class="visually-hidden" for="search">Search all notes</label>
          <input class="input" id="search" type="search" placeholder="Search all notes" autocomplete="off">
        </div>` : ""}
      <div id="library-body">${grid}</div>
      <div id="search-results" hidden></div>`;
  }

  renderLibrary.mount = () => {
    view.querySelectorAll('[data-action="new-subject"]').forEach((b) => b.addEventListener("click", createSubject));
    const input = view.querySelector("#search");
    if (!input) return;
    let timer;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => runSearch(input.value.trim()), 120);
    });
  };

  async function runSearch(query) {
    const body = view.querySelector("#library-body");
    const results = view.querySelector("#search-results");
    if (!body || !results) return;
    if (!query) {
      body.hidden = false;
      results.hidden = true;
      return;
    }
    const [notes, subjects] = await Promise.all([DB.listNotes(), DB.listSubjects()]);
    const byId = Object.fromEntries(subjects.map((s) => [s.id, s]));
    const q = query.toLowerCase();
    const hits = notes.filter((n) => (n.title || "").toLowerCase().includes(q) || (n.rawText || "").toLowerCase().includes(q));
    body.hidden = true;
    results.hidden = false;
    results.innerHTML = hits.length
      ? `<div class="section-head"><h2>Results</h2><span class="count">${plural(hits.length, "note")}</span></div>
         <ul class="card note-list">${hits
           .map((n) => {
             const s = byId[n.subjectId];
             return `<li><a class="note-row" href="#/note/${encodeURIComponent(n.id)}">
               <div>
                 ${s ? `<span class="tag" style="${subjectVar(s.color)}"><span class="dot"></span>${esc(s.name)}</span>` : ""}
                 <h3>${R.highlight(n.title || "Untitled", query)}</h3>
                 <p>${R.snippet(n.rawText, query)}</p>
               </div>
               <span class="when">${when(n.updatedAt)}</span>
             </a></li>`;
           })
           .join("")}</ul>`
      : `<div class="card empty"><h2>No matches</h2><p>Nothing in your notes contains “${esc(query)}”. Try a shorter word.</p></div>`;
  }

  async function createSubject() {
    const data = await subjectSheet();
    if (!data) return;
    const subject = await DB.saveSubject({ name: data.get("name").trim(), color: data.get("color"), kind: data.get("kind") });
    toast(`${subject.name} created`);
    location.hash = `#/subject/${encodeURIComponent(subject.id)}`;
  }

  /* ---------- Subject ---------- */

  const generatedCount = (n) => Object.keys(n.outputs || {}).length;

  async function renderSubject(id) {
    const subject = await DB.getSubject(id);
    if (!subject) {
      location.hash = "#/library";
      return;
    }
    const [notes, due] = await Promise.all([DB.listNotes(id), SRS.dueCards(id)]);
    const pageCount = Book.groups(await Book.pagesOf(id)).length;
    return `
      <a class="back" href="#/library">${icon("back")}Library</a>
      <div class="page-head">
        <div>
          <span class="eyebrow">${plural(notes.length, "note")} · ${esc(R.KINDS.find((k) => k.id === R.subjectKind(subject)).label)} style</span>
          <h1>${esc(subject.name)}</h1>
        </div>
        <div class="head-actions">
          <button class="btn btn-quiet btn-icon" type="button" data-action="edit" aria-label="Edit subject">${icon("edit")}</button>
          <button class="btn btn-quiet btn-icon" type="button" data-action="delete" aria-label="Delete subject">${icon("trash")}</button>
          <button class="btn btn-primary" type="button" data-action="add-notes">${icon("plus")}Add notes</button>
        </div>
      </div>
      ${
        notes.length
          ? `<div class="quick-row reveal">
              <a class="quick" href="#/review/subject/${encodeURIComponent(id)}">${icon("study")}<span><strong>${due.length}</strong> cards due</span></a>
              <a class="quick" href="#/quiz/subject/${encodeURIComponent(id)}">${icon("target")}<span>Fresh quiz</span></a>
              <a class="quick" href="#/tutor?subject=${encodeURIComponent(id)}">${icon("tutor")}<span>Ask the tutor</span></a>
              <a class="quick" href="#/book/${encodeURIComponent(id)}">${icon("layers")}<span>Reference book${pageCount ? ` <strong>${pageCount}</strong>` : ""}</span></a>
            </div>
            <ul class="card note-list reveal">${notes
              .map(
                (n) => `<li><a class="note-row" href="#/note/${encodeURIComponent(n.id)}">
                  <div><h3>${esc(n.title || "Untitled")}</h3>${n.rawText ? `<p>${R.snippet(n.rawText)}</p>` : ""}</div>
                  <span class="when">${generatedCount(n) ? `<span class="ready">${icon("check")}Study set</span>` : ""}${when(n.updatedAt)}</span>
                </a></li>`
              )
              .join("")}</ul>`
          : emptyState({
              mark: "note",
              title: "Paste your first notes",
              body: `Copy your ${subject.name} notes from class, a document or a website, or upload a PDF or photos. Messy is fine.`,
              action: `<button class="btn btn-primary" type="button" data-action="add-notes">${icon("plus")}Add notes</button>`,
            })
      }`;
  }

  renderSubject.mount = (id) => {
    view.querySelectorAll('[data-action="add-notes"]').forEach((b) =>
      b.addEventListener("click", async () => {
        const subject = await DB.getSubject(id);
        const data = await noteSheet(subject);
        if (!data) return;
        const note = await DB.saveNote({ subjectId: id, title: data.get("title").trim(), rawText: data.get("rawText") });
        toast("Notes saved");
        location.hash = `#/note/${encodeURIComponent(note.id)}`;
        if (data.submitter === "generate") startGenerate(note.id);
      })
    );
    view.querySelector('[data-action="edit"]').addEventListener("click", async () => {
      const subject = await DB.getSubject(id);
      const data = await subjectSheet(subject);
      if (!data) return;
      const { isMaths: _old, ...rest } = subject;
      await DB.saveSubject({ ...rest, name: data.get("name").trim(), color: data.get("color"), kind: data.get("kind") });
      toast("Subject updated");
      R.render();
    });
    view.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      const subject = await DB.getSubject(id);
      const count = (await DB.listNotes(id)).length;
      const ok = await confirmSheet({
        title: `Delete ${subject.name}?`,
        body: count
          ? `This also deletes its ${plural(count, "note")}, flashcards, quiz history and exams. You can't undo this.`
          : "You can't undo this.",
        action: "Delete subject",
      });
      if (!ok) return;
      await DB.deleteSubject(id);
      toast(`${subject.name} deleted`);
      location.hash = "#/library";
    });
  };

  /* ---------- Note ---------- */

  function startGenerate(noteId, only) {
    AI.generate(noteId, only)
      .then((note) => {
        const failed = Object.values(note.status || {}).filter((s) => s.state === "error").length;
        if (failed) toast(failed === 1 ? "One part didn't finish. Press Retry on it." : `${failed} parts didn't finish. Press Retry on them.`);
        else toast("Study set ready");
      })
      .catch((err) => toast(err.message || "Couldn't generate."));
  }

  const TABS = [
    { id: "clean", label: "Notes" },
    { id: "summary", label: "Summary" },
    { id: "flashcards", label: "Flashcards" },
    { id: "quiz", label: "Quiz" },
    { id: "exam", label: "Exam" },
    { id: "source", label: "Source text" },
  ];

  function genPanel(note, subject) {
    const steps = AI.stepsFor(subject);
    const status = note.status || {};
    const anyStatus = steps.some((st) => status[st.id]);
    const running = AI.isRunning(note.id);
    const hasKey = !!Gemini.getKey();

    if (!anyStatus && !running) {
      return `<section class="card gen-panel gen-intro">
        <div>
          <h2>Turn this into a study set</h2>
          <p>Clean notes, a summary, flashcards, a quiz and exam questions. Only from what's in your notes.</p>
        </div>
        ${hasKey
          ? `<button class="btn btn-primary" type="button" data-action="generate">${icon("spark")}Generate</button>`
          : `<a class="btn btn-primary" href="#/settings">Add your Gemini key</a>`}
      </section>`;
    }

    const rows = steps
      .map((st) => {
        const s = status[st.id] || { state: "idle" };
        const pct = s.state === "done" ? 100 : s.state === "working" ? Math.round(((s.part || 0) + 0.5) / (s.parts || 1) * 100) : 0;
        const label =
          s.state === "done" ? "Done" :
          s.state === "working" ? (s.parts > 1 ? `Part ${s.part + 1} of ${s.parts}` : "Writing…") :
          s.state === "queued" ? "Waiting" :
          s.state === "error" ? "Didn't finish" : "Not made yet";
        return `<li class="gen-step" data-state="${s.state}">
          <div class="gen-step-head">
            <span class="gen-name">${s.state === "done" ? icon("check") : s.state === "error" ? icon("alert") : '<span class="gen-dot"></span>'}${esc(st.label)}</span>
            <span class="gen-state">${label}</span>
          </div>
          <div class="bar ${s.state === "working" ? "bar-live" : ""}" role="progressbar" aria-label="${esc(st.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
          ${s.state === "error" ? `<div class="gen-error"><span>${esc(s.error)}</span><button class="btn btn-small" type="button" data-retry="${st.id}">${icon("refresh")}Retry</button></div>` : ""}
          ${s.state === "idle" && !running ? `<div class="gen-error"><span>Not generated for this note yet.</span><button class="btn btn-small" type="button" data-retry="${st.id}">${icon("spark")}Make it</button></div>` : ""}
        </li>`;
      })
      .join("");

    return `<section class="card gen-panel" aria-live="polite">
      <div class="gen-head">
        <h2>Study set</h2>
        ${running ? '<span class="gen-badge"><span class="spinner" aria-hidden="true"></span>Generating</span>'
          : `<button class="btn btn-quiet btn-small" type="button" data-action="regenerate">${icon("refresh")}Regenerate all</button>`}
      </div>
      <ol class="gen-steps">${rows}</ol>
    </section>`;
  }

  function tabContent(tab, note, subject, cards) {
    const out = note.outputs || {};
    const st = (note.status || {})[tab] || {};
    const pending = () =>
      st.state === "working" || st.state === "queued"
        ? `<div class="card panel">${skeleton(6)}</div>`
        : `<div class="card empty"><h2>Not made yet</h2><p>Generate a study set from this note to see it here.</p></div>`;

    switch (tab) {
      case "clean": {
        const c = out.clean;
        if (!c) return pending();
        return `<article class="card panel clean-notes">
          ${c.formulas.length ? `<aside class="formula-box"><h3>Key formulas</h3><ul>${c.formulas.map((f) => `<li>${f.name ? `<span>${esc(f.name)}</span>` : ""}<code>${esc(f.formula)}</code></li>`).join("")}</ul></aside>` : ""}
          ${c.sections.map((s) => `<section><h3>${inline(s.heading)}</h3><ul>${s.bullets.map((b) => `<li>${inline(b)}</li>`).join("")}</ul></section>`).join("")}
          ${c.keyTerms.length ? `<section class="terms"><h3>Key terms</h3><dl>${c.keyTerms.map((t) => `<div><dt>${esc(t.term)}</dt><dd>${inline(t.definition)}</dd></div>`).join("")}</dl></section>` : ""}
        </article>`;
      }
      case "summary": {
        const s = out.summary;
        if (!s) return pending();
        return `<article class="card panel summary"><ul>${s.points.map((p) => `<li>${inline(p)}</li>`).join("")}</ul></article>`;
      }
      case "flashcards": {
        if (!cards.length && !out.flashcards) return pending();
        return `<div class="tab-actions">
            <a class="btn btn-primary" href="#/review/note/${encodeURIComponent(note.id)}">${icon("study")}Study these cards</a>
            <button class="btn" type="button" data-action="add-card">${icon("plus")}Add a card</button>
          </div>
          <ul class="card-list">${cards
            .map(
              (c) => `<li class="card flash-row">
                <div><p class="flash-front">${inline(c.front)}</p><p class="flash-back">${inline(c.back)}</p></div>
                <div class="row-actions">
                  ${c.source === "mistake" ? '<span class="chip">From a mistake</span>' : ""}
                  <button class="btn btn-quiet btn-icon" type="button" data-edit-card="${c.id}" aria-label="Edit card">${icon("edit")}</button>
                  <button class="btn btn-quiet btn-icon" type="button" data-delete-card="${c.id}" aria-label="Delete card">${icon("trash")}</button>
                </div>
              </li>`
            )
            .join("")}</ul>`;
      }
      case "quiz": {
        const q = out.quiz;
        if (!q) return pending();
        return `<div class="card panel launch">
          <div><h2>${plural(q.questions.length, "question")}</h2><p>Multiple choice, with an explanation after each answer.</p></div>
          <a class="btn btn-primary" href="#/quiz/note/${encodeURIComponent(note.id)}">Start quiz</a>
        </div>`;
      }
      case "exam": {
        const e = out.exam;
        if (!e) return pending();
        const marks = e.questions.reduce((a, q) => a + q.marks, 0);
        return `<div class="card panel launch">
            <div><h2>${plural(e.questions.length, "question")} · ${marks} marks</h2><p>Type your answers. Gemini marks each one against the model answer.</p></div>
            <a class="btn btn-primary" href="#/exam/note/${encodeURIComponent(note.id)}">Start practice</a>
          </div>
          <ol class="exam-preview">${e.questions.map((q) => `<li><span>${inline(q.question)}</span><span class="marks">${plural(q.marks, "mark")}</span></li>`).join("")}</ol>`;
      }
      case "source":
        return `<label class="visually-hidden" for="note-source">Your notes</label>
          <textarea class="textarea source-text" id="note-source" placeholder="Paste or type your notes here">${esc(note.rawText)}</textarea>
          <p class="hint source-hint">Changes save automatically. Press Regenerate all to update the study set.</p>`;
    }
    return "";
  }

  async function renderNote(id) {
    const note = await DB.getNote(id);
    const subject = note && (await DB.getSubject(note.subjectId));
    if (!note || !subject) {
      location.hash = "#/library";
      return;
    }
    return `
      <a class="back" href="#/subject/${encodeURIComponent(subject.id)}">${icon("back")}${esc(subject.name)}</a>
      <label class="visually-hidden" for="note-title-edit">Note title</label>
      <h1 class="visually-hidden">${esc(note.title || "Untitled")}</h1>
      <input class="note-title" id="note-title-edit" value="${esc(note.title)}" maxlength="120" placeholder="Untitled" autocomplete="off">
      <div class="note-bar">
        <span class="subject-tag" style="${subjectVar(subject.color)}"><span class="dot"></span>${esc(subject.name)}</span>
        <span class="save-state" data-state="saved">Saved ${when(note.updatedAt).toLowerCase()}</span>
        <button class="btn btn-quiet btn-small" type="button" data-action="delete">${icon("trash")}Delete</button>
      </div>
      <div id="gen-slot"></div>
      <section class="card ref-card">
        <div>
          <h2>Reference book</h2>
          <p>One A4 page per topic in this note, added to the ${esc(subject.name)} book. Topics already in the book are updated, and you see the changes before they're saved.</p>
        </div>
        <div class="head-actions">
          <a class="btn" href="#/book/${encodeURIComponent(subject.id)}">Open book</a>
          <button class="btn btn-primary" type="button" data-action="make-pages">${icon("layers")}Make reference pages</button>
        </div>
      </section>
      <div class="tabs" role="tablist" aria-label="Study set" id="note-tabs"></div>
      <div id="tab-slot" role="tabpanel"></div>`;
  }

  renderNote.mount = async (id) => {
    let note = await DB.getNote(id);
    const subject = await DB.getSubject(note.subjectId);
    const tabs = TABS;
    let tab = Object.keys(note.outputs || {}).length || AI.isRunning(id) ? "clean" : "source";
    const genSlot = view.querySelector("#gen-slot");
    const tabBar = view.querySelector("#note-tabs");
    const slot = view.querySelector("#tab-slot");
    const titleInput = view.querySelector("#note-title-edit");
    const state = view.querySelector(".save-state");
    let timer = null;

    const drawGen = () => (genSlot.innerHTML = genPanel(note, subject));
    const drawTabs = () => {
      tabBar.innerHTML = tabs
        .map((t) => {
          const ready = t.id === "source" || (note.outputs || {})[t.id];
          return `<button type="button" role="tab" id="tab-${t.id}" aria-selected="${t.id === tab}" tabindex="${t.id === tab ? 0 : -1}" data-tab-id="${t.id}" class="${ready ? "" : "is-empty"}">${t.label}</button>`;
        })
        .join("");
    };
    const drawTab = async () => {
      if (tab === "source" && slot.querySelector("#note-source")) return; // don't wipe the editor while typing
      const cards = tab === "flashcards" ? (await DB.all("cards", "noteId", id)).sort((a, b) => a.createdAt - b.createdAt) : [];
      slot.setAttribute("aria-labelledby", `tab-${tab}`);
      slot.innerHTML = tabContent(tab, note, subject, cards);
      if (tab === "source") wireSource();
    };

    const save = async () => {
      timer = null;
      const fresh = await DB.getNote(id);
      if (!fresh) return;
      const source = slot.querySelector("#note-source");
      note = await DB.saveNote({ ...fresh, title: titleInput.value.trim() || "Untitled", rawText: source ? source.value : fresh.rawText });
      state.dataset.state = "saved";
      state.textContent = "Saved";
    };
    const queue = () => {
      state.dataset.state = "saving";
      state.textContent = "Saving…";
      clearTimeout(timer);
      timer = setTimeout(save, 500);
    };
    function wireSource() {
      slot.querySelector("#note-source").addEventListener("input", queue);
    }
    titleInput.addEventListener("input", queue);
    titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); } });

    tabBar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-tab-id]");
      if (!b || b.dataset.tabId === tab) return;
      tab = b.dataset.tabId;
      drawTabs();
      drawTab();
    });
    tabBar.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
      const i = tabs.findIndex((t) => t.id === tab);
      tab = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length].id;
      drawTabs();
      drawTab();
      tabBar.querySelector(`[data-tab-id="${tab}"]`).focus();
    });

    const flushSave = async () => {
      if (timer) { clearTimeout(timer); await save(); }
    };

    genSlot.addEventListener("click", async (e) => {
      const gen = e.target.closest('[data-action="generate"], [data-action="regenerate"]');
      const retry = e.target.closest("[data-retry]");
      if (!gen && !retry) return;
      await flushSave();
      if (!(note.rawText || "").trim()) return toast("Add some notes first");
      if (!Gemini.getKey()) return (location.hash = "#/settings");
      if (gen && gen.dataset.action === "regenerate") {
        const ok = await confirmSheet({ title: "Regenerate the study set?", body: "This replaces the current outputs and the flashcards Gemini made. Cards made from your mistakes are kept.", action: "Regenerate", tone: "primary" });
        if (!ok) return;
      }
      if (tab === "source") { tab = "clean"; drawTabs(); }
      startGenerate(id, retry ? [retry.dataset.retry] : undefined);
    });

    slot.addEventListener("click", async (e) => {
      const add = e.target.closest('[data-action="add-card"]');
      const edit = e.target.closest("[data-edit-card]");
      const del = e.target.closest("[data-delete-card]");
      if (add) {
        const data = await Study.cardSheet();
        if (!data) return;
        await DB.put("cards", SRS.newCard({ subjectId: note.subjectId, noteId: id, front: data.front, back: data.back, source: "manual" }));
        toast("Card added");
        drawTab();
      } else if (edit) {
        const card = await DB.get("cards", edit.dataset.editCard);
        const data = await Study.cardSheet(card);
        if (!data) return;
        if (data.delete) await DB.del("cards", card.id);
        else await DB.put("cards", { ...card, ...data });
        toast(data.delete ? "Card deleted" : "Card updated");
        drawTab();
      } else if (del) {
        await DB.del("cards", del.dataset.deleteCard);
        toast("Card deleted");
        drawTab();
      }
    });

    view.querySelector('[data-action="make-pages"]').addEventListener("click", async (e) => {
      const btn = e.currentTarget; // currentTarget is cleared once we await
      await flushSave();
      if (!(note.rawText || "").trim()) return toast("Add some notes first");
      if (!Gemini.getKey()) return (location.hash = "#/settings");
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>Reading your notes…';
      const saved = await Book.make(id);
      btn.disabled = false;
      btn.innerHTML = `${icon("layers")}Make reference pages`;
      if (saved) location.hash = `#/book/${encodeURIComponent(note.subjectId)}`;
    });

    view.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      const ok = await confirmSheet({ title: `Delete “${note.title || "Untitled"}”?`, body: "This also deletes its flashcards. You can't undo this.", action: "Delete note" });
      if (!ok) return;
      clearTimeout(timer);
      timer = null;
      await DB.deleteNote(id);
      toast("Note deleted");
      location.hash = `#/subject/${encodeURIComponent(note.subjectId)}`;
    });

    const onNote = (e) => {
      if (e.detail.id !== id) return;
      const editing = slot.querySelector("#note-source");
      note = { ...e.detail, rawText: editing ? editing.value : e.detail.rawText, title: titleInput.value || e.detail.title };
      drawGen();
      drawTabs();
      drawTab();
    };
    window.addEventListener("reforge:note", onNote);

    drawGen();
    drawTabs();
    await drawTab();

    return () => {
      window.removeEventListener("reforge:note", onNote);
      if (timer) { clearTimeout(timer); save(); }
    };
  };

  R.route(/^\/library$/, "library", renderLibrary);
  R.route(/^\/subject\/([^/]+)$/, "library", renderSubject);
  R.route(/^\/note\/([^/]+)$/, "library", renderNote);

  return {};
})();
