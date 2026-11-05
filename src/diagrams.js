/* Reforge diagrams: draws reference-sheet diagrams as inline SVG from a small spec.
   Gemini never writes SVG itself; it picks a kind and gives numbers and labels,
   and expressions are parsed by a tiny safe evaluator (no eval). */

const Diagrams = (() => {
  const W = 320, H = 240, PAD = 28;
  let uid = 0;
  const esc = R.esc;

  /* ---------- Expression parser: f(x) ---------- */
  const FUNCS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
    sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10, log10: Math.log10, log2: Math.log2,
  };
  const CONSTS = { pi: Math.PI, "π": Math.PI, e: Math.E };

  function tokenize(src) {
    const tokens = [];
    const s = src.replace(/\s+/g, "").replace(/[−–]/g, "-").replace(/[×·]/g, "*").replace(/÷/g, "/").replace(/²/g, "^2").replace(/³/g, "^3").replace(/√/g, "sqrt");
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/[0-9.]/.test(c)) {
        let j = i;
        while (j < s.length && /[0-9.]/.test(s[j])) j++;
        tokens.push({ t: "num", v: parseFloat(s.slice(i, j)) });
        i = j;
      } else if (/[a-zπ]/i.test(c)) {
        let j = i;
        while (j < s.length && /[a-z0-9π]/i.test(s[j])) j++;
        let word = s.slice(i, j).toLowerCase();
        // split things like "xsin" or "2pix" into known pieces
        while (word) {
          const fn = Object.keys(FUNCS).sort((a, b) => b.length - a.length).find((f) => word.startsWith(f));
          const k = fn || (word.startsWith("pi") ? "pi" : word[0]);
          tokens.push({ t: fn ? "fn" : "id", v: k });
          word = word.slice(k.length);
        }
        i = j;
      } else if ("+-*/^(),".includes(c)) {
        tokens.push({ t: c });
        i++;
      } else if (c === "y" || c === "=") {
        i++;
      } else throw new Error("Unexpected " + c);
    }
    return tokens;
  }

  function compile(src) {
    // accept "y = ..." or "f(x) = ..."
    const body = String(src).replace(/^\s*(y|f\s*\(\s*x\s*\))\s*=/i, "");
    const tk = tokenize(body);
    let p = 0;
    const peek = () => tk[p];
    const take = (t) => (tk[p] && tk[p].t === t ? tk[p++] : null);

    function expr() {
      let node = term();
      for (;;) {
        if (take("+")) { const a = node, b = term(); node = (x) => a(x) + b(x); }
        else if (take("-")) { const a = node, b = term(); node = (x) => a(x) - b(x); }
        else return node;
      }
    }
    function term() {
      let node = unary();
      for (;;) {
        if (take("*")) { const a = node, b = unary(); node = (x) => a(x) * b(x); }
        else if (take("/")) { const a = node, b = unary(); node = (x) => a(x) / b(x); }
        else if (peek() && ["num", "id", "fn", "("].includes(peek().t)) { const a = node, b = power(); node = (x) => a(x) * b(x); }
        else return node;
      }
    }
    function unary() {
      if (take("-")) { const a = unary(); return (x) => -a(x); }
      if (take("+")) return unary();
      return power();
    }
    function power() {
      const base = primary();
      if (take("^")) { const ex = unary(); return (x) => Math.pow(base(x), ex(x)); }
      return base;
    }
    function primary() {
      const tok = tk[p++];
      if (!tok) throw new Error("Unexpected end");
      if (tok.t === "num") return () => tok.v;
      if (tok.t === "id") {
        if (tok.v === "x") return (x) => x;
        if (tok.v in CONSTS) { const v = CONSTS[tok.v]; return () => v; }
        throw new Error("Unknown " + tok.v);
      }
      if (tok.t === "fn") {
        const f = FUNCS[tok.v];
        if (take("(")) { const a = expr(); if (!take(")")) throw new Error("Missing )"); return (x) => f(a(x)); }
        const a = power();
        return (x) => f(a(x));
      }
      if (tok.t === "(") { const a = expr(); if (!take(")")) throw new Error("Missing )"); return a; }
      throw new Error("Unexpected " + tok.t);
    }
    const fn = expr();
    if (p !== tk.length) throw new Error("Unexpected input");
    return fn;
  }

  /* ---------- Helpers ---------- */
  const fmt = (n) => (Math.abs(n) >= 1000 || Number.isInteger(n) ? String(Math.round(n)) : String(+n.toFixed(2)));
  function niceStep(range) {
    const raw = range / 6;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }
  const svg = (inner, label, vb = `0 0 ${W} ${H}`) =>
    `<svg class="diagram" viewBox="${vb}" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
  const text = (x, y, s, anchor = "middle", cls = "d-label") =>
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" class="${cls}">${esc(s)}</text>`;

  /* ---------- Graph ---------- */
  function graph(d) {
    const fns = d.expressions.map((e) => { try { return compile(e); } catch { return null; } }).filter(Boolean);
    let xMin = d.xMin ?? -5, xMax = d.xMax ?? 5;
    if (!(xMax > xMin)) [xMin, xMax] = [-5, 5];
    const pts = d.points || [];
    pts.forEach((pt) => { if (pt.x < xMin) xMin = pt.x - 1; if (pt.x > xMax) xMax = pt.x + 1; });

    // y range: fit the key points when there are enough, otherwise the curve itself
    let yMin = d.yMin, yMax = d.yMax;
    if (!(yMax > yMin)) {
      const ys = [];
      const keyYs = pts.map((pt) => (pt.y !== undefined ? pt.y : fns[0] ? fns[0](pt.x) : NaN)).filter(isFinite);
      if (keyYs.length >= 2) {
        ys.push(...keyYs);
      } else {
        fns.forEach((f) => { for (let i = 0; i <= 120; i++) { const y = f(xMin + ((xMax - xMin) * i) / 120); if (isFinite(y)) ys.push(y); } });
        ys.push(...keyYs);
      }
      ys.sort((a, b) => a - b);
      // trim the extreme 3% so asymptotes don't flatten the picture
      const lo = ys[Math.floor(ys.length * 0.03)] ?? -5, hi = ys[Math.ceil(ys.length * 0.97) - 1] ?? 5;
      yMin = Math.min(lo, 0); yMax = Math.max(hi, 0);
      const padY = (yMax - yMin || 4) * (keyYs.length >= 2 ? 0.45 : 0.12);
      yMin -= padY; yMax += padY;
    }
    const sx = (x) => PAD + ((x - xMin) / (xMax - xMin)) * (W - 2 * PAD);
    const sy = (y) => H - PAD - ((y - yMin) / (yMax - yMin)) * (H - 2 * PAD);

    const arrowId = `d-arrow-${++uid}`, clipId = `d-clip-${uid}`;
    let out = "";
    // grid + ticks
    const xs = niceStep(xMax - xMin), ys = niceStep(yMax - yMin);
    const ax = Math.min(Math.max(0, xMin), xMax), ay = Math.min(Math.max(0, yMin), yMax);
    for (let x = Math.ceil(xMin / xs) * xs; x <= xMax + 1e-9; x += xs) {
      out += `<line class="d-grid" x1="${sx(x)}" y1="${PAD}" x2="${sx(x)}" y2="${H - PAD}"/>`;
      if (Math.abs(x) > 1e-9) out += text(sx(x), Math.min(H - PAD + 14, sy(ay) + 14), fmt(x), "middle", "d-tick");
    }
    for (let y = Math.ceil(yMin / ys) * ys; y <= yMax + 1e-9; y += ys) {
      out += `<line class="d-grid" x1="${PAD}" y1="${sy(y)}" x2="${W - PAD}" y2="${sy(y)}"/>`;
      if (Math.abs(y) > 1e-9) out += text(Math.max(PAD - 4, sx(ax) - 5), sy(y) + 4, fmt(y), "end", "d-tick");
    }
    out += `<line class="d-axis" x1="${PAD}" y1="${sy(ay)}" x2="${W - PAD + 6}" y2="${sy(ay)}" marker-end="url(#${arrowId})"/>`;
    out += `<line class="d-axis" x1="${sx(ax)}" y1="${H - PAD}" x2="${sx(ax)}" y2="${PAD - 6}" marker-end="url(#${arrowId})"/>`;
    out += text(W - PAD + 8, sy(ay) - 6, "x", "start", "d-axis-label") + text(sx(ax) + 7, PAD - 4, "y", "start", "d-axis-label");

    // curves (break the path where it leaves the box or isn't finite)
    fns.forEach((f, idx) => {
      let path = "", pen = false;
      const N = 240;
      for (let i = 0; i <= N; i++) {
        const x = xMin + ((xMax - xMin) * i) / N;
        const y = f(x);
        const ok = isFinite(y) && y >= yMin - 3 * (yMax - yMin) && y <= yMax + 3 * (yMax - yMin);
        if (!ok) { pen = false; continue; }
        path += `${pen ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`;
        pen = true;
      }
      out += `<path class="d-curve d-curve-${idx}" d="${path}" clip-path="url(#${clipId})"/>`;
    });

    // labelled points: try a few positions and keep the first that doesn't collide
    const placed = [];
    const overlaps = (b) => b.x < PAD - 24 || b.x + b.w > W - 2 || b.y < 2 || b.y + b.h > H - 2 ||
      placed.some((p) => b.x < p.x + p.w && b.x + b.w > p.x && b.y < p.y + p.h && b.y + b.h > p.y);
    const marks = pts
      .map((pt) => ({ pt, y: pt.y !== undefined ? pt.y : fns[0] ? fns[0](pt.x) : 0 }))
      .filter((m) => isFinite(m.y) && m.y >= yMin && m.y <= yMax);
    marks.forEach((m) => placed.push({ x: sx(m.pt.x) - 4, y: sy(m.y) - 4, w: 8, h: 8 }));
    marks.forEach(({ pt, y }) => {
      const X = sx(pt.x), Y = sy(y);
      const label = pt.label || `(${fmt(pt.x)}, ${fmt(y)})`;
      const w = label.length * 6.1 + 4, h = 13;
      const tries = [[8, -16], [-8 - w, -16], [8, 5], [-8 - w, 5], [-w / 2, -22], [-w / 2, 10]];
      let best = tries[0];
      for (const [dx, dy] of tries) {
        if (!overlaps({ x: X + dx, y: Y + dy, w, h })) { best = [dx, dy]; break; }
      }
      placed.push({ x: X + best[0], y: Y + best[1], w, h });
      out += `<circle class="d-point" cx="${X.toFixed(1)}" cy="${Y.toFixed(1)}" r="3.5"/>`;
      out += text(X + best[0] + 2, Y + best[1] + 10, label, "start", "d-label d-halo");
    });

    return svg(`<defs><clipPath id="${clipId}"><rect x="${PAD}" y="${PAD - 6}" width="${W - 2 * PAD}" height="${H - 2 * PAD + 6}"/></clipPath><marker id="${arrowId}" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 Z" class="d-arrowhead"/></marker></defs>${out}`, d.caption || "Graph");
  }

  /* ---------- Shapes ---------- */
  function rightTriangle(d) {
    const [a = "a", b = "b", c = "c", angle = ""] = d.labels;
    const A = [60, 200], B = [270, 200], C = [270, 50]; // right angle at B
    let out = `<path class="d-shape" d="M${A} L${B} L${C} Z"/>`;
    out += `<path class="d-thin" d="M${B[0] - 14},${B[1]} L${B[0] - 14},${B[1] - 14} L${B[0]},${B[1] - 14}"/>`;
    out += text(B[0] + 10, (B[1] + C[1]) / 2 + 4, a, "start");
    out += text((A[0] + B[0]) / 2, B[1] + 20, b);
    out += text((A[0] + C[0]) / 2 - 12, (A[1] + C[1]) / 2 - 6, c, "end");
    if (angle) {
      out += `<path class="d-thin" d="M${A[0] + 34},${A[1]} A34,34 0 0 0 ${A[0] + 34 * Math.cos(0.62)},${A[1] - 34 * Math.sin(0.62)}"/>`;
      out += text(A[0] + 44, A[1] - 9, angle, "start");
    }
    return svg(out, d.caption || "Right-angled triangle");
  }

  function triangle(d) {
    const [a = "a", b = "b", c = "c", angA = "A", angB = "B", angC = "C"] = d.labels;
    const A = [50, 200], B = [280, 200], C = [190, 45];
    let out = `<path class="d-shape" d="M${A} L${B} L${C} Z"/>`;
    out += text(A[0] - 8, A[1] + 16, angA, "end") + text(B[0] + 8, B[1] + 16, angB, "start") + text(C[0], C[1] - 10, angC);
    out += text((B[0] + C[0]) / 2 + 12, (B[1] + C[1]) / 2, a, "start"); // a opposite A
    out += text((A[0] + C[0]) / 2 - 12, (A[1] + C[1]) / 2, b, "end"); // b opposite B
    out += text((A[0] + B[0]) / 2, A[1] + 20, c); // c opposite C
    return svg(out, d.caption || "Triangle");
  }

  function circle(d) {
    const [r = "r", centre = "O"] = d.labels;
    const cx = 160, cy = 120, rad = 88;
    let out = `<circle class="d-shape" cx="${cx}" cy="${cy}" r="${rad}"/>`;
    out += `<circle class="d-point" cx="${cx}" cy="${cy}" r="3.5"/>`;
    out += `<line class="d-shape" x1="${cx}" y1="${cy}" x2="${cx + rad * 0.866}" y2="${cy - rad * 0.5}"/>`;
    out += text(cx + rad * 0.45, cy - rad * 0.25 - 8, r, "middle", "d-label d-halo") + text(cx - 6, cy + 18, centre, "end");
    return svg(out, d.caption || "Circle");
  }

  function numberLine(d) {
    const pts = d.points || [];
    let xMin = d.xMin ?? Math.min(-5, ...pts.map((p) => p.x - 1));
    let xMax = d.xMax ?? Math.max(5, ...pts.map((p) => p.x + 1));
    if (!(xMax > xMin)) [xMin, xMax] = [-5, 5];
    const y = 70, h = 130;
    const sx = (x) => PAD + ((x - xMin) / (xMax - xMin)) * (W - 2 * PAD);
    let out = `<line class="d-axis" x1="${PAD - 10}" y1="${y}" x2="${W - PAD + 10}" y2="${y}"/>`;
    const step = niceStep(xMax - xMin);
    for (let x = Math.ceil(xMin / step) * step; x <= xMax + 1e-9; x += step) {
      out += `<line class="d-axis" x1="${sx(x)}" y1="${y - 5}" x2="${sx(x)}" y2="${y + 5}"/>` + text(sx(x), y + 22, fmt(x), "middle", "d-tick");
    }
    pts.forEach((p, i) => {
      out += `<circle class="d-point" cx="${sx(p.x)}" cy="${y}" r="5"/>` + text(sx(p.x), y - 14 - (i % 2) * 14, p.label || fmt(p.x), "middle", "d-label d-halo");
    });
    return svg(out, d.caption || "Number line", `0 0 ${W} ${h}`);
  }


  /* ---------- Text wrapping for SVG ---------- */
  function wrap(str, max) {
    const words = String(str || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    words.forEach((w) => {
      if ((line + " " + w).trim().length > max && line) { lines.push(line); line = w; }
      else line = (line + " " + w).trim();
    });
    if (line) lines.push(line);
    return lines.slice(0, 3);
  }
  function block(x, y, str, max, anchor = "middle", cls = "d-label", lh = 12) {
    const lines = wrap(str, max);
    const top = y - ((lines.length - 1) * lh) / 2;
    return `<text text-anchor="${anchor}" class="${cls}">${lines.map((l, i) => `<tspan x="${x.toFixed(1)}" y="${(top + i * lh).toFixed(1)}">${esc(l)}</tspan>`).join("")}</text>`;
  }

  /* ---------- Timeline (history) ---------- */
  function timeline(d) {
    const items = (d.items || []).slice(0, 8);
    if (!items.length) return "";
    const h = 220, y = 110;
    const x0 = 22, x1 = W - 22;
    const step = items.length > 1 ? (x1 - x0) / (items.length - 1) : 0;
    let out = `<line class="d-axis" x1="${x0 - 8}" y1="${y}" x2="${x1 + 8}" y2="${y}"/>`;
    items.forEach((it, i) => {
      const x = items.length > 1 ? x0 + step * i : W / 2;
      const up = i % 2 === 0;
      const max = items.length > 5 ? 11 : 15;
      out += `<line class="d-thin" x1="${x}" y1="${y}" x2="${x}" y2="${up ? y - 22 : y + 22}"/>`;
      out += `<circle class="d-point" cx="${x}" cy="${y}" r="4.5"/>`;
      out += text(x, up ? y - 28 : y + 34, it.label, "middle", "d-label d-strong");
      if (it.detail) out += block(x, up ? y - 62 : y + 62, it.detail, max, "middle", "d-small");
    });
    return svg(out, d.caption || "Timeline", `0 0 ${W} ${h}`);
  }

  /* ---------- Flow: steps in order ---------- */
  function flow(d) {
    const items = (d.items || []).slice(0, 6);
    if (!items.length) return "";
    const bw = 220, bh = 34, gap = 16;
    const h = items.length * (bh + gap) + 8;
    const x = (W - bw) / 2;
    let out = "";
    items.forEach((it, i) => {
      const y = 4 + i * (bh + gap);
      out += `<rect class="d-box" x="${x}" y="${y}" width="${bw}" height="${bh}" rx="8"/>`;
      out += block(W / 2, y + bh / 2 + 4, it.detail ? `${it.label}: ${it.detail}` : it.label, 34, "middle", "d-label", 11);
      if (i < items.length - 1) out += `<path class="d-arrow-line" d="M${W / 2},${y + bh + 2} L${W / 2},${y + bh + gap - 3}"/><path class="d-arrowhead" d="M${W / 2 - 4},${y + bh + gap - 7} L${W / 2},${y + bh + gap - 1} L${W / 2 + 4},${y + bh + gap - 7}Z"/>`;
    });
    return svg(out, d.caption || "Process", `0 0 ${W} ${h}`);
  }

  /* ---------- Cycle: steps that loop ---------- */
  function cycle(d) {
    const items = (d.items || []).slice(0, 6);
    if (items.length < 2) return flow(d);
    const cx = W / 2, cy = 122, r = 82, h = 250;
    let out = `<circle class="d-ring" cx="${cx}" cy="${cy}" r="${r}"/>`;
    items.forEach((it, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / items.length;
      const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      // arrowhead between this item and the next, pointing clockwise
      const m = a + Math.PI / items.length;
      const ax = cx + r * Math.cos(m), ay = cy + r * Math.sin(m);
      const deg = (m * 180) / Math.PI + 90;
      out += `<path class="d-arrowhead" transform="translate(${ax.toFixed(1)},${ay.toFixed(1)}) rotate(${deg.toFixed(1)})" d="M-5,-5 L0,0 L-5,5Z"/>`;
      out += `<circle class="d-node" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="30"/>`;
      out += block(x, y + 4, it.label, 11, "middle", "d-label", 11);
    });
    if (d.title) out += block(cx, cy + 4, d.title, 14, "middle", "d-label d-strong");
    return svg(out, d.caption || "Cycle", `0 0 ${W} ${h}`);
  }

  /* ---------- Labelled parts (science) ---------- */
  function labelled(d) {
    const items = (d.items || []).slice(0, 8);
    const h = 240, cx = W / 2, cy = 120;
    let out = `<ellipse class="d-shape" cx="${cx}" cy="${cy}" rx="70" ry="56"/>`;
    out += block(cx, cy + 4, d.title || "", 14, "middle", "d-label d-strong");
    items.forEach((it, i) => {
      const left = i % 2 === 0;
      const row = Math.floor(i / 2);
      const rows = Math.ceil(items.length / 2);
      const ly = 30 + (rows > 1 ? (row * 180) / (rows - 1) : 90);
      const a = Math.atan2(ly - cy, left ? -100 : 100);
      const px = cx + 70 * Math.cos(a) * 0.82, py = cy + 56 * Math.sin(a) * 0.82;
      const lx = left ? 92 : W - 92;
      out += `<circle class="d-point" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3"/>`;
      out += `<line class="d-thin" x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${lx}" y2="${ly}"/>`;
      out += block(left ? lx - 4 : lx + 4, ly + 3, it.detail ? `${it.label} (${it.detail})` : it.label, 14, left ? "end" : "start", "d-label", 11);
    });
    return svg(out, d.caption || "Labelled diagram", `0 0 ${W} ${h}`);
  }

  /* ---------- Bar chart ---------- */
  function bar(d) {
    const items = (d.items || []).filter((it) => typeof it.value === "number" && isFinite(it.value)).slice(0, 8);
    if (!items.length) return "";
    const max = Math.max(...items.map((it) => it.value), 0) || 1;
    const min = Math.min(0, ...items.map((it) => it.value));
    const top = PAD, bottom = H - 44, left = PAD + 8;
    const bw = (W - left - 12) / items.length;
    const sy = (v) => bottom - ((v - min) / (max - min)) * (bottom - top);
    let out = `<line class="d-axis" x1="${left}" y1="${sy(0)}" x2="${W - 8}" y2="${sy(0)}"/>`;
    items.forEach((it, i) => {
      const x = left + i * bw + bw * 0.18, w = bw * 0.64;
      const y0 = sy(0), y1 = sy(it.value);
      out += `<rect class="d-bar" x="${x.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.abs(y1 - y0).toFixed(1)}" rx="2"/>`;
      out += text(x + w / 2, Math.min(y0, y1) - 5, fmt(it.value) + (it.detail ? ` ${it.detail}` : ""), "middle", "d-small");
      out += block(x + w / 2, bottom + 16, it.label, 9, "middle", "d-tick", 10);
    });
    return svg(out, d.caption || "Bar chart");
  }

  function render(d) {
    if (!d || d.kind === "none") return "";
    try {
      switch (d.kind) {
        case "graph": return d.expressions.length || (d.points || []).length ? graph(d) : "";
        case "right_triangle": return rightTriangle(d);
        case "triangle": return triangle(d);
        case "circle": return circle(d);
        case "number_line": return numberLine(d);
        case "timeline": return timeline(d);
        case "flow": return flow(d);
        case "cycle": return cycle(d);
        case "labelled": return labelled(d);
        case "bar": return bar(d);
      }
    } catch (err) {
      console.warn("Reforge: couldn't draw diagram", err, d);
    }
    return "";
  }

  return { render, compile };
})();
