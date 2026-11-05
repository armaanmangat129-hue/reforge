/* Reforge Tutor: a chat grounded in your own notes, saved per subject. */

const Tutor = (() => {
  const { esc, icon, subjectVar, toast, emptyState, skeleton, view } = R;
  const MAX_SAVED = 80;

  const PREFS = "reforge.tutor";
  function prefs() {
    try { return JSON.parse(localStorage.getItem(PREFS)) || {}; } catch { return {}; }
  }
  function savePrefs(p) {
    try { localStorage.setItem(PREFS, JSON.stringify({ ...prefs(), ...p })); } catch { /* ignore */ }
  }

  function bubble(m) {
    if (m.role === "user") {
      return `<li class="msg msg-user"><div class="msg-body">${m.image ? `<span class="chip">${icon("camera")}Photo attached</span>` : ""}${m.text ? `<p>${esc(m.text)}</p>` : ""}</div></li>`;
    }
    return `<li class="msg msg-tutor"><div class="msg-body">
      ${m.inNotes === false ? `<p class="not-in-notes">${icon("alert")}Not in your notes. This answer uses general knowledge.</p>` : ""}
      ${R.md(m.text)}
      ${m.sources && m.sources.length ? `<p class="sources">From: ${m.sources.map((s) => `<span class="chip">${esc(s)}</span>`).join("")}</p>` : ""}
    </div></li>`;
  }

  async function renderTutor() {
    const subjects = await DB.listSubjects();
    const notes = await DB.listNotes();
    const withNotes = subjects.filter((s) => notes.some((n) => n.subjectId === s.id && (n.rawText || "").trim()));
    if (!withNotes.length) {
      return `<div class="page-head"><div><span class="eyebrow">Ask</span><h1>Tutor</h1>
          <p class="lead">A tutor that answers from your own notes and tells you which note each answer came from.</p></div></div>
        ${emptyState({ mark: "tutor", title: "Your tutor needs notes", body: "Add notes to a subject, then come back to ask questions, get quizzed or have your working checked.", action: `<a class="btn btn-primary" href="#/library">Go to Library</a>` })}`;
    }
    const p = prefs();
    const wanted = R.query().get("subject") || p.subject;
    const subject = withNotes.find((s) => s.id === wanted) || withNotes[0];
    const mode = AI.TUTOR_MODES[p.mode] ? p.mode : "explain";

    return `
      <div class="page-head tutor-head"><div><span class="eyebrow">Ask</span><h1>Tutor</h1></div></div>
      <div class="tutor">
        <div class="tutor-controls card">
          <div class="field">
            <label class="label" for="tutor-subject">Subject</label>
            <select class="select" id="tutor-subject">${withNotes.map((s) => `<option value="${s.id}" ${s.id === subject.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
          </div>
          <details class="note-picker" id="note-picker"><summary>Using <span id="scope-label">all notes</span></summary><div id="note-checks"></div></details>
          <div class="modes" role="radiogroup" aria-label="Tutor mode">
            ${Object.entries(AI.TUTOR_MODES).map(([id, m]) => `<button type="button" role="radio" class="mode" data-mode="${id}" aria-checked="${id === mode}">${esc(m.label)}</button>`).join("")}
          </div>
        </div>
        <section class="card chat" aria-label="Conversation">
          <ol class="messages" id="messages" aria-live="polite"></ol>
          <form class="composer" id="composer">
            <div class="attach-preview" id="attach-preview" hidden></div>
            <div class="composer-row">
              <label class="btn btn-quiet btn-icon" title="Attach a photo of your working">
                ${icon("camera")}<span class="visually-hidden">Attach a photo</span>
                <input type="file" accept="image/*" class="visually-hidden" id="tutor-photo">
              </label>
              <label class="visually-hidden" for="tutor-input">Message</label>
              <textarea id="tutor-input" class="composer-input" rows="1" placeholder=""></textarea>
              <button class="btn btn-primary btn-icon" type="submit" aria-label="Send">${icon("send")}</button>
            </div>
          </form>
        </section>
      </div>`;
  }

  renderTutor.mount = async () => {
    const select = view.querySelector("#tutor-subject");
    if (!select) return;
    const list = view.querySelector("#messages");
    const form = view.querySelector("#composer");
    const input = view.querySelector("#tutor-input");
    const photo = view.querySelector("#tutor-photo");
    const preview = view.querySelector("#attach-preview");
    const checks = view.querySelector("#note-checks");
    const scopeLabel = view.querySelector("#scope-label");
    let mode = view.querySelector('.mode[aria-checked="true"]').dataset.mode;
    let subject, notes, chat, image = null, sending = false;

    const placeholder = () => (input.placeholder = AI.TUTOR_MODES[mode].hint);

    async function loadSubject() {
      subject = await DB.getSubject(select.value);
      notes = (await DB.listNotes(subject.id)).filter((n) => (n.rawText || "").trim());
      chat = (await DB.get("chats", subject.id)) || { subjectId: subject.id, messages: [] };
      savePrefs({ subject: subject.id });
      checks.innerHTML = `${notes.map((n) => `<label class="check-line"><input type="checkbox" value="${n.id}" checked> ${esc(n.title)}</label>`).join("")}`;
      updateScope();
      drawMessages();
    }
    function chosenNotes() {
      const ids = [...checks.querySelectorAll("input:checked")].map((c) => c.value);
      return notes.filter((n) => ids.includes(n.id));
    }
    function updateScope() {
      const n = chosenNotes().length;
      scopeLabel.textContent = n === notes.length ? (n === 1 ? "your note" : `all ${n} notes`) : `${n} of ${notes.length} notes`;
    }
    function drawMessages() {
      list.innerHTML = chat.messages.length
        ? chat.messages.map(bubble).join("") + `<li class="msg-clear"><button class="btn btn-quiet btn-small" type="button" data-clear>Clear this chat</button></li>`
        : `<li class="chat-empty"><h2>Ask about ${esc(subject.name)}</h2><p>${esc(AI.TUTOR_MODES[mode].hint)}. Answers come from your notes and say which note they used.</p></li>`;
      list.scrollTop = list.scrollHeight;
    }

    async function send(text) {
      if (sending) return;
      if (!text && !image) return;
      if (!AI.getKey()) { toast("Add your Groq key in Settings first"); return; }
      const scope = chosenNotes();
      if (!scope.length) { toast("Pick at least one note"); return; }
      sending = true;
      const history = chat.messages.slice();
      const userMsg = { role: "user", text, image: !!image, at: Date.now() };
      chat.messages.push(userMsg);
      drawMessages();
      list.insertAdjacentHTML("beforeend", `<li class="msg msg-tutor" id="typing"><div class="msg-body">${skeleton(3)}</div></li>`);
      list.scrollTop = list.scrollHeight;
      const images = image ? [image] : [];
      clearImage();
      input.value = "";
      autosize();
      try {
        const res = await AI.tutorReply({ subject, notes: scope, mode, history, message: text, images });
        const titles = scope.map((n) => n.title.toLowerCase());
        chat.messages.push({ role: "tutor", text: res.answer, inNotes: res.inNotes, sources: res.sources.filter((s) => titles.includes(s.toLowerCase())), at: Date.now() });
        SRS.track("tutor");
      } catch (err) {
        chat.messages.pop();
        input.value = text;
        toast(err.message || "The tutor couldn't answer");
      }
      chat.messages = chat.messages.slice(-MAX_SAVED);
      await DB.put("chats", chat);
      sending = false;
      drawMessages();
    }

    function clearImage() {
      image = null;
      preview.hidden = true;
      preview.innerHTML = "";
    }
    function autosize() {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 180) + "px";
    }

    select.addEventListener("change", loadSubject);
    checks.addEventListener("change", updateScope);
    view.querySelector(".modes").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mode]");
      if (!b) return;
      mode = b.dataset.mode;
      savePrefs({ mode });
      view.querySelectorAll(".mode").forEach((m) => m.setAttribute("aria-checked", String(m === b)));
      placeholder();
      if (!chat.messages.length) drawMessages();
    });
    list.addEventListener("click", async (e) => {
      if (!e.target.closest("[data-clear]")) return;
      chat.messages = [];
      await DB.put("chats", chat);
      drawMessages();
    });
    photo.addEventListener("change", async () => {
      const file = photo.files[0];
      photo.value = "";
      if (!file) return;
      if (file.size > 15 * 1024 * 1024) return toast("That photo is over 15 MB. Try a smaller one.");
      try {
        image = await Upload.imageToJpeg(file, 1600);
        preview.hidden = false;
        preview.innerHTML = `<img src="data:image/jpeg;base64,${image.data}" alt="Attached photo"><button class="btn btn-quiet btn-small" type="button" data-remove>${icon("x")}Remove</button>`;
        preview.querySelector("[data-remove]").addEventListener("click", clearImage);
        if (mode !== "check") view.querySelector('[data-mode="check"]').click();
      } catch (err) {
        toast(err.message);
      }
    });
    input.addEventListener("input", autosize);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input.value.trim()); }
    });
    form.addEventListener("submit", (e) => { e.preventDefault(); send(input.value.trim()); });

    placeholder();
    await loadSubject();
  };

  R.route(/^\/tutor$/, "tutor", renderTutor);
  return {};
})();
