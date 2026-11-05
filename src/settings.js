/* Reforge Settings: Gemini key, model, and your data. */

(() => {
  const { esc, icon, toast, confirmSheet, view } = R;

  async function renderSettings() {
    const key = Gemini.getKey();
    const model = Gemini.getModel();
    const [subjects, notes, cards] = await Promise.all([DB.listSubjects(), DB.listNotes(), DB.all("cards")]);
    return `
      <div class="page-head"><div><span class="eyebrow">Preferences</span><h1>Settings</h1></div></div>

      <section class="card panel reveal" aria-labelledby="key-heading">
        <div class="panel-head">
          <h2 id="key-heading">Gemini API key</h2>
          <p>Reforge uses Google's Gemini to write your study material. The free tier is enough for daily study.
          Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>, then paste it here.</p>
        </div>
        <div class="field">
          <label class="label" for="api-key">Your key</label>
          <div class="input-row">
            <input class="input" id="api-key" type="password" value="${esc(key)}" placeholder="Paste your key" autocomplete="off" spellcheck="false">
            <button class="btn btn-icon" type="button" data-action="toggle-key" aria-label="Show key" aria-pressed="false">${icon("eye")}</button>
          </div>
          <span class="hint">Saved only in this browser and sent only to Google. Everyone who uses Reforge needs their own free key.</span>
        </div>
        <div class="key-actions">
          <button class="btn btn-primary" type="button" data-action="save-key">Save key</button>
          <button class="btn" type="button" data-action="test-key">Test key</button>
          ${key ? `<button class="btn btn-quiet" type="button" data-action="remove-key">Remove</button>` : ""}
        </div>
        <p class="status-line" id="key-status" hidden></p>
      </section>

      <section class="card panel reveal" aria-labelledby="model-heading">
        <div class="panel-head">
          <h2 id="model-heading">Model</h2>
          <p>Used for clean notes, reference sheets, marking and the tutor. Flashcards, summaries and quizzes always use Flash-Lite to save your quota.</p>
        </div>
        <fieldset class="model-options">
          <legend class="visually-hidden">Gemini model</legend>
          ${Gemini.MODELS.map(
            (m) => `<label class="radio-card"><input type="radio" name="model" value="${m.id}" ${m.id === model ? "checked" : ""}>
              <div><strong>${esc(m.label)}</strong><span>${esc(m.note)}</span></div></label>`
          ).join("")}
        </fieldset>
      </section>

      <section class="card panel reveal" aria-labelledby="data-heading">
        <div class="panel-head">
          <h2 id="data-heading">Your data</h2>
          <p>Everything is stored in this browser only. Clearing your browser data deletes it, so download a backup now and then.</p>
        </div>
        <div class="stats">
          <div class="stat"><strong>${subjects.length}</strong><span>${subjects.length === 1 ? "Subject" : "Subjects"}</span></div>
          <div class="stat"><strong>${notes.length}</strong><span>${notes.length === 1 ? "Note" : "Notes"}</span></div>
          <div class="stat"><strong>${cards.length}</strong><span>${cards.length === 1 ? "Flashcard" : "Flashcards"}</span></div>
        </div>
        <div class="key-actions">
          <button class="btn" type="button" data-action="export">${icon("download")}Download backup</button>
          <label class="btn">${icon("upload")}Restore backup<input type="file" accept="application/json,.json" class="visually-hidden" data-action="import"></label>
        </div>
      </section>`;
  }

  renderSettings.mount = () => {
    const input = view.querySelector("#api-key");
    const status = view.querySelector("#key-status");
    const toggle = view.querySelector('[data-action="toggle-key"]');

    const setStatus = (tone, text) => {
      status.hidden = false;
      status.dataset.tone = tone;
      const mark = tone === "ok" ? icon("check") : tone === "error" ? icon("alert") : '<span class="spinner" aria-hidden="true"></span>';
      status.innerHTML = `${mark}<span>${esc(text)}</span>`;
    };

    toggle.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.setAttribute("aria-pressed", String(show));
      toggle.setAttribute("aria-label", show ? "Hide key" : "Show key");
    });

    view.querySelector('[data-action="save-key"]').addEventListener("click", () => {
      const value = input.value.trim();
      if (!value) return setStatus("error", "Paste your key first.");
      Gemini.setKey(value);
      toast("Key saved");
      R.render();
    });

    view.querySelector('[data-action="remove-key"]')?.addEventListener("click", () => {
      Gemini.setKey("");
      toast("Key removed");
      R.render();
    });

    const testBtn = view.querySelector('[data-action="test-key"]');
    testBtn.addEventListener("click", async () => {
      const value = input.value.trim();
      if (!value) return setStatus("error", "Paste your key first.");
      testBtn.disabled = true;
      setStatus("busy", "Checking your key with Gemini…");
      try {
        await Gemini.testKey(value, Gemini.getModel(), () => setStatus("busy", "Gemini is busy. Trying again in a few seconds…"));
        setStatus("ok", `Your key works with ${Gemini.MODELS.find((m) => m.id === Gemini.getModel())?.label || Gemini.getModel()}.${Gemini.getKey() === value ? "" : " Press Save key to keep it."}`);
      } catch (err) {
        setStatus("error", err.message);
      } finally {
        testBtn.disabled = false;
      }
    });

    view.querySelectorAll('input[name="model"]').forEach((r) =>
      r.addEventListener("change", () => {
        Gemini.setModel(r.value);
        status.hidden = true;
        toast("Model updated");
      })
    );

    view.querySelector('[data-action="export"]').addEventListener("click", async () => {
      const data = await DB.exportAll();
      const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `reforge-backup-${R.dayKey()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    view.querySelector('[data-action="import"]').addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data.app !== "reforge") throw new Error();
        const ok = await confirmSheet({ title: "Restore this backup?", body: `It adds ${data.subjects?.length || 0} subjects and ${data.notes?.length || 0} notes. Items with the same ID are replaced.`, action: "Restore", tone: "primary" });
        if (!ok) return;
        await DB.importAll(data);
        toast("Backup restored");
        R.render();
      } catch {
        toast("That file isn't a Reforge backup");
      }
    });
  };

  R.route(/^\/settings$/, "settings", renderSettings);
})();
