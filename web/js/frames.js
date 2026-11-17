// The Approve frames screen.

// Two steps (when frames are assigned to user): 1. sort the unknown cones, 2. review the frames.
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
    const label = `${text}: ${count ? `${count} left` : "done"}`;
    const button = el("button", { className: count ? "" : "done", onclick: () => goStep(n) },
      el("span", { className: "num" }, count ? String(n) : icon("check")), label);
    if (active) button.setAttribute("aria-current", "step");
    return button;
  };
  const sortingUnknown = mode === "cones" && fixFrame === null && sortLabel() === unknownLabel();
  $("steps").replaceChildren(
    el("span", { className: "muted", textContent: whose("Your work", "@'s work") }),
    step(1, "Sort unknown cones", left.cones, sortingUnknown),
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
    const firstToReview = data.frames.find((f) => mine.has(f.index) && TODO.includes(f.status));
    if (firstToReview) current = firstToReview.index;
    fit();
    setMode("frames", reload);
  }
}


// The progress strip under the top bar

// How many cones changed on the Sort cones screen
function sortedCount() {
  let total = 0;
  for (const u of undoStack) {
    if (u.kind === "keep" || u.kind === "add") continue;
    total += u.changes?.length ?? u.ids?.length ?? 1;
  }
  return total;
}

function renderProgress() {
  let title, parts;  // each part: [count, color, label]
  if (mode === "cones" && fixFrame !== null) {
    const done = coneList.filter((p) => p < coneAt).length;
    const total = coneList.length;
    title = done < total ? `Fixing frame #${fixFrame}: box ${done + 1} of ${total}` : `All ${total} boxes on frame #${fixFrame} checked`;
    parts = [[done, "var(--black)", "checked"], [total - done, "", "left to check"]];
  } else if (mode === "cones") {
    const done = sortedCount();
    const left = coneList.length;
    const name = `${niceName(labelName(sortLabel())).toLowerCase()} cones`;
    title = left ? `${done} of ${done + left} ${name} sorted (${pct(done, done + left)}%)` : `All ${name} sorted`;
    parts = [[done, "var(--black)", "sorted this session"], [left, "", "left to sort"]];
  } else {
    const frames = data.frames.filter((f) => inScope(f.index));
    const count = (...statuses) => frames.filter((f) => statuses.includes(f.status)).length;
    const approved = count("verified");
    const your = mine && scope === "mine" ? "your " : "";
    title = approved === frames.length
      ? `All ${your}${frames.length} frames approved`
      : `${approved} of ${your}${frames.length} frames approved (${pct(approved, frames.length)}%)`;
    parts = [
      [approved, "var(--black)", "approved"],
      [count("needs_fix"), "var(--red)", "need fix"],
      [count("needs_reverification"), "var(--grey)", "changed since approval"],
      [count("pending", "in_review"), "", "to review"],
    ];
    for (const button of $("filter").children) {
      button.setAttribute("aria-pressed", button.dataset.filter === filter);
      button.querySelector(".count").textContent = frames.filter(FILTERS[button.dataset.filter]).length;
    }
  }
  renderSteps();

  const total = parts.reduce((sum, [count]) => sum + count, 0);
  $("progress-title").textContent = title;
  $("progress").setAttribute("aria-valuenow", pct(parts[0][0], total));
  $("progress-legend").replaceChildren(...parts.filter(([count]) => count).map(([count, color, label]) =>
    el("span", {}, swatch(color || "var(--line)"), `${count} ${label}`)));
  $("bar").replaceChildren(...parts.map(([count, color, label]) =>
    el("i", { title: `${count} ${label}`, style: `width:${(100 * count) / Math.max(1, total)}%;background:${color || "transparent"}` })));
}


