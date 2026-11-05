/* Reforge rewards: daily goal, daily quests, achievements, subject mastery, and the
   moments that make progress feel good (floating +XP, confetti, level-up and badge
   overlays, optional sounds). Everything reads and writes the one progress record in
   srs.js; this file only adds rules on top of it. */

const Rewards = (() => {
  const { esc, icon, plural, toast } = R;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Settings (IndexedDB) ---------- */
  const DEFAULTS = { dailyGoal: 50, sounds: false };
  let settings = { ...DEFAULTS };
  const settingsReady = DB.getMeta("settings", {}).then((s) => (settings = { ...DEFAULTS, ...s })).catch(() => settings);
  async function getSettings() { await settingsReady; return settings; }
  async function setSettings(patch) {
    await settingsReady;
    settings = { ...settings, ...patch };
    await DB.setMeta("settings", settings);
    window.dispatchEvent(new CustomEvent("reforge:progress", { detail: { gained: 0, kind: "settings" } }));
  }

  /* ---------- Sounds (off by default; tiny synthesized tones, no files) ---------- */
  let audio;
  function tone(notes, { type = "sine", gain = 0.06, step = 0.09, length = 0.16 } = {}) {
    if (!settings.sounds) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audio.currentTime + 0.01;
      notes.forEach((f, i) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = type;
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t0 + i * step);
        g.gain.linearRampToValueAtTime(gain, t0 + i * step + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * step + length);
        o.connect(g).connect(audio.destination);
        o.start(t0 + i * step);
        o.stop(t0 + i * step + length + 0.02);
      });
    } catch { /* audio blocked: stay silent */ }
  }
  const sound = {
    click: () => tone([880], { type: "triangle", gain: 0.04, length: 0.07 }),
    reward: () => tone([660, 990], { type: "triangle", gain: 0.05, step: 0.07 }),
    levelUp: () => tone([523.25, 659.25, 783.99, 1046.5], { gain: 0.06, step: 0.1, length: 0.35 }),
  };

  /* ---------- Daily quests ---------- */
  const QUESTS = {
    review20: { label: "Review 20 flashcards", target: 20, xp: 30, metric: (d) => d.review || 0, eligible: (c) => c.cards > 0, href: () => "#/review/all" },
    quiz80: { label: "Finish a quiz with 80% or more", target: 1, xp: 40, metric: (d) => d.quiz80 || 0, eligible: (c) => c.notes > 0, href: (c) => (c.firstSubject ? `#/quiz/subject/${c.firstSubject}` : "#/study") },
    addNotes: { label: "Add new notes", target: 1, xp: 25, metric: (d) => d.notes || 0, eligible: () => true, href: (c) => (c.firstSubject ? `#/subject/${c.firstSubject}` : "#/library") },
    pages3: { label: "Make 3 reference pages", target: 3, xp: 35, metric: (d) => d.pages || 0, eligible: (c) => c.notes > 0, href: (c) => (c.firstNote ? `#/note/${c.firstNote}` : "#/library") },
    tutor3: { label: "Ask the tutor 3 questions", target: 3, xp: 20, metric: (d) => d.tutor || 0, eligible: (c) => c.notes > 0, href: () => "#/tutor" },
    clearDue: { label: "Clear all due cards", target: null, xp: 40, metric: null, eligible: (c) => c.due > 0, href: () => "#/review/all" },
  };

  // same picks all day; different tomorrow
  function seeded(seedStr) {
    let h = 2166136261;
    for (const ch of seedStr) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
  }

  async function context() {
    const [notes, cards, subjects, attempts, pages] = await Promise.all([DB.listNotes(), DB.all("cards"), DB.listSubjects(), DB.all("attempts"), DB.all("pages")]);
    const end = R.endOfToday();
    return {
      notes: notes.length, cards: cards.length, due: cards.filter((c) => c.due <= end).length,
      firstSubject: subjects[0]?.id, firstNote: notes[0]?.id,
      subjects, notesList: notes, cardsList: cards, attempts, pages,
    };
  }

  /* Today's 3 quests with progress. Picks them on first look each day. */
  async function quests(ctx) {
    ctx = ctx || (await context());
    const today = R.dayKey();
    let state = (await SRS.getProgress()).quests[today];
    if (!state) {
      state = await SRS.update((prog) => {
        if (prog.quests[today]) return prog.quests[today];
        const rnd = seeded(today);
        const pool = Object.keys(QUESTS).filter((id) => QUESTS[id].eligible(ctx));
        // new users always get "Add new notes" first
        const picks = ctx.notes ? [] : ["addNotes"];
        const rest = pool.filter((id) => !picks.includes(id)).map((id) => [rnd(), id]).sort((a, b) => a[0] - b[0]).map(([, id]) => id);
        const ids = [...picks, ...rest].slice(0, 3);
        return (prog.quests[today] = { ids, dueAtStart: ctx.due, done: {} });
      });
    }
    const day = (await SRS.getProgress()).log[today] || {};
    return state.ids.map((id) => {
      const q = QUESTS[id];
      const target = id === "clearDue" ? Math.max(1, state.dueAtStart) : q.target;
      const value = id === "clearDue" ? Math.max(0, state.dueAtStart - ctx.due) : q.metric(day);
      return { id, label: q.label, target, value: Math.min(value, target), xp: q.xp, done: !!state.done[id], href: q.href(ctx) };
    });
  }

  /* ---------- Achievements ---------- */
  const BADGES = [
    { id: "firstNotes", name: "First Notes", desc: "Add your first notes", icon: "note", xp: 50, value: (c) => c.notes, target: 1 },
    { id: "streak7", name: "7-Day Streak", desc: "Study 7 days in a row", icon: "flame", xp: 100, value: (c, p) => p.best || 0, target: 7 },
    { id: "streak30", name: "30-Day Streak", desc: "Study 30 days in a row", icon: "flame", xp: 300, value: (c, p) => p.best || 0, target: 30 },
    { id: "cards100", name: "100 Cards", desc: "Review 100 flashcards", icon: "study", xp: 100, value: (c, p) => p.totals.review || 0, target: 100 },
    { id: "perfectQuiz", name: "Perfect Quiz", desc: "Get every question right", icon: "target", xp: 75, value: (c, p) => (p.flags.perfectQuiz || c.attempts.some((a) => a.kind === "quiz" && a.total && a.score === a.total) ? 1 : 0), target: 1 },
    { id: "nightOwl", name: "Night Owl", desc: "Study after 10pm", icon: "moon", xp: 50, value: (c, p) => (p.flags.nightOwl ? 1 : 0), target: 1 },
    { id: "earlyBird", name: "Early Bird", desc: "Study before 7am", icon: "sun", xp: 50, value: (c, p) => (p.flags.earlyBird ? 1 : 0), target: 1 },
    { id: "refBook", name: "Reference Book", desc: "10 pages in one subject's book", icon: "layers", xp: 150, value: (c) => {
      const per = {};
      c.pages.forEach((pg) => ((per[pg.subjectId] = per[pg.subjectId] || new Set()).add(pg.group)));
      return Math.max(0, ...Object.values(per).map((s) => s.size));
    }, target: 10 },
  ];

  async function achievements(ctx) {
    ctx = ctx || (await context());
    const prog = await SRS.getProgress();
    return BADGES.map((b) => {
      const value = Math.min(b.value(ctx, prog), b.target);
      return { ...b, value, unlocked: !!prog.badges[b.id], at: prog.badges[b.id] };
    });
  }

  /* ---------- Subject mastery ---------- */
  function mastery(ctx) {
    const end = R.endOfToday();
    return ctx.subjects
      .map((s) => {
        const cards = ctx.cardsList.filter((c) => c.subjectId === s.id);
        const cardScore = cards.length
          ? cards.reduce((t, c) => t + (c.reps ? Math.min(1, c.interval / 21) * 0.75 + Math.max(0, Math.min(1, (c.ef - 1.3) / 1.2)) * 0.25 : 0), 0) / cards.length
          : null;
        const att = ctx.attempts.filter((a) => a.subjectId === s.id && a.total).sort((a, b) => b.at - a.at).slice(0, 10);
        const quizScore = att.length ? att.reduce((t, a) => t + a.score / a.total, 0) / att.length : null;
        const pct = cardScore === null && quizScore === null ? 0
          : cardScore === null ? quizScore : quizScore === null ? cardScore : cardScore * 0.6 + quizScore * 0.4;
        return {
          subject: s, pct: Math.round(pct * 100),
          due: cards.filter((c) => c.due <= end).length, cards: cards.length,
          notes: ctx.notesList.filter((n) => n.subjectId === s.id).length,
        };
      })
      .sort((a, b) => b.due - a.due || b.pct - a.pct);
  }

  /* ---------- Checking for rewards after any progress ---------- */
  let checking = Promise.resolve();
  function check() {
    checking = checking.then(runCheck).catch((err) => console.warn("Reforge: reward check failed", err));
    return checking;
  }

  async function runCheck() {
    const ctx = await context();
    const prog = await SRS.getProgress();
    const today = R.dayKey();
    const { dailyGoal } = await getSettings();

    // daily goal (counts XP before the goal bonus itself)
    const todayXp = (prog.log[today] || {}).xp || 0;
    if (todayXp >= dailyGoal && !prog.goalDone[today]) {
      const first = await SRS.update((p) => (p.goalDone[today] ? false : (p.goalDone[today] = true)));
      if (first) {
        celebrateGoal();
        await SRS.award(10, "bonus", 1, { reason: "Daily goal" });
      }
    }

    // quests
    for (const q of await quests(ctx)) {
      if (q.done || q.value < q.target) continue;
      const first = await SRS.update((p) => {
        const st = p.quests[today];
        if (!st || st.done[q.id]) return false;
        return (st.done[q.id] = true);
      });
      if (first) {
        sound.reward();
        toast(`Quest complete: ${q.label}`);
        window.dispatchEvent(new CustomEvent("reforge:quest", { detail: q }));
        await SRS.award(q.xp, "quest", 1, { reason: q.label });
      }
    }

    // achievements
    for (const b of await achievements(ctx)) {
      if (b.unlocked || b.value < b.target) continue;
      await unlock(b.id);
    }
  }

  async function unlock(id) {
    const b = BADGES.find((x) => x.id === id);
    if (!b) return;
    const first = await SRS.update((p) => (p.badges[id] ? false : (p.badges[id] = Date.now())));
    if (!first) return;
    showBadge(b);
    await SRS.award(b.xp, "badge", 1, { reason: b.name });
  }

  /* ---------- Moments ---------- */
  let lastPointer = { x: 0, y: 0, t: 0 };
  document.addEventListener("pointerdown", (e) => (lastPointer = { x: e.clientX, y: e.clientY, t: Date.now() }), true);

  function floatXP(amount) {
    if (!amount) return;
    const el = document.createElement("div");
    el.className = "xp-float";
    el.textContent = `+${amount} XP`;
    el.setAttribute("aria-hidden", "true");
    const recent = Date.now() - lastPointer.t < 4000;
    const x = recent ? lastPointer.x : innerWidth - 90;
    const y = recent ? lastPointer.y - 12 : 72;
    el.style.left = `${Math.max(40, Math.min(innerWidth - 40, x))}px`;
    el.style.top = `${Math.max(24, y)}px`;
    document.body.appendChild(el);
    el.addEventListener("animationend", () => el.remove());
    setTimeout(() => el.remove(), 1600);
  }

  function confetti(x, y) {
    if (reduced()) return;
    const layer = document.createElement("div");
    layer.className = "confetti";
    layer.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 36; i++) {
      const p = document.createElement("i");
      const a = (Math.PI * 2 * i) / 36 + Math.random() * 0.3;
      const d = 60 + Math.random() * 90;
      p.style.left = `${x}px`;
      p.style.top = `${y}px`;
      p.style.setProperty("--dx", `${Math.cos(a) * d}px`);
      p.style.setProperty("--dy", `${Math.sin(a) * d - 30}px`);
      p.style.setProperty("--r", `${Math.random() * 540 - 270}deg`);
      p.className = ["c-gold", "c-ivory", "c-navy"][i % 3];
      layer.appendChild(p);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 950);
  }

  function celebrateGoal() {
    sound.reward();
    const ring = document.querySelector(".goal-ring");
    if (ring) {
      const r = ring.getBoundingClientRect();
      confetti(r.left + r.width / 2, r.top + r.height / 2);
      ring.closest(".goal-card")?.classList.add("is-done", "just-done");
    } else {
      toast("Daily goal reached: +10 bonus XP");
    }
  }

  /* Full-screen moments share one overlay, queued so they never stack. */
  let overlayChain = Promise.resolve();
  function overlay(build) {
    overlayChain = overlayChain.then(
      () =>
        new Promise((resolve) => {
          const el = document.createElement("div");
          el.className = "moment";
          el.setAttribute("role", "dialog");
          el.setAttribute("aria-modal", "true");
          el.innerHTML = build();
          document.body.appendChild(el);
          const btn = el.querySelector("[data-continue]");
          const prevFocus = document.activeElement;
          const close = () => {
            el.classList.add("leaving");
            document.removeEventListener("keydown", onKey, true);
            setTimeout(() => { el.remove(); prevFocus?.focus?.(); resolve(); }, reduced() ? 0 : 180);
          };
          const onKey = (e) => {
            if (e.key === "Escape" || e.key === "Enter" || e.key === " ") { e.preventDefault(); close(); }
            if (e.key === "Tab") { e.preventDefault(); btn.focus(); }
          };
          el.addEventListener("click", (e) => { if (e.target === el || e.target.closest("[data-continue]")) close(); });
          document.addEventListener("keydown", onKey, true);
          requestAnimationFrame(() => el.classList.add("in"));
          btn.focus({ preventScroll: true });
          el._afterOpen?.();
          if (typeof build.after === "function") build.after(el);
        })
    );
    return overlayChain;
  }

  function showLevelUp(before, after) {
    sound.levelUp();
    const newTitle = after.title !== before.title;
    const build = () => `
      <div class="moment-card level-card-up" aria-labelledby="moment-title">
        <div class="moment-glow" aria-hidden="true"></div>
        <span class="moment-eyebrow">Level up</span>
        <div class="moment-level" id="moment-title"><span class="ml-lv">Lv</span> <span class="ml-num" data-from="${before.level}" data-to="${after.level}">${reduced() ? after.level : before.level}</span></div>
        <p class="moment-title-line">${newTitle ? `New title: <strong>${esc(after.title)}</strong>` : esc(after.title)}</p>
        <button class="btn btn-gold moment-btn" type="button" data-continue>Continue</button>
      </div>`;
    build.after = (el) => {
      const num = el.querySelector(".ml-num");
      const from = before.level, to = after.level;
      if (reduced() || from === to) { num.textContent = to; return; }
      const start = performance.now(), dur = 700;
      const step = (t) => {
        const k = Math.min(1, (t - start) / dur);
        num.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
        if (k < 1) requestAnimationFrame(step);
        else num.classList.add("landed");
      };
      requestAnimationFrame(step);
    };
    return overlay(build);
  }

  function showBadge(b) {
    sound.reward();
    const build = () => `
      <div class="moment-card badge-card-up" aria-labelledby="moment-title">
        <div class="moment-glow" aria-hidden="true"></div>
        <span class="moment-eyebrow">Achievement unlocked</span>
        <div class="badge-medal big">${icon(b.icon)}</div>
        <h2 class="moment-badge-name" id="moment-title">${esc(b.name)}</h2>
        <p class="moment-title-line">${esc(b.desc)} · <strong>+${b.xp} XP</strong></p>
        <button class="btn btn-gold moment-btn" type="button" data-continue>Continue</button>
      </div>`;
    return overlay(build);
  }

  // React to every XP change anywhere in the app
  window.addEventListener("reforge:progress", (e) => {
    const d = e.detail || {};
    if (d.gained > 0) floatXP(d.gained);
    if (d.after && d.before && d.after.level > d.before.level) showLevelUp(d.before, d.after);
    if (d.usedFreeze) toast("Streak freeze used: your streak is safe");
    if (d.kind !== "settings") check();
  });

  /* ---------- Dev panel: Shift+D ---------- */
  function devPanel() {
    let panel = document.querySelector(".dev-panel");
    if (panel) { panel.remove(); return; }
    panel = document.createElement("div");
    panel.className = "dev-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Developer panel");
    panel.innerHTML = `
      <div class="dev-head"><strong>Dev panel</strong><button class="btn btn-quiet btn-icon btn-small" type="button" data-dev="close" aria-label="Close dev panel">${icon("x")}</button></div>
      <div class="dev-row"><button class="btn btn-small" data-dev="xp" data-n="10">+10 XP</button><button class="btn btn-small" data-dev="xp" data-n="50">+50 XP</button><button class="btn btn-small" data-dev="xp" data-n="250">+250 XP</button></div>
      <div class="dev-row"><button class="btn btn-small" data-dev="level">Level up now</button><button class="btn btn-small" data-dev="goal">Fill daily goal</button></div>
      <div class="dev-row"><select class="select dev-select" aria-label="Badge to unlock">${BADGES.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("")}</select><button class="btn btn-small" data-dev="badge">Unlock</button></div>
      <div class="dev-row"><button class="btn btn-small" data-dev="quests">New quests today</button><button class="btn btn-small" data-dev="reset">Reset progress</button></div>
      <p class="hint">Shift+D to hide</p>`;
    document.body.appendChild(panel);
    panel.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-dev]");
      if (!b) return;
      const act = b.dataset.dev;
      if (act === "close") return panel.remove();
      if (act === "xp") await SRS.award(Number(b.dataset.n), "dev");
      if (act === "level") {
        const lv = SRS.level((await SRS.getProgress()).xp);
        await SRS.award(lv.needed - lv.into, "dev");
      }
      if (act === "goal") {
        const p = await SRS.getProgress();
        const need = Math.max(1, (await getSettings()).dailyGoal - ((p.log[R.dayKey()] || {}).xp || 0));
        await SRS.award(need, "dev");
      }
      if (act === "badge") {
        const id = panel.querySelector(".dev-select").value;
        await SRS.update((p) => { delete p.badges[id]; });
        await unlock(id);
      }
      if (act === "quests") {
        await SRS.update((p) => { delete p.quests[R.dayKey()]; });
        R.render();
      }
      if (act === "reset") {
        if (!confirm("Reset XP, streak, quests and badges? Your notes and cards stay.")) return;
        await DB.setMeta("progress", null);
        R.render();
        window.dispatchEvent(new CustomEvent("reforge:progress", { detail: { gained: 0, kind: "settings" } }));
      }
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.shiftKey && (e.key === "D" || e.key === "d") && !e.target.closest?.("input, textarea, select, [contenteditable]")) {
      e.preventDefault();
      devPanel();
    }
  });

  return { getSettings, setSettings, quests, achievements, mastery, context, check, unlock, confetti, sound, BADGES, QUESTS };
})();
