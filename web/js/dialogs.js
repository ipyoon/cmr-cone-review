// dialogs.js: the pop-up windows.
//   Assign    who reviews which frames (anyone: add a name, or create their CVAT account)
//   New task  upload pictures or a video and create the task in CVAT
//   Export    download the approved frames as a zip

let users = null;  // names to choose from in the Assign dialog: CVAT's users, plus anyone added
async function openAssign() {
  if (!data) {  // e.g. from the home page, before any task was opened
    try { await busy("Loading the task from CVAT…", () => loadTask(true)); } catch (error) { return toast(error.message); }
  }
  try {
    users ??= await busy("Loading CVAT users…", () => api("/api/users"));
  } catch (error) {
    return toast(error.message);
  }
  // People already given frames here stay on the list, even without a CVAT account
  for (const a of data.assignments) if (!users.includes(a.username)) users.push(a.username);
  drawPeople(new Set(data.assignments.map((a) => a.username)));
  fillAssign(data.assignments);
  $("assign-error").hidden = true;
  $("assign-dialog").showModal();
}

const checkedUsers = () => [...$("assign-users").querySelectorAll("input:checked")].map((i) => i.value);

function drawPeople(chosen) {
  $("assign-users").replaceChildren(...users.map((u) => el("label", {},
    el("input", { type: "checkbox", value: u, checked: chosen.has(u), onchange: () => fillAssign(splitFrames(checkedUsers())) }), u)));
}

// "Add": put a new name on the list, ticked. With an email and password, create their CVAT account first.
$("person-add").onclick = async () => {
  const name = $("person-name").value.trim(), email = $("person-email").value.trim(), password = $("person-password").value;
  if (!name) return $("person-name").focus();
  $("assign-error").hidden = true;
  if (email || password) {
    try {
      await busy(`Creating ${name}'s CVAT account…`, () => post("/api/users", { username: name, email, password }));
      toast(`Created a CVAT account for ${name}.`, "info");
    } catch (error) {
      $("assign-error").textContent = error.message;
      $("assign-error").hidden = false;
      return;
    }
  }
  const chosen = new Set([...checkedUsers(), name]);
  if (!users.includes(name)) users.push(name);
  drawPeople(chosen);
  fillAssign(splitFrames(checkedUsers()));
  $("person-name").value = $("person-email").value = $("person-password").value = "";
};
$("person-name").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); $("person-add").click(); } };

// Even, back-to-back ranges; cut at CVAT job boundaries when there are enough jobs,
// so each job can be assigned to one person in CVAT
function splitFrames(people) {
  const n = data.frames.length;
  const cuts = data.jobs.length >= people.length && data.jobs.length > 1 ? data.jobs.map((j) => j.start).filter((s) => s > 0) : null;
  let start = 0;
  return people.map((username, i) => {
    let next = n;
    if (i < people.length - 1) {
      const target = Math.round(((i + 1) * n) / people.length);
      const options = cuts?.filter((c) => c > start) ?? [];
      next = options.length ? options.reduce((a, c) => (Math.abs(c - target) < Math.abs(a - target) ? c : a)) : Math.max(target, start + 1);
    }
    const row = { username, start, stop: next - 1 };
    start = next;
    return row;
  });
}

function fillAssign(rows) {
  const frame = (value) => el("input", { type: "number", min: 0, max: data.frames.length - 1, value });
  $("assign-rows").replaceChildren(...rows.map((r) =>
    el("tr", {}, el("td", { textContent: r.username }), el("td", {}, frame(r.start)), el("td", {}, frame(r.stop)), el("td", { className: "muted" }))));
  $("assign-empty").hidden = rows.length > 0;
  countAssign();
}

function countAssign() {
  for (const row of $("assign-rows").children) {
    const [first, last] = row.querySelectorAll("input");
    row.lastChild.textContent = `${Math.max(0, last.value - first.value + 1)} frames`;
  }
}

$("assign-rows").oninput = countAssign;
$("assign-cancel").onclick = () => $("assign-dialog").close();
$("assign-form").onsubmit = async (e) => {
  e.preventDefault();
  const assignments = [...$("assign-rows").children].map((row) => {
    const [first, last] = row.querySelectorAll("input");
    return { username: row.firstChild.textContent, start: Number(first.value), stop: Number(last.value) };
  });
  try {
    const result = await post(`/api/tasks/${data.task.id}/assignments`, { assignments });
    $("assign-dialog").close();
    toast(result.warning || "Assignments saved.", result.warning ? "warn" : "info");
    await loadTask(false);
    if (mode === "home") renderHome();
  } catch (error) {
    $("assign-error").textContent = error.message;
    $("assign-error").hidden = false;
  }
};

