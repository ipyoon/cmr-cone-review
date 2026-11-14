// home.js: the Home screen.
//
// Top panel: % approved over all tasks, and the one thing to do next.
// Pipeline: CVAT -> Assign -> Sort cones -> Review -> Export.
// Each task is drawn as a timeline: one sliver per video frame, coloured by its status.
// Hovering a timeline shows that frame; clicking opens it.

// ------------------------------------------------------------- home

let overview = [];          // tasks with their assignments
let cvatUrl = "";
const summaries = new Map();  // task id -> progress, filled in after the page shows

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
function meter(label, value, colour, fraction) {
  return el("div", { className: "meter" },
    el("div", { className: "meter-head" }, el("span", { textContent: label }), el("span", { textContent: value })),
    el("div", { className: "track" }, el("i", { style: `width:${Math.round(100 * fraction)}%;background:${colour}` })));
}
const progressOf = (task, a) => summaries.get(task.id)?.assignments.find((x) => x.username === a.username && x.start === a.start);
const nextStep = (s) => (s && !s.unknown ? 2 : 1);
const finished = (s) => s && !s.unknown && s.approved === s.frames;
const myAssignments = () => overview.flatMap((t) => t.assignments.filter((a) => a.username === me()).map((a) => [t, a]));

// The timeline: each frame of the video as a sliver. Grey until a reviewer decides on it, then
// green (approved), red (needs fix) or amber (boxes changed after approval). A thin violet line
// underneath marks frames that still have unknown cones to sort.
const FRAME_STATES = {
  a: ["var(--ok)", "approved"], f: ["var(--bad)", "needs fix"], c: ["var(--warn)", "changed since approval"],
  ".": ["var(--todo)", "not reviewed yet"],
};
const legend = () => el("span", { className: "legend" },
  ...Object.values(FRAME_STATES).map(([colour, text]) => el("span", {}, el("i", { style: `background:${colour}` }), text)),
  el("span", {}, el("i", { className: "line", style: "background:var(--unsorted)" }), "cones to sort"));

// One floating preview, shared by every timeline: the frame under the pointer, with its status
const peekImg = el("img", { alt: "", decoding: "async" });
const peekDot = el("i"), peekNum = el("b"), peekText = el("span", { className: "muted" });
const peek = el("div", { className: "peek", hidden: true }, peekImg, el("div", {}, peekDot, peekNum, peekText));
document.body.append(peek);

// Each new frame can mean a whole video chunk downloaded from CVAT, so the preview waits until the
// pointer rests, keeps at most one request going, and shows frames it already has straight away.
const peekSeen = new Set();
let peekWant = null, peekBusy = false;
function peekLoad(url) {
  peekWant = url;
  clearTimeout(peekLoad.timer);
  if (peekSeen.has(url)) return void (peekImg.src = url);
  peekImg.removeAttribute("src");
  peekLoad.timer = setTimeout(peekNext, 220);
}
function peekNext() {
  if (peekBusy || !peekWant || peek.hidden) return;
  const url = peekWant, img = new Image();
  peekBusy = true;
  img.onload = img.onerror = () => {
    peekBusy = false;
    if (img.naturalWidth) peekSeen.add(url);
    if (url === peekWant && img.naturalWidth) peekImg.src = url;
    else if (url !== peekWant) peekNext();  // the pointer moved on meanwhile: fetch where it is now
  };
  img.src = url;
}

function timeline(task, states, unsorted = "", offset = 0, interactive = true) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "timeline");
  svg.setAttribute("viewBox", `0 0 ${Math.max(1, states.length)} 10`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Frames ${offset}–${offset + states.length - 1} by status`);
  // One rectangle per run of frames in the same state, not one per frame
  const runs = (text, skip, y, height, colour) => {
    for (let i = 0; i < text.length;) {
      let j = i;
      while (j < text.length && text[j] === text[i]) j++;
      if (text[i] !== skip) {
        const rect = document.createElementNS(NS, "rect");
        for (const [k, v] of Object.entries({ x: i, y, width: j - i, height })) rect.setAttribute(k, v);
        rect.style.fill = colour(text[i]);
        svg.append(rect);
      }
      i = j;
    }
  };
  runs(states, ".", 0, unsorted.includes("1") ? 7.4 : 10, (c) => FRAME_STATES[c]?.[0] ?? "var(--todo)");
  runs(unsorted, "0", 8.4, 1.6, () => "var(--unsorted)");
  if (!interactive) return svg;

  const cursor = el("i", { className: "cursor" });
  const wrap = el("div", { className: "tl" }, svg, cursor);
  let shown = -1;
  const at = (e) => {
    const r = svg.getBoundingClientRect();
    return Math.min(states.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * states.length)));
  };
  svg.onpointermove = (e) => {
    const i = at(e), r = svg.getBoundingClientRect();
    cursor.style.left = `${((i + 0.5) / states.length) * 100}%`;
    Object.assign(peek.style, { left: `${Math.min(window.innerWidth - 116, Math.max(116, e.clientX))}px`, top: `${r.top}px` });
    peek.hidden = false;
    if (i === shown) return;
    shown = i;
    const [colour, text] = FRAME_STATES[states[i]] ?? FRAME_STATES["."];
    peekLoad(`/api/tasks/${task.id}/frames/${offset + i}/image?size=small`);
    peekDot.style.background = colour;
    peekNum.textContent = `#${offset + i}`;
    peekText.textContent = unsorted[i] === "1" ? `${text} · cones to sort` : text;
  };
  svg.onpointerleave = () => { peek.hidden = true; shown = -1; peekWant = null; clearTimeout(peekLoad.timer); };
  svg.onclick = (e) => { peek.hidden = true; openFrameOf(task, offset + at(e)); };
  return wrap;
}

