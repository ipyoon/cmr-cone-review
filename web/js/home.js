// The Home screen.

let overview = [];            // every task, with who it's assigned to
let cvatUrl = "";
const summaries = new Map();  // task id -> its progress (takes time to load a moment after the page)

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
// Progress of one assignment: { frames, approved, needs_fix, unknown, cones }
const progressOf = (task, a) => summaries.get(task.id)?.assignments.find((x) => x.username === a.username && x.start === a.start);
const nextStep = (s) => (s && !s.unknown ? 2 : 1);  // step 1 until every unknown cone is sorted
const finished = (s) => s && !s.unknown && s.approved === s.frames;
const myAssignments = () => overview.flatMap((t) => t.assignments.filter((a) => a.username === me()).map((a) => [t, a]));

// "Your assignments": one card per assignment
function assignmentCard(task, a) {
  const s = progressOf(task, a);
  const step = nextStep(s);
  const go = () => openAssignment(task, a, nextStep(progressOf(task, a)));
  const stepBlock = (n, label, done, total, colour) => el("div", { className: "astep" },
    el("span", { className: "astep-label" }, el("small", { textContent: `Step ${n}` }), label),
    el("span", { className: "astep-num" }, el("b", { textContent: s ? `${pct(done, total)}%` : "…" }),
      el("span", { textContent: s ? `${done.toLocaleString()} of ${total.toLocaleString()}` : "" })),
    el("div", { className: "track" }, el("i", { style: `width:${s ? Math.round((100 * done) / Math.max(1, total)) : 0}%;background:${colour}` })));
  const card = el("div", { className: "assignment", tabIndex: 0, title: "Open this assignment",
    onclick: (e) => { if (!e.target.closest("button")) go(); },
    onkeydown: (e) => { if (e.key === "Enter" && e.target === card) go(); } },
    el("div", { className: "ahead" },
      el("div", {}, el("h3", { className: "title", textContent: `Frames ${a.start}–${a.stop}` }),
        el("div", { className: "sub", textContent: task.name })),
      el("button", { className: finished(s) ? "" : "cta", onclick: go },
        finished(s) ? "Open" : step === 1 ? "Sort cones" : "Review frames", icon("right"))),
    el("div", { className: "asteps" },
      stepBlock(1, "sort unknown cones", s ? s.cones - s.unknown : 0, s?.cones ?? 0, "var(--red)"),
      stepBlock(2, "approve frames", s?.approved ?? 0, s?.frames ?? 0, "var(--black)")));
  return card;
}

// "Tasks": one card per task
function taskRow(task) {
  const s = summaries.get(task.id)?.task;
  const stats = [plural(task.size, "frame")];
  if (!s) stats.push("counting…");
  else {
    stats.push(`${pct(s.approved, s.frames)}% approved`);
    if (s.needs_fix) stats.push(`${s.needs_fix} to fix`);
    if (s.unknown) stats.push(plural(s.unknown, "unknown cone"));
  }
  const people = [...new Set(task.assignments.map((a) => a.username))];
  return el("div", { className: "task-card" },
    el("button", { className: "task-open", title: "Open this task", onclick: () => openTask(task) },
      el("span", { className: "name", textContent: task.name }),
      el("span", { className: "stats" }, ...stats.map((text) => el("span", { textContent: text }))),
      el("span", { className: "go" }, "Open", icon("right"))),
    el("button", { className: "ghost task-assign", onclick: () => assignTask(task),
      textContent: people.length ? `Reviewers: ${people.join(", ")}` : "Assign reviewers" }));
}

