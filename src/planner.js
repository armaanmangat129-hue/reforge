/* Reforge Planner: exams with countdowns, a day-by-day revision plan, XP, streaks and stats. */

const Planner = (() => {
  const { esc, icon, plural, subjectVar, toast, openSheet, confirmSheet, emptyState, view } = R;
  const MAX_DAYS = 60;
  const PER_DAY = 4;

  function examSheet(subjects, exam) {
    const min = R.dayKey();
    return openSheet(
      `<div class="sheet-body">
        <h2 id="sheet-title">${exam ? "Edit exam" : "Add an exam"}</h2>
        <p>Reforge counts down to it and plans your revision.</p>
        <div class="field">
          <label class="label" for="exam-subject">Subject</label>
          <select class="select" id="exam-subject" name="subjectId" required>
            ${subjects.map((s) => `<option value="${s.id}" ${exam && exam.subjectId === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label class="label" for="exam-name">Name</label>
          <input class="input" id="exam-name" name="name" required maxlength="60" autocomplete="off" value="${esc(exam ? exam.name : "")}" placeholder="e.g. Unit 3 SAC">
        </div>
        <div class="field">
          <label class="label" for="exam-date">Date</label>
          <input class="input" id="exam-date" name="date" type="date" required min="${min}" value="${exam ? exam.date : ""}">
        </div>
      </div>
      <div class="sheet-foot">
        <button class="btn" type="button" data-close>Cancel</button>
        <button class="btn btn-primary" value="save">${exam ? "Save" : "Add exam"}</button>
      </div>`,
      { onOpen: (form) => form.querySelector("#exam-name").focus() }
    );
  }

  /* Builds tasks from today up to each exam using due cards, weak topics and each subject's notes. */
  async function buildPlan() {
    const today = R.dayKey();
    const exams = (await DB.all("exams")).filter((e) => e.date > today).sort((a, b) => a.date.localeCompare(b.date));
    const old = await DB.all("tasks");
    // keep finished tasks; replace the rest
    for (const t of old) if (!t.done || t.day < today) await DB.del("tasks", t.id);
    if (!exams.length) return 0;

    const subjects = Object.fromEntries((await DB.listSubjects()).map((s) => [s.id, s]));
    const notesBy = {}, weakBy = {}, dueBy = await SRS.dueCountsBySubject();
    for (const e of exams) {
      notesBy[e.subjectId] = notesBy[e.subjectId] || (await DB.listNotes(e.subjectId)).sort((a, b) => a.createdAt - b.createdAt);
      weakBy[e.subjectId] = weakBy[e.subjectId] || (await SRS.weakTopics(e.subjectId));
    }

    const tasks = [];
    const cursor = {}; // rotate through notes and weak topics per exam
    const last = exams[exams.length - 1].date;
    const span = Math.min(MAX_DAYS, R.daysBetween(today, last));
    const add = (day, exam, kind, label, link) =>
      tasks.push({ id: DB.uid(), examId: exam.id, subjectId: exam.subjectId, day, kind, label, link, done: false, order: tasks.length });

    for (let d = 0; d < span; d++) {
      const day = R.addDays(today, d);
      const active = exams.filter((e) => e.date > day);
      if (!active.length) continue;
      // nearer exams get more slots
      const ranked = active.map((e) => ({ e, left: R.daysBetween(day, e.date) })).sort((a, b) => a.left - b.left);
      let slots = PER_DAY;
      for (const { e, left } of ranked) {
        if (slots <= 0) break;
        const s = subjects[e.subjectId];
        if (!s) continue;
        const notes = notesBy[e.subjectId];
        const weak = weakBy[e.subjectId];
        const c = (cursor[e.id] = cursor[e.id] || { note: 0, weak: 0 });
        const sid = encodeURIComponent(e.subjectId);

        if (left === 1) {
          add(day, e, "final", `Final review for ${e.name}: all due ${s.name} cards`, `#/review/subject/${sid}`);
          add(day, e, "quiz", `One last ${s.name} quiz`, `#/quiz/subject/${sid}`);
          slots -= 2;
          continue;
        }
        const due = d === 0 ? dueBy[e.subjectId] || 0 : null;
        add(day, e, "review", due ? `Review ${plural(due, "due card")} in ${s.name}` : `Review today's due ${s.name} cards`, `#/review/subject/${sid}`);
        slots--;
        if (slots <= 0) break;
        if (weak.length && (d + c.weak) % 2 === 0) {
          const w = weak[c.weak++ % weak.length];
          add(day, e, "weak", `Go over your weak topic in ${s.name}: ${w.topic}`, `#/tutor?subject=${sid}`);
        } else if (notes.length) {
          const n = notes[c.note++ % notes.length];
          const hasExam = n.outputs?.exam?.questions?.length;
          add(day, e, hasExam ? "exam" : "quiz", hasExam ? `Exam questions: ${n.title}` : `Quiz: ${n.title}`, hasExam ? `#/exam/note/${encodeURIComponent(n.id)}` : `#/quiz/subject/${sid}`);
        } else {
          add(day, e, "quiz", `Fresh ${s.name} quiz`, `#/quiz/subject/${sid}`);
        }
        slots--;
      }
    }
    await DB.putMany("tasks", tasks);
    return tasks.length;
  }

  function countdown(date) {
    const left = R.daysBetween(R.dayKey(), date);
    if (left < 0) return { n: "", label: "Finished" };
    if (left === 0) return { n: "", label: "Today" };
    return { n: left, label: left === 1 ? "day" : "days" };
  }

  async function renderPlanner() {
    const [subjects, exams, tasks, prog, attempts] = await Promise.all([DB.listSubjects(), DB.all("exams"), DB.all("tasks"), SRS.getProgress(), DB.all("attempts")]);
    const byId = Object.fromEntries(subjects.map((s) => [s.id, s]));
    const today = R.dayKey();
    const upcoming = exams.filter((e) => e.date >= today && byId[e.subjectId]).sort((a, b) => a.date.localeCompare(b.date));
    const past = exams.filter((e) => e.date < today && byId[e.subjectId]);
    const lvl = SRS.level(prog.xp);
    const weak = (await SRS.weakTopics()).filter((w) => byId[w.subjectId]).slice(0, 8);
    const weekCards = SRS.weekCount(prog, "review");

    // quiz average per subject (last 10 attempts)
    const avgs = subjects
      .map((s) => {
        const a = attempts.filter((x) => x.subjectId === s.id).sort((x, y) => y.at - x.at).slice(0, 10);
        return a.length ? { s, avg: Math.round(a.reduce((t, x) => t + (x.total ? x.score / x.total : 0), 0) / a.length * 100), n: a.length } : null;
      })
      .filter(Boolean);

    const days = {};
    tasks.filter((t) => t.day >= today && byId[t.subjectId]).sort((a, b) => a.day.localeCompare(b.day) || (a.order ?? 0) - (b.order ?? 0)).forEach((t) => (days[t.day] = days[t.day] || []).push(t));
    const dayKeys = Object.keys(days).slice(0, 14);

    // last 7 days activity for the stat strip
    const week = Array.from({ length: 7 }, (_, i) => {
      const k = R.addDays(today, i - 6);
      return { k, xp: (prog.log[k] || {}).xp || 0, label: new Date(k + "T00:00").toLocaleDateString(undefined, { weekday: "narrow" }) };
    });
    const maxXp = Math.max(30, ...week.map((w) => w.xp));

    return `
      <div class="page-head"><div><span class="eyebrow">Plan</span><h1>Planner</h1></div>
        <div class="head-actions">${subjects.length ? `<button class="btn btn-primary" type="button" data-action="add-exam">${icon("plus")}Add exam</button>` : ""}</div>
      </div>

      <section class="progress-strip reveal" aria-label="Your progress">
        <div class="card stat-card level-card">
          <span class="stat-label">Level</span>
          <strong class="gold-num">${lvl.level}</strong>
          <div class="bar bar-gold" role="progressbar" aria-label="Progress to next level" aria-valuenow="${lvl.pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${lvl.pct}%"></span></div>
          <span class="stat-sub">${lvl.into} / ${lvl.needed} XP to level ${lvl.level + 1}</span>
        </div>
        <div class="card stat-card">
          <span class="stat-label">Streak</span>
          <strong class="gold-num">${prog.streak}<small> ${prog.streak === 1 ? "day" : "days"}</small></strong>
          <span class="stat-sub">Best ${prog.best || 0} · ${prog.lastDay === today ? "studied today" : "study today to keep it"}</span>
        </div>
        <div class="card stat-card">
          <span class="stat-label">Cards this week</span>
          <strong class="num">${weekCards}</strong>
          <div class="week-bars" aria-hidden="true">${week.map((w) => `<span><i style="height:${Math.round((w.xp / maxXp) * 100)}%" class="${w.k === today ? "today" : ""}"></i><b>${w.label}</b></span>`).join("")}</div>
        </div>
      </section>

      <div class="planner-grid">
        <div>
          <div class="section-head section"><h2>Exams</h2>${upcoming.length ? `<span class="count">${plural(upcoming.length, "upcoming exam")}</span>` : ""}</div>
          ${upcoming.length
            ? `<ul class="exam-list">${upcoming.map((e) => {
                const c = countdown(e.date);
                const s = byId[e.subjectId];
                return `<li class="card exam-card reveal" style="${subjectVar(s.color)}">
                  <div class="countdown"><strong>${c.n}</strong><span>${c.label}</span></div>
                  <div class="exam-info"><h3>${esc(e.name)}</h3><p><span class="dot"></span>${esc(s.name)} · ${R.prettyDay(e.date)}</p></div>
                  <div class="row-actions">
                    <button class="btn btn-quiet btn-icon" type="button" data-edit-exam="${e.id}" aria-label="Edit exam">${icon("edit")}</button>
                    <button class="btn btn-quiet btn-icon" type="button" data-delete-exam="${e.id}" aria-label="Delete exam">${icon("trash")}</button>
                  </div>
                </li>`;
              }).join("")}</ul>`
            : subjects.length
              ? emptyState({ mark: "planner", title: "No exams added", body: "Add each exam or SAC date and Reforge will build a day-by-day plan up to it.", action: `<button class="btn btn-primary" type="button" data-action="add-exam">${icon("plus")}Add your first exam</button>` })
              : emptyState({ mark: "planner", title: "Add a subject first", body: "Your plan uses your notes, flashcards and quiz results, so start in the Library.", action: `<a class="btn btn-primary" href="#/library">Go to Library</a>` })}
          ${past.length ? `<p class="hint past-note">${plural(past.length, "past exam")} hidden. <button class="link-btn" type="button" data-action="clear-past">Remove them</button></p>` : ""}

          ${upcoming.length ? `
          <div class="section-head section"><h2>Revision plan</h2>
            <button class="btn btn-small ${dayKeys.length ? "" : "btn-primary"}" type="button" data-action="make-plan">${icon(dayKeys.length ? "refresh" : "spark")}${dayKeys.length ? "Rebuild plan" : "Make my revision plan"}</button>
          </div>
          ${dayKeys.length
            ? dayKeys.map((k) => `<section class="plan-day reveal"><h3>${R.prettyDay(k)} <span class="count">${days[k].filter((t) => t.done).length}/${days[k].length}</span></h3>
                <ul class="task-list">${days[k].map((t) => `<li class="task ${t.done ? "is-done" : ""}" style="${subjectVar(byId[t.subjectId].color)}">
                  <label><input type="checkbox" data-task="${t.id}" ${t.done ? "checked" : ""} ${k > today ? "disabled" : ""}><span class="task-text">${esc(t.label)}</span></label>
                  ${t.link && !t.done && k === today ? `<a class="btn btn-small" href="${t.link}">Start</a>` : ""}
                </li>`).join("")}</ul></section>`).join("")
            : `<div class="card panel muted-panel"><p>Your plan mixes due flashcards, quizzes on each note and your weak topics, with more time for the nearest exam. You can tick tasks off as you go.</p></div>`}` : ""}
        </div>

        <aside>
          <div class="section-head section"><h2>Weak topics</h2></div>
          ${weak.length
            ? `<ul class="card weak-list">${weak.map((w) => `<li style="${subjectVar(byId[w.subjectId].color)}"><span><span class="dot"></span>${esc(w.topic)}</span><span class="count">${plural(w.misses, "miss", "misses")}</span></li>`).join("")}</ul>`
            : `<div class="card panel muted-panel"><p>Topics you get wrong in quizzes and exam practice will show up here.</p></div>`}

          <div class="section-head section"><h2>Quiz average</h2></div>
          ${avgs.length
            ? `<ul class="card avg-list">${avgs.map((a) => `<li style="${subjectVar(a.s.color)}"><span><span class="dot"></span>${esc(a.s.name)}</span><span class="avg-bar"><i style="width:${a.avg}%"></i></span><strong>${a.avg}%</strong></li>`).join("")}</ul>`
            : `<div class="card panel muted-panel"><p>Finish a quiz to see your average per subject.</p></div>`}
        </aside>
      </div>`;
  }

  renderPlanner.mount = () => {
    const addExam = async (exam) => {
      const subjects = await DB.listSubjects();
      const data = await examSheet(subjects, exam);
      if (!data) return;
      await DB.put("exams", { id: exam ? exam.id : DB.uid(), subjectId: data.get("subjectId"), name: data.get("name").trim(), date: data.get("date") });
      const hadPlan = (await DB.all("tasks")).some((t) => !t.done);
      if (hadPlan) await buildPlan();
      toast(exam ? "Exam updated" : hadPlan ? "Exam added and plan updated" : "Exam added");
      R.render();
    };
    view.querySelectorAll('[data-action="add-exam"]').forEach((b) => b.addEventListener("click", () => addExam()));

    const onClick = async (e) => {
      const edit = e.target.closest("[data-edit-exam]");
      const del = e.target.closest("[data-delete-exam]");
      if (edit) return addExam(await DB.get("exams", edit.dataset.editExam));
      if (del) {
        const exam = await DB.get("exams", del.dataset.deleteExam);
        if (!(await confirmSheet({ title: `Delete ${exam.name}?`, body: "Its tasks are removed from your plan.", action: "Delete exam" }))) return;
        await DB.del("exams", exam.id);
        for (const t of await DB.all("tasks", "examId", exam.id)) await DB.del("tasks", t.id);
        toast("Exam deleted");
        return R.render();
      }
      if (e.target.closest('[data-action="make-plan"]')) {
        const n = await buildPlan();
        toast(n ? `Plan ready: ${plural(n, "task")}` : "No upcoming exams to plan for");
        return R.render();
      }
      if (e.target.closest('[data-action="clear-past"]')) {
        const today = R.dayKey();
        for (const ex of (await DB.all("exams")).filter((x) => x.date < today)) {
          await DB.del("exams", ex.id);
          for (const t of await DB.all("tasks", "examId", ex.id)) await DB.del("tasks", t.id);
        }
        return R.render();
      }
    };

    const onChange = async (e) => {
      const box = e.target.closest("[data-task]");
      if (!box) return;
      const task = await DB.get("tasks", box.dataset.task);
      task.done = box.checked;
      if (task.done && !task.xpAwarded) {
        task.xpAwarded = true;
        await SRS.award(SRS.XP.task, "task");
        toast(`+${SRS.XP.task} XP`);
      }
      await DB.put("tasks", task);
      box.closest(".task").classList.toggle("is-done", task.done);
      box.closest(".task").querySelector(".btn")?.remove();
      const day = box.closest(".plan-day");
      const boxes = day.querySelectorAll("[data-task]");
      day.querySelector("h3 .count").textContent = `${[...boxes].filter((b) => b.checked).length}/${boxes.length}`;
    };

    // #view outlives this screen, so remove the listeners when leaving
    view.addEventListener("click", onClick);
    view.addEventListener("change", onChange);
    return () => {
      view.removeEventListener("click", onClick);
      view.removeEventListener("change", onChange);
    };
  };

  R.route(/^\/planner$/, "planner", renderPlanner);
  return { buildPlan };
})();