// Frame numbers under a timeline, like distance markers along a track: round steps, plus the last frame
function scale(from, to) {
  const n = to - from + 1, rough = (n - 1) / 4;
  const pow = 10 ** Math.floor(Math.log10(Math.max(1, rough)));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= rough));
  const marks = [from];
  for (let f = Math.ceil((from + 1) / step) * step; f <= to - step / 2; f += step) if (f - from >= step / 2) marks.push(f);
  if (to !== from) marks.push(to);
  const at = (f) => (n === 1 ? 0 : (100 * (f - from)) / (n - 1));
  return el("div", { className: "scale" }, ...marks.map((f) => el("span", { style: `left:${at(f)}%`, textContent: f })));
}

// Under the timeline: who reviews which stretch of it
function ranges(task) {
  return el("div", { className: "ranges" }, ...task.assignments.map((a) => {
    const p = progressOf(task, a);
    return el("button", {
      className: `range${a.username === me() ? " me" : ""}`, onclick: () => openAssignment(task, a, nextStep(p)),
      title: `${a.username}: frames #${a.start}–${a.stop}${p ? ` · ${p.approved}/${p.frames} approved · ${p.unknown} unknown cones` : ""}`,
      style: `left:${(100 * a.start) / task.size}%;width:${(100 * (a.stop - a.start + 1)) / task.size}%`,
    }, el("b", { textContent: a.username }), " ", el("span", { className: "f", textContent: `${a.start}–${a.stop}` }));
  }));
}

function assignmentCard(task, a) {
  const s = progressOf(task, a);
  const step = nextStep(s);
  const sum = summaries.get(task.id);
  const states = sum?.timeline.slice(a.start, a.stop + 1), unsorted = sum?.unsorted.slice(a.start, a.stop + 1);
  const card = el("div", { className: "assignment", tabIndex: 0, title: "Open this assignment",
    onclick: (e) => { if (!e.target.closest("button, .tl")) openAssignment(task, a, nextStep(progressOf(task, a))); },
    onkeydown: (e) => { if (e.key === "Enter" && e.target === card) openAssignment(task, a, nextStep(progressOf(task, a))); } },
    el("div", {}, el("h3", { className: "title", textContent: `Frames ${a.start}–${a.stop}` }),
      el("div", { className: "sub", textContent: task.name })),
    el("div", {}, states ? timeline(task, states, unsorted, a.start) : el("div", { className: "timeline" }), scale(a.start, a.stop)),
    meter("1 · Sort unknown cones", s ? (s.unknown ? `${s.cones - s.unknown} / ${s.cones} sorted` : "done") : "…", "var(--unsorted)",
      s ? (s.cones - s.unknown) / Math.max(1, s.cones) : 0),
    meter("2 · Review frames", s ? `${s.approved} / ${s.frames}` : "…", "var(--ok)", s ? s.approved / Math.max(1, s.frames) : 0),
    el("div", {}, el("button", {
      className: finished(s) ? "soft sm" : "cta sm", onclick: () => openAssignment(task, a, step),
      textContent: finished(s) ? "Open" : step === 1 ? "Sort cones" : "Review frames",
    })));
  return card;
}

