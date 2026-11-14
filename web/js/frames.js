// frames.js: the "Approve frames" screen.
//
// Shows one frame with its boxes. You can zoom and drag the picture, click a box to change
// or delete it, draw a new box (B), and Approve (A) or mark Needs fix (F).
// "Fix it now" keeps you on the frame with a bar at the bottom until you're done.

// Each reviewer's pipeline: 1. sort the unknown cones in your frames, 2. review your frames
function stepsLeft() {
  const unknown = unknownLabel();
  return {
    cones: cones.filter((c) => mine.has(c.frame.index) && c.box.label === unknown && !c.box.deleted).length,
    frames: data.frames.filter((f) => mine.has(f.index) && TODO.includes(f.status)).length,
  };
}

function renderSteps() {
  $("steps").hidden = !mine;
  if (!mine) return;
  const left = stepsLeft();
  const step = (n, text, count, active) => {
    const button = el("button", { className: count ? "" : "done", onclick: () => goStep(n) },
      el("span", { className: "num" }, count ? String(n) : icon("check")), `${text}: ${count ? `${count} left` : "done"}`);
    if (active) button.setAttribute("aria-current", "step");
    return button;
  };
  $("steps").replaceChildren(
    el("span", { className: "muted", textContent: whose("Your work", "@'s work") }),
    step(1, "Sort unknown cones", left.cones, mode === "cones" && fixFrame === null && sortLabel() === unknownLabel()),
    el("span", { className: "muted" }, icon("right")),
    step(2, whose("Review your frames", "Review frames"), left.frames, mode !== "cones"));
}

function goStep(n, reload = true) {
  scope = "mine";
  store("review.scope", scope);
  if (n === 1) {
    fixFrame = null;
    if (unknownLabel() !== undefined) $("sort").value = unknownLabel();
    store("review.sort", labelName(sortLabel()));
    setMode("cones", reload);
  } else {
    filter = "todo";
    current = data.frames.find((f) => mine.has(f.index) && TODO.includes(f.status))?.index ?? current;
    fit();
    setMode("frames", reload);
  }
}

// ------------------------------------------------------------- progress

// One bar for the whole task: coloured parts add up to every frame (or cone)
function renderProgress() {
  let title, parts;  // parts: [count, colour, label]
  if (mode === "cones" && fixFrame !== null) {
    const done = coneList.filter((p) => p < coneAt).length, total = coneList.length;
    title = done < total ? `Fixing frame #${fixFrame}: box ${done + 1} of ${total}` : `All ${total} boxes on frame #${fixFrame} checked`;
    parts = [[done, "var(--ok)", "checked"], [total - done, "", "left to check"]];
  } else if (mode === "cones") {
    const done = undoStack.reduce((n, u) => n + (u.kind === "keep" || u.kind === "add" ? 0 : u.changes?.length ?? u.ids?.length ?? 1), 0);
    const left = coneList.length;
    const name = `${niceName(labelName(sortLabel())).toLowerCase()} cones`;
    title = left ? `${done} of ${done + left} ${name} sorted (${pct(done, done + left)}%)` : `All ${name} sorted`;
    parts = [[done, "var(--ok)", "sorted this session"], [left, "", "left to sort"]];
  } else {
    const frames = data.frames.filter((f) => inScope(f.index)), n = frames.length;
    const count = (...statuses) => frames.filter((f) => statuses.includes(f.status)).length;
    const ok = count("verified"), your = mine && scope === "mine" ? "your " : "";
    title = ok === n ? `All ${your}${n} frames approved` : `${ok} of ${your}${n} frames approved (${pct(ok, n)}%)`;
    parts = [
      [ok, "var(--ok)", "approved"],
      [count("needs_fix"), "var(--bad)", "need fix"],
      [count("needs_reverification"), "var(--warn)", "changed since approval"],
      [count("pending", "in_review"), "", "to review"],
    ];
    for (const button of $("filter").children) {
      button.setAttribute("aria-pressed", button.dataset.filter === filter);
      button.querySelector(".count").textContent = frames.filter(FILTERS[button.dataset.filter]).length;
    }
  }
  renderSteps();
  const total = parts.reduce((sum, [k]) => sum + k, 0);
  $("progress-title").textContent = title;
  $("progress").setAttribute("aria-valuenow", pct(parts[0][0], total));
  $("progress-legend").replaceChildren(...parts.filter(([k]) => k).map(([k, color, label]) =>
    el("span", {}, swatch(color || "var(--line)"), `${k} ${label}`)));
  $("bar").replaceChildren(...parts.map(([k, color, label]) =>
    el("i", { title: `${k} ${label}`, style: `width:${(100 * k) / Math.max(1, total)}%;background:${color || "transparent"}` })));
}

