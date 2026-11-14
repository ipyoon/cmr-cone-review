// main.js: starts the page and connects buttons and keys to what they do.
//
//   setMode("home" | "frames" | "gallery" | "cones")  switches screens
//   loadTask()                                        gets the open task from the server
// Loaded last, so everything from the other files exists by now.

// ------------------------------------------------------------- loading

async function start(username) {
  $("who").textContent = username;
  $("login").hidden = true;
  $("app").hidden = false;
  const tasks = await loadTaskList();
  if (!tasks.length) return setMode("home");  // nothing to review yet: Home has "New task"
  setMode(["frames", "cones", "gallery"].includes(store("review.mode")) ? store("review.mode") : "home");
}

// The task picker in the top bar (also refreshed after "New task")
async function loadTaskList() {
  const tasks = await api("/api/tasks");
  $("task").replaceChildren(...tasks.map((t) => el("option", { value: t.id, textContent: `${t.name} · ${t.size} frames` })));
  const saved = store("review.task");
  if (tasks.some((t) => String(t.id) === saved)) $("task").value = saved;
  return tasks;
}

let taskLoadedAt = 0;
async function loadTask(fresh, keepId) {
  const keep = fresh ? undefined : keepId ?? cones[coneAt]?.box.id;
  const sentBefore = sent;
  const loaded = await api(`/api/tasks/${$("task").value}/frames`);
  // A change made while this was loading isn't in it: wait until it's saved, then load again
  if (sent !== sentBefore) {
    await queue;
    return loadTask(fresh, keep);
  }
  data = loaded;
  taskLoadedAt = Date.now();
  setupScope();
  setupSort();
  buildList();
  buildCones();
  if (fresh) {
    current = list[0] ?? 0;
    fit();
    coneAt = 0;
    undoStack = [];
  }
  // Stay on the same box after a reload, or the next unsorted one if it's gone
  const same = keep !== undefined && cones.find((c) => c.box.id === keep);
  coneAt = same ? same.pos : coneList.find((p) => p >= coneAt) ?? cones.length;
  show();
}

// The faint blurred picture behind the page: the frame you're on, or the middle of the task elsewhere.
// It waits half a second, so flipping quickly through frames doesn't load every one.
let ambientUrl = "";
function setAmbient() {
  const task = data?.task.id ?? overview[0]?.id;
  if (task == null) return;
  const size = data?.frames.length ?? overview[0]?.size ?? 1;
  const index = mode === "frames" ? current : mode === "cones" && cones[coneAt] ? cones[coneAt].frame.index : Math.floor(size / 2);
  const url = `/api/tasks/${task}/frames/${index}/image?size=small`;
  if (url === ambientUrl) return;
  ambientUrl = url;
  clearTimeout(setAmbient.timer);
  setAmbient.timer = setTimeout(() => {
    const img = new Image();
    img.onload = () => { if (ambientUrl === url) $("ambient").style.backgroundImage = `url("${url}")`; };
    img.src = url;
  }, 500);
}

// Draw the screen that's showing
function show() {
  setAmbient();
  ({ cones: renderCone, gallery: renderGallery, frames: render, home: () => {} })[mode]();
}

function buildList() { list = data.frames.filter((f) => inScope(f.index) && FILTERS[filter](f)).map((f) => f.index); }

function setupScope() {
  const ranges = data.assignments.filter((a) => a.username === who());
  mine = ranges.length ? new Set(ranges.flatMap((a) => Array.from({ length: a.stop - a.start + 1 }, (_, i) => a.start + i))) : null;
  $("scope").replaceChildren(
    el("option", { value: "mine", textContent: `${whose("My", "@'s")} frames (${ranges.map((a) => `#${a.start}–${a.stop}`).join(", ")})` }),
    el("option", { value: "all", textContent: "All frames" }));
  $("scope").value = scope;
  $("scope").hidden = !mine;
}

function setMode(next, reload = true) {
  mode = next;
  store("review.mode", mode);
  for (const button of $("mode").children) button.setAttribute("aria-pressed", button.dataset.mode === mode);
  // Each part of the page lists the screens it belongs to in data-show="..."
  for (const node of document.querySelectorAll("[data-show]")) node.hidden = !node.dataset.show.split(" ").includes(mode);
  if (next !== "cones") fixFrame = null;
  if (next === "gallery") { fromGallery = false; scrollToLast = true; }
  if (next === "home") return renderHome();
  if (!data) return loadTask(true).catch((e) => toast(e.message));
  if (!reload) {  // the task was just loaded
    buildList();
    buildConeList();
    firstCone();
    return show();
  }
  if (mode === "cones") { cones = []; coneAt = 0; }  // start at the first unsorted box
  // Reload either way: cone changes alter the fingerprints the Frames screen approves
  loadTask(false).catch((e) => toast(e.message));
}

// Selects and inputs give the keyboard back to the shortcuts once a choice is made
const onPick = (id, fn) => ($(id).onchange = () => { $(id).blur(); fn(); });
onPick("scope", () => {
  scope = $("scope").value;
  store("review.scope", scope);
  buildList();
  buildConeList();
  firstCone();
  if (mode === "frames" && list.length && !list.includes(current)) go(list[0]); else show();
});
onPick("sort", () => { fixFrame = null; store("review.sort", labelName(sortLabel())); buildConeList(); firstCone(); renderCone(); });
onPick("jump", () => { go(Number($("jump").value)); $("jump").value = ""; });
onPick("task", () => { focusUser = null; store("review.task", $("task").value); loadTask(true).catch((e) => toast(e.message)); });
$("mode").onclick = (e) => { const b = e.target.closest("button"); if (b) { b.blur(); setMode(b.dataset.mode); } };
$("filter").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b || !data) return;
  b.blur();
  filter = b.dataset.filter;
  buildList();
  if (mode === "frames" && list.length && !list.includes(current)) go(list[0]); else show();
};
onPick("gallery-sort", renderGallery);
$("gallery-size").oninput = () => {
  $("gallery").style.setProperty("--card", `${$("gallery-size").value}px`);
  store("review.size", $("gallery-size").value);
};
$("follow").checked = store("review.follow") !== "off";
$("follow").onchange = () => { $("follow").blur(); store("review.follow", $("follow").checked ? "on" : "off"); };
$("gallery-size").value = store("review.size") ?? 240;
$("gallery-size").oninput();

