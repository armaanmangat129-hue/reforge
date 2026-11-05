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

  /* ---------- Progress: XP, level, streak ---------- */

  const XP = { review: 2, reviewGood: 3, quiz: 20, quizCorrect: 2, exam: 10, task: 15 };

  const defaultProgress = () => ({ xp: 0, streak: 0, best: 0, lastDay: null, log: {} });

  async function getProgress() {
    const p = await DB.getMeta("progress", null);
    const prog = p || defaultProgress();
    // A streak only counts if you studied today or yesterday.
    const today = R.dayKey();
    if (prog.lastDay && prog.lastDay !== today && prog.lastDay !== R.addDays(today, -1)) prog.streak = 0;
    return prog;
  }

  function level(xp) {
    // Level n needs 50·n·(n-1) XP in total: 0, 100, 300, 600, 1000…
    let n = 1;
    while (50 * (n + 1) * n <= xp) n++;
    const floor = 50 * n * (n - 1), ceil = 50 * (n + 1) * n;
    return { level: n, into: xp - floor, needed: ceil - floor, pct: Math.round(((xp - floor) / (ceil - floor)) * 100) };
  }

  /* kind: "review" | "quiz" | "exam" | "task". Logs the activity and updates the streak. */
  async function award(amount, kind, count = 1) {
    const prog = await getProgress();
    const today = R.dayKey();
    if (prog.lastDay !== today) {
      prog.streak = prog.lastDay === R.addDays(today, -1) ? prog.streak + 1 : 1;
      prog.lastDay = today;
    }
    prog.best = Math.max(prog.best || 0, prog.streak);
    const before = level(prog.xp).level;
    prog.xp += amount;
    const day = (prog.log[today] = prog.log[today] || { review: 0, quiz: 0, exam: 0, task: 0, xp: 0 });
    day[kind] = (day[kind] || 0) + count;
    day.xp += amount;
    // keep ~120 days of history
    const keys = Object.keys(prog.log).sort();
    while (keys.length > 120) delete prog.log[keys.shift()];
    await DB.setMeta("progress", prog);
    const after = level(prog.xp).level;
    if (after > before) R.toast(`Level ${after} reached`);
    window.dispatchEvent(new CustomEvent("reforge:progress"));
    return prog;
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

  return { RATINGS, XP, newCard, schedule, previewInterval, dueCards, dueCountsBySubject, getProgress, level, award, weekCount, weakTopics };
})();