function taskRow(task) {
  const sum = summaries.get(task.id), s = sum?.task;
  const done = s && s.approved === s.frames;
  const stats = s ? [plural(task.size, "frame"), `${pct(s.approved, s.frames)}% approved`,
    ...(s.needs_fix ? [`${s.needs_fix} to fix`] : []),
    ...(s.unknown ? [`${s.unknown.toLocaleString()} unknown`] : [])].join("  ·  ") : `${plural(task.size, "frame")}  ·  counting…`;
  return el("div", { className: "task" },
    el("div", { className: "task-head" },
      el("button", { className: `name link${done ? " flag" : ""}`, title: done ? "Every frame approved. Open the task" : "Open the task", textContent: task.name, onclick: () => openTask(task) }),
      el("span", { className: "stats", textContent: stats }),
      el("span", { className: "row" },
        el("button", { className: "ghost", textContent: "Assign", onclick: () => assignTask(task) }),
        el("button", { className: "soft sm", textContent: "Open", onclick: () => openTask(task) }))),
    sum ? timeline(task, sum.timeline, sum.unsorted) : el("div", { className: "timeline" }),
    scale(0, task.size - 1),
    task.assignments.length ? ranges(task) : el("div", { className: "empty-note", style: "margin:4px 0 6px", textContent: "Nobody assigned yet." }));
}

// The single most useful thing to do next, spelled out
function drawNext() {
  const mine = myAssignments();
  const todo = mine.find(([t, a]) => !finished(progressOf(t, a)));
  let title, where = "", label, go, done = false;
  if (todo) {
    const [t, a] = todo, s = progressOf(t, a), step = nextStep(s);
    title = !s ? "Your assignment" : step === 1 ? `Sort ${plural(s.unknown, "unknown cone")}`
      : `Review ${plural(s.frames - s.approved, "frame")}`;
    where = `${t.name}  ·  frames ${a.start}–${a.stop}${s?.approved ? `  ·  ${s.approved} approved so far` : ""}`;
    label = step === 1 ? "Sort cones" : "Review frames";
    go = () => openAssignment(t, a, nextStep(progressOf(t, a)));
  } else if (mine.length) {
    [title, label, go, done] = ["Every frame assigned to you is approved", "Open a task", () => openTask(currentTask()), true];
  } else if (overview.length) {
    [title, where, label, go] = ["Nothing is assigned to you yet", "Open a task to review it, or assign frames from its row below.", "Open a task", () => openTask(currentTask())];
  } else {
    [title, where, label, go] = ["No tasks yet", "Upload pictures or a video to start reviewing.", "New task", openNewTask];
  }
  $("home-next-title").textContent = title;
  $("home-next-title").classList.toggle("flag", done);
  $("home-next-where").textContent = where;
  $("home-continue").hidden = !label;
  $("home-continue").replaceChildren(label ?? "", icon("right"));
  $("home-continue").onclick = go;
}

// The progress over every task, as a sentence, with every frame of every task drawn end to end below it
function drawTotals() {
  const ready = overview.length > 0 && overview.every((t) => summaries.has(t.id));
  const total = (key) => overview.reduce((n, t) => n + (summaries.get(t.id)?.task[key] ?? 0), 0);
  const frames = overview.reduce((n, t) => n + t.size, 0);
  const people = new Set(overview.flatMap((t) => t.assignments.map((a) => a.username))).size;
  $("home-total").textContent = !overview.length ? "Loading tasks…"
    : !ready ? "Counting frames in CVAT…"
    : `${total("approved").toLocaleString()} of ${plural(frames, "frame")} approved (${pct(total("approved"), frames)}%)`;
  $("home-badge").textContent = ready
    ? `${total("needs_fix")} to fix · ${plural(total("unknown"), "unknown cone")} to sort · ${plural(overview.length, "task")}, ${plural(people, "reviewer")}`
    : "";
  $("home-strip").replaceChildren(...(ready ? overview.map((t) => {
    const sum = summaries.get(t.id);
    return el("div", { title: t.name, style: `flex:${Math.max(1, t.size)} 1 0;min-width:0` }, timeline(t, sum.timeline, sum.unsorted));
  }) : []));
}

function drawHome() {
  const mine = myAssignments();
  $("home-mine-block").hidden = !mine.length;
  $("home-mine").replaceChildren(...mine.map(([t, a]) => assignmentCard(t, a)));
  $("home-legend").replaceWith(Object.assign(legend(), { id: "home-legend" }));
  $("home-tasks").replaceChildren(...overview.map(taskRow));
  drawTotals();
  drawNext();
  drawFlow();
  setAmbient();
}

