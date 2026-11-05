/* Reforge uploads: turn PDFs, Word documents, text files and photos into editable text.
   Nothing here needs the AI:
   - PDF: pdf.js (cdnjs). Scanned PDFs are rendered to images and read like photos.
   - Word (.docx): mammoth.js (cdnjs).
   - Photos: compressed, then read with Tesseract.js (cdnjs) in the browser. If the Groq key
     has a vision model, that reads them instead (better on handwriting and diagrams), with
     Tesseract as the fallback.
   Libraries load only when a file needs them. */

const Upload = (() => {
  const CDN = "https://cdnjs.cloudflare.com/ajax/libs";
  const PDFJS = `${CDN}/pdf.js/3.11.174/pdf.min.js`;
  const PDFJS_WORKER = `${CDN}/pdf.js/3.11.174/pdf.worker.min.js`;
  const MAMMOTH = `${CDN}/mammoth/1.13.0/mammoth.browser.min.js`;
  const TESSERACT = `${CDN}/tesseract.js/7.0.0/tesseract.min.js`;
  const TESSERACT_WORKER = `${CDN}/tesseract.js/7.0.0/worker.min.js`;
  const MB = 1024 * 1024;
  const LIMITS = { pdf: 30 * MB, docx: 20 * MB, txt: 5 * MB, image: 15 * MB };
  const MAX_IMAGES = 12;
  const MAX_SCAN_PAGES = 15;

  class UploadError extends Error {}

  const ACCEPT = ".pdf,.docx,.txt,.md,image/png,image/jpeg,image/webp,image/heic,image/heif";

  function kindOf(file) {
    const name = file.name.toLowerCase();
    if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
    if (name.endsWith(".docx")) return "docx";
    if (name.endsWith(".doc")) return "doc";
    if (file.type.startsWith("text/") || name.endsWith(".txt") || name.endsWith(".md")) return "txt";
    if (file.type.startsWith("image/") || /\.(png|jpe?g|webp|heic|heif)$/.test(name)) return "image";
    return null;
  }

  const sizeText = (bytes) => `${Math.round(bytes / MB)} MB`;
  function checkSize(file, kind) {
    if (file.size > LIMITS[kind]) {
      throw new UploadError(`${file.name} is ${sizeText(file.size)}. The limit for this kind of file is ${sizeText(LIMITS[kind])}. Split it into smaller files.`);
    }
  }

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
  async function readPdf(file, onStatus) {
    const pdfjs = await loadScript(PDFJS, "pdfjsLib", "Couldn't load the PDF reader. Check your internet connection.");
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise.catch(() => {
      throw new UploadError(`${file.name} couldn't be opened. It may be damaged or password-protected.`);
    });
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      onStatus(`Reading page ${i} of ${doc.numPages}…`);
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
    }
    const text = pages.join("\n\n").trim();
    if (text.replace(/\s/g, "").length > doc.numPages * 40) return text;

    // Little or no text: it's a scan. Render the pages and read them like photos.
    const count = Math.min(doc.numPages, MAX_SCAN_PAGES);
    const images = [];
    for (let i = 1; i <= count; i++) {
      onStatus(`Preparing scanned page ${i} of ${count}…`);
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1.6 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      images.push(canvasToImage(shrink(canvas, 1800)));
    }
    const read = await readImages(images, onStatus, "scanned page");
    return doc.numPages > count ? `${read}\n\n[Only the first ${count} pages were read. Upload the rest as a separate file.]` : read;
  }

  /* ---------- Word ---------- */
  async function readDocx(file) {
    const mammoth = await loadScript(MAMMOTH, "mammoth", "Couldn't load the Word reader. Check your internet connection.");
    let result;
    try {
      result = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
    } catch {
      throw new UploadError(`${file.name} couldn't be opened. Save it again as .docx and retry.`);
    }
    // keep headings and lists, drop everything else
    const doc = new DOMParser().parseFromString(result.value, "text/html");
    const out = [];
    doc.body.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, td").forEach((el) => {
      if (el.closest("li") && el.tagName !== "LI") return;
      const t = el.textContent.replace(/\s+/g, " ").trim();
      if (!t) return;
      if (/^H\d$/.test(el.tagName)) out.push(`\n# ${t}`);
      else if (el.tagName === "LI") out.push(`- ${t}`);
      else out.push(t);
    });
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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

  /* Compresses a photo to a JPEG no bigger than maxSide pixels on its longest edge. */
  async function imageToJpeg(file, maxSide = 1600) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new UploadError(`${file.name} couldn't be opened. Try a JPG or PNG.`));
        i.src = url;
      });
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvasToImage(canvas);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* On-device text recognition (no AI, no key). */
  let tesseractWorker;
  async function ocr(images, onStatus = () => {}, label = "photo") {
    const Tesseract = await loadScript(TESSERACT, "Tesseract", "Couldn't load the text reader. Check your internet connection.");
    let current = 0;
    if (!tesseractWorker) {
      onStatus("Loading the text reader…");
      tesseractWorker = Tesseract.createWorker("eng", 1, {
        workerPath: TESSERACT_WORKER,
        logger: (m) => {
          if (m.status === "recognizing text") onStatus(`Reading ${label} ${current + 1} of ${images.length}… ${Math.round(m.progress * 100)}%`);
        },
      });
    }
    const worker = await tesseractWorker;
    const out = [];
    for (let i = 0; i < images.length; i++) {
      current = i;
      onStatus(`Reading ${label} ${i + 1} of ${images.length}…`);
      const { data } = await worker.recognize(`data:${images[i].mimeType};base64,${images[i].data}`);
      out.push(data.text.trim());
    }
    return out.join("\n\n").trim();
  }

  /* Groq vision when the key has a vision model, otherwise (or if it fails) Tesseract. */
  async function readImages(images, onStatus, label = "photo") {
    if (AI.getKey() && (await AI.visionModel())) {
      try {
        const out = [];
        for (let i = 0; i < images.length; i += 3) {
          const batch = images.slice(i, i + 3);
          onStatus(images.length > 1 ? `Reading ${label}s ${i + 1}-${i + batch.length} of ${images.length} with AI vision…` : `Reading your ${label} with AI vision…`);
          out.push(await AI.transcribe(batch, (msg) => onStatus(msg)));
        }
        const text = out.join("\n\n").trim();
        if (text) return text;
      } catch (err) {
        console.warn("Reforge: AI vision failed, using on-device text recognition", err);
      }
    }
    return ocr(images, onStatus, label);
  }

  /* ---------- Entry point ---------- */
  /* Returns [{ name, text }] in the order given. onStatus(message) reports progress. */
  async function extract(files, onStatus = () => {}) {
    files = [...files];
    const photos = files.filter((f) => kindOf(f) === "image");
    if (photos.length > MAX_IMAGES) throw new UploadError(`That's ${photos.length} photos. Upload up to ${MAX_IMAGES} at a time.`);
    const results = [];

    for (const file of files) {
      const kind = kindOf(file);
      if (!kind) throw new UploadError(`${file.name} isn't a file Reforge can read. Use PDF, Word (.docx), text or photos.`);
      if (kind === "doc") throw new UploadError(`${file.name} is an old Word format. Open it in Word and save it as .docx first.`);
      checkSize(file, kind);
      if (kind === "image") continue;
      onStatus(`Reading ${file.name}…`);
      const text = kind === "pdf" ? await readPdf(file, onStatus) : kind === "docx" ? await readDocx(file) : await file.text();
      if (!text.trim()) throw new UploadError(`${file.name} has no text Reforge can find.`);
      results.push({ name: file.name, text: text.trim() });
    }

    if (photos.length) {
      const prepared = [];
      for (const [i, f] of photos.entries()) {
        onStatus(`Compressing photo ${i + 1} of ${photos.length}…`);
        prepared.push(await imageToJpeg(f));
      }
      const text = await readImages(prepared, onStatus);
      if (!text.trim()) throw new UploadError("No text was found in those photos. Try a clearer, closer photo.");
      results.push({ name: photos.map((f) => f.name).join(", "), text });
    }
    return results;
  }

  return { extract, imageToJpeg, ocr, ACCEPT, UploadError, kindOf };
})();