function render() {
  renderProgress();
  $("back-gallery").hidden = !fromGallery;
  const frame = data.frames[current];
  const at = list.indexOf(current);
  $("position").textContent = list.length ? `${at >= 0 ? at + 1 : "–"} of ${list.length}` : "Nothing here";
  if (!frame) return;

  const img = $("image");
  if (!img.src.endsWith(imageUrl(current))) {
    $("loading").hidden = false;
    img.src = imageUrl(current);
  }
  sizeView(frame);

  const boxes = liveBoxes(frame);
  drawBoxes($("boxes"), frame, showBoxes, { selected, sketch: pending ?? sketch, hovered });
  $("stage").classList.toggle("drawing", drawing);
  renderEditBar();
  renderFixBar();
  $("toggle").firstChild.textContent = showBoxes ? "Hide boxes " : "Show boxes ";

  $("name").textContent = `#${frame.index} · ${frame.name}`;
  $("status").textContent = STATUS_TEXT[frame.status] ?? frame.status;
  $("status").className = `status ${frame.status}`;
  $("reviewer").textContent = frame.reviewer ? `Last decision by ${frame.reviewer}` : "";

  const counts = {};
  for (const b of boxes) counts[b.label] = (counts[b.label] || 0) + 1;
  const rows = Object.entries(counts).map(([id, n]) =>
    el("div", {}, swatch(labelColor(+id)), el("span", { textContent: niceName(labelName(+id)) }), el("b", { textContent: n })));
  $("counts").replaceChildren(...(rows.length ? rows : [el("span", { className: "muted", textContent: "No boxes" })]));

  // Shapes this page can't draw or export must not be approved blindly
  const notes = [
    frame.other_shapes && `${frame.other_shapes} non-box shape(s) here aren't shown, and the export will reject them.`,
    data.tracks && `This task has ${data.tracks} tracked object(s). They aren't shown or exported, so convert them to shapes in CVAT first.`,
  ].filter(Boolean);
  $("warn").textContent = notes.join(" ");
  $("warn").hidden = !notes.length;

  $("jump").max = data.frames.length - 1;

  // Fetch the next frames early so advancing feels instant
  for (const i of list.slice(at + 1, at + 3)) new Image().src = imageUrl(i);
}

// ------------------------------------------------------------- zoom/pan

function fit() { view = { scale: 1, x: 0, y: 0 }; }

function sizeView(frame) {
  // At scale 1 the frame fits the stage and is centred
  const stage = $("stage").getBoundingClientRect();
  const base = Math.min(stage.width / frame.width, stage.height / frame.height);
  const w = frame.width * base, h = frame.height * base;
  const left = (stage.width - w * view.scale) / 2 + view.x;
  const top = (stage.height - h * view.scale) / 2 + view.y;
  Object.assign($("view").style, { width: `${w}px`, height: `${h}px`, transform: `translate(${left}px, ${top}px) scale(${view.scale})` });
  $("zoom-pct").textContent = `${Math.round(view.scale * 100)}%`;
}

