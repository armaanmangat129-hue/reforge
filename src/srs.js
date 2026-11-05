/* Reforge study engine: SM-2 spaced repetition, XP, levels and streaks. */

const SRS = (() => {
  const DAY = 86400000;
  const RATINGS = [
    { id: "again", label: "Again", q: 1, key: "1" },
    { id: "hard", label: "Hard", q: 3, key: "2" },
    { id: "good", label: "Good", q: 4, key: "3" },
    { id: "easy", label: "Easy", q: 5, key: "4" },
  ];

  function newCard({ subjectId, noteId, front, back, source = "ai" }) {
    return { id: DB.uid(), subjectId, noteId, front, back, source, ef: 2.5, interval: 0, reps: 0, due: Date.now(), createdAt: Date.now() };
  }

  /* SM-2. q is 0-5. Returns the updated card (does not save it). */
  function schedule(card, q) {
    let { ef = 2.5, interval = 0, reps = 0 } = card;
    if (q < 3) {
      reps = 0;
      interval = 0; // seen again this session, then tomorrow
    } else {
      reps += 1;
      if (reps === 1) interval = 1;
      else if (reps === 2) interval = 6;
      else interval = Math.round(interval * ef);
      if (q === 3) interval = Math.max(1, Math.round(interval * 0.8));
      if (q === 5) interval = Math.max(interval + 2, Math.round(interval * 1.3));
    }
    ef = Math.max(1.3, ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    const due = q < 3 ? startOfToday + DAY : startOfToday + interval * DAY;
    return { ...card, ef: +ef.toFixed(3), interval, reps, due, lastReviewed: Date.now() };
  }

  function previewInterval(card, q) {
    const next = schedule(card, q);
    if (q < 3) return "again";
    return next.interval === 1 ? "1 day" : next.interval < 30 ? `${next.interval} days` : `${Math.round(next.interval / 30)} mo`;
  }

  async function dueCards(subjectId) {
    const cards = subjectId ? await DB.all("cards", "subjectId", subjectId) : await DB.all("cards");
    const end = R.endOfToday();
    return cards.filter((c) => c.due <= end);
  }

  async function dueCountsBySubject() {
    const end = R.endOfToday();
    return (await DB.all("cards")).reduce((acc, c) => {
      if (c.due <= end) acc[c.subjectId] = (acc[c.subjectId] || 0) + 1;
      return acc;
    }, {});
  }

  /* ---------- Progress: XP, levels, titles, streak (with weekly freeze) ---------- */

  const XP = { review: 2, reviewGood: 3, quiz: 20, quizCorrect: 2, exam: 10, task: 15 };
  const TITLES = ["Rookie", "Learner", "Scholar", "Scholar II", "Master", "Grandmaster", "Legend"];

  const defaultProgress = () => ({
    xp: 0, streak: 0, best: 0, lastDay: null, log: {},
    totals: {}, flags: {}, badges: {}, goalDone: {}, quests: {}, freezeUsed: [],
  });

  // Monday of the week a day falls in, as YYYY-MM-DD
  function weekKey(key) {
    const [y, m, d] = key.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return R.addDays(key, -((dt.getDay() + 6) % 7));
  }

  function normalize(p) {
    const prog = { ...defaultProgress(), ...p };
    // older saves: build lifetime totals from the daily log once
    if (!p || !p.totals) {
      prog.totals = {};
      Object.values(prog.log || {}).forEach((d) => Object.entries(d).forEach(([k, v]) => { if (k !== "xp") prog.totals[k] = (prog.totals[k] || 0) + v; }));
    }
    return prog;
  }

  /* Streak state for today without changing anything. */
  function streakState(prog) {
    const today = R.dayKey();
    const yesterday = R.addDays(today, -1);
    const freezeAvailable = !prog.freezeUsed.includes(weekKey(today));
    if (!prog.lastDay) return { streak: 0, alive: false, frozen: false, freezeAvailable };
    if (prog.lastDay === today || prog.lastDay === yesterday) return { streak: prog.streak, alive: true, frozen: false, freezeAvailable };
    // missed exactly one day: a freeze for that day's week keeps the streak
    const missed = yesterday;
    if (prog.lastDay === R.addDays(today, -2) && !prog.freezeUsed.includes(weekKey(missed))) {
      return { streak: prog.streak, alive: true, frozen: true, freezeAvailable: weekKey(missed) === weekKey(today) ? false : freezeAvailable };
    }
    return { streak: 0, alive: false, frozen: false, freezeAvailable };
  }

  async function getProgress() {
    const prog = normalize(await DB.getMeta("progress", null));
    const st = streakState(prog);
    prog.streak = st.streak;
    prog.streakFrozen = st.frozen;
    prog.freezeAvailable = st.freezeAvailable;
    return prog;
  }

  /* XP needed to go from level n to n+1: 100, then 20% more each level. */
  const needFor = (n) => Math.round(100 * Math.pow(1.2, n - 1));

  function level(xp) {
    let n = 1, floor = 0;
    while (xp >= floor + needFor(n)) { floor += needFor(n); n++; }
    const needed = needFor(n);
    return { level: n, into: xp - floor, needed, pct: Math.round(((xp - floor) / needed) * 100), title: titleFor(n) };
  }
  const titleFor = (n) => TITLES[Math.min(TITLES.length - 1, Math.floor((n - 1) / 5))];

  // Saves run one after another so quick XP gains never overwrite each other
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));

  function touchDay(prog) {
    const today = R.dayKey();
    if (prog.lastDay !== today) {
      const yesterday = R.addDays(today, -1);
      if (prog.lastDay === yesterday) prog.streak += 1;
      else if (prog.lastDay === R.addDays(today, -2) && !prog.freezeUsed.includes(weekKey(yesterday))) {
        prog.freezeUsed = [...prog.freezeUsed, weekKey(yesterday)].slice(-12);
        prog.streak += 1;
        prog.justUsedFreeze = true;
      } else prog.streak = 1;
      prog.lastDay = today;
    }
    prog.best = Math.max(prog.best || 0, prog.streak);
    const hour = new Date().getHours();
    if (hour >= 22) prog.flags.nightOwl = true;
    if (hour < 7) prog.flags.earlyBird = true;
    return (prog.log[today] = prog.log[today] || { review: 0, quiz: 0, exam: 0, task: 0, xp: 0 });
  }

  function trim(prog) {
    const keys = Object.keys(prog.log).sort();
    while (keys.length > 120) delete prog.log[keys.shift()];
    Object.keys(prog.goalDone).filter((k) => k < R.addDays(R.dayKey(), -14)).forEach((k) => delete prog.goalDone[k]);
    Object.keys(prog.quests).filter((k) => k < R.addDays(R.dayKey(), -14)).forEach((k) => delete prog.quests[k]);
  }

  /* Adds XP and logs the activity. kind: review | quiz | exam | task | bonus | quest | badge … */
  function award(amount, kind, count = 1, detail = {}) {
    return serial(async () => {
      const prog = normalize(await DB.getMeta("progress", null));
      const day = touchDay(prog);
      const before = level(prog.xp);
      prog.xp += amount;
      day[kind] = (day[kind] || 0) + count;
      day.xp += amount;
      prog.totals[kind] = (prog.totals[kind] || 0) + count;
      const usedFreeze = prog.justUsedFreeze;
      delete prog.justUsedFreeze;
      trim(prog);
      await DB.setMeta("progress", prog);
      const after = level(prog.xp);
      window.dispatchEvent(new CustomEvent("reforge:progress", { detail: { gained: amount, kind, before, after, usedFreeze, ...detail } }));
      return prog;
    });
  }

  /* Logs an activity that doesn't give XP by itself (notes added, pages made, tutor questions…). */
  function track(kind, count = 1, flags = {}) {
    return serial(async () => {
      const prog = normalize(await DB.getMeta("progress", null));
      const day = touchDay(prog);
      day[kind] = (day[kind] || 0) + count;
      prog.totals[kind] = (prog.totals[kind] || 0) + count;
      Object.assign(prog.flags, flags);
      trim(prog);
      await DB.setMeta("progress", prog);
      window.dispatchEvent(new CustomEvent("reforge:progress", { detail: { gained: 0, kind } }));
      return prog;
    });
  }

  /* Read-modify-write on the progress record (rewards bookkeeping). */
  function update(fn) {
    return serial(async () => {
      const prog = normalize(await DB.getMeta("progress", null));
      const out = await fn(prog);
      await DB.setMeta("progress", prog);
      return out;
    });
  }

  function weekCount(prog, kind) {
    let total = 0;
    for (let i = 0; i < 7; i++) total += (prog.log[R.addDays(R.dayKey(), -i)] || {})[kind] || 0;
    return total;
  }

  /* Topics you got wrong recently, most frequent first. */
  async function weakTopics(subjectId) {
    const attempts = subjectId ? await DB.all("attempts", "subjectId", subjectId) : await DB.all("attempts");
    const since = Date.now() - 45 * DAY;
    const tally = {};
    attempts
      .filter((a) => a.at >= since)
      .forEach((a) =>
        (a.wrong || []).forEach((w) => {
          const topic = (w.topic || "").trim();
          if (!topic) return;
          const k = a.subjectId + "|" + topic.toLowerCase();
          tally[k] = tally[k] || { subjectId: a.subjectId, topic, misses: 0, last: 0 };
          tally[k].misses += 1;
          tally[k].last = Math.max(tally[k].last, a.at);
        })
      );
    return Object.values(tally).sort((a, b) => b.misses - a.misses || b.last - a.last);
  }

  return { RATINGS, XP, TITLES, newCard, schedule, previewInterval, dueCards, dueCountsBySubject, getProgress, level, titleFor, needFor, weekKey, award, track, update, weekCount, weakTopics };
})();
