/* STG Listing Lead Sheet — handwriting web app
   Apple Pencil writes, finger scrolls and taps. Photos per room. Autosaves. Exports a PDF. */
(() => {
  "use strict";

  const SHEET_W = 816, SHEET_H = 1056;          // sheet units (CSS px at 96 dpi = letter)
  const INK = "#14213D";
  const PEN_W = 2.1;                            // base stroke width in sheet units
  const ERASE_R = 11;                           // eraser radius in sheet units
  const PHOTO_MAX = 1600;                       // longest side kept for photos
  const ICON_CAM = '<svg viewBox="0 0 24 24"><path d="M4 8h3l1.6-2.4h6.8L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.6"/></svg>';

  const $ = (s, r = document) => r.querySelector(s);
  const state = {
    layout: null,
    pages: [],          // {el, canvas, ctx, bg}
    strokes: [],        // per page: [{pts:[[x,y,p],...]}]
    photos: {},         // slotId -> Blob
    photoUrls: {},      // slotId -> objectURL
    tool: "pen",
    undo: [],
    drawing: null,      // {page, stroke | erased:[]}
    lastPenUp: 0,
  };

  /* ---------------- storage (IndexedDB, best effort) ---------------- */
  const DB = {
    db: null,
    async open() {
      if (this.db) return this.db;
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open("stg-lead-sheet", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return this.db;
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction("kv", mode); const st = t.objectStore("kv");
        const out = fn(st);
        t.oncomplete = () => res(out instanceof IDBRequest ? out.result : undefined);
        t.onerror = () => rej(t.error);
      });
    },
    get(k) { return this.tx("readonly", st => st.get(k)); },
    set(k, v) { return this.tx("readwrite", st => { st.put(v, k); }); },
    del(k) { return this.tx("readwrite", st => { st.delete(k); }); },
    clear() { return this.tx("readwrite", st => { st.clear(); }); },
  };

  let saveTimer = null;
  function scheduleSave() {
    setSaved("…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveInk, 700);
  }
  async function saveInk() {
    clearTimeout(saveTimer); saveTimer = null;
    try { await DB.set("strokes", state.strokes); setSaved("Saved"); }
    catch (e) { setSaved(""); console.warn("save failed", e); }
  }
  async function savePhoto(id) {
    try { state.photos[id] ? await DB.set("photo:" + id, state.photos[id]) : await DB.del("photo:" + id); setSaved("Saved"); }
    catch (e) { console.warn("photo save failed", e); }
  }
  function setSaved(t) { $("#saved").textContent = t; }

  /* ---------------- build the document ---------------- */
  async function init() {
    state.layout = await fetch("layout.json").then(r => r.json());
    const doc = $("#doc");
    for (let i = 0; i < state.layout.pages; i++) {
      const el = document.createElement("section");
      el.className = "page";
      const bg = new Image(); bg.className = "bg"; bg.src = `page-${i + 1}.png`; bg.alt = ""; bg.draggable = false;
      const canvas = document.createElement("canvas"); canvas.className = "ink";
      el.append(bg, canvas);
      doc.append(el);
      state.pages.push({ el, canvas, ctx: canvas.getContext("2d"), bg, index: i });
      state.strokes.push([]);
      bindInk(state.pages[i]);
    }
    for (const s of state.layout.slots) {
      const b = document.createElement("button");
      b.className = "slot"; b.dataset.id = s.id;
      Object.assign(b.style, { left: pct(s.x, SHEET_W), top: pct(s.y, SHEET_H), width: pct(s.w, SHEET_W), height: pct(s.h, SHEET_H) });
      b.addEventListener("click", () => openPhotoMenu(s));
      state.pages[s.page].el.append(b);
      renderSlot(s.id);
    }
    try {
      const saved = await DB.get("strokes");
      if (Array.isArray(saved)) saved.forEach((p, i) => { if (state.strokes[i]) state.strokes[i] = p; });
      for (const s of state.layout.slots) {
        const blob = await DB.get("photo:" + s.id);
        if (blob) { state.photos[s.id] = blob; renderSlot(s.id); }
      }
    } catch (e) { console.warn("load failed", e); }
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}

    const ro = new ResizeObserver(() => state.pages.forEach(sizeCanvas));
    state.pages.forEach(p => ro.observe(p.el));
    state.pages.forEach(sizeCanvas);
    bindUI();
    if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  const pct = (v, total) => (v / total * 100) + "%";

  function sizeCanvas(p) {
    const r = p.el.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (p.canvas.width !== w || p.canvas.height !== h) { p.canvas.width = w; p.canvas.height = h; redraw(p.index); }
  }

  /* ---------------- ink ---------------- */
  const widthFor = pr => PEN_W * (0.45 + 0.9 * (pr || 0.5));

  function drawStroke(ctx, stroke, k, fromIdx = 1) {
    const pts = stroke.pts;
    ctx.strokeStyle = INK; ctx.fillStyle = INK; ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (pts.length === 1) {
      ctx.beginPath(); ctx.arc(pts[0][0] * k, pts[0][1] * k, widthFor(pts[0][2]) * k / 2, 0, Math.PI * 2); ctx.fill(); return;
    }
    for (let i = Math.max(1, fromIdx); i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], prev = pts[i - 2] || a;
      const m1 = [(prev[0] + a[0]) / 2, (prev[1] + a[1]) / 2], m2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      ctx.lineWidth = widthFor((a[2] + b[2]) / 2) * k;
      ctx.beginPath(); ctx.moveTo(m1[0] * k, m1[1] * k); ctx.quadraticCurveTo(a[0] * k, a[1] * k, m2[0] * k, m2[1] * k); ctx.stroke();
      if (i === pts.length - 1) { ctx.beginPath(); ctx.moveTo(m2[0] * k, m2[1] * k); ctx.lineTo(b[0] * k, b[1] * k); ctx.stroke(); }
    }
  }
  function redraw(i) {
    const p = state.pages[i]; const k = p.canvas.width / SHEET_W;
    p.ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
    for (const s of state.strokes[i]) drawStroke(p.ctx, s, k);
  }

  function toSheet(p, e) {
    const r = p.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * SHEET_W, (e.clientY - r.top) / r.height * SHEET_H, e.pressure || 0.5];
  }
  const isPenLike = e => e.pointerType === "pen" || e.pointerType === "mouse";

  function bindInk(p) {
    const c = p.canvas;
    c.addEventListener("pointerdown", e => {
      if (!isPenLike(e) || e.button > 0) return;      // fingers scroll; only Pencil (or a mouse) writes
      e.preventDefault();
      try { c.setPointerCapture(e.pointerId); } catch (_) {}
      const pt = toSheet(p, e);
      if (state.tool === "pen") {
        const stroke = { pts: [pt] };
        state.strokes[p.index].push(stroke);
        state.drawing = { p, stroke, id: e.pointerId };
        drawStroke(p.ctx, stroke, c.width / SHEET_W);
      } else {
        state.drawing = { p, erased: [], id: e.pointerId };
        eraseAt(p, pt);
      }
    });
    c.addEventListener("pointermove", e => {
      const d = state.drawing; if (!d || d.id !== e.pointerId) return;
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const k = c.width / SHEET_W;
      for (const ev of (evs.length ? evs : [e])) {
        const pt = toSheet(p, ev);
        if (d.stroke) {
          const last = d.stroke.pts[d.stroke.pts.length - 1];
          if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 0.4) continue;
          d.stroke.pts.push(pt);
          drawStroke(p.ctx, d.stroke, k, d.stroke.pts.length - 1);
        } else eraseAt(p, pt);
      }
    });
    const end = e => {
      const d = state.drawing; if (!d || d.id !== e.pointerId) return;
      state.drawing = null; state.lastPenUp = Date.now();
      if (d.stroke) { pushUndo({ type: "ink", page: p.index, stroke: d.stroke }); scheduleSave(); }
      else if (d.erased.length) { pushUndo({ type: "erase", page: p.index, items: d.erased }); scheduleSave(); }
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
  }

  function eraseAt(p, [x, y]) {
    const list = state.strokes[p.index]; let hit = false;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].pts.some(q => Math.hypot(q[0] - x, q[1] - y) < ERASE_R)) {
        state.drawing.erased.push({ stroke: list[i], idx: i }); list.splice(i, 1); hit = true;
      }
    }
    if (hit) redraw(p.index);
  }

  // Stop the Pencil (and a resting palm while writing) from scrolling the page. Fingers still scroll.
  document.addEventListener("touchstart", e => {
    if ([...e.touches].some(t => t.touchType === "stylus") && e.target.closest && e.target.closest("canvas.ink")) e.preventDefault();
  }, { passive: false });
  document.addEventListener("touchmove", e => {
    const stylus = [...e.touches].some(t => t.touchType === "stylus");
    if (stylus || state.drawing || Date.now() - state.lastPenUp < 350) { if (e.cancelable) e.preventDefault(); }
  }, { passive: false });

  /* ---------------- undo ---------------- */
  function pushUndo(a) { state.undo.push(a); if (state.undo.length > 300) state.undo.shift(); }
  function undo() {
    const a = state.undo.pop(); if (!a) { toast("Nothing to undo."); return; }
    if (a.type === "ink") {
      const list = state.strokes[a.page]; const i = list.lastIndexOf(a.stroke); if (i >= 0) list.splice(i, 1);
      redraw(a.page); scheduleSave();
    } else if (a.type === "erase") {
      const list = state.strokes[a.page];
      a.items.slice().reverse().forEach(it => list.splice(Math.min(it.idx, list.length), 0, it.stroke));
      redraw(a.page); scheduleSave();
    } else if (a.type === "photo") {
      setPhoto(a.id, a.prev, false);
    }
  }

  /* ---------------- photos ---------------- */
  let pendingSlot = null;

  function renderSlot(id) {
    const b = document.querySelector(`.slot[data-id="${id}"]`); if (!b) return;
    if (state.photoUrls[id]) { URL.revokeObjectURL(state.photoUrls[id]); delete state.photoUrls[id]; }
    const blob = state.photos[id];
    if (blob) {
      const url = state.photoUrls[id] = URL.createObjectURL(blob);
      b.innerHTML = `<img alt="" draggable="false" src="${url}">`; b.classList.add("has");
    } else {
      b.innerHTML = `<span class="empty">${ICON_CAM}<span>Tap for photo</span></span>`; b.classList.remove("has");
    }
  }

  function setPhoto(id, blob, undoable = true) {
    if (undoable) pushUndo({ type: "photo", id, prev: state.photos[id] || null });
    if (blob) state.photos[id] = blob; else delete state.photos[id];
    renderSlot(id); savePhoto(id);
  }

  async function shrink(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const s = Math.min(1, PHOTO_MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const out = await new Promise(r => c.toBlob(r, "image/jpeg", 0.86));
      c.width = c.height = 0;
      return out;
    } finally { URL.revokeObjectURL(url); }
  }

  function openPhotoMenu(slot) {
    const has = !!state.photos[slot.id];
    const body = $("#sheetBody"); body.innerHTML = "";
    $("#sheetTitle").textContent = slot.room + " photo";
    const btn = (label, cls, fn) => { const b = document.createElement("button"); b.className = "big " + cls; b.innerHTML = label; b.onclick = fn; body.append(b); };
    btn(ICON_CAM.replace("<svg", '<svg width="24" height="24" style="fill:none;stroke:currentColor;stroke-width:1.8"') + (has ? "Retake photo" : "Take photo"), "", () => {
      pendingSlot = slot.id; closeModal(); $("#camInput").value = ""; $("#camInput").click();
    });
    btn("Paste from iPhone", "light", () => pasteInto(slot.id));
    if (has) {
      btn("View photo", "light", () => { closeModal(); const v = $("#viewer"); v.querySelector("img").src = state.photoUrls[slot.id]; v.hidden = false; });
      btn("Remove photo", "danger", () => { closeModal(); setPhoto(slot.id, null); toast("Photo removed. Tap Undo to bring it back."); });
    }
    $("#sheet").hidden = false;
  }

  async function pasteInto(id) {
    closeModal();
    try {
      if (!navigator.clipboard || !navigator.clipboard.read) throw new Error("no clipboard");
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find(t => t.startsWith("image/"));
        if (type) { const blob = await shrink(await it.getType(type)); setPhoto(id, blob); toast("Photo added."); return; }
      }
      toast("No photo to paste. On the iPhone: open the photo, tap Share, then Copy. Then try again.");
    } catch (e) {
      if (e && e.name === "NotAllowedError") return;  // she tapped away from the Paste bubble
      toast("Couldn't paste. On the iPhone: open the photo, tap Share, then Copy. Then tap Paste again.");
    }
  }

  /* ---------------- PDF export ---------------- */
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

  async function renderPageCanvas(i, scale) {
    const p = state.pages[i];
    const c = document.createElement("canvas"); c.width = SHEET_W * scale; c.height = SHEET_H * scale;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    const bg = p.bg.complete && p.bg.naturalWidth ? p.bg : await loadImg(p.bg.src);
    ctx.drawImage(bg, 0, 0, c.width, c.height);
    for (const s of state.layout.slots.filter(s => s.page === i && state.photos[s.id])) {
      const img = await loadImg(state.photoUrls[s.id]);
      const bx = s.x * scale, by = s.y * scale, bw = s.w * scale, bh = s.h * scale;
      const r = Math.max(bw / img.naturalWidth, bh / img.naturalHeight);
      const sw = bw / r, sh = bh / r;
      ctx.save(); ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.clip();
      ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, bx, by, bw, bh);
      ctx.restore();
      ctx.strokeStyle = "#B9BFC9"; ctx.lineWidth = 1.5 * scale / 2; ctx.strokeRect(bx, by, bw, bh);
    }
    for (const s of state.strokes[i]) drawStroke(ctx, s, scale);
    return c;
  }

  async function buildPdf() {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: "pt", format: "letter", compress: true });
    const PW = 612, PH = 792;
    for (let i = 0; i < state.pages.length; i++) {
      if (i) pdf.addPage();
      const c = await renderPageCanvas(i, 2);
      pdf.addImage(c.toDataURL("image/jpeg", 0.88), "JPEG", 0, 0, PW, PH, undefined, "FAST");
      c.width = c.height = 0;
    }
    // Photo pages: each room photo, large, two per page
    const withPhotos = state.layout.slots.filter(s => state.photos[s.id]);
    const perPage = 2, totalPhotoPages = Math.ceil(withPhotos.length / perPage);
    for (let n = 0; n < withPhotos.length; n++) {
      const slotIdx = n % perPage;
      if (slotIdx === 0) {
        pdf.addPage();
        pdf.setFillColor(27, 42, 73); pdf.rect(36, 36, PW - 72, 26, "F");
        pdf.setFillColor(184, 144, 58); pdf.rect(36, 36, 6, 26, "F");
        pdf.setTextColor(255, 255, 255); pdf.setFont("helvetica", "bold"); pdf.setFontSize(10.5);
        pdf.text("ROOM PHOTOS", 50, 53);
        pdf.setDrawColor(185, 191, 201); pdf.setLineWidth(0.5); pdf.line(36, PH - 40, PW - 36, PH - 40);
        pdf.setTextColor(140, 150, 168); pdf.setFont("helvetica", "normal"); pdf.setFontSize(7.5);
        pdf.text("Susan Taylor Real Estate Group  |  Confidential seller information", 36, PH - 28);
        pdf.text(`Photos ${Math.floor(n / perPage) + 1} of ${totalPhotoPages}`, PW - 36, PH - 28, { align: "right" });
      }
      const s = withPhotos[n];
      const top = 78 + slotIdx * 328;
      pdf.setTextColor(27, 42, 73); pdf.setFont("helvetica", "bold"); pdf.setFontSize(12);
      pdf.text(s.room, 36, top + 10);
      const img = await loadImg(state.photoUrls[s.id]);
      const maxW = PW - 72, maxH = 296;
      const r = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
      const w = img.naturalWidth * r, h = img.naturalHeight * r;
      const dataUrl = await blobToDataURL(state.photos[s.id]);
      pdf.addImage(dataUrl, "JPEG", 36 + (maxW - w) / 2, top + 18, w, h, undefined, "FAST");
    }
    return pdf.output("blob");
  }
  const blobToDataURL = b => new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });

  function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

  function openSaveDialog() {
    const body = $("#sheetBody"); $("#sheetTitle").textContent = "Save as PDF";
    body.innerHTML = `<p>Name the file (handy: the property address).</p>
      <input type="text" id="fname" value="Listing Lead Sheet ${today()}" autocomplete="off">`;
    const go = document.createElement("button"); go.className = "big gold"; go.textContent = "Make PDF"; body.append(go);
    go.onclick = async () => {
      const name = ($("#fname").value || "Listing Lead Sheet").replace(/[\\/:*?"<>|]+/g, "-").trim();
      closeModal(); $("#busy").hidden = false;
      try {
        await saveInk();
        const blob = await buildPdf();
        $("#busy").hidden = true;
        offerPdf(new File([blob], name.endsWith(".pdf") ? name : name + ".pdf", { type: "application/pdf" }));
      } catch (e) {
        console.error(e); $("#busy").hidden = true; toast("Sorry, the PDF didn't work. Try again; your work is still here.");
      }
    };
    $("#sheet").hidden = false;
  }

  function offerPdf(file) {
    const url = URL.createObjectURL(file);
    window.__lastPdf = file;
    const body = $("#sheetBody"); $("#sheetTitle").textContent = "PDF ready";
    body.innerHTML = `<p>Tap <b>Share</b>, then <b>Save to Files</b> and pick the SharePoint folder.</p>`;
    const canShare = navigator.canShare && navigator.canShare({ files: [file] });
    if (canShare) {
      const b = document.createElement("button"); b.className = "big gold"; b.textContent = "Share / Save"; body.append(b);
      b.onclick = async () => { try { await navigator.share({ files: [file], title: file.name }); closeModal(); } catch (e) { /* cancelled */ } };
    }
    const a = document.createElement("a"); a.className = "big light"; a.href = url; a.download = file.name; a.target = "_blank";
    a.textContent = canShare ? "Open PDF" : "Download PDF"; a.style.textDecoration = "none"; body.append(a);
    $("#sheet").hidden = false;
  }

  /* ---------------- new form ---------------- */
  function openNewDialog() {
    const body = $("#sheetBody"); $("#sheetTitle").textContent = "Start a new lead sheet?";
    body.innerHTML = `<p>This clears all writing and photos. Save the PDF first if you need it.</p>`;
    const b = document.createElement("button"); b.className = "big danger"; b.textContent = "Clear and start new"; body.append(b);
    b.onclick = async () => {
      closeModal();
      state.strokes = state.strokes.map(() => []); state.undo = [];
      Object.keys(state.photos).forEach(id => { delete state.photos[id]; renderSlot(id); });
      state.pages.forEach(p => redraw(p.index));
      try { await DB.clear(); } catch (e) {}
      setSaved(""); window.scrollTo({ top: 0 }); toast("Fresh lead sheet ready.");
    };
    $("#sheet").hidden = false;
  }

  /* ---------------- UI wiring ---------------- */
  function closeModal() { $("#sheet").hidden = true; }
  let toastTimer;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 4200); }

  function setTool(t) {
    state.tool = t;
    $("#tPen").classList.toggle("on", t === "pen");
    $("#tEraser").classList.toggle("on", t === "eraser");
  }

  function bindUI() {
    $("#tPen").onclick = () => setTool("pen");
    $("#tEraser").onclick = () => setTool("eraser");
    $("#tUndo").onclick = undo;
    $("#bSave").onclick = openSaveDialog;
    $("#bNew").onclick = openNewDialog;
    document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => { closeModal(); $("#viewer").hidden = true; });
    $("#sheet").addEventListener("click", e => { if (e.target.id === "sheet") closeModal(); });
    $("#camInput").addEventListener("change", async e => {
      const f = e.target.files && e.target.files[0]; const id = pendingSlot; pendingSlot = null;
      if (!f || !id) return;
      try { setPhoto(id, await shrink(f)); } catch (err) { toast("Couldn't use that photo. Try again."); }
    });
    // Apple Pencil double-tap / squeeze isn't exposed to web pages; keyboard shortcut for testing:
    document.addEventListener("keydown", e => { if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); undo(); } });
    document.addEventListener("visibilitychange", () => { if (document.hidden && saveTimer) saveInk(); });
  }

  window.__app = { state, buildPdf, setPhoto, shrink };   // test hooks
  init();
})();