// The zoom buttons: zoom around the middle of the picture, or around a point (stage pixels from its centre)
function zoomBy(factor, cx = 0, cy = 0) {
  const frame = data?.frames[current];
  if (!frame) return;
  const next = Math.min(16, Math.max(1, view.scale * factor));
  const k = next / view.scale;
  view = next === 1 ? { scale: 1, x: 0, y: 0 } : { scale: next, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k };
  $("view").style.transition = "transform .22s var(--ease)";  // buttons glide; the wheel stays immediate
  sizeView(frame);
  setTimeout(() => ($("view").style.transition = ""), 240);
}

$("stage").addEventListener("wheel", (e) => {
  e.preventDefault();
  const frame = data?.frames[current];
  if (!frame) return;
  const rect = $("stage").getBoundingClientRect();
  const cx = e.clientX - rect.left - rect.width / 2;
  const cy = e.clientY - rect.top - rect.height / 2;
  const next = Math.min(16, Math.max(1, view.scale * Math.exp(-Math.max(-300, Math.min(300, e.deltaY)) / 300)));
  const k = next / view.scale;
  // Keep the point under the cursor in place while zooming
  view = next === 1 ? { scale: 1, x: 0, y: 0 } : { scale: next, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k };
  sizeView(frame);
}, { passive: false });

// Drag pans; a click selects a box; in draw mode (or with Shift) dragging draws a new box
let drag = null;
let sketch = null;   // the box being drawn, in frame pixels
function toFrame(e) {
  const r = $("view").getBoundingClientRect(), f = data.frames[current];
  return { x: ((e.clientX - r.left) / r.width) * f.width, y: ((e.clientY - r.top) / r.height) * f.height };
}
$("stage").addEventListener("pointerleave", () => {
  if (hovered == null || !data?.frames[current]) return;
  hovered = null;
  $("stage").classList.remove("over-box");
  drawBoxes($("boxes"), data.frames[current], showBoxes, { selected, sketch: pending });
});
$("stage").addEventListener("pointerdown", (e) => {
  if (!data?.frames[current] || e.target.closest("#edit-bar, #fix-bar, #zoom-ctl")) return;
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, from: toFrame(e), draw: drawing || e.shiftKey };
  $("stage").setPointerCapture(e.pointerId);
  if (!drag.draw) $("stage").classList.add("dragging");
});
$("stage").addEventListener("pointermove", (e) => {
  if (!drag) {
    if (!data?.frames[current] || !showBoxes || drawing || e.target.closest("#edit-bar, #fix-bar, #zoom-ctl")) return;
    const id = boxAt(toFrame(e));
    if (id === hovered) return;
    hovered = id;
    $("stage").classList.toggle("over-box", id != null);
    return drawBoxes($("boxes"), data.frames[current], showBoxes, { selected, sketch: pending, hovered });
  }
  if (drag.draw) {
    const p = toFrame(e);
    sketch = { x1: Math.min(drag.from.x, p.x), y1: Math.min(drag.from.y, p.y), x2: Math.max(drag.from.x, p.x), y2: Math.max(drag.from.y, p.y) };
    return drawBoxes($("boxes"), data.frames[current], showBoxes, { selected, sketch });
  }
  view.x = drag.vx + e.clientX - drag.x;
  view.y = drag.vy + e.clientY - drag.y;
  sizeView(data.frames[current]);
});
$("stage").addEventListener("pointerup", (e) => {
  if (!drag) return;
  const moved = Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4;
  if (drag.draw && sketch && sketch.x2 - sketch.x1 >= 3 && sketch.y2 - sketch.y1 >= 3) {
    pending = sketch;  // now pick its class
    drawing = false;
  } else if (!drag.draw && !moved) {
    selectAt(drag.from);
  }
  sketch = null;
  drag = null;
  $("stage").classList.remove("dragging");
  render();
});
$("stage").addEventListener("dblclick", (e) => { if (!e.target.closest("#zoom-ctl, #edit-bar, #fix-bar")) { fit(); if (data) sizeView(data.frames[current]); } });
$("zoom-in").onclick = () => zoomBy(1.6);
$("zoom-out").onclick = () => zoomBy(1 / 1.6);
$("zoom-fit").onclick = () => { fit(); zoomBy(1); };
window.addEventListener("resize", () => {
  if (mode === "cones") redrawCone();
  else if (mode === "frames" && data?.frames[current]) sizeView(data.frames[current]);
});

