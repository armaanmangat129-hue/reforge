# Reforge

Paste or upload your class notes and Reforge turns them into clean notes, a summary, flashcards, a quiz, exam-style questions and, for maths, a printable reference book with diagrams, worked examples and TI-Nspire CX CAS steps. It also has a tutor that answers from your own notes, and a revision planner.

- **Private:** everything is saved in your browser (IndexedDB). There's no server and no account.
- **Free:** it uses Groq's free tier. Each person pastes their own key in Settings ([get one at console.groq.com/keys](https://console.groq.com/keys)).
- **Plain HTML, CSS and JavaScript.** No build step. Outside libraries load from cdnjs only when needed: pdf.js (PDFs), mammoth.js (Word) and Tesseract.js (reading photos on the device).

## Run it locally

```bash
python3 -m http.server 3400 --directory src
```

Then open http://localhost:3400.

## Deploy

Live at **https://reforge-study.pages.dev** (Cloudflare Pages project `reforge-study`, output folder `src`, no build command).

- Once the GitHub repo is connected to the Pages project in the Cloudflare dashboard, every push to `main` redeploys.
- Until then, deploy by hand: `npx wrangler pages deploy src --project-name reforge-study --branch main`
- `.github/workflows/pages.yml` also publishes `src/` to GitHub Pages (https://armaanmangat129-hue.github.io/reforge/) as a backup.

## Files

| File | What it does |
|---|---|
| `src/index.html` | Entry point |
| `src/styles.css`, `src/motion.css` | All styles. Colours, spacing and fonts are variables in `:root` |
| `src/core.js` | Shared helpers, dialogs, markdown and the hash router |
| `src/db.js` | IndexedDB storage |
| `src/ai.js` | The Groq client (live model list, JSON mode, one-at-a-time queue, 429 countdown and retry, cache) plus every AI feature |
| `src/diagrams.js` | Draws reference-sheet diagrams as SVG from a small spec |
| `src/upload.js` | Reads PDF (pdf.js), Word (mammoth.js), text and photos (Groq vision, or Tesseract.js on the device) |
| `src/srs.js` | SM-2 spaced repetition, XP, levels and streaks |
| `src/library.js` | Library, subjects, notes, study sets and the print book |
| `src/study.js` | Flashcard reviews, quizzes and exam practice |
| `src/tutor.js` | Tutor chat |
| `src/planner.js` | Exams, revision plan and stats |
| `src/settings.js` | Key, model and backups |
