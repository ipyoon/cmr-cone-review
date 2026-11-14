// gallery.js: the Gallery screen.

// ------------------------------------------------------------- gallery

const SORTS = {
  order: () => 0,
  most: (a, b) => liveBoxes(b).length - liveBoxes(a).length,
  fewest: (a, b) => liveBoxes(a).length - liveBoxes(b).length,
};
const cards = new Map();  // frame index -> {key, node}; rebuilt only when the frame's boxes change

function card(frame) {
  const key = `${data.task.id}/${frame.hash}/${liveBoxes(frame).length}`;
  let entry = cards.get(frame.index);
  if (entry?.key !== key) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    drawBoxes(svg, frame);
    const quick = (text, className, fn) => el("button", { textContent: text, className, onclick: (e) => { e.stopPropagation(); fn(); } });
    const node = el("div", { tabIndex: 0, title: frame.name },
      el("div", { className: "thumb", style: `aspect-ratio:${frame.width}/${frame.height}` },
        el("img", { src: `${imageUrl(frame.index)}?size=small`, loading: "lazy", decoding: "async", alt: "" }), svg),
      el("div", { className: "meta" }, el("span", { className: "status" }), el("span", { textContent: `#${frame.index}` }),
        el("span", { className: "muted", textContent: `${liveBoxes(frame).length} boxes` })),
      el("div", { className: "quick" },
        quick("Approve", "primary", () => decide("approve", undefined, frame.index)),
        quick("Needs fix", "danger", () => askFix(frame.index))));
    node.onclick = () => openFrame(frame.index);
    node.onkeydown = (e) => { if (e.key === "Enter") openFrame(frame.index); };
    cards.set(frame.index, (entry = { key, node }));
  }
  entry.node.className = `card ${frame.status}`;
  const status = entry.node.querySelector(".status");
  status.className = `status ${frame.status}`;
  status.textContent = STATUS_TEXT[frame.status] ?? frame.status;
  return entry.node;
}

function renderGallery() {
  renderProgress();
  const frames = list.map((i) => data.frames[i]).sort(SORTS[$("gallery-sort").value]);
  $("position").textContent = `${frames.length} frame${frames.length === 1 ? "" : "s"}`;
  $("gallery").replaceChildren(...(frames.length ? frames.map(card) : [el("div", { id: "gallery-empty", textContent: "No frames here." })]));
  // Coming back from a frame: scroll to the picture you opened, and mark it
  for (const entry of cards.values()) entry.node.classList.remove("last");
  const last = cards.get(lastOpened)?.node;
  if (last?.isConnected) {
    last.classList.add("last");
    if (scrollToLast) last.scrollIntoView({ block: "center" });
  }
  scrollToLast = false;
}

let lastOpened = Number(store("review.lastOpened") ?? -1);  // gallery picture opened most recently
let scrollToLast = true;
let fromGallery = false;
function openFrame(index) {
  lastOpened = index;
  store("review.lastOpened", index);
  fromGallery = true;
  current = index;
  fit();
  setMode("frames");
}