// ------------------------------------------------------------- actions

function go(index) {
  if (!data || index < 0 || index >= data.frames.length) return;
  if (index !== current) selected = pending = null;
  current = index;
  fit();
  render();
}

function step(delta) {
  // Move through the filtered list. If this frame just left it, use its old neighbours.
  const target = delta > 0 ? list.find((i) => i > current) : list.filter((i) => i < current).pop();
  if (target !== undefined) go(target);
}

function decide(decision, note, index = current, stay = false) {
  const frame = data?.frames[index];
  if (!frame) return;
  lastEdit = "decision";
  const before = { status: frame.status, reviewer: frame.reviewer };
  if (decision !== "needs_fix" && index === fixing) fixing = null;
  frame.status = { approve: "verified", needs_fix: "needs_fix", reset: "pending" }[decision];
  frame.reviewer = decision === "reset" ? null : $("who").textContent;

  // Advance straight away; the server checks in the background so reviewing stays quick
  const advance = !stay && mode === "frames" && index === current && decision !== "reset";
  const nextIndex = advance ? list.find((i) => i > current) : undefined;
  buildList();
  if (nextIndex !== undefined) go(nextIndex); else show();

  send("/review", { frame: frame.name, decision, hash: frame.hash, note }, {
    revert: (error) => { Object.assign(frame, before); toast(`${frame.name}: ${error.message}`); buildList(); },
    // Back to the frame that needs another look
    retry: () => loadTask(false).then(() => mode === "frames" && go(frame.index)),
  });
}

let fixIndex = 0;  // the frame the Needs fix dialog is for
function askFix(index = current) {
  if (!data?.frames[index]) return;
  fixIndex = index;
  $("fix-note").value = "";
  $("fix-dialog").showModal();
}
// "Fix it now": stay on the frame (opening it first if you came from the gallery) and fix boxes by clicking them
let fixing = null;  // frame index being fixed on the Approve screen
$("fix-form").onsubmit = (e) => {
  e.preventDefault();
  $("fix-dialog").close();
  fixing = fixIndex;
  if (mode !== "frames" || current !== fixIndex) {
    if (mode === "gallery") { lastOpened = fixIndex; fromGallery = true; }
    current = fixIndex;
    fit();
    decide("needs_fix", $("fix-note").value.trim(), fixIndex, true);
    return setMode("frames", false);
  }
  decide("needs_fix", $("fix-note").value.trim(), fixIndex, true);
};

function renderFixBar() {
  const on = fixing === current && mode === "frames" && !pending && selected == null && !drawing;
  $("fix-bar").hidden = !on;
  if (!on) return;
  $("fix-bar").replaceChildren(
    el("span", { className: "what" }, el("b", { textContent: `Fixing #${current}` }),
      el("span", { className: "muted", textContent: "Click a cone to change it · B adds a missing one" })),
    el("button", { onclick: () => zoomBy(1.6), title: "Zoom in (+). Scroll to zoom where you point, drag to move" }, "Zoom in ", el("kbd", { textContent: "+" })),
    el("button", { onclick: () => { fixing = null; startFix(current); }, title: "Check every box on this frame, one at a time" }, "One by one"),
    el("button", { onclick: () => { fixing = null; render(); } }, "Leave as needs fix"),
    el("button", { className: "primary", onclick: finishFix }, "Done, approve ", el("kbd", { textContent: "A" })));
}

// Approving straight after an edit needs the frame's new fingerprint: wait for the edits to reach CVAT, reload, then approve
async function finishFix() {
  const index = fixing;
  fixing = null;
  $("fix-bar").hidden = true;
  if (inFlight) {
    $("loading").textContent = "Saving your fixes…";
    $("loading").hidden = false;
    await queue;
    try { await loadTask(false); } catch (error) { $("loading").hidden = true; return toast(error.message); }
    $("loading").hidden = true;
    $("loading").textContent = "Loading…";
  }
  if (mode === "frames" && current === index) decide("approve", undefined, index);
}
$("fix-later").onclick = () => {
  $("fix-dialog").close();
  decide("needs_fix", $("fix-note").value.trim(), fixIndex);
};