// Drawing the frame

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

  drawBoxes($("boxes"), frame, showBoxes, { selected, sketch: pending ?? sketch, hovered });
  $("stage").classList.toggle("drawing", drawing);
  renderEditBar();
  renderFixBar();
  $("toggle").firstChild.textContent = showBoxes ? "Hide boxes " : "Show boxes ";

  $("name").textContent = `Frame ${frame.index} (${frame.name})`;
  $("status").textContent = STATUS_TEXT[frame.status] ?? frame.status;
  $("status").className = `status ${frame.status}`;
  $("reviewer").textContent = frame.reviewer ? `Last decision by ${frame.reviewer}` : "";

  // How many boxes of each color
  const counts = {};
  for (const b of liveBoxes(frame)) counts[b.label] = (counts[b.label] || 0) + 1;
  const rows = Object.entries(counts).map(([id, n]) =>
    el("div", {}, swatch(labelColor(+id)), el("span", { textContent: niceName(labelName(+id)) }), el("b", { textContent: n })));
  $("counts").replaceChildren(...(rows.length ? rows : [el("span", { className: "muted", textContent: "No boxes" })]));

  // Warn about shapes this page can't show
  const notes = [];
  if (frame.other_shapes) notes.push(`${frame.other_shapes} non-box shape(s) here aren't shown, and the export will reject them.`);
  if (data.tracks) notes.push(`This task has ${data.tracks} tracked object(s). They aren't shown or exported, so convert them to shapes in CVAT first.`);
  $("warn").textContent = notes.join(" ");
  $("warn").hidden = !notes.length;

  $("jump").max = data.frames.length - 1;

  // Load the next two frames early so "next" is instant
  for (const i of list.slice(at + 1, at + 3)) new Image().src = imageUrl(i);
}


// Zoom and drag

function fit() { view = { scale: 1, x: 0, y: 0 }; }

// At zoom 1 the frame fits the stage and is centered
function sizeView(frame) {
  const stage = $("stage").getBoundingClientRect();
  const base = Math.min(stage.width / frame.width, stage.height / frame.height);
  const w = frame.width * base;
  const h = frame.height * base;
  const left = (stage.width - w * view.scale) / 2 + view.x;
  const top = (stage.height - h * view.scale) / 2 + view.y;
  Object.assign($("view").style, { width: `${w}px`, height: `${h}px`, transform: `translate(${left}px, ${top}px) scale(${view.scale})` });
  $("zoom-pct").textContent = `${Math.round(view.scale * 100)}%`;
}

// Zoom to `scale` (1 to 16), keeping the point (cx, cy) in place. 
function zoomTo(scale, cx = 0, cy = 0) {
  const next = Math.min(16, Math.max(1, scale));
  const k = next / view.scale;
  view = next === 1 ? { scale: 1, x: 0, y: 0 } : { scale: next, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k };
}

function zoomBy(factor) {
  const frame = data?.frames[current];
  if (!frame) return;
  zoomTo(view.scale * factor);
  $("view").style.transition = "transform .22s var(--ease)";
  sizeView(frame);
  setTimeout(() => ($("view").style.transition = ""), 240);
}

$("stage").addEventListener("wheel", (e) => {
  e.preventDefault();
  const frame = data?.frames[current];
  if (!frame) return;
  const rect = $("stage").getBoundingClientRect();
  const delta = Math.max(-300, Math.min(300, e.deltaY));
  zoomTo(view.scale * Math.exp(-delta / 300), e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2);
  sizeView(frame);
}, { passive: false });

// Drag moves the picture, a click selects a box, and in draw mode (or with Shift) dragging draws a new box
let drag = null;
let sketch = null;   // the box being drawn, in frame pixels
const onOverlay = (e) => e.target.closest("#edit-bar, #fix-bar, #zoom-ctl");

// Mouse position in frame pixels
function toFrame(e) {
  const r = $("view").getBoundingClientRect();
  const f = data.frames[current];
  return { x: ((e.clientX - r.left) / r.width) * f.width, y: ((e.clientY - r.top) / r.height) * f.height };
}

// Which part of the selected box is under the mouse: a corner ("nw", "ne", "sw", "se"), "inside", or null
function grabAt(p) {
  const box = selected != null && liveBoxes(data.frames[current]).find((b) => b.id === selected);
  if (!box) return null;
  const r = (8 * data.frames[current].width) / ($("view").getBoundingClientRect().width || 1);  // 8 screen pixels
  const names = ["nw", "ne", "sw", "se"];
  const corner = cornersOf(box).findIndex(([x, y]) => Math.abs(p.x - x) <= r && Math.abs(p.y - y) <= r);
  if (corner >= 0) return names[corner];
  return p.x >= box.x1 && p.x <= box.x2 && p.y >= box.y1 && p.y <= box.y2 ? "inside" : null;
}
const GRAB_CURSOR = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", inside: "move" };