// The "Next up" line at the top
function drawNext() {
  const mine = myAssignments();
  const todo = mine.find(([t, a]) => !finished(progressOf(t, a)));
  let title, where = "", label, go;
  if (todo) {
    const [t, a] = todo, s = progressOf(t, a), step = nextStep(s);
    title = !s ? "Your assignment" : step === 1 ? `Sort ${plural(s.unknown, "unknown cone")}`
      : `Review ${plural(s.frames - s.approved, "frame")}`;
    where = t.name;
    label = step === 1 ? "Sort cones" : "Review frames";
    go = () => openAssignment(t, a, nextStep(progressOf(t, a)));
  } else if (mine.length) {
    [title, label, go] = ["Every frame assigned to you is approved", "Open a task", () => openTask(currentTask())];
  } else if (overview.length) {
    [title, where, label, go] = ["Pick a task to review", "Nothing is assigned to you yet. Open a task, or assign reviewers from Tasks below.", "Open a task", () => openTask(currentTask())];
  } else {
    [title, where, label, go] = ["No tasks yet", "Upload pictures or a video to start reviewing.", "New task", openNewTask];
  }
  $("home-next-title").textContent = title;
  $("home-next-where").textContent = where;
  $("home-continue").hidden = !label;
  $("home-continue").replaceChildren(label ?? "", icon("right"));
  $("home-continue").onclick = go;
}

// "Progress": bar chart. Each part: [letter in the timeline, color, words, gallery filter].
const STATUS_PARTS = [["a", "var(--black)", "approved", "verified"], ["f", "var(--red)", "needs fix", "needs_fix"],
  ["c", "var(--grey)", "changed since approval", "todo"], [".", "var(--light-grey)", "to review", "todo"]];
function drawTotals() {
  const ready = overview.length > 0 && overview.every((t) => summaries.has(t.id));
  // How many frames of a task are in a state. The server sends each frame's state as one letter.
  const count = (t, letter) => (summaries.get(t.id)?.timeline.split(letter).length ?? 1) - 1;
  const frames = overview.reduce((n, t) => n + t.size, 0);
  const tally = (tasks) => STATUS_PARTS.map(([letter, colour, text, filterKey]) =>
    ({ letter, colour, text, filterKey, n: tasks.reduce((m, t) => m + count(t, letter), 0) }));
  const all = tally(overview);
  $("home-total").textContent = ready ? `${pct(all[0].n, frames)}% approved overall` : "Counting frames in CVAT…";

  const bar = (name, tasks, size) => {
    const parts = tally(tasks);
    const open = (p) => () => {
      // Open the task with the most frames in this state
      const task = [...tasks].sort((x, y) => count(y, p.letter) - count(x, p.letter))[0];
      if (task) openStatus(task, p.filterKey);
    };
    return el("div", {},
      el("div", { className: "prow-head" }, el("span", { className: "pname", textContent: name }),
        el("span", { className: "pmeta", textContent: `${parts[0].n.toLocaleString()} of ${plural(size, "frame")} approved` })),
      el("div", { className: "bigbar" }, ...parts.filter((p) => p.n > 0).map((p) =>
        el("button", { className: `part s-${p.letter === "." ? "todo" : p.letter}`, style: `flex:${p.n} 1 0;--c:${p.colour}`,
          title: `${p.n.toLocaleString()} ${p.text}: click to see them`, onclick: open(p) },
          el("b", { textContent: `${pct(p.n, size)}%` }), el("span", { textContent: p.text })))));
  };
  if (!ready) $("home-bars").replaceChildren();
  else $("home-bars").replaceChildren(bar(overview.length > 1 ? "All tasks" : overview[0].name, overview, frames));
  $("home-legend").replaceChildren(...(ready ? all : []).map((p) =>
    el("span", {}, el("i", { style: `background:${p.colour}` }), el("b", { textContent: p.n.toLocaleString() }), ` ${p.text}`)));
}

// Open a task's frames in one state in the Gallery
async function openStatus(task, filterKey) {
  focusUser = null;
  try { await useTask(task); } catch (error) { return toast(error.message); }
  scope = "all";
  store("review.scope", scope);
  filter = filterKey;
  setupScope();
  setMode("gallery", false);
}