// The zip is built on the server first (it downloads full-quality frames from CVAT), so the page
// fetches it with the loading bar showing, then saves it like any download
async function downloadExport(task, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Building zip…";  // the dialog covers the top loading bar
  try {
    await busy(`Building ${task.name} export…`, async () => {
      const res = await fetch(`/api/tasks/${task.id}/export.zip`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `Export failed (${res.status})`);
      const name = /filename="?([^";]+)/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `task_${task.id}_approved.zip`;
      const url = URL.createObjectURL(await res.blob());
      el("a", { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast(`Downloaded ${plural(Number(res.headers.get("x-frame-count") ?? 0), "approved frame")}: ${name}`, "info");
    });
  } catch (error) {
    if (error.status === 401) return showLogin();
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function showExport() {
  $("export-list").replaceChildren(...overview.map((t) => {
    const n = summaries.get(t.id)?.task.approved;
    const button = el("button", { className: "cta sm", textContent: "Download .zip" });
    button.onclick = () => downloadExport(t, button);
    return el("div", { className: "export-row" },
      el("div", {}, el("div", { className: "name", textContent: t.name }),
        el("div", { className: "small muted", textContent: n === undefined ? `${plural(t.size, "frame")}` : `${plural(n, "approved frame")} of ${t.size.toLocaleString()}` })),
      button);
  }));
  $("export-commands").replaceChildren(...overview.map((t) =>
    el("div", {}, el("div", { className: "small muted", textContent: `${t.name}` }),
      el("div", { className: "copy-row" },
        el("code", { textContent: `CVAT_TASK_ID=${t.id} venv/bin/python export_verified.py` }),
        el("button", { className: "ghost", textContent: "Copy", onclick: async (e) => {
          const button = e.currentTarget;
          try {
            await navigator.clipboard.writeText(button.previousSibling.textContent);
            button.textContent = "Copied";
          } catch {
            button.textContent = "Select and ⌘C";
          }
          setTimeout(() => (button.textContent = "Copy"), 1500);
        } })))));
  $("export-dialog").showModal();
}

// ------------------------------------------------------------- new task

let projects = null;  // CVAT projects, for the New task dialog
async function openNewTask() {
  try {
    projects ??= await busy("Loading CVAT projects…", () => api("/api/projects"));
  } catch (error) {
    return toast(error.message);
  }
  $("new-task-project").replaceChildren(el("option", { value: "", textContent: "No project (uses the cone labels)" }),
    ...projects.map((p) => el("option", { value: p.id, textContent: `${p.name} (uses its labels)` })));
  $("new-task-form").reset();
  $("new-task-error").hidden = $("new-task-progress").hidden = $("new-task-match").hidden = true;
  $("new-task-submit").disabled = false;
  $("new-task-dialog").showModal();
}

function showUpload(fraction, text) {
  $("new-task-progress").hidden = false;
  $("new-task-progress").querySelector("i").style.width = `${Math.round(100 * fraction)}%`;
  $("new-task-progress").querySelector("span").textContent = text;
}

// Two steps, each with its own progress: the files come to this server, then this server sends them to CVAT
$("new-task-form").onsubmit = (e) => {
  e.preventDefault();
  const form = new FormData($("new-task-form"));
  form.set("prepare", $("new-task-form").prepare.checked ? "on" : "off");
  const name = form.get("name");
  $("new-task-submit").disabled = true;
  $("new-task-error").hidden = true;

  const fail = (message) => {
    $("new-task-error").textContent = message;
    $("new-task-error").hidden = false;
    $("new-task-progress").hidden = true;
    $("new-task-submit").disabled = false;
  };

  const request = new XMLHttpRequest();  // unlike fetch, this reports upload progress
  request.open("POST", "/api/tasks/new");
  request.upload.onprogress = (p) => p.lengthComputable && showUpload(p.loaded / p.total / 2, `Uploading… ${Math.round((100 * p.loaded) / p.total)}%`);
  request.onerror = () => fail("The upload stopped. Check the connection and try again.");
  request.onload = () => {
    const body = JSON.parse(request.responseText || "{}");
    if (request.status !== 200) return fail(body.detail || `Upload failed (${request.status})`);
    watchUpload(body.upload, name, fail);
  };
  request.send(form);
};

async function watchUpload(id, name, fail) {
  for (;;) {
    let status;
    try { status = await api(`/api/uploads/${id}`); } catch (error) { return fail(error.message); }
    if (status.state === "failed") return fail(status.error);
    if (status.state === "done") break;
    if (status.state === "adding boxes") showUpload(1, `Adding the boxes to their frames (${status.boxes})…`);
    else if (status.state === "preparing") showUpload(1, "CVAT is preparing the frames. A long video can take a few minutes…");
    else showUpload(0.5 + (status.total ? status.sent / status.total / 2 : 0), "Sending to CVAT…");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  $("new-task-dialog").close();
  const final = await api(`/api/uploads/${id}`).catch(() => ({}));
  toast(`Created "${name}" in CVAT${final.boxes ? `, ${final.boxes}` : ""}.`, "info");
  await loadTaskList();
  if (mode === "home") renderHome();
}
$("new-task-cancel").onclick = () => $("new-task-dialog").close();

// As soon as files are picked, say how the boxes match the pictures (the server checks again on Create)
$("new-task-files").onchange = $("new-task-boxes").onchange = () => checkBoxes().catch((error) => showMatch(error.message, true));

function showMatch(text, bad = false) {
  $("new-task-match").hidden = !text;
  $("new-task-match").className = `small${bad ? " bad" : ""}`;
  $("new-task-match").replaceChildren(...(text ? [icon(bad ? "minus" : "check"), text] : []));
}

async function checkBoxes() {
  const media = [...$("new-task-files").files], boxFiles = [...$("new-task-boxes").files];
  if (!boxFiles.length) return showMatch("");
  const video = media.some((f) => f.type.startsWith("video/"));
  const pictures = new Set(media.filter((f) => !f.type.startsWith("video/")).map((f) => f.name));
  const names = boxFiles.map((f) => f.name.toLowerCase());

  if (names.length === 1 && names[0].endsWith(".csv")) {  // SAM3 boxes.csv: matched by frame number
    const rows = (await boxFiles[0].text()).trim().split("\n");
    const header = rows.shift().split(",");
    const frame = header.indexOf("frame");
    if (frame < 0 || header.indexOf("colour") < 0) return showMatch(`${boxFiles[0].name} needs "frame" and "colour" columns.`, true);
    const frames = rows.map((r) => Number(r.split(",")[frame]));
    const last = Math.max(...frames), used = new Set(frames).size;
    if (video || !media.length) return showMatch(`${rows.length.toLocaleString()} boxes on ${used.toLocaleString()} frames (0 to ${last}). Matched by frame number.`);
    if (last >= pictures.size) return showMatch(`boxes.csv has boxes up to frame ${last}, but you chose ${pictures.size} pictures (frames 0 to ${pictures.size - 1}).`, true);
    return showMatch(`${rows.length.toLocaleString()} boxes on ${used} of ${pictures.size} pictures. Matched by frame number.`);
  }
  if (names.every((n) => n.endsWith(".json"))) {
    const docs = await Promise.all(boxFiles.map(async (f) => ({ file: f, doc: JSON.parse(await f.text()) })));
    if (docs.length === 1 && docs[0].doc.images && docs[0].doc.annotations) return showMatch("COCO file: CVAT matches it to the pictures by name.");
    if (video) return showMatch("SAM3 .json files match pictures by name, but you chose a video. Use boxes.csv for a video.", true);
    const target = docs.map(({ file, doc }) => doc.image || file.name.replace(/\.json$/i, ".jpg"));
    const missing = target.filter((n) => !pictures.has(n));
    if (media.length && missing.length) return showMatch(`${missing.length} .json file${missing.length === 1 ? " is" : "s are"} for pictures you didn't choose, like ${missing[0]}.`, true);
    const boxes = docs.reduce((n, { doc }) => n + (doc.predictions?.length ?? 0), 0);
    return showMatch(`${boxes.toLocaleString()} boxes for ${target.length} of ${pictures.size || "?"} pictures. Matched by picture name.`);
  }
  if (names.length === 1 && names[0].endsWith(".xml")) return showMatch("CVAT XML: CVAT matches it to the pictures by name.");
  showMatch("Boxes must be a boxes.csv, SAM3 .json files, a CVAT .xml, or a COCO .json.", true);
}