const clicks = {
  flag: flagCone, skip: skipCone, "cone-undo": undoCone,
  "cone-edit": () => cones[coneAt] && openInCvat(cones[coneAt].frame.index),
  wide: () => { coneZoom = coneGeom && coneGeom.side >= coneGeom.fullSide ? 3 : "full"; conePan = null; redrawCone(); },
  "cone-prev": () => coneStep(-1), "cone-next": () => coneStep(1),
  approve: () => decide("approve"), fix: () => askFix(), reset: () => decide("reset"),
  edit: () => openInCvat(), prev: () => step(-1), next: () => step(1),
  toggle: () => { showBoxes = !showBoxes; render(); },
  draw: () => { drawing = !drawing; selected = pending = null; render(); },
  "auto-sort": autoSort,
  help: () => $("help-dialog").showModal(), "help-close": () => $("help-dialog").close(),
  "fix-done": () => fixFrame !== null && endFix(),
  brand: () => setMode("home"),
  theme: () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"),
  "export-close": () => $("export-dialog").close(),
  assign: openAssign,
  "new-task": openNewTask,
  "back-gallery": () => fromGallery && setMode("gallery"),
  logout: async () => { await post("/api/logout", {}); data = null; showLogin(); },
};
for (const [id, fn] of Object.entries(clicks)) $(id).onclick = fn;
$("brand").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setMode("home"); } };

$("image").onload = () => { $("loading").hidden = true; };
$("image").onerror = () => { $("loading").hidden = true; toast("Could not load this frame from CVAT."); };

$("login-form").onsubmit = async (e) => {
  e.preventDefault();
  $("login-error").hidden = true;
  try {
    const me = await post("/api/login", { username: $("username").value, password: $("password").value });
    $("password").value = "";
    await start(me.username);
  } catch (error) {
    $("login-error").textContent = error.message;
    $("login-error").hidden = false;
  }
};

const KEYS = {
  cones: { escape: "fix-done", x: "flag", s: "skip", u: "cone-undo", e: "cone-edit", z: "wide", arrowright: "cone-next", n: "cone-next", arrowleft: "cone-prev", p: "cone-prev" },
  gallery: {},
  home: {},
  frames: { escape: "back-gallery", a: "approve", f: "fix", u: "reset", e: "edit", t: "toggle", arrowright: "next", n: "next", arrowleft: "prev", p: "prev" },
};
window.addEventListener("keydown", (e) => {
  if ($("app").hidden || !data || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector("dialog[open]") || ["INPUT", "SELECT"].includes(e.target.tagName)) return;
  const key = e.key.toLowerCase();
  if (e.target.tagName === "BUTTON" && (key === " " || key === "enter")) return;
  const n = Number(e.key);
  let action = clicks[KEYS[mode][key]];
  if (key === "?") action = clicks.help;
  const digit = Number.isInteger(n) && n >= 1 && n <= Math.min(9, data.labels.length) ? data.labels[n - 1].id : null;
  if (mode === "cones" && digit != null) action = () => relabel(digit);
  if (mode === "cones" && key === "enter" && cones[coneAt]?.box.suggest) action = () => relabel(cones[coneAt].box.suggest.label);
  if (mode === "frames") {
    const editing = pending || selected != null;
    if (digit != null && editing) action = () => pickClass(digit);
    if (["x", "delete", "backspace"].includes(key) && selected != null) action = deleteSelected;
    if (key === "b") action = clicks.draw;
    if (key === "escape" && (editing || drawing)) action = cancelEdit;
    if (key === "u" && lastEdit === "box") action = undoCone;
    if (key === "a" && fixing === current && !editing) action = finishFix;
    if (key === "+" || key === "=") action = () => zoomBy(1.6);
    if (key === "-" || key === "_") action = () => zoomBy(1 / 1.6);
    if (key === "0") action = () => { fit(); zoomBy(1); };
  }
  if (mode === "cones" && key === "home") action = () => { firstCone(); renderCone(); };
  if (action) { e.preventDefault(); action(); }
});

// Coming back from the CVAT tab: pick up any box edits made there. Not more than every 20 seconds,
// because a big task's boxes take a while to download.
window.addEventListener("focus", () => {
  if (mode === "home" && !$("app").hidden) return Date.now() - homeLoadedAt > 30000 && renderHome();
  if (data && !inFlight && Date.now() - taskLoadedAt > 20000) loadTask(false).catch(() => {});
});

api("/api/me").then((me) => start(me.username)).catch(showLogin);
