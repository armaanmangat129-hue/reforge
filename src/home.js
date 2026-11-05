/* Reforge Home: player card, daily goal, quests, the next best action, weekly stats,
   subject mastery and achievements. Sections refresh in place when XP changes. */

(() => {
  const { esc, icon, plural, subjectVar, view } = R;

  function greeting() {
    const h = new Date().getHours();
    return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  }

  async function load() {
    const [ctx, prog, settings] = await Promise.all([Rewards.context(), SRS.getProgress(), Rewards.getSettings()]);
    const isNew = !ctx.notes && !prog.xp;
    const [quests, badges] = isNew ? [[], []] : await Promise.all([Rewards.quests(ctx), Rewards.achievements(ctx)]);
    return { ctx, prog, settings, isNew, quests, badges, lvl: SRS.level(prog.xp), mastery: isNew ? [] : Rewards.mastery(ctx) };
  }

  /* ---------- Sections ---------- */
  function playerCard({ prog, lvl }) {
    const hot = prog.streak >= 7;
    return `
      <div class="pc-top">
        <div>
          <p class="pc-greet">${greeting()}</p>
          <p class="pc-level"><span class="pc-lv">Lv ${lvl.level}</span><span class="pc-dot">·</span><span class="pc-title">${esc(lvl.title)}</span></p>
        </div>
        <div class="streak ${hot ? "hot" : ""} ${prog.streak ? "" : "cold"}" title="${prog.streakFrozen ? "Yesterday was covered by your streak freeze" : "Days in a row with study"}">
          <span class="streak-flame">${icon("flame")}</span>
          <span class="streak-num">${prog.streak}</span>
          <span class="streak-label">day${prog.streak === 1 ? "" : "s"}</span>
          <span class="freeze ${prog.freezeAvailable ? "ready" : "used"}" title="${prog.freezeAvailable ? "Streak freeze ready: miss one day this week without losing your streak" : "Streak freeze used this week"}" aria-label="${prog.freezeAvailable ? "Streak freeze ready" : "Streak freeze used this week"}">${icon("snow")}</span>
        </div>
      </div>
      <div class="xpbar" role="progressbar" aria-label="XP to the next level" aria-valuemin="0" aria-valuemax="${lvl.needed}" aria-valuenow="${lvl.into}">
        <span class="xpbar-fill" style="width:${lvl.pct}%"></span>
      </div>
      <div class="pc-xp"><span><strong>${lvl.into}</strong> / ${lvl.needed} XP</span><span>${lvl.needed - lvl.into} XP to Lv ${lvl.level + 1}</span></div>`;
  }

  function goalCard({ prog, settings }) {
    const xp = (prog.log[R.dayKey()] || {}).xp || 0;
    const goal = settings.dailyGoal;
    const done = !!prog.goalDone[R.dayKey()] || xp >= goal;
    const pct = Math.min(1, xp / goal);
    const C = 2 * Math.PI * 52;
    return `
      <div class="goal-ring" role="img" aria-label="Daily goal: ${Math.min(xp, goal)} of ${goal} XP${done ? ", reached" : ""}">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle class="ring-track" cx="60" cy="60" r="52"/>
          <circle class="ring-fill" cx="60" cy="60" r="52" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - pct)).toFixed(1)}" transform="rotate(-90 60 60)"/>
        </svg>
        <div class="ring-center">${done ? `<span class="ring-check">${icon("check")}</span>` : `<strong>${Math.min(xp, goal)}</strong><span>/ ${goal} XP</span>`}</div>
      </div>
      <div class="goal-text">
        <h2>Daily goal</h2>
        <p>${done ? "Reached. +10 bonus XP earned." : `${goal - xp} XP to go today.`}</p>
      </div>`;
  }

  function nextAction({ ctx, quests, isNew, prog, settings }) {
    if (isNew) return { label: "Add your first notes", href: "#/library", icon: "plus" };
    if (ctx.due) return { label: `Review ${plural(ctx.due, "due card")}`, href: "#/review/all", icon: "study" };
    const open = quests.find((q) => !q.done);
    if (open) return { label: quests.some((q) => q.done) ? "Finish today's quests" : open.label, href: open.href, icon: "target" };
    const xp = (prog.log[R.dayKey()] || {}).xp || 0;
    if (xp < settings.dailyGoal && ctx.firstSubject) return { label: "Take a fresh quiz", href: `#/quiz/subject/${ctx.firstSubject}`, icon: "target" };
    return { label: "Make reference pages", href: ctx.firstNote ? `#/note/${ctx.firstNote}` : "#/library", icon: "layers" };
  }

  function questsCard({ quests }) {
    const done = quests.filter((q) => q.done).length;
    return `
      <div class="card-head"><h2>Daily quests</h2><span class="count">${done}/${quests.length} · resets at midnight</span></div>
      <ul class="quest-list">${quests.map((q) => `
        <li class="quest ${q.done ? "is-done" : ""}" data-quest="${q.id}">
          <span class="quest-tick" aria-hidden="true">${q.done ? icon("check") : ""}</span>
          <div class="quest-body">
            <div class="quest-line"><a href="${q.href}">${esc(q.label)}</a><span class="quest-xp">+${q.xp} XP</span></div>
            <div class="mini-bar" role="progressbar" aria-label="${esc(q.label)}" aria-valuemin="0" aria-valuemax="${q.target}" aria-valuenow="${q.value}"><span style="width:${Math.round((q.value / q.target) * 100)}%"></span></div>
            <span class="quest-count">${q.done ? "Done" : `${q.value}/${q.target}`}</span>
          </div>
        </li>`).join("")}
      </ul>`;
  }

  function weekCard({ prog }) {
    const today = R.dayKey();
    const start = SRS.weekKey(today);
    const days = Array.from({ length: 7 }, (_, i) => {
      const k = R.addDays(start, i);
      return { k, xp: (prog.log[k] || {}).xp || 0, label: ["M", "T", "W", "T", "F", "S", "S"][i], future: k > today };
    });
    const max = Math.max(20, ...days.map((d) => d.xp));
    const best = days.reduce((b, d) => (d.xp > b.xp ? d : b), { xp: 0 });
    const elapsed = days.filter((d) => !d.future).length;
    const thisWeek = days.reduce((t, d) => t + d.xp, 0);
    const lastWeek = Array.from({ length: elapsed }, (_, i) => (prog.log[R.addDays(start, i - 7)] || {}).xp || 0).reduce((a, b) => a + b, 0);
    const diff = lastWeek ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : null;
    return `
      <div class="card-head"><h2>This week</h2><span class="count">${thisWeek} XP</span></div>
      <div class="week-chart" role="img" aria-label="XP per day this week. Best day ${best.xp} XP.">
        ${days.map((d) => `<span class="wk ${d.future ? "future" : ""} ${d.k === today ? "today" : ""}">
          <em>${d.xp || ""}</em>
          <i class="${best.xp && d.k === best.k ? "best" : ""}" style="height:${Math.max(d.xp ? 6 : 2, Math.round((d.xp / max) * 100))}%"></i>
          <b>${d.label}</b></span>`).join("")}
      </div>
      <p class="vs ${diff === null ? "" : diff >= 0 ? "up" : "down"}">${
        diff === null
          ? thisWeek ? "Your first week of XP. Keep it going." : "Earn XP to start this week's chart."
          : `${diff >= 0 ? "▲" : "▼"} ${Math.abs(diff)}% vs the same days last week`
      }</p>`;
  }

  function masteryCard({ mastery }) {
    if (!mastery.length) return "";
    return `
      <div class="section-head section"><h2>Subject mastery</h2><span class="count">most due first</span></div>
      <div class="mastery-grid">${mastery.map((m) => `
        <article class="card mastery reveal" style="${subjectVar(m.subject.color)}">
          <div class="m-head"><h3><span class="dot"></span>${esc(m.subject.name)}</h3><span class="m-pct">${m.pct}%</span></div>
          <div class="m-bar" role="progressbar" aria-label="${esc(m.subject.name)} mastery" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${m.pct}"><span style="width:${m.pct}%"></span></div>
          <div class="m-foot">
            <span>${m.due ? `<strong>${m.due}</strong> due today` : m.cards ? "Nothing due" : m.notes ? "No flashcards yet" : "No notes yet"}</span>
            <a class="btn btn-small ${m.due ? "btn-primary" : ""}" href="${m.due ? `#/review/subject/${m.subject.id}` : m.notes ? `#/quiz/subject/${m.subject.id}` : `#/subject/${m.subject.id}`}">${m.due || m.notes ? "Study" : "Add notes"}</a>
          </div>
        </article>`).join("")}
      </div>`;
  }

  function badgesCard({ badges }) {
    if (!badges.length) return "";
    const got = badges.filter((b) => b.unlocked).length;
    return `
      <div class="section-head section"><h2>Achievements</h2><span class="count">${got}/${badges.length} unlocked</span></div>
      <ul class="badge-grid">${badges.map((b) => `
        <li class="badge ${b.unlocked ? "unlocked" : "locked"} reveal" title="${esc(b.desc)}">
          <span class="badge-medal">${icon(b.icon)}</span>
          <strong>${esc(b.name)}</strong>
          ${b.unlocked
            ? `<span class="badge-sub">+${b.xp} XP</span>`
            : `<span class="badge-sub">${esc(b.desc)}</span><span class="mini-bar" role="progressbar" aria-label="${esc(b.name)} progress" aria-valuemin="0" aria-valuemax="${b.target}" aria-valuenow="${b.value}"><span style="width:${Math.round((b.value / b.target) * 100)}%"></span></span><span class="badge-count">${b.value}/${b.target}</span>`}
        </li>`).join("")}
      </ul>`;
  }

  /* ---------- Screen ---------- */
  async function renderHome() {
    const d = await load();
    const action = nextAction(d);
    if (d.isNew) {
      return `
        <h1 class="visually-hidden">Home</h1>
        <section class="player-card" id="player">${playerCard(d)}</section>
        <section class="card welcome reveal">
          <h2>Welcome to Reforge</h2>
          <p>Paste or upload your class notes and Reforge turns them into flashcards, quizzes and a reference book. Every session earns XP.</p>
          <a class="btn btn-gold btn-big" href="${action.href}">${icon(action.icon)}${esc(action.label)}</a>
        </section>`;
    }
    return `
      <h1 class="visually-hidden">Home</h1>
      <div class="home-top">
        <section class="player-card" id="player">${playerCard(d)}</section>
        <section class="card goal-card ${d.prog.goalDone[R.dayKey()] ? "is-done" : ""}" id="goal">${goalCard(d)}</section>
      </div>
      <a class="btn btn-gold btn-big next-action" id="next-action" href="${action.href}">${icon(action.icon)}<span>${esc(action.label)}</span>${icon("arrow")}</a>
      <div class="home-grid">
        <section class="card home-card reveal" id="quests">${questsCard(d)}</section>
        <section class="card home-card reveal" id="week">${weekCard(d)}</section>
      </div>
      <div id="mastery">${masteryCard(d)}</div>
      <div id="badges">${badgesCard(d)}</div>`;
  }

  renderHome.mount = async () => {
    const player = view.querySelector("#player");
    if (!player) return;

    // XP bar fills up from where you last saw it
    const fill = player.querySelector(".xpbar-fill");
    const seen = await DB.getMeta("homeSeen", null);
    const prog = await SRS.getProgress();
    const lvl = SRS.level(prog.xp);
    if (seen && seen.xp < prog.xp && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const from = SRS.level(seen.xp);
      fill.style.transition = "none";
      fill.style.width = `${from.level === lvl.level ? from.pct : 0}%`;
      fill.getBoundingClientRect();
      fill.style.transition = "";
      requestAnimationFrame(() => (fill.style.width = `${lvl.pct}%`));
    }
    await DB.setMeta("homeSeen", { xp: prog.xp });

    // Refresh sections in place when XP changes, so bars animate rather than re-render
    let pending = null, justQuest = null;
    const refresh = async () => {
      const d = await load();
      if (!view.querySelector("#player")) return;
      if (d.isNew !== !view.querySelector("#goal")) return R.render(); // switched between new-user and full view
      player.innerHTML = playerCard(d).replace(/style="width:[\d.]+%"/, `style="width:${fill.style.width || "0%"}"`);
      const newFill = player.querySelector(".xpbar-fill");
      newFill.getBoundingClientRect();
      requestAnimationFrame(() => (newFill.style.width = `${d.lvl.pct}%`));
      const goal = view.querySelector("#goal");
      if (goal) {
        const wasDone = goal.classList.contains("just-done");
        goal.innerHTML = goalCard(d);
        goal.classList.toggle("is-done", !!d.prog.goalDone[R.dayKey()]);
        if (wasDone) setTimeout(() => goal.classList.remove("just-done"), 900);
      }
      const act = nextAction(d);
      const btn = view.querySelector("#next-action");
      if (btn) { btn.href = act.href; btn.querySelector("span").textContent = act.label; }
      const q = view.querySelector("#quests");
      if (q) q.innerHTML = questsCard(d);
      if (justQuest) view.querySelector(`[data-quest="${justQuest}"]`)?.classList.add("just-done");
      justQuest = null;
      const w = view.querySelector("#week");
      if (w) w.innerHTML = weekCard(d);
      const m = view.querySelector("#mastery");
      if (m) { m.innerHTML = masteryCard(d); m.querySelectorAll(".reveal").forEach((el) => el.classList.add("is-visible")); }
      const b = view.querySelector("#badges");
      if (b) { b.innerHTML = badgesCard(d); b.querySelectorAll(".reveal").forEach((el) => el.classList.add("is-visible")); }
      await DB.setMeta("homeSeen", { xp: d.prog.xp });
    };
    const onProgress = () => { clearTimeout(pending); pending = setTimeout(refresh, 120); };
    const onQuest = (e) => { justQuest = e.detail.id; };
    window.addEventListener("reforge:progress", onProgress);
    window.addEventListener("reforge:quest", onQuest);
    Rewards.check();
    return () => {
      window.removeEventListener("reforge:progress", onProgress);
      window.removeEventListener("reforge:quest", onQuest);
    };
  };

  R.route(/^\/home$/, "home", renderHome);
})();