$("stage").addEventListener("pointerleave", () => {
  if (hovered == null || !data?.frames[current]) return;
  hovered = null;
  $("stage").classList.remove("over-box");
  drawBoxes($("boxes"), data.frames[current], showBoxes, { selected, sketch: pending });
});

$("stage").addEventListener("pointerdown", (e) => {
  if (!data?.frames[current] || onOverlay(e)) return;
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, from: toFrame(e), draw: drawing || e.shiftKey };
  $("stage").setPointerCapture(e.pointerId);
  const grab = drag.draw ? null : grabAt(drag.from);
  if (grab) {  // moving or resizing the selected box
    drag.grab = grab;
    drag.box = liveBoxes(data.frames[current]).find((b) => b.id === selected);
    drag.start = positionOf(drag.box);
  } else if (!drag.draw) {
    $("stage").classList.add("dragging");
  }
});

$("stage").addEventListener("pointermove", (e) => {
  const frame = data?.frames[current];
  if (!drag) {
    // Not dragging: outline the box under the mouse
    if (!frame || !showBoxes || drawing || onOverlay(e)) return;
    $("stage").style.cursor = GRAB_CURSOR[grabAt(toFrame(e))] ?? "";
    const id = boxAt(toFrame(e));
    if (id === hovered) return;
    hovered = id;
    $("stage").classList.toggle("over-box", id != null);
    drawBoxes($("boxes"), frame, showBoxes, { selected, sketch: pending, hovered });
  } else if (drag.grab) {
    const p = toFrame(e);
    const dx = p.x - drag.from.x;
    const dy = p.y - drag.from.y;
    const { x1, y1, x2, y2 } = drag.start;
    const box = drag.box;
    if (drag.grab === "inside") {
      Object.assign(box, { x1: x1 + dx, y1: y1 + dy, x2: x2 + dx, y2: y2 + dy });
    } else {  // a corner: "nw", "ne", "sw" or "se"
      if (drag.grab[1] === "w") box.x1 = x1 + dx;
      if (drag.grab[1] === "e") box.x2 = x2 + dx;
      if (drag.grab[0] === "n") box.y1 = y1 + dy;
      if (drag.grab[0] === "s") box.y2 = y2 + dy;
    }
    drawBoxes($("boxes"), frame, showBoxes, { selected });
  } else if (drag.draw) {
    const p = toFrame(e);
    sketch = { x1: Math.min(drag.from.x, p.x), y1: Math.min(drag.from.y, p.y), x2: Math.max(drag.from.x, p.x), y2: Math.max(drag.from.y, p.y) };
    drawBoxes($("boxes"), frame, showBoxes, { selected, sketch });
  } else {
    view.x = drag.vx + e.clientX - drag.x;
    view.y = drag.vy + e.clientY - drag.y;
    sizeView(frame);
  }
});

$("stage").addEventListener("pointerup", (e) => {
  if (!drag) return;
  const moved = Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4;
  const bigEnough = sketch && sketch.x2 - sketch.x1 >= 3 && sketch.y2 - sketch.y1 >= 3;
  if (drag.grab) {
    if (moved) moveBox(drag.box, drag.start);  // a plain click just keeps it selected
  } else if (drag.draw && bigEnough) {
    pending = sketch;  // next, the user picks its color
    keepDrawing = drawing;  // in draw mode (B), draw another one after that
    drawing = false;
  } else if (!drag.draw && !moved) {
    selectAt(drag.from);
  }
  sketch = null;
  drag = null;
  $("stage").classList.remove("dragging");
  render();
});

$("stage").addEventListener("dblclick", (e) => {
  if (onOverlay(e)) return;
  fit();
  if (data) sizeView(data.frames[current]);
});
$("zoom-in").onclick = () => zoomBy(1.6);
$("zoom-out").onclick = () => zoomBy(1 / 1.6);
$("zoom-fit").onclick = () => { fit(); zoomBy(1); };
window.addEventListener("resize", () => {
  if (mode === "cones") redrawCone();
  else if (mode === "frames" && data?.frames[current]) sizeView(data.frames[current]);
});


