// Small helpers and the state shared by all the other files.

// $("id") finds an element. el("div", { className: "x" }, child) makes one.
const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
const swatch = (color) => el("span", { className: "swatch", style: `background:${color}` });
const pct = (part, whole) => Math.round((100 * part) / Math.max(1, whole));

// Read or save a setting in the browser. (localStorage throws in private windows.)
function store(key, value) {
  try {
    return value === undefined ? localStorage.getItem(key) : localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

// An icon from the set at the top of index.html, e.g. icon("check")
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("theme").replaceChildren(icon(theme === "light" ? "moon" : "sun"));
  store("review.theme", theme);
}
setTheme(store("review.theme") === "dark" ? "dark" : "light");

const FALLBACK_COLORS = { blue_cone: "#2f7bff", yellow_cone: "#f5c400", orange_cone: "#ff7a1a", large_orange_cone: "#e0218a" };
const STATUS_TEXT = { pending: "To review", verified: "Approved", needs_fix: "Needs fix", needs_reverification: "Changed since approval", in_review: "In review" };
const TODO = ["pending", "needs_reverification", "in_review"];
const FILTERS = {
  todo: (f) => TODO.includes(f.status),
  needs_fix: (f) => f.status === "needs_fix",
  verified: (f) => f.status === "verified",
  all: () => true,
};

let mode = "home";      // the screen showing: home, frames, gallery or cones
let data = null;        // the open task, as the server sent it
let scope = store("review.scope") === "all" ? "all" : "mine";
let mine = null;        // the frame numbers assigned to you (null if none)
let filter = "todo";
let list = [];          // the frame numbers that match the filter
let current = 0;        // the frame on screen
let showBoxes = true;
let view = { scale: 1, x: 0, y: 0 };
let queue = Promise.resolve();  // changes go to the server one after another
let inFlight = 0;       // changes not saved yet
let sent = 0;           // changes sent so far (loadTask uses this)

async function api(path, options = {}) {
  const headers = options.body ? { "Content-Type": "application/json" } : {};
  const res = await fetch(path, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body.detail || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
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
  $("app").classList.remove("ready");
  $("login").hidden = false;
  $("password").value = "";
  $("username").focus();
}

const me = () => $("who").textContent;
let focusUser = null;   // whose assignment is open (null means yours)
const who = () => focusUser ?? me();
// whose("Your work", "@'s work") gives "Your work", or "sam's work" when you're looking at sam's frames
const whose = (yours, theirs) => (who() === me() ? yours : theirs.replace("@", who()));
const inScope = (index) => scope === "all" || !mine || mine.has(index);
const liveBoxes = (frame) => frame.boxes.filter((b) => !b.deleted);

function unknownLabel() {
  const label = data.labels.find((l) => l.name === "unknown_cone") ?? data.labels.find((l) => /unknown/i.test(l.name));
  return label?.id;
}


// Drawing boxes

const imageUrl = (index) => `/api/tasks/${data.task.id}/frames/${index}/image`;
const labelName = (id) => data.labels.find((l) => l.id === id)?.name ?? "unknown";

function labelColor(id) {
  const label = data.labels.find((l) => l.id === id);
  return FALLBACK_COLORS[label?.name] || label?.color || "#ff00ff";
}

// Draw a frame's boxes into an <svg>. The selected or hovered box gets a white outline and a light fill.
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

  const shapes = [];
  for (const b of visible ? liveBoxes(frame) : []) {
    const color = labelColor(b.label);
    if (b.id === selected) shapes.push(rect(b, "#fff", 6), rect(b, color, 3, "none", color));
    else if (b.id === hovered) shapes.push(rect(b, "#fff", 4), rect(b, color, 2, "none", color));
    else shapes.push(rect(b, color, 2));
  }
  if (sketch) shapes.push(rect(sketch, "#fff", 2, "6 4"));
  svg.replaceChildren(...shapes);
}

// Send one change to the server. Changes are saved one at a time, in order.
// revert() undoes it on screen if it fails, retry() reloads after a conflict, done() runs when it's saved.
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
      // Don't await retry(): it reloads, and reloading waits for this same queue.
      if (error.status === 409 || error.status === 404) return void retry().catch((e) => toast(e.message));
      show();
    } finally {
      inFlight--;
      setSync();
    }
  });
}

// "large_orange_cone" becomes "Large orange"
function niceName(name) {
  const words = name.replace(/_cone$/, "").replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// A button for one cone color, with its number key
function classButton(label, i, onclick, className = "big") {
  const button = el("button", { className: `${className} class-btn`, style: `--c:${labelColor(label.id)}`, onclick },
    niceName(label.name), el("kbd", { textContent: i + 1 }));
  button.dataset.label = label.id;
  return button;
}

// Show the red loading line while `work` runs
let busyCount = 0;
async function busy(text, work) {
  busyCount++;
  document.body.classList.add("busy");
  $("busy-text").textContent = text;
  try {
    return await work();
  } finally {
    busyCount--;
    if (busyCount === 0) document.body.classList.remove("busy");
  }
}