function drawHome() {
  const mine = myAssignments();
  $("home-mine-block").hidden = !mine.length;
  $("home-mine").replaceChildren(...mine.map(([t, a]) => assignmentCard(t, a)));
  $("home-tasks").replaceChildren(...overview.map(taskRow));
  drawTotals();
  drawNext();
  drawFlow();
}

// "Pipeline": CVAT, Assign, Sort cones, Review, Export
function drawFlow() {
  const ready = overview.length > 0 && overview.every((t) => summaries.has(t.id));
  const total = (key) => overview.reduce((n, t) => n + (summaries.get(t.id)?.task[key] ?? 0), 0);
  const frames = overview.reduce((n, t) => n + t.size, 0);
  const assigned = overview.reduce((n, t) => n + t.assignments.reduce((m, a) => m + a.stop - a.start + 1, 0), 0);
  const people = new Set(overview.flatMap((t) => t.assignments.map((a) => a.username))).size;
  const [unknown, approved, fixes] = [total("unknown"), total("approved"), total("needs_fix")];
  const nodes = [
    { title: "CVAT", value: overview.length, sub: `${overview.length === 1 ? "task" : "tasks"} with ${plural(frames, "frame")}`, done: true,
      go: () => window.open(cvatUrl, "cvat") },
    { title: "Assign", value: `${pct(assigned, frames)}%`, sub: `of frames, shared by ${plural(people, "reviewer")}`,
      done: frames > 0 && assigned >= frames, go: () => overview[0] && assignTask(currentTask()) },
    { title: "Sort cones", value: ready ? unknown.toLocaleString() : "…", sub: "unknown cones left to sort",
      done: ready && unknown === 0, go: () => continueStep(1) },
    { title: "Review", value: ready ? `${pct(approved, frames)}%` : "…", sub: ready ? `approved, ${fixes} to fix` : "",
      done: ready && approved === frames, go: () => continueStep(2) },
    { title: "Export", value: ready ? approved.toLocaleString() : "…", sub: "frames ready", done: false, go: showExport },
  ];
  // The black line runs to the last finished stage (counting from the start)
  const firstNotDone = nodes.findIndex((n) => !n.done);
  const lastDone = (firstNotDone < 0 ? nodes.length : firstNotDone) - 1;
  $("flow").style.setProperty("--at", Math.max(0, lastDone) / (nodes.length - 1));
  $("flow").replaceChildren(...nodes.map((n, i) => el("button", {
    className: `step${n.done ? " done" : ""}`, onclick: n.go },
    el("span", { className: "node" }, n.done ? icon("check") : String(i + 1)),
    el("span", { className: "label", textContent: n.title }),
    el("span", { className: "value", textContent: n.value }),
    el("span", { className: "sub", textContent: n.sub }))));
}

const currentTask = () => overview.find((t) => String(t.id) === $("task").value) ?? overview[0];

// Clicking Sort cones or Review: next assignment on that step, or else the whole task
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

// Load Home; if it's already loading, load once more when that's done.
let homeLoading = null, homeAgain = false, homeLoadedAt = 0;
function renderHome() {
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
  // Count only after last changes are saved. Each task's numbers appear as soon as they arrive.
  await queue;
  await Promise.all(overview.map(async (task) => {
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

// Open a task (load it if it's not the one already open)
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

async function assignTask(task) {
  try { await useTask(task); } catch (error) { return toast(error.message); }
  openAssign();
}

// The photo fades out as page scrolls; fade goes from 0 to 1 (see .hero in style.css)
$("home").addEventListener("scroll", () => {
  cancelAnimationFrame(drawHome.fadeFrame);
  drawHome.fadeFrame = requestAnimationFrame(() => {
    const hero = document.querySelector(".hero");
    hero.style.setProperty("--fade", Math.min(1, $("home").scrollTop / (hero.offsetHeight * .8)).toFixed(3));
  });
}, { passive: true });