// Approve, Needs fix, moving between frames

function go(index) {
  if (!data || index < 0 || index >= data.frames.length) return;
  if (index !== current) selected = pending = null;
  current = index;
  fit();
  render();
}

// Next or previous frame in the list. Works even if the current frame just left the list.
function step(delta) {
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

  // Move on right away; saving in the background
  const advance = !stay && mode === "frames" && index === current && decision !== "reset";
  const nextIndex = advance ? list.find((i) => i > current) : undefined;
  buildList();
  if (nextIndex !== undefined) go(nextIndex);
  else show();

  send("/review", { frame: frame.name, decision, hash: frame.hash, note }, {
    revert: (error) => {
      Object.assign(frame, before);
      toast(`${frame.name}: ${error.message}`);
      buildList();
    },
    retry: () => loadTask(false).then(() => mode === "frames" && go(frame.index)),
  });
}


// Needs fix

let fixIndex = 0;   // the frame the Needs fix dialog is for
let fixing = null;  // the frame being fixed right now 

function askFix(index = current) {
  if (!data?.frames[index]) return;
  fixIndex = index;
  $("fix-note").value = "";
  $("fix-dialog").showModal();
}

// "Fix it now": mark the frame, open it, and let the user click boxes to fix them
$("fix-form").onsubmit = (e) => {
  e.preventDefault();
  $("fix-dialog").close();
  fixing = fixIndex;
  const note = $("fix-note").value.trim();
  if (mode !== "frames" || current !== fixIndex) {
    if (mode === "gallery") {
      lastOpened = fixIndex;
      fromGallery = true;
    }
    current = fixIndex;
    fit();
    decide("needs_fix", note, fixIndex, true);
    return setMode("frames", false);
  }
  decide("needs_fix", note, fixIndex, true);
};

// "Just mark it"
$("fix-later").onclick = () => {
  $("fix-dialog").close();
  decide("needs_fix", $("fix-note").value.trim(), fixIndex);
};
$("fix-cancel").onclick = () => $("fix-dialog").close();

function renderFixBar() {
  const on = fixing === current && mode === "frames" && !pending && selected == null && !drawing;
  $("fix-bar").hidden = !on;
  if (!on) return;
  $("fix-bar").replaceChildren(
    el("span", { className: "what" }, el("b", { textContent: `Fixing #${current}` }),
      el("span", { className: "muted", textContent: "Click a cone to change it, or press B to add a missing one" })),
    el("button", { onclick: () => zoomBy(1.6), title: "Zoom in (+). Scroll to zoom where you point, drag to move" }, "Zoom in ", el("kbd", { textContent: "+" })),
    el("button", { onclick: () => { fixing = null; startFix(current); }, title: "Check every box on this frame, one at a time" }, "One by one"),
    el("button", { onclick: () => { fixing = null; render(); } }, "Leave as needs fix"),
    el("button", { className: "primary", onclick: finishFix }, "Done, approve ", el("kbd", { textContent: "A" })));
}

// "Done, approve": wait until the fixes are saved in CVAT, then approve
async function finishFix() {
  const index = fixing;
  fixing = null;
  $("fix-bar").hidden = true;
  if (inFlight) {
    $("loading").textContent = "Saving your fixes…";
    $("loading").hidden = false;
    await queue;
    try {
      await loadTask(false);
    } catch (error) {
      $("loading").hidden = true;
      return toast(error.message);
    }
    $("loading").hidden = true;
    $("loading").textContent = "Loading…";
  }
  if (mode === "frames" && current === index) decide("approve", undefined, index);
}

// "One by one": go through every box of one frame on the Sort cones screen
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

function openInCvat(index = current) {
  const job = data?.jobs.find((j) => index >= j.start && index <= j.stop);
  if (!job) return toast("No CVAT job contains this frame.");
  window.open(`${data.cvat_url}/tasks/${data.task.id}/jobs/${job.id}?frame=${index}`, "cvat");
}