// Sort cones, limited to one frame's boxes: check each one, then go back to the frame
let fixFrame = null;
function startFix(index) {
  fixFrame = index;
  setMode("cones");
}
function endFix() {
  const index = fixFrame;
  fixFrame = null;
  current = index;
  fit();
  setMode("frames");
}
$("fix-cancel").onclick = () => $("fix-dialog").close();

function openInCvat(index = current) {
  const job = data?.jobs.find((j) => index >= j.start && index <= j.stop);
  if (!job) return toast("No CVAT job contains this frame.");
  window.open(`${data.cvat_url}/tasks/${data.task.id}/jobs/${job.id}?frame=${index}`, "cvat");
}

// ------------------------------------------------------------- editing boxes on the Approve screen

let selected = null;   // id of the box clicked on
let pending = null;    // a newly drawn box waiting for its class
let drawing = false;
let lastEdit = null;   // "box" or "decision": what U undoes on the Approve screen

// The smallest box under a point, with a few screen pixels of slack so small, far cones are easy to hit
function boxAt(p) {
  const slack = (6 * data.frames[current].width) / ($("view").getBoundingClientRect().width || 1);
  const hits = liveBoxes(data.frames[current]).filter((b) => b.x1 - slack <= p.x && p.x <= b.x2 + slack && b.y1 - slack <= p.y && p.y <= b.y2 + slack);
  const area = (b) => (b.x2 - b.x1) * (b.y2 - b.y1);
  return hits.sort((a, b) => area(a) - area(b))[0]?.id ?? null;
}
function selectAt(p) {
  selected = boxAt(p);
  pending = null;
}
let hovered = null;

function renderEditBar() {
  const box = selected != null && liveBoxes(data.frames[current]).find((b) => b.id === selected);
  if (!box) selected = null;
  const text = pending ? "New box: pick its class" : box ? `${niceName(labelName(box.label))} box: change to` : drawing ? "Drag on the picture to draw a box" : null;
  $("edit-bar").hidden = !text;
  if (!text) return;
  $("edit-bar").replaceChildren(el("span", { textContent: text }),
    ...(pending || box ? data.labels.slice(0, 9).map((l, i) => classButton(l, i, () => pickClass(l.id), "")) : []),
    ...(box ? [el("button", { className: "danger", onclick: deleteSelected }, "Delete ", el("kbd", { textContent: "X" }))] : []),
    el("button", { onclick: cancelEdit }, "Cancel ", el("kbd", { textContent: "Esc" })));
}

function pickClass(label) {
  lastEdit = "box";
  if (pending) addBox(label);
  else if (selected != null && coneById(selected)) changeClass(coneById(selected), label);
  selected = null;
  render();
}

function deleteSelected() {
  if (selected == null || !coneById(selected)) return;
  lastEdit = "box";
  deleteBox(coneById(selected));
  selected = null;
  render();
}

function cancelEdit() {
  selected = pending = sketch = null;
  drawing = false;
  render();
}

function addBox(label) {
  const frame = data.frames[current], r = pending;
  pending = null;
  const box = { id: `new-${Date.now()}`, label, ...r };  // shown at once, replaced on reload
  frame.boxes.push(box);
  const entry = { id: null, kind: "add" };
  undoStack.push(entry);
  send("/boxes", { frame: frame.index, label, ...r }, {
    revert: (error) => {
      frame.boxes.splice(frame.boxes.indexOf(box), 1);
      undoStack.splice(undoStack.indexOf(entry), 1);
      toast(error.message);
    },
    retry: () => loadTask(false),
    done: (result) => { entry.id = result.id; loadTask(false).catch((e) => toast(e.message)); },
  });
}
