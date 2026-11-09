/* Reforge uploads: turn PDFs, Word documents, text files and photos into editable text.
   Nothing here needs the AI:
   - PDF: pdf.js (cdnjs). Scanned PDFs are rendered to images and read like photos.
   - Word (.docx): mammoth.js (cdnjs). Embedded images are skipped: converting them is what
     made image-heavy Word files sit on "Reading…" for over a minute.
   - Photos (JPG, PNG, WebP, HEIC): compressed, then read with Groq's vision model when the key
     has one, otherwise with Tesseract.js (cdnjs) in the browser. HEIC is decoded natively where
     the browser can, otherwise converted with heic2any (cdnjs).
   Every step reports progress as (message, percent), and a file that stops making progress
   fails with a clear message instead of hanging. Libraries load only when a file needs them. */

const Upload = (() => {
  const CDN = "https://cdnjs.cloudflare.com/ajax/libs";
  const PDFJS = `${CDN}/pdf.js/3.11.174/pdf.min.js`;
  const PDFJS_WORKER = `${CDN}/pdf.js/3.11.174/pdf.worker.min.js`;
  const MAMMOTH = `${CDN}/mammoth/1.13.0/mammoth.browser.min.js`;
  const TESSERACT = `${CDN}/tesseract.js/7.0.0/tesseract.min.js`;
  const TESSERACT_WORKER = `${CDN}/tesseract.js/7.0.0/worker.min.js`;
  const HEIC2ANY = `${CDN}/heic2any/0.0.4/heic2any.min.js`;
  const MB = 1024 * 1024;
  const LIMITS = { pdf: 30 * MB, docx: 20 * MB, txt: 5 * MB, image: 15 * MB };
  const MAX_IMAGES = 12;
  const MAX_SCAN_PAGES = 15;
  const STALL_MS = 90000; // no progress for this long = give up with a message

  class UploadError extends Error {}

  const ACCEPT = ".pdf,.docx,.txt,.md,.heic,.heif,image/png,image/jpeg,image/webp,image/heic,image/heif";

  function kindOf(file) {
    const name = file.name.toLowerCase();
    if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
    if (name.endsWith(".docx")) return "docx";
    if (name.endsWith(".doc")) return "doc";
    if (file.type.startsWith("text/") || name.endsWith(".txt") || name.endsWith(".md")) return "txt";
    if (file.type.startsWith("image/") || /\.(png|jpe?g|webp|heic|heif)$/.test(name)) return "image";
    return null;
  }
  const isHeic = (file) => /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);

  const sizeText = (bytes) => (bytes < MB ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / MB).toFixed(1)} MB`);
  function checkSize(file, kind) {
    if (!file.size) throw new UploadError(`${file.name} is empty.`);
    if (file.size > LIMITS[kind]) {
      throw new UploadError(`${file.name} is ${sizeText(file.size)}. The limit for this kind of file is ${sizeText(LIMITS[kind])}. Split it into smaller files.`);
    }
  }

  // let the page repaint so progress is visible during long jobs
  const breathe = () => new Promise((r) => setTimeout(r, 0));

  const loaded = {};
  function loadScript(src, globalName, failMsg) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    loaded[src] =
      loaded[src] ||
      new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => (window[globalName] ? resolve(window[globalName]) : reject(new UploadError(failMsg)));
        s.onerror = () => { delete loaded[src]; reject(new UploadError(failMsg)); };
        document.head.appendChild(s);
      });
    return loaded[src];
  }

  /* ---------- PDF ---------- */
  async function readPdf(file, progress) {
    progress("Loading the PDF reader…", 2);
    const pdfjs = await loadScript(PDFJS, "pdfjsLib", "Couldn't load the PDF reader. Check your internet connection and try again.");
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    progress("Opening the PDF…", 5);
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    } catch (err) {
      if (err && err.name === "PasswordException") throw new UploadError(`${file.name} is password-protected. Remove the password, or copy and paste the text.`);
      throw new UploadError(`${file.name} couldn't be opened. It may be damaged. Try saving it as a new PDF.`);
    }
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      progress(`Reading page ${i} of ${doc.numPages}…`, 5 + Math.round((i / doc.numPages) * 85));
      const content = await (await doc.getPage(i)).getTextContent();
      let lastY = null, line = "";
      const lines = [];
      content.items.forEach((it) => {
        const y = Math.round(it.transform[5]);
        if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line.trimEnd()); line = ""; }
        line += it.str;
        lastY = y;
      });
      if (line) lines.push(line.trimEnd());
      pages.push(lines.join("\n").replace(/\n{3,}/g, "\n\n"));
      if (i % 5 === 0) await breathe();
    }
    const text = pages.join("\n\n").trim();
    if (text.replace(/\s/g, "").length > doc.numPages * 40) return text;

    // Little or no text: it's a scan. Render the pages and read them like photos.
    const count = Math.min(doc.numPages, MAX_SCAN_PAGES);
    const images = [];
    for (let i = 1; i <= count; i++) {
      progress(`This PDF is a scan. Preparing page ${i} of ${count}…`, 10 + Math.round((i / count) * 30));
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1.6 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      images.push(canvasToImage(shrink(canvas, 1800)));
      await breathe();
    }
    const read = await readImages(images, (msg, p) => progress(msg, p == null ? null : 40 + Math.round(p * 0.6)), "scanned page");
    if (!read.trim()) throw new UploadError(`${file.name} is a scan and no text could be read from it. Try a clearer scan.`);
    return doc.numPages > count ? `${read}\n\n[Only the first ${count} pages were read. Upload the rest as a separate file.]` : read;
  }

  /* ---------- Word ---------- */
  async function readDocx(file, progress) {
    progress("Loading the Word reader…", 5);
    const mammoth = await loadScript(MAMMOTH, "mammoth", "Couldn't load the Word reader. Check your internet connection and try again.");
    progress("Opening the document…", 25);
    const buffer = await file.arrayBuffer();
    progress("Reading the text…", 45);
    await breathe();
    let skipped = 0;
    let result;
    try {
      result = await mammoth.convertToHtml(
        { arrayBuffer: buffer },
        // Don't read or encode embedded images: that's what made big Word files hang
        { convertImage: mammoth.images.imgElement(() => { skipped++; return Promise.resolve({ src: "" }); }) }
      );
    } catch {
      throw new UploadError(`${file.name} couldn't be opened. In Word, use File › Save As › Word Document (.docx), then try again.`);
    }
    progress("Tidying the text…", 90);
    const doc = new DOMParser().parseFromString(result.value, "text/html");
    const out = [];
    doc.body.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, td").forEach((el) => {
      if (el.closest("li") && el.tagName !== "LI") return;
      if (el.closest("td") && el.tagName !== "TD") return;
      const t = el.textContent.replace(/\s+/g, " ").trim();
      if (!t) return;
      if (/^H\d$/.test(el.tagName)) out.push(`\n# ${t}`);
      else if (el.tagName === "LI") out.push(`- ${t}`);
      else out.push(t);
    });
    const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) throw new UploadError(`${file.name} has no text Reforge can find${skipped ? ` (it only has pictures; upload those as photos instead)` : ""}.`);
    return { text, note: skipped ? `${skipped} picture${skipped === 1 ? " was" : "s were"} skipped. If they contain notes, upload them as photos.` : "" };
  }

  /* ---------- Photos ---------- */
  function shrink(canvas, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    if (scale === 1) return canvas;
    const c = document.createElement("canvas");
    c.width = Math.round(canvas.width * scale);
    c.height = Math.round(canvas.height * scale);
    c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  }
  function canvasToImage(canvas) {
    const url = canvas.toDataURL("image/jpeg", 0.82);
    return { mimeType: "image/jpeg", data: url.split(",")[1] };
  }

  function decode(blob) {
    const url = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("decode"));
      i.src = url;
    }).finally(() => setTimeout(() => URL.revokeObjectURL(url), 0));
  }

  /* Compresses a photo to a JPEG no bigger than maxSide pixels on its longest edge.
     HEIC (iPhone) is decoded natively where possible, otherwise converted first. */
  async function imageToJpeg(file, maxSide = 1600, progress = () => {}) {
    let img;
    try {
      img = await decode(file);
    } catch {
      if (!isHeic(file)) throw new UploadError(`${file.name} couldn't be opened. Try saving it as a JPG or PNG.`);
      progress("Converting the iPhone photo…", null);
      try {
        const heic2any = await loadScript(HEIC2ANY, "heic2any", "Couldn't load the iPhone photo converter. Check your internet connection.");
        const out = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.85 });
        img = await decode(Array.isArray(out) ? out[0] : out);
      } catch (err) {
        if (err instanceof UploadError) throw err;
        throw new UploadError(`${file.name} couldn't be converted. On your iPhone, set Settings › Camera › Formats to "Most Compatible", or share the photo as a JPG.`);
      }
    }
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvasToImage(canvas);
  }

  /* On-device text recognition (no AI, no key). progress(message, percent 0-100). */
  let tesseractWorker;
  async function ocr(images, progress = () => {}, label = "photo") {
    progress("Loading the text reader…", 2);
    const Tesseract = await loadScript(TESSERACT, "Tesseract", "Couldn't load the text reader. Check your internet connection and try again.");
    let current = 0;
    if (!tesseractWorker) {
      tesseractWorker = Tesseract.createWorker("eng", 1, {
        workerPath: TESSERACT_WORKER,
        logger: (m) => {
          if (m.status === "recognizing text") {
            const pct = Math.round(((current + m.progress) / images.length) * 100);
            ocr.onTick && ocr.onTick(`Reading ${label} ${current + 1} of ${images.length}…`, pct);
          }
        },
      });
    }
    ocr.onTick = progress;
    const worker = await tesseractWorker;
    const out = [];
    for (let i = 0; i < images.length; i++) {
      current = i;
      progress(`Reading ${label} ${i + 1} of ${images.length}…`, Math.round((i / images.length) * 100));
      const { data } = await worker.recognize(`data:${images[i].mimeType};base64,${images[i].data}`);
      out.push(data.text.trim());
    }
    progress("Done", 100);
    return out.join("\n\n").trim();
  }

  /* Groq vision when the key has a vision model, otherwise (or if it fails) Tesseract. */
  async function readImages(images, progress = () => {}, label = "photo") {
    if (AI.getKey() && (await AI.visionModel())) {
      try {
        const out = [];
        for (let i = 0; i < images.length; i += 3) {
          const batch = images.slice(i, i + 3);
          const pct = Math.round((i / images.length) * 100);
          progress(images.length > 1 ? `Reading ${label}s ${i + 1}-${i + batch.length} of ${images.length} with AI vision…` : `Reading your ${label} with AI vision…`, pct);
          out.push(await AI.transcribe(batch, (msg) => progress(msg, pct)));
        }
        const text = out.join("\n\n").trim();
        if (text) { progress("Done", 100); return text; }
      } catch (err) {
        console.warn("Reforge: AI vision failed, using on-device text recognition", err);
      }
    }
    return ocr(images, progress, label);
  }

  /* Runs one file's job; fails with a clear message if it stops making progress. */
  function withStallGuard(name, job) {
    return new Promise((resolve, reject) => {
      let timer;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => reject(new UploadError(`${name} stopped responding. Try again, or split it into smaller files.`)), STALL_MS);
      };
      arm();
      job(arm).then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  /* ---------- Entry point ----------
     Reads each file and reports progress as onProgress({ index, total, name, message, percent }).
     Returns { results: [{ name, text, note }], errors: [{ name, message }] }; one bad file
     doesn't stop the others. Photos are read together as one result. */
  async function extract(files, onProgress = () => {}) {
    files = [...files];
    const photos = files.filter((f) => kindOf(f) === "image");
    const others = files.filter((f) => kindOf(f) !== "image");
    const total = others.length + (photos.length ? 1 : 0);
    const results = [], errors = [];
    let index = 0;

    for (const file of others) {
      const report = (message, percent) => onProgress({ index, total, name: file.name, message, percent });
      try {
        const kind = kindOf(file);
        if (!kind) throw new UploadError(`${file.name} isn't a file Reforge can read. Use PDF, Word (.docx), text or photos.`);
        if (kind === "doc") throw new UploadError(`${file.name} is an old Word format (.doc). Open it in Word and save it as .docx first.`);
        checkSize(file, kind);
        const out = await withStallGuard(file.name, async (tick) => {
          const p = (m, pct) => { tick(); report(m, pct); };
          p(`Reading ${file.name}…`, 1);
          if (kind === "pdf") return { text: await readPdf(file, p) };
          if (kind === "docx") return readDocx(file, p);
          const text = await file.text();
          p("Done", 100);
          return { text };
        });
        if (!out.text.trim()) throw new UploadError(`${file.name} has no text Reforge can find.`);
        results.push({ name: file.name, text: out.text.trim(), note: out.note || "" });
        report("Done", 100);
      } catch (err) {
        console.error(`Reforge: couldn't read ${file.name}`, err);
        errors.push({ name: file.name, message: err instanceof UploadError ? err.message : `${file.name} couldn't be read. Try again, or copy and paste the text.` });
      }
      index++;
    }

    if (photos.length) {
      const name = photos.length === 1 ? photos[0].name : `${photos.length} photos`;
      const report = (message, percent) => onProgress({ index, total, name, message, percent });
      try {
        if (photos.length > MAX_IMAGES) throw new UploadError(`That's ${photos.length} photos. Upload up to ${MAX_IMAGES} at a time.`);
        photos.forEach((f) => checkSize(f, "image"));
        const text = await withStallGuard(name, async (tick) => {
          const p = (m, pct) => { tick(); report(m, pct); };
          const prepared = [];
          for (const [i, f] of photos.entries()) {
            p(`Preparing photo ${i + 1} of ${photos.length}…`, Math.round((i / photos.length) * 15));
            prepared.push(await imageToJpeg(f, 1600, p));
          }
          return readImages(prepared, (m, pct) => p(m, pct == null ? null : 15 + Math.round(pct * 0.85)));
        });
        if (!text.trim()) throw new UploadError("No text was found in the photos. Try a clearer, closer photo in good light.");
        results.push({ name, text, note: "" });
        report("Done", 100);
      } catch (err) {
        console.error("Reforge: couldn't read photos", err);
        errors.push({ name, message: err instanceof UploadError ? err.message : "The photos couldn't be read. Try again, or type the notes in." });
      }
    }
    return { results, errors };
  }

  return { extract, imageToJpeg, ocr, ACCEPT, UploadError, kindOf };
})();
