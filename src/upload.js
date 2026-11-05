/* Reforge uploads: turn PDFs, photos, Word documents and text files into editable text.
   PDFs use pdf.js (loaded from cdnjs only when needed). Word files are unzipped with the
   browser's built-in DecompressionStream. Photos are read by Gemini. */

const Upload = (() => {
  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
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

  /* ---------- PDF ---------- */
  let pdfjsPromise;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    pdfjsPromise =
      pdfjsPromise ||
      new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = PDFJS;
        s.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
          resolve(window.pdfjsLib);
        };
        s.onerror = () => reject(new UploadError("Couldn't load the PDF reader. Check your internet connection."));
        document.head.appendChild(s);
      });
    return pdfjsPromise;
  }

  async function readPdf(file, onStatus) {
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise.catch(() => {
      throw new UploadError(`${file.name} couldn't be opened. It may be damaged or password-protected.`);
    });
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      onStatus(`Reading page ${i} of ${doc.numPages}…`);
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // rebuild lines from text positions
      let lastY = null, line = "", lines = [];
      content.items.forEach((it) => {
        const y = Math.round(it.transform[5]);
        if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line.trimEnd()); line = ""; }
        line += it.str + (it.hasEOL ? "" : "");
        lastY = y;
      });
      if (line) lines.push(line.trimEnd());
      pages.push(lines.join("\n").replace(/\n{3,}/g, "\n\n"));
    }
    const text = pages.join("\n\n").trim();
    if (text.replace(/\s/g, "").length > doc.numPages * 40) return text;

    // Little or no text: it's probably a scan. Render pages and read them with Gemini.
    if (!Gemini.getKey()) throw new UploadError(`${file.name} is a scanned PDF. Add your Gemini key in Settings so Reforge can read it.`);
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
      images.push(canvasToImage(canvas));
    }
    onStatus("Reading the scanned pages with Gemini…");
    const read = await transcribeInBatches(images, onStatus);
    return doc.numPages > count ? `${read}\n\n[Only the first ${count} pages were read. Upload the rest as a separate file.]` : read;
  }

  /* ---------- DOCX (zip) ---------- */
  async function inflate(bytes) {
    if (!("DecompressionStream" in window)) throw new UploadError("This browser can't open Word files. Copy and paste the text instead.");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzipEntry(buffer, wanted) {
    const view = new DataView(buffer);
    let eocd = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 66000); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new UploadError("This doesn't look like a Word document.");
    const entries = view.getUint16(eocd + 10, true);
    let ptr = view.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    for (let n = 0; n < entries; n++) {
      if (view.getUint32(ptr, true) !== 0x02014b50) break;
      const method = view.getUint16(ptr + 10, true);
      const compSize = view.getUint32(ptr + 20, true);
      const nameLen = view.getUint16(ptr + 28, true);
      const extraLen = view.getUint16(ptr + 30, true);
      const commentLen = view.getUint16(ptr + 32, true);
      const localOffset = view.getUint32(ptr + 42, true);
      const name = dec.decode(new Uint8Array(buffer, ptr + 46, nameLen));
      if (name === wanted) {
        const lNameLen = view.getUint16(localOffset + 26, true);
        const lExtraLen = view.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + lNameLen + lExtraLen;
        const data = new Uint8Array(buffer, start, compSize);
        if (method === 0) return dec.decode(data);
        if (method === 8) return dec.decode(await inflate(data));
        throw new UploadError("This Word document uses a format Reforge can't read. Copy and paste the text instead.");
      }
      ptr += 46 + nameLen + extraLen + commentLen;
    }
    throw new UploadError("This doesn't look like a Word document.");
  }

  async function readDocx(file) {
    const xml = await unzipEntry(await file.arrayBuffer(), "word/document.xml");
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const paras = [...doc.getElementsByTagName("w:p")];
    const lines = paras.map((p) => {
      let text = "";
      p.querySelectorAll("*").forEach((el) => {
        if (el.tagName === "w:t") text += el.textContent;
        else if (el.tagName === "w:tab") text += "\t";
        else if (el.tagName === "w:br") text += "\n";
      });
      const style = p.getElementsByTagName("w:pStyle")[0]?.getAttribute("w:val") || "";
      if (!text.trim()) return "";
      if (/^(Heading|Title)/i.test(style)) return `# ${text.trim()}`;
      if (p.getElementsByTagName("w:numPr").length || /List/i.test(style)) return `- ${text.trim()}`;
      return text;
    });
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  /* ---------- Images ---------- */
  function canvasToImage(canvas) {
    const url = canvas.toDataURL("image/jpeg", 0.85);
    return { mimeType: "image/jpeg", data: url.split(",")[1] };
  }

  async function imageToJpeg(file, maxSide = 2000) {
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

  async function transcribeInBatches(images, onStatus) {
    const out = [];
    for (let i = 0; i < images.length; i += 4) {
      const batch = images.slice(i, i + 4);
      if (images.length > 4) onStatus(`Reading pages ${i + 1}-${i + batch.length} of ${images.length} with Gemini…`);
      out.push(await AI.transcribe(batch, () => onStatus("Gemini is busy. Trying again in a few seconds…")));
    }
    return out.join("\n\n").trim();
  }

  /* ---------- Entry point ---------- */
  /* Returns [{ name, text }] in the order given. onStatus(message) reports progress. */
  async function extract(files, onStatus = () => {}) {
    files = [...files];
    const images = files.filter((f) => kindOf(f) === "image");
    if (images.length > MAX_IMAGES) throw new UploadError(`That's ${images.length} photos. Upload up to ${MAX_IMAGES} at a time.`);
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

    if (images.length) {
      if (!Gemini.getKey()) throw new UploadError("Reading photos uses Gemini. Add your key in Settings first.");
      const prepared = [];
      for (const [i, f] of images.entries()) {
        onStatus(`Preparing photo ${i + 1} of ${images.length}…`);
        prepared.push(await imageToJpeg(f));
      }
      onStatus(images.length === 1 ? "Reading your photo with Gemini…" : "Reading your photos with Gemini…");
      const text = await transcribeInBatches(prepared, onStatus);
      results.push({ name: images.map((f) => f.name).join(", "), text });
    }
    return results;
  }

  return { extract, imageToJpeg, ACCEPT, UploadError, kindOf };
})();
