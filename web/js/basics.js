// basics.js: small helpers and shared state that every other file uses.
//
//   $("id")              finds an element on the page
//   el("div", {...}, …)  makes a new element
//   api(path) / post()   talk to the server (review_web.py)
//   send(...)            saves a change in the background, one at a time
//   toast("message")     shows a short message at the bottom
//   busy(text, work)     shows the red loading bar while `work` runs
//
// The order the files load in: basics, home, frames, gallery, cones, dialogs, main.
// main.js loads last and starts everything.

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const swatch = (color) => el("span", { className: "swatch", style: `background:${color}` });
const pct = (part, whole) => Math.round((100 * part) / Math.max(1, whole));
function store(key, value) {  // localStorage can throw in private windows
  try { return value === undefined ? localStorage.getItem(key) : localStorage.setItem(key, value); } catch { return null; }
}

// A drawn icon from the set in index.html: icon("right"), icon("check"), ...
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}
function setTheme(theme) {  // dark unless you pick light
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  $("theme").replaceChildren(icon(theme === "light" ? "moon" : "sun"));
  store("review.theme", theme);
}
setTheme(store("review.theme") === "dark" ? "dark" : "light");  // white unless you pick night

const FALLBACK_COLORS = { blue_cone: "#2f7bff", yellow_cone: "#f5c400", orange_cone: "#ff7a1a", large_orange_cone: "#e0218a" };
const STATUS_TEXT = { pending: "To review", verified: "Approved", needs_fix: "Needs fix", needs_reverification: "Changed since approval", in_review: "In review" };
const TODO = ["pending", "needs_reverification", "in_review"];
const FILTERS = {
  todo: (f) => TODO.includes(f.status),
  needs_fix: (f) => f.status === "needs_fix",
  verified: (f) => f.status === "verified",
  all: () => true,
};

let mode = "home";     // which screen is showing: home, frames, gallery or cones
let data = null;       // the open task, from the server
let scope = store("review.scope") === "all" ? "all" : "mine";
let mine = null;       // frame indexes assigned to you, or null if nobody assigned you any
let filter = "todo";
let list = [];         // frame indexes matching the filter
let current = 0;       // frame index on screen
let showBoxes = true;
let view = { scale: 1, x: 0, y: 0 };
let queue = Promise.resolve();  // changes are sent to the server one at a time
let inFlight = 0;
let sent = 0;                   // changes made so far, to spot reloads that miss one

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: options.body ? { "Content-Type": "application/json" } : {} });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.detail || `Request failed (${res.status})`), { status: res.status });
  return body;
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });

function toast(message, kind = "error") {
  $("toast").textContent = message;
  $("toast").className = kind;
  $("toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").hidden = true), 5000);
}

function setSync() {
  $("sync").classList.toggle("saving", inFlight > 0);
  $("sync").textContent = inFlight ? "Saving…" : "Saved to CVAT";
}

function showLogin() {
  $("app").hidden = true;
  $("login").hidden = false;
  $("password").value = "";
  $("username").focus();
}

const me = () => $("who").textContent;
let focusUser = null;  // whose assignment is open (null: yours)
const who = () => focusUser ?? me();
const whose = (mine, theirs) => (who() === me() ? mine : theirs.replace("@", who()));
const inScope = (index) => scope === "all" || !mine || mine.has(index);
const unknownLabel = () => (data.labels.find((l) => l.name === "unknown_cone") ?? data.labels.find((l) => /unknown/i.test(l.name)))?.id;

const liveBoxes = (frame) => frame.boxes.filter((b) => !b.deleted);

// ------------------------------------------------------------- drawing

function imageUrl(index) { return `/api/tasks/${data.task.id}/frames/${index}/image`; }
function labelName(id) { return data.labels.find((l) => l.id === id)?.name ?? "unknown"; }
function labelColor(id) {
  const label = data.labels.find((l) => l.id === id);
  return FALLBACK_COLORS[label?.name] || label?.color || "#ff00ff";
}

function drawBoxes(svg, frame, visible = true, { selected, sketch, hovered } = {}) {
  svg.setAttribute("viewBox", `0 0 ${frame.width} ${frame.height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const rect = (b, stroke, width, dash = "none", fill = "none") => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    const attrs = {
      x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1, fill, "fill-opacity": .22,
      stroke, "stroke-width": width, "vector-effect": "non-scaling-stroke", "stroke-dasharray": dash,
    };
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  svg.replaceChildren(
    ...(visible ? liveBoxes(frame) : []).flatMap((b) => b.id === selected
      ? [rect(b, "#fff", 6), rect(b, labelColor(b.label), 3, "none", labelColor(b.label))]
      : b.id === hovered
        ? [rect(b, "#fff", 4), rect(b, labelColor(b.label), 2, "none", labelColor(b.label))]
        : [rect(b, labelColor(b.label), 2)]),
    ...(sketch ? [rect(sketch, "#fff", 2, "6 4")] : []));
}

// Send a change in the background, one at a time. On failure undo it on screen and say why.
function send(path, body, { revert, retry, done }) {
  const taskId = data.task.id;
  inFlight++;
  sent++;
  setSync();
  queue = queue.then(async () => {
    try {
      const result = await post(`/api/tasks/${taskId}${path}`, body);
      if (result.warning) toast(result.warning, "warn");
      done?.(result);
    } catch (error) {
      revert(error);
      if (error.status === 401) return showLogin();
      if (data?.task.id !== taskId) return;
      // Not awaited: the reload waits for this queue, so awaiting it here would never finish
      if (error.status === 409 || error.status === 404) return void retry().catch((e) => toast(e.message));
      show();
    } finally {
      inFlight--;
      setSync();
    }
  });
}

// "large_orange_cone" -> "Large orange"
function niceName(name) {
  const words = name.replace(/_cone$/, "").replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Dark text on light colours (yellow), white text on dark ones
function textOn(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return "#fff";
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150 ? "#000" : "#fff";
}

function classButton(l, i, onclick, className = "big") {
  const colour = labelColor(l.id);
  const button = el("button", { className, style: `background:${colour};color:${textOn(colour)}`, onclick },
    `${niceName(l.name)} `, el("kbd", { textContent: i + 1 }));
  button.dataset.label = l.id;
  return button;
}

// A thin CMR-red bar along the top while something loads from CVAT, so a click never looks ignored
let busyCount = 0;
async function busy(text, work) {
  busyCount++;
  document.body.classList.add("busy");
  $("busy-text").textContent = text;
  try { return await work(); } finally {
    if (--busyCount === 0) document.body.classList.remove("busy");
  }
}