// The pipeline: CVAT -> Assign -> Sort -> Review -> Export, with the first unfinished stage lit
function drawFlow() {
  const ready = overview.length > 0 && overview.every((t) => summaries.has(t.id));
  const total = (key) => overview.reduce((n, t) => n + (summaries.get(t.id)?.task[key] ?? 0), 0);
  const frames = overview.reduce((n, t) => n + t.size, 0);
  const assigned = overview.reduce((n, t) => n + t.assignments.reduce((m, a) => m + a.stop - a.start + 1, 0), 0);
  const people = new Set(overview.flatMap((t) => t.assignments.map((a) => a.username))).size;
  const [unknown, approved, fixes] = [total("unknown"), total("approved"), total("needs_fix")];
  const nodes = [
    { title: "CVAT", value: overview.length, sub: `tasks · ${frames.toLocaleString()} frames`, done: true,
      go: () => window.open(cvatUrl, "cvat") },
    { title: "Assign", value: `${pct(assigned, frames)}%`, sub: `of frames · ${plural(people, "reviewer")}`,
      done: frames > 0 && assigned >= frames, go: () => overview[0] && assignTask(currentTask()) },
    { title: "Sort cones", value: ready ? unknown.toLocaleString() : "…", sub: "unknown cones left",
      done: ready && unknown === 0, go: () => continueStep(1) },
    { title: "Review", value: ready ? `${pct(approved, frames)}%` : "…", sub: ready ? `approved · ${fixes} to fix` : "",
      done: ready && approved === frames, go: () => continueStep(2) },
    { title: "Export", value: ready ? approved.toLocaleString() : "…", sub: "frames ready", done: false, go: showExport },
  ];
  const active = nodes.findIndex((n) => !n.done);
  $("flow").replaceChildren(...nodes.map((n, i) => el("button", {
    className: `step${n.done ? " done" : ""}${i === active ? " active" : ""}`, onclick: n.go },
    el("span", { className: "label" }, n.done ? icon("check") : "", n.title),
    el("span", { className: "value", textContent: n.value }),
    el("span", { className: "sub", textContent: n.sub }))));
}

const currentTask = () => overview.find((t) => String(t.id) === $("task").value) ?? overview[0];

// The pipeline's step buttons: your next assignment on that step, or the whole task
function continueStep(step) {
  const mineList = overview.flatMap((t) => t.assignments.filter((a) => a.username === me()).map((a) => [t, a]));
  const pick = mineList.find(([t, a]) => {
    const s = progressOf(t, a);
    return !s || (step === 1 ? s.unknown > 0 : s.approved < s.frames);
  });
  if (pick) return openAssignment(pick[0], pick[1], step);
  const task = currentTask();
  if (!task) return;
  openTask(task, step === 1 ? "cones" : "frames");
}

let homeLoading = null, homeAgain = false, homeLoadedAt = 0;
function renderHome() {
  // Never two rounds of CVAT requests at once: asking during a refresh runs one more right after it,
  // so a decision made meanwhile is still counted
  if (homeLoading) { homeAgain = true; drawHome(); return homeLoading; }
  homeLoading = (async () => {
    do { homeAgain = false; await loadHome(); } while (homeAgain && mode === "home");
  })().finally(() => { homeLoading = null; homeLoadedAt = Date.now(); });
  return homeLoading;
}
async function loadHome() {
  try {
    ({ tasks: overview, cvat_url: cvatUrl } = await api("/api/overview"));
  } catch (error) {
    return toast(error.message);
  }
  drawHome();
  // Approvals are saved in the background: count only once they've all reached CVAT,
  // or the home page would show the numbers from before your last decisions
  await queue;
  await Promise.all(overview.map(async (task) => {  // each needs the task's boxes from CVAT, so they fill in as they arrive
    let summary;
    try {
      summary = await api(`/api/tasks/${task.id}/summary`);
    } catch (error) {
      if (error.status === 401) return showLogin();
      return toast(`${task.name}: ${error.message}`);
    }
    summaries.set(task.id, summary);
    if (mode === "home") drawHome();
  }));
}

async function useTask(task) {
  $("task").value = task.id;
  store("review.task", task.id);
  if (data?.task.id !== task.id) {
    data = null;
    cards.clear();
    await busy(`Loading ${task.name} from CVAT…`, () => loadTask(true));
  }
}

async function openAssignment(task, a, step) {
  focusUser = a.username === me() ? null : a.username;
  try { await useTask(task); } catch (error) { return toast(error.message); }
  setupScope();
  goStep(step, false);
}

async function openTask(task, screen = "frames") {
  focusUser = null;
  try { await useTask(task); } catch (error) { return toast(error.message); }
  scope = "all";
  store("review.scope", scope);
  setupScope();
  if (screen === "cones" && unknownLabel() !== undefined) $("sort").value = unknownLabel();
  setMode(screen, false);
}

// A click on a task's timeline: that exact frame, whatever its status
async function openFrameOf(task, index) {
  focusUser = null;
  try { await useTask(task); } catch (error) { return toast(error.message); }
  scope = "all";
  store("review.scope", scope);
  filter = "all";
  setupScope();
  fromGallery = false;
  current = index;
  fit();
  setMode("frames", false);
}

async function assignTask(task) {
  try { await useTask(task); } catch (error) { return toast(error.message); }
  openAssign();
}
