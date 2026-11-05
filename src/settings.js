/* Reforge Settings: Groq key, model, goals and sounds, and your data. */

(() => {
  const { esc, icon, toast, confirmSheet, view } = R;

  async function renderSettings() {
    const key = AI.getKey();
    const [subjects, notes, cards, rewardSettings] = await Promise.all([DB.listSubjects(), DB.listNotes(), DB.all("cards"), Rewards.getSettings()]);
    return `
      <div class="page-head"><div><span class="eyebrow">Preferences</span><h1>Settings</h1></div></div>

      <section class="card panel reveal" aria-labelledby="key-heading">
        <div class="panel-head">
          <h2 id="key-heading">Groq API key</h2>
          <p>Reforge uses Groq to write your study material. Groq's free tier is enough for daily study.</p>
        </div>
        <div class="field">
          <label class="label" for="api-key">Your key</label>
          <div class="input-row">
            <input class="input" id="api-key" type="password" value="${esc(key)}" placeholder="Paste your Groq key" autocomplete="off" spellcheck="false">
            <button class="btn btn-icon" type="button" data-action="toggle-key" aria-label="Show key" aria-pressed="false">${icon("eye")}</button>
          </div>
          <span class="hint">Get a free key at <a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com/keys</a>. It's saved only in this browser and sent only to Groq.</span>
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
          <p>Every AI feature uses this model. The list comes from Groq with your key. The largest text model is picked for you.</p>
        </div>
        <div class="field">
          <label class="label" for="model-select">Model</label>
          <div class="input-row">
            <select class="select" id="model-select" ${key ? "" : "disabled"}><option>${key ? "Loading models…" : "Add your key first"}</option></select>
            <button class="btn btn-icon" type="button" data-action="refresh-models" aria-label="Refresh the model list" ${key ? "" : "disabled"}>${icon("refresh")}</button>
          </div>
          <span class="hint" id="vision-hint"></span>
        </div>
      </section>

      <section class="card panel reveal" aria-labelledby="rewards-heading">
        <div class="panel-head">
          <h2 id="rewards-heading">Goals and sounds</h2>
          <p>Your daily XP goal fills the ring on Home. Reaching it earns 10 bonus XP.</p>
        </div>
        <div class="field">
          <label class="label" for="daily-goal">Daily XP goal</label>
          <div class="input-row goal-input">
            <input class="input" id="daily-goal" type="number" min="10" max="500" step="10" value="${rewardSettings.dailyGoal}" inputmode="numeric">
            <span class="hint">XP a day</span>
          </div>
        </div>
        <label class="switch-row">
          <span><strong>Sounds</strong><span>Small click and level-up sounds.</span></span>
          <input type="checkbox" role="switch" id="sounds" ${rewardSettings.sounds ? "checked" : ""}>
          <span class="switch" aria-hidden="true"></span>
        </label>
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

    const select = view.querySelector("#model-select");
    const visionHint = view.querySelector("#vision-hint");
    async function fillModels(force = false) {
      if (!AI.getKey()) return;
      select.disabled = true;
      try {
        const models = await AI.listModels({ force });
        const current = await AI.currentModel();
        const def = AI.pickDefault(models);
        select.innerHTML = models
          .map((m) => `<option value="${esc(m.id)}" ${m.id === current ? "selected" : ""}>${esc(m.id)}${m.id === def ? " (recommended)" : ""}${m.vision ? " · reads photos" : ""}</option>`)
          .join("");
        const vision = AI.pickVision(models);
        visionHint.textContent = vision
          ? `Photos are read with ${vision}, with on-device text recognition as a backup.`
          : "No vision model on your key, so photos are read with on-device text recognition.";
        select.disabled = false;
      } catch (err) {
        select.innerHTML = `<option>${esc(err.message)}</option>`;
      }
    }
    select.addEventListener("change", () => {
      AI.setModel(select.value);
      toast("Model updated");
    });
    view.querySelector('[data-action="refresh-models"]').addEventListener("click", () => fillModels(true));
    fillModels();

    view.querySelector('[data-action="save-key"]').addEventListener("click", () => {
      const value = input.value.trim();
      if (!value) return setStatus("error", "Paste your key first.");
      AI.setKey(value);
      toast("Key saved");
      R.render();
    });

    view.querySelector('[data-action="remove-key"]')?.addEventListener("click", () => {
      AI.setKey("");
      toast("Key removed");
      R.render();
    });

    const testBtn = view.querySelector('[data-action="test-key"]');
    testBtn.addEventListener("click", async () => {
      const value = input.value.trim();
      if (!value) return setStatus("error", "Paste your key first.");
      testBtn.disabled = true;
      setStatus("busy", "Checking your key with Groq…");
      try {
        const res = await AI.testKey(value, (msg) => setStatus("busy", msg));
        setStatus("ok", `Your key works. ${res.models.length} models available; ${res.model} is recommended.${AI.getKey() === value ? "" : " Press Save key to keep it."}`);
      } catch (err) {
        setStatus("error", err.message);
      } finally {
        testBtn.disabled = false;
      }
    });

    const goal = view.querySelector("#daily-goal");
    goal.addEventListener("change", async () => {
      const n = Math.max(10, Math.min(500, Math.round(Number(goal.value) / 10) * 10 || 50));
      goal.value = n;
      await Rewards.setSettings({ dailyGoal: n });
      toast(`Daily goal set to ${n} XP`);
    });
    view.querySelector("#sounds").addEventListener("change", async (e) => {
      await Rewards.setSettings({ sounds: e.target.checked });
      if (e.target.checked) Rewards.sound.click();
      toast(e.target.checked ? "Sounds on" : "Sounds off");
    });

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