// Editing boxes on this screen

let selected = null;   // id of the clicked box
let pending = null;    // a newly drawn box that still needs a color
let drawing = false;
let keepDrawing = false;  // stay in draw mode after each new box
let hovered = null;
let lastEdit = null;   // "box" or "decision": what U undoes here

// The smallest box under a point
function boxAt(p) {
  const slack = (6 * data.frames[current].width) / ($("view").getBoundingClientRect().width || 1);
  const inside = (b) => b.x1 - slack <= p.x && p.x <= b.x2 + slack && b.y1 - slack <= p.y && p.y <= b.y2 + slack;
  const area = (b) => (b.x2 - b.x1) * (b.y2 - b.y1);
  const hits = liveBoxes(data.frames[current]).filter(inside).sort((a, b) => area(a) - area(b));
  return hits[0]?.id ?? null;
}

function selectAt(p) {
  selected = boxAt(p);
  pending = null;
}

// The bar at the top of the picture while a box is selected or being drawn
function renderEditBar() {
  const box = selected != null && liveBoxes(data.frames[current]).find((b) => b.id === selected);
  if (!box) selected = null;

  let text = null;
  if (pending) text = "New box: pick its class";
  else if (box) text = `${niceName(labelName(box.label))} box`;
  else if (drawing) text = "Drag on the picture to draw a box. Esc when done";
  $("edit-bar").hidden = !text;
  if (!text) return;

  const colorButtons = pending || box ? data.labels.slice(0, 9).map((l, i) => classButton(l, i, () => pickClass(l.id), "")) : [];
  const deleteButton = box ? [el("button", { className: "danger", onclick: deleteSelected }, "Delete ", el("kbd", { textContent: "X" }))] : [];
  const close = drawing && !pending ? "Done " : "Cancel ";
  $("edit-bar").replaceChildren(el("span", { textContent: text }), ...colorButtons, ...deleteButton,
    el("button", { onclick: cancelEdit }, close, el("kbd", { textContent: "Esc" })));
}

function pickClass(label) {
  lastEdit = "box";
  if (pending) {
    addBox(label);
    drawing = keepDrawing;
  } else if (selected != null && coneById(selected)) {
    changeClass(coneById(selected), label);
  }
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
  drawing = keepDrawing = false;
  render();
}

// After dragging a box: tidy its corners, save it, and remember where it was for undo
function moveBox(box, from) {
  const f = data.frames[current];
  const clamp = (v, max) => Math.min(Math.max(v, 0), max);
  [box.x1, box.x2] = [box.x1, box.x2].map((v) => clamp(v, f.width)).sort((a, b) => a - b);
  [box.y1, box.y2] = [box.y1, box.y2].map((v) => clamp(v, f.height)).sort((a, b) => a - b);
  lastEdit = "box";
  undoStack.push({ id: box.id, kind: "move", from });
  saveMove(box, from);
}

// Send a box's new corners to CVAT. If it fails, put it back at `from`.
function saveMove(box, from) {
  const { x1, y1, x2, y2 } = box;
  send(`/cones/${box.id}`, { action: "move", expected: [from.x1, from.y1, from.x2, from.y2], x1, y1, x2, y2 }, {
    revert: (error) => { Object.assign(box, from); toast(error.message); },
    retry: () => loadTask(false),
    done: () => loadTask(false).catch((e) => toast(e.message)),  // approving needs the new fingerprint
  });
}

function addBox(label) {
  const frame = data.frames[current];
  const corners = pending;
  pending = null;
  const box = { id: `new-${Date.now()}`, label, ...corners };  // shown now, replaced by the real one on reload
  frame.boxes.push(box);
  const entry = { id: null, kind: "add" };
  undoStack.push(entry);
  send("/boxes", { frame: frame.index, label, ...corners }, {
    revert: (error) => {
      frame.boxes.splice(frame.boxes.indexOf(box), 1);
      undoStack.splice(undoStack.indexOf(entry), 1);
      toast(error.message);
    },
    retry: () => loadTask(false),
    done: (result) => {
      entry.id = result.id;
      loadTask(false).catch((e) => toast(e.message));
    },
  });
}
