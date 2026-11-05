# Reforge

Paste or upload your class notes and Reforge turns them into clean notes, a summary, flashcards, a quiz, exam-style questions and, for maths, a printable reference book with diagrams, worked examples and TI-Nspire CX CAS steps. It also has a tutor that answers from your own notes, and a revision planner.

- **Private:** everything is saved in your browser (IndexedDB). There's no server and no account.
- **Free:** it uses the Google Gemini free tier. Each person pastes their own key in Settings ([get one at Google AI Studio](https://aistudio.google.com/apikey)).
- **Plain HTML, CSS and JavaScript.** No build step. The only outside library is pdf.js, loaded from cdnjs when you upload a PDF.

## Run it locally

```bash
python3 -m http.server 3400 --directory src
```

Then open http://localhost:3400.

## Deploy

Every push to `main` publishes `src/` to GitHub Pages using `.github/workflows/pages.yml`.

## Files

| File | What it does |
|---|---|
| `src/index.html` | Entry point |
| `src/styles.css`, `src/motion.css` | All styles. Colours, spacing and fonts are variables in `:root` |
| `src/core.js` | Shared helpers, dialogs, markdown and the hash router |
| `src/db.js` | IndexedDB storage |
| `src/gemini.js` | Gemini API calls: one-at-a-time queue, 429 retry, response cache |
| `src/ai.js` | Prompts, JSON schemas, validation, chunking and the generate pipeline |
| `src/diagrams.js` | Draws reference-sheet diagrams as SVG from a small spec |
| `src/upload.js` | Reads PDF, Word, text and photos |
| `src/srs.js` | SM-2 spaced repetition, XP, levels and streaks |
| `src/library.js` | Library, subjects, notes, study sets and the print book |
| `src/study.js` | Flashcard reviews, quizzes and exam practice |
| `src/tutor.js` | Tutor chat |
| `src/planner.js` | Exams, revision plan and stats |
| `src/settings.js` | Key, model and backups |
