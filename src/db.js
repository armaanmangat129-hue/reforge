/* Reforge storage: IndexedDB wrapper.
   subjects { id, name, color, isMaths, createdAt }
   notes    { id, subjectId, title, rawText, outputs, status, createdAt, updatedAt }
   cards    { id, subjectId, noteId, front, back, source, ef, interval, reps, due, createdAt }
   attempts { id, subjectId, noteId, kind, score, total, wrong[], at }
   chats    { subjectId, messages[] }
   exams    { id, subjectId, name, date }
   tasks    { id, examId, subjectId, day, kind, label, link, done }
   meta     { key, value }   (progress, settings)
   cache    { key, value, at } (AI responses) */

const DB = (() => {
  const NAME = "reforge";
  const VERSION = 2;
  let dbPromise;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const make = (name, keyPath, indexes = []) => {
          if (db.objectStoreNames.contains(name)) return;
          const s = db.createObjectStore(name, { keyPath });
          indexes.forEach((i) => s.createIndex(i, i));
        };
        make("subjects", "id");
        make("notes", "id", ["subjectId"]);
        make("cards", "id", ["subjectId", "noteId"]);
        make("attempts", "id", ["subjectId"]);
        make("chats", "subjectId");
        make("exams", "id", ["subjectId"]);
        make("tasks", "id", ["examId"]);
        make("meta", "key");
        make("cache", "key");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function store(name, mode = "readonly") {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  /* Generic helpers */
  async function all(name, index, value) {
    const s = await store(name);
    return wrap(index ? s.index(index).getAll(value) : s.getAll());
  }
  async function get(name, key) {
    return wrap((await store(name)).get(key));
  }
  async function put(name, value) {
    await wrap((await store(name, "readwrite")).put(value));
    return value;
  }
  async function del(name, key) {
    return wrap((await store(name, "readwrite")).delete(key));
  }
  async function putMany(name, values) {
    const db = await open();
    const tx = db.transaction(name, "readwrite");
    values.forEach((v) => tx.objectStore(name).put(v));
    return done(tx);
  }
  async function deleteWhere(names, index, value) {
    const db = await open();
    const tx = db.transaction(names, "readwrite");
    for (const name of names) {
      const s = tx.objectStore(name);
      const keys = await wrap(s.index(index).getAllKeys(value));
      keys.forEach((k) => s.delete(k));
    }
    return done(tx);
  }

  const byNewest = (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);

  return {
    uid,
    all,
    get,
    put,
    del,
    putMany,

    async listSubjects() {
      return (await all("subjects")).sort((a, b) => a.createdAt - b.createdAt);
    },
    getSubject: (id) => get("subjects", id),
    async saveSubject(subject) {
      return put("subjects", { createdAt: Date.now(), ...subject, id: subject.id || uid() });
    },
    async deleteSubject(id) {
      const exams = await all("exams", "subjectId", id);
      for (const e of exams) await deleteWhere(["tasks"], "examId", e.id);
      await deleteWhere(["notes", "cards", "attempts", "exams"], "subjectId", id);
      await del("chats", id);
      await del("subjects", id);
    },

    async listNotes(subjectId) {
      const list = subjectId ? await all("notes", "subjectId", subjectId) : await all("notes");
      return list.sort(byNewest);
    },
    getNote: (id) => get("notes", id),
    async saveNote(note) {
      const now = Date.now();
      return put("notes", { createdAt: now, outputs: {}, status: {}, rawText: "", ...note, id: note.id || uid(), updatedAt: now });
    },
    async deleteNote(id) {
      await deleteWhere(["cards"], "noteId", id);
      await del("notes", id);
    },
    async countNotesBySubject() {
      return (await all("notes")).reduce((acc, n) => ((acc[n.subjectId] = (acc[n.subjectId] || 0) + 1), acc), {});
    },

    async replaceNoteCards(noteId, cards) {
      const existing = await all("cards", "noteId", noteId);
      const db = await open();
      const tx = db.transaction("cards", "readwrite");
      existing.filter((c) => c.source === "ai").forEach((c) => tx.objectStore("cards").delete(c.id));
      cards.forEach((c) => tx.objectStore("cards").put(c));
      return done(tx);
    },

    async getMeta(key, fallback) {
      const row = await get("meta", key);
      return row ? row.value : fallback;
    },
    setMeta: (key, value) => put("meta", { key, value }),

    async exportAll() {
      const names = ["subjects", "notes", "cards", "attempts", "chats", "exams", "tasks", "meta"];
      const out = { app: "reforge", version: VERSION, exportedAt: new Date().toISOString() };
      for (const n of names) out[n] = await all(n);
      return out;
    },
    async importAll(data) {
      const names = ["subjects", "notes", "cards", "attempts", "chats", "exams", "tasks", "meta"];
      const db = await open();
      const tx = db.transaction(names, "readwrite");
      names.forEach((n) => (Array.isArray(data[n]) ? data[n] : []).forEach((row) => tx.objectStore(n).put(row)));
      return done(tx);
    },
  };
})();
