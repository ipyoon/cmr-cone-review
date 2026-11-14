// cones.js: the Sort cones screen.

// ------------------------------------------------------------- cones

let cones = [];      // every box in the task, in frame order: {box, frame, pos}
let coneList = [];   // positions of boxes still to sort: the chosen class, not deleted
let coneAt = 0;      // position on screen; cones.length means past the last one
let undoStack = [];  // {id, kind: "relabel" | "flag" | "keep", from, to}
let coneZoom = 3;    // picture shown around the cone, in box sizes; "full" shows the whole frame
let conePan = null;  // {cx, cy} in image pixels once the reviewer drags; reset for each cone
let coneGeom = null; // the crop last drawn, for zooming and dragging
let coneShown = null;
let drawToken = 0;
const images = new Map();  // "task/frame" -> Promise<Image>, oldest first

function loadImage(index) {
  const key = `${data.task.id}/${index}`;
  const promise = images.get(key) ?? new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => { images.delete(key); reject(new Error("Could not load this frame from CVAT.")); };
    img.src = imageUrl(index);
  });
  images.delete(key);  // re-insert at the end: recently used
  images.set(key, promise);
  if (images.size > 30) images.delete(images.keys().next().value);
  return promise;
}

function sortLabel() { return Number($("sort").value); }

function setupSort() {
  const saved = store("review.sort");
  const pick = data.labels.find((l) => l.name === saved) ?? data.labels.find((l) => l.name === "unknown_cone") ?? data.labels[0];
  $("sort").replaceChildren(...data.labels.map((l) => el("option", { value: l.id, textContent: `Sorting: ${niceName(l.name)}` })));
  if (pick) $("sort").value = pick.id;

  // One button per class, filled with its colour; its number key changes the box to that class
  $("label-keys").replaceChildren(...data.labels.slice(0, 9).map((l, i) => classButton(l, i, () => relabel(l.id))));
}

function buildCones() {
  cones = data.frames.flatMap((frame) => frame.boxes.map((box) => ({ box, frame })));
  cones.forEach((c, pos) => (c.pos = pos));
  buildConeList();
}

function buildConeList() {
  const wanted = fixFrame !== null ? (c) => c.frame.index === fixFrame : (c) => inScope(c.frame.index) && c.box.label === sortLabel();
  coneList = cones.filter((c) => wanted(c) && !c.box.deleted).map((c) => c.pos);
}

function firstCone() { coneAt = coneList[0] ?? cones.length; }

async function renderCone() {
  renderProgress();
  const sure = fixFrame === null && sortLabel() === unknownLabel() ? coneList.filter((p) => sureSuggestion(cones[p])).length : 0;
  $("auto-sort").hidden = !sure;
  $("auto-sort").textContent = `Auto-sort ${sure} sure one${sure === 1 ? "" : "s"}`;
  $("position").textContent = "";
  const token = ++drawToken;
  const c = cones[coneAt]?.box.deleted ? undefined : cones[coneAt];
  $("crop").hidden = $("cone-question").hidden = $("zoom-level").hidden = !c;
  $("sort").hidden = fixFrame !== null;
  $("fixing").hidden = fixFrame === null;
  $("fixing-text").textContent = `Fixing frame #${fixFrame}`;
  $("cone-question").textContent = fixFrame !== null ? "Right colour? Press it, or X if it's not a cone" : "What colour is this cone?";
  $("cone-empty").hidden = !!c;
  if (c?.box.id !== coneShown) {  // a new cone starts centred on it
    coneShown = c?.box.id;
    conePan = null;
  }
  if (!c) {
    coneGeom = null;
    const name = niceName(labelName(sortLabel())).toLowerCase();
    $("cone-empty").replaceChildren(...(fixFrame !== null
      ? [`Every box on frame #${fixFrame} checked. Missing a cone? Add it in CVAT.`,
         el("div", {}, el("button", { textContent: "Add missing cones in CVAT", onclick: () => openInCvat(fixFrame) }),
           el("button", { className: "primary", textContent: "Back to frame", onclick: endFix }))]
      : mine && scope === "mine" && sortLabel() === unknownLabel() && !coneList.length
      ? ["Step 1 done: every unknown cone in your frames is sorted.",
         el("div", {}, el("button", { className: "primary", onclick: () => goStep(2) }, "Step 2: Review your frames", icon("right")))]
      : [coneList.length
        ? `End of the list. You skipped ${coneList.length}. Press Home to go through them again.`
        : `All done! No ${name} cones left.`]));
    $("cone-frame").textContent = "";
    $("cone-class").replaceChildren();
    $("thumb").getContext("2d").clearRect(0, 0, $("thumb").width, $("thumb").height);
    return;
  }

  $("cone-frame").textContent = `Frame #${c.frame.index} · ${c.frame.name}`;
  $("cone-class").replaceChildren(swatch(labelColor(c.box.label)), niceName(labelName(c.box.label)));
  const hint = c.box.label === unknownLabel() && c.box.suggest;
  $("cone-suggest").hidden = !hint;
  if (hint) $("cone-suggest").textContent = `Suggested: ${niceName(labelName(hint.label))}, as in ${hint.votes} of ${hint.of} nearby frames. Press Enter.`;
  for (const button of $("label-keys").children) button.classList.toggle("suggested", !!hint && Number(button.dataset.label) === hint.label);

  // Fetch the next few frames early so moving on feels instant
  for (const p of coneList.filter((p) => p > coneAt).slice(0, 3)) loadImage(cones[p].frame.index).catch(() => {});

  let img;
  try {
    img = await loadImage(c.frame.index);
  } catch (error) {
    if (token === drawToken) toast(error.message);
    return;
  }
  if (token !== drawToken) return;  // the reviewer has already moved on
  drawCrop(img, c);
  drawThumb(img, c);
}

