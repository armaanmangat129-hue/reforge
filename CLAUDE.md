# Reforge

Paste or upload notes and Reforge turns them into clean notes, a maths reference book, flashcards, quizzes, exam questions, an AI tutor and a revision plan.

## Rules

- Plain HTML/CSS/JS only. No frameworks or packages, except pdf.js, mammoth.js and Tesseract.js from cdnjs for reading uploads.
- All AI calls go to Groq (OpenAI-compatible chat completions) through src/ai.js, using a key the user pastes into Settings. Store the key in localStorage only. Never hard-code it or any model name: models come from Groq's /models list.
- All notes, flashcards and progress are saved in the browser with IndexedDB. No server, no accounts.
- Design: light, luxurious, calm for long study sessions. Warm ivory paper background (low glare), ink-navy text, deep navy for main actions, antique gold only for highlights, streaks and achievements. Frosted-glass header and tab bar only; cards are solid with hairline borders. Colours only from CSS variables in `:root` (Lookbook names: `--bg`, `--surface`, `--text`, `--text-muted`, `--accent`, `--border`, `--radius`, `--shadow`, `--font-display`, `--font-body`). Fonts: Cormorant Garamond for h1/h2 display, Inter for everything else.
- Motion: Motion Effects classes (`.reveal`, `.btn`), opacity/transform only, 200-300ms for UI, always respect `prefers-reduced-motion`.
- Copy: follow the copywriting playbook voice rules — short, specific, "you" over "we"; never use passion, journey, elevate, seamless, world-class, premium, best-in-class, game-changing.
- No placeholder text, lorem ipsum, or fake data in the final app.
- Every screen must work at 390px wide with no horizontal scroll.
- Stay inside Groq's free limits: one call at a time, 3 s apart; chunk long notes to the per-minute token budget; on 429 read retry-after, show a countdown and retry up to 3 times.

## Layout

- `src/index.html` — entry point (`src/` is deployed to GitHub Pages by `.github/workflows/pages.yml`)
- `src/styles.css`, `src/motion.css` — all styles; colours and spacing are CSS variables in `:root`
- `src/core.js` — `R`: helpers, dialogs, markdown, hash router (`R.route(regex, tab, render)`; `render.mount` may return a cleanup)
- `src/db.js` — IndexedDB (subjects, notes, cards, attempts, chats, exams, tasks, meta, cache)
- `src/ai.js` — Groq client (models, JSON mode, queue, 429 retry, cache) + prompts, schemas, validation, chunking, pipeline, tutor, marking
- `src/diagrams.js` — SVG diagrams from a spec (the AI never writes SVG)
- `src/upload.js` — PDF (pdf.js), .docx (mammoth.js), .txt, photos (Groq vision model, else Tesseract.js)
- `src/srs.js` — SM-2, XP, levels, streaks, weak topics
- `src/library.js`, `study.js`, `tutor.js`, `planner.js`, `settings.js` — screens
- `src/app.js` — nav and start-up (loaded last)
- `assets/`, `docs/` — spare folders

## Run locally

```
python3 -m http.server 3400 --directory src
```
