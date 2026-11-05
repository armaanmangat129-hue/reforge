/* Reforge AI transport: Google Gemini API.
   - The key lives in localStorage only and is sent straight to Google.
   - Calls run one at a time with a short gap, to stay inside free-tier limits.
   - HTTP 429 gets a friendly message and one retry after a few seconds.
   - JSON results are cached in IndexedDB so nothing is generated twice. */

const Gemini = (() => {
  const KEY_STORE = "reforge.geminiKey";
  const MODEL_STORE = "reforge.geminiModel";
  const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/";
  const RETRY_DELAY_MS = 4000;
  const GAP_MS = 1200;
  const LITE = "gemini-3.5-flash-lite";

  const MODELS = [
    { id: LITE, label: "Gemini 3.5 Flash-Lite", note: "Fast, uses the least of your free quota" },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", note: "Stronger reasoning, slower" },
  ];

  class GeminiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  function getKey() {
    try { return localStorage.getItem(KEY_STORE) || ""; } catch { return ""; }
  }
  function setKey(key) {
    try {
      if (key) localStorage.setItem(KEY_STORE, key.trim());
      else localStorage.removeItem(KEY_STORE);
    } catch { /* storage blocked */ }
  }
  function getModel() {
    try { return localStorage.getItem(MODEL_STORE) || LITE; } catch { return LITE; }
  }
  function setModel(model) {
    try { localStorage.setItem(MODEL_STORE, model); } catch { /* ignore */ }
  }

  function friendlyError(status, body) {
    const detail = body && body.error && body.error.message;
    if (status === 429) return "Gemini's free tier is busy or you've hit your limit for the minute. Wait a moment and try again.";
    if (status === 400 && detail && /API key/i.test(detail)) return "That key wasn't accepted. Copy it again from Google AI Studio.";
    if (status === 400 && detail && /too large|token|exceeds/i.test(detail)) return "That's too much text for one request. Split it into smaller notes.";
    if (status === 401 || status === 403) return "That key doesn't have access. Check it in Google AI Studio.";
    if (status === 404) return "This model isn't available for your key. Pick the other model in Settings.";
    if (status >= 500) return "Gemini is having trouble right now. Try again in a minute.";
    return detail || `Gemini returned an error (${status}).`;
  }

  /* One-at-a-time queue */
  let chain = Promise.resolve();
  let lastCall = 0;
  function enqueue(fn) {
    const run = chain.then(async () => {
      const wait = lastCall + GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try { return await fn(); } finally { lastCall = Date.now(); }
    });
    chain = run.catch(() => {});
    return run;
  }

  async function post(model, payload, key) {
    const res = await fetch(`${ENDPOINT}${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    return { res, body };
  }

  async function rawGenerate(payload, { model = getModel(), key = getKey(), onRetry } = {}) {
    if (!key) throw new GeminiError("Add your Gemini key in Settings first.", 0);
    return enqueue(async () => {
      let attempt;
      try {
        attempt = await post(model, payload, key);
        if (attempt.res.status === 429) {
          if (onRetry) onRetry();
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          attempt = await post(model, payload, key);
        }
      } catch {
        throw new GeminiError("Couldn't reach Gemini. Check your internet connection.", 0);
      }
      if (!attempt.res.ok) throw new GeminiError(friendlyError(attempt.res.status, attempt.body), attempt.res.status);
      const candidate = attempt.body?.candidates?.[0];
      if (!candidate) {
        const reason = attempt.body?.promptFeedback?.blockReason;
        throw new GeminiError(reason ? "Gemini declined to answer this one. Try rewording it." : "Gemini sent back an empty answer. Try again.", 200);
      }
      const text = (candidate.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
      if (!text && candidate.finishReason === "MAX_TOKENS") throw new GeminiError("The answer was cut off. Try a shorter note.", 200);
      return text;
    });
  }

  async function hash(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function parseJSON(text) {
    const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    return JSON.parse(clean);
  }

  /* Ask for JSON that matches `schema`, then run `validate` on it.
     `validate` returns the cleaned value or throws. */
  async function json({ system, prompt, schema, validate, model, images = [], cache = true, temperature = 0.3, onRetry }) {
    model = model || getModel();
    const parts = [{ text: prompt }, ...images.map((img) => ({ inline_data: { mime_type: img.mimeType, data: img.data } }))];
    const payload = {
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature },
    };
    if (system) payload.systemInstruction = { parts: [{ text: system }] };

    const key = cache && !images.length ? "ai:" + (await hash(model + JSON.stringify(payload))) : null;
    if (key) {
      const hit = await DB.get("cache", key).catch(() => null);
      if (hit) return hit.value;
    }

    let text;
    try {
      text = await rawGenerate(payload, { model, onRetry });
    } catch (err) {
      // The lite model may not exist for every key: fall back to the chosen model.
      if (err.status !== 404 || model === getModel()) throw err;
      text = await rawGenerate(payload, { model: getModel(), onRetry });
    }
    let value;
    try {
      value = parseJSON(text);
    } catch {
      console.warn("Reforge: Gemini returned text that isn't JSON:", text);
      throw new GeminiError("Gemini's answer came back in the wrong format. Press Retry.", 200);
    }
    try {
      value = validate ? validate(value) : value;
    } catch (err) {
      console.warn("Reforge: Gemini JSON failed validation:", err.message, value);
      throw new GeminiError("Gemini's answer was missing parts. Press Retry.", 200);
    }
    if (key) DB.put("cache", { key, value, at: Date.now() }).catch(() => {});
    return value;
  }

  /* Plain text answer, e.g. reading a photo. */
  async function text({ system, prompt, images = [], model, temperature = 0.2, onRetry }) {
    const parts = [{ text: prompt }, ...images.map((img) => ({ inline_data: { mime_type: img.mimeType, data: img.data } }))];
    const payload = { contents: [{ role: "user", parts }], generationConfig: { temperature } };
    if (system) payload.systemInstruction = { parts: [{ text: system }] };
    return rawGenerate(payload, { model: model || getModel(), onRetry });
  }

  async function testKey(key, model, onRetry) {
    return rawGenerate(
      { contents: [{ role: "user", parts: [{ text: "Reply with the single word: ready" }] }], generationConfig: { temperature: 0 } },
      { key, model, onRetry }
    );
  }

  return { MODELS, LITE, getKey, setKey, getModel, setModel, json, text, testKey, GeminiError };
})();