function drawCrop(img, c) {
  const canvas = $("crop");
  const area = $("cone-stage").getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(area.width * dpr));
  canvas.height = Math.max(1, Math.round(area.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0b0c0e";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Box coordinates are in frame pixels; the image CVAT sends may be smaller
  const k = img.naturalWidth / c.frame.width;
  const b = c.box;
  const W = img.naturalWidth, H = img.naturalHeight;
  // The view has the canvas's shape, so nothing is stretched; side is its shorter edge in image pixels
  const ratio = canvas.width / canvas.height;
  const fullSide = ratio > 1 ? Math.max(W / ratio, H) : Math.max(W, H * ratio);
  // One "box size", at least 20 px so far-away cones still get some surroundings
  const unit = Math.max(b.x2 - b.x1, b.y2 - b.y1, 20) * k;
  const side = coneZoom === "full" ? fullSide : Math.min(fullSide, unit * coneZoom);
  const { cx, cy } = conePan ?? (side >= fullSide ? { cx: W / 2, cy: H / 2 } : { cx: ((b.x1 + b.x2) / 2) * k, cy: ((b.y1 + b.y2) / 2) * k });
  const rw = ratio > 1 ? side * ratio : side, rh = ratio > 1 ? side : side / ratio;
  const sx = cx - rw / 2, sy = cy - rh / 2, scale = canvas.width / rw;
  coneGeom = { img, c, cx, cy, side, fullSide, unit, scale };
  $("zoom-level").textContent = side >= fullSide ? "Full frame" : `${(fullSide / side).toFixed(1)}× zoom`;
  $("wide").firstChild.textContent = side >= fullSide ? "Close-up " : "Full frame ";

  // Draw only the part that's inside the image; the rest stays dark
  const ix1 = Math.max(0, sx), iy1 = Math.max(0, sy);
  const ix2 = Math.min(img.naturalWidth, sx + rw), iy2 = Math.min(img.naturalHeight, sy + rh);
  ctx.imageSmoothingQuality = "high";
  if (ix2 > ix1 && iy2 > iy1) {
    ctx.drawImage(img, ix1, iy1, ix2 - ix1, iy2 - iy1,
      (ix1 - sx) * scale, (iy1 - sy) * scale, (ix2 - ix1) * scale, (iy2 - iy1) * scale);
  }

  const rect = (box, pad) => [
    (box.x1 * k - sx) * scale - pad, (box.y1 * k - sy) * scale - pad,
    (box.x2 - box.x1) * k * scale + 2 * pad, (box.y2 - box.y1) * k * scale + 2 * pad,
  ];
  ctx.setLineDash([6 * dpr, 4 * dpr]);
  ctx.lineWidth = dpr;
  ctx.strokeStyle = "rgba(255,255,255,.55)";
  for (const other of liveBoxes(c.frame)) if (other !== b) ctx.strokeRect(...rect(other, 0));
  // White outline, drawn just outside the box
  ctx.setLineDash([]);
  for (const [width, colour] of [[4, "rgba(0,0,0,.6)"], [2, "#fff"]]) {
    ctx.lineWidth = width * dpr;
    ctx.strokeStyle = colour;
    ctx.strokeRect(...rect(b, 6 * dpr));
  }
}

function drawThumb(img, c) {
  const canvas = $("thumb");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.getBoundingClientRect().width || 248;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round((width * dpr * c.frame.height) / c.frame.width);
  canvas.style.height = `${canvas.height / dpr}px`;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const s = canvas.width / c.frame.width;
  const b = c.box;
  // At least 10 px, so a far-away cone is still visible on the thumbnail
  const w = Math.max((b.x2 - b.x1) * s, 10 * dpr), h = Math.max((b.y2 - b.y1) * s, 10 * dpr);
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = "#fff";
  ctx.strokeRect(((b.x1 + b.x2) / 2) * s - w / 2, ((b.y1 + b.y2) / 2) * s - h / 2, w, h);
}

function coneStep(delta) {
  const p = delta > 0 ? coneList.find((i) => i > coneAt) : coneList.filter((i) => i < coneAt).pop();
  if (p !== undefined) coneAt = p;
  else if (delta > 0) coneAt = cones.length;  // past the last one
  renderCone();
}

function sendCone(c, body, revert, done) {
  send(`/cones/${c.box.id}`, body, {
    revert: (error) => {
      revert();
      toast(`Frame #${c.frame.index}: ${error.message}`);
      buildConeList();
      if (mode === "cones") coneAt = c.pos;
    },
    retry: () => loadTask(false, c.box.id),  // back to the box, with fresh boxes if CVAT changed
    done,
  });
}

const coneById = (id) => cones.find((x) => x.box.id === id);
const follow = () => $("follow").checked;

// Apply the confirmed change to every affected box
function boxesChanged(ids, change) {
  for (const id of ids) { const x = coneById(id); if (x) change(x.box); }
  if (ids.length > 1) toast(`Changed in ${ids.length} frames.`, "info");
  buildConeList();
  // The Approve screen needs the frame's new fingerprint before it can be approved
  if (mode === "frames") loadTask(false).catch((e) => toast(e.message)); else renderProgress();
}

function changeClass(c, label) {
  const from = c.box.label;
  // Pressing the class it already has just keeps it
  const entry = { id: c.box.id, kind: label === from ? "keep" : "relabel", from, to: label, ids: [c.box.id] };
  undoStack.push(entry);
  if (label === from) return;
  c.box.label = label;
  sendCone(c, { action: "relabel", label, expected: from, follow: follow() }, () => { c.box.label = from; },
    (result) => boxesChanged((entry.ids = result.ids), (b) => (b.label = label)));
}

function deleteBox(c, spread = follow()) {
  if (c.box.deleted) return;
  c.box.deleted = true;
  const entry = { id: c.box.id, kind: "flag", ids: [c.box.id] };
  undoStack.push(entry);
  sendCone(c, { action: "not_a_cone", follow: spread }, () => { c.box.deleted = false; },
    (result) => boxesChanged((entry.ids = result.ids), (b) => (b.deleted = true)));
}

function relabel(label) {
  const c = cones[coneAt];
  if (mode !== "cones" || !c || c.box.deleted) return;
  changeClass(c, label);
  buildConeList();
  coneStep(1);
}

function flagCone() {
  const c = cones[coneAt];
  if (!c || c.box.deleted) return;
  deleteBox(c);
  buildConeList();
  coneStep(1);
}

// Unknown cones whose colour every nearby frame agrees on
const sureSuggestion = (c) => c.box.suggest && c.box.suggest.votes === c.box.suggest.of && c.box.suggest.of >= 3;
function autoSort() {
  const ids = coneList.map((p) => cones[p]).filter(sureSuggestion).map((c) => c.box.id);
  if (!ids.length) return;
  send("/auto_sort", { ids }, {
    revert: (error) => toast(error.message),
    retry: () => loadTask(false),
    done: (result) => {
      undoStack.push({ id: result.changes[0]?.id, kind: "auto", changes: result.changes, from: unknownLabel() });
      for (const { id, label } of result.changes) { const x = coneById(id); if (x) x.box.label = label; }
      toast(`Sorted ${result.changes.length} cones from the frames around them. Undo (U) puts them back.`, "info");
      buildConeList();
      firstCone();
      renderCone();
    },
  });
}

function skipCone() {
  const c = cones[coneAt];
  if (!c) return;
  undoStack.push({ id: c.box.id, kind: "keep" });
  coneStep(1);
}

function undoCone() {
  const last = undoStack.pop();
  if (!last) return toast("Nothing to undo.", "info");
  const c = coneById(last.id);
  const mark = (ids, change) => { for (const id of ids) { const x = coneById(id); if (x) change(x.box); } };
  if (last.kind === "flag") {
    // The boxes were deleted in CVAT, so they come back with new ids: reload and go to it
    mark(last.ids, (b) => (b.deleted = false));
    send(`/cones/${last.id}`, { action: "undo_not_a_cone", ids: last.ids }, {
      revert: (error) => { mark(last.ids, (b) => (b.deleted = true)); toast(error.message); },
      retry: () => loadTask(false),
      done: (result) => loadTask(false, result.restored[last.id]).catch((e) => toast(e.message)),
    });
  } else if (last.kind === "add") {
    if (last.id == null) {
      undoStack.push(last);
      return toast("Still saving that box. Try again in a moment.", "info");
    }
    if (c) {
      deleteBox(c, false);
      undoStack.pop();  // removing the drawn box isn't itself an undo step
    }
  } else if (last.kind === "auto") {
    // Back to unknown, one request per class they were given
    for (const label of new Set(last.changes.map((x) => x.label))) {
      const ids = last.changes.filter((x) => x.label === label).map((x) => x.id);
      mark(ids, (b) => (b.label = last.from));
      send(`/cones/${ids[0]}`, { action: "relabel", label: last.from, expected: label, ids }, {
        revert: (error) => { mark(ids, (b) => (b.label = label)); toast(error.message); },
        retry: () => loadTask(false),
      });
    }
  } else if (!c) {
    return toast("That box is no longer in CVAT.");
  } else if (last.kind === "relabel") {
    mark(last.ids, (b) => (b.label = last.from));
    sendCone(c, { action: "relabel", label: last.from, expected: last.to, ids: last.ids },
      () => mark(last.ids, (b) => (b.label = last.to)), () => mode === "frames" && loadTask(false));
  }
  buildConeList();
  if (c && mode === "cones") coneAt = c.pos;
  if (mode === "cones" && last.kind === "auto") firstCone();
  show();
}

// Cone close-up: scroll to zoom around the cursor, drag to pan, double-click for the close-up again
const redrawCone = () => coneGeom && drawCrop(coneGeom.img, coneGeom.c);
$("cone-stage").addEventListener("wheel", (e) => {
  e.preventDefault();
  const g = coneGeom;
  if (!g) return;
  const dpr = window.devicePixelRatio || 1, rect = $("cone-stage").getBoundingClientRect();
  const side = Math.min(g.fullSide, Math.max(g.unit / 2, g.side * Math.exp(Math.max(-300, Math.min(300, e.deltaY)) / 300)));
  // The image point under the cursor stays put
  const px = g.cx + ((e.clientX - rect.left - rect.width / 2) * dpr) / g.scale;
  const py = g.cy + ((e.clientY - rect.top - rect.height / 2) * dpr) / g.scale;
  const f = side / g.side;
  coneZoom = side >= g.fullSide ? "full" : side / g.unit;
  conePan = coneZoom === "full" ? null : { cx: px - (px - g.cx) * f, cy: py - (py - g.cy) * f };
  redrawCone();
}, { passive: false });
let coneDrag = null;
$("cone-stage").addEventListener("pointerdown", (e) => {
  if (!coneGeom) return;
  coneDrag = { x: e.clientX, y: e.clientY, cx: coneGeom.cx, cy: coneGeom.cy };
  $("cone-stage").setPointerCapture(e.pointerId);
  $("cone-stage").classList.add("dragging");
});
$("cone-stage").addEventListener("pointermove", (e) => {
  if (!coneDrag || !coneGeom) return;
  const k = (window.devicePixelRatio || 1) / coneGeom.scale;
  conePan = { cx: coneDrag.cx - (e.clientX - coneDrag.x) * k, cy: coneDrag.cy - (e.clientY - coneDrag.y) * k };
  redrawCone();
});
$("cone-stage").addEventListener("pointerup", () => { coneDrag = null; $("cone-stage").classList.remove("dragging"); });
$("cone-stage").addEventListener("dblclick", () => { coneZoom = 3; conePan = null; redrawCone(); });
