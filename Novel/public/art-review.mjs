const $ = (id) => document.getElementById(id),
  root = document.querySelector("main");
const modes = ["recent", "used", "picks", "workshop", "stories", "flags"];
let reviewBatch = new URLSearchParams(location.search).get("batch");
let readingKey = new URLSearchParams(location.search).get("read");
let rows = [],
  mode = modes.includes(location.hash.slice(1))
    ? location.hash.slice(1)
    : "recent";
let marks = new Set(
  JSON.parse(localStorage.getItem("nightread-art-review") || "[]"),
);
function el(tag, txt) {
  let n = document.createElement(tag);
  n.textContent = txt;
  return n;
}
function addEditionPicker(row, details, cover, picture) {
  const variants = row.variants;
  const hasClips = variants.every(item => item.clip);
  const picker = el("select", "");
  picker.setAttribute("aria-label", row.title + " · " + row.variantLabel);
  variants.forEach((item, index) => picker.add(new Option(item.label, String(index))));
  const label = el("label", row.variantLabel);
  label.className = "variant-picker";
  label.append(picker);
  const original = el("a", ""), source = el("a", "");
  for (const link of [original, source]) {
    link.target = "_blank";
    link.rel = "noreferrer";
  }
  const player = hasClips ? el("video", "") : null;
  if (player) {
    player.controls = true;
    player.loop = true;
    player.playsInline = true;
    player.muted = true;
    player.preload = "none";
  }
  const update = () => {
    const item = variants[picker.selectedIndex];
    const caption = row.title + " · " + item.label;
    original.href = item.full || item.img;
    original.textContent = item.full ? `看原尺寸（${item.width}×${item.height}）` : "看实录截图";
    if (player) {
      player.poster = item.img;
      player.src = item.clip;
      player.setAttribute("aria-label", caption);
    } else {
      picture.src = item.img;
      picture.alt = caption;
      cover.href = original.href;
      source.href = item.source;
      source.textContent = item.artist + " · 工坊出处";
    }
  };
  picker.onchange = () => {
    update();
    if (player) player.play().catch(() => {});
  };
  update();
  details.append(label, original);
  if (!player) details.append(el("br", ""), source);
  return player || cover;
}
function draw() {
  root.replaceChildren();
  for (const id of modes)
    $(id).setAttribute("aria-pressed", id === mode);
  const query = $("search").value.trim().toLowerCase();
  const batch = ["workshop", "picks"].includes(mode) ? reviewBatch : null;
  let visible = rows.filter(
    (x) =>
      (mode === "flags"
        ? marks.has(x.id)
        : mode === "workshop"
          ? x.workshopVerified
        : mode === "recent"
          ? x.group === "used" && x.recent
          : x.group === mode) && (!batch || x.reviewBatch === batch) &&
      (!query || [x.title, x.kind, x.id, ...(x.variants || []).map(v => [v.label, v.artist].join(" "))].join(" ").toLowerCase().includes(query)),
  );
  const reading = mode === "picks" && readingKey && visible.find(x => x.galleryKey === readingKey);
  if (reading) visible = [reading];
  root.classList.toggle("reading", Boolean(reading));
  if (mode === "workshop") {
    visible.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
  }
  $("status").textContent =
    (batch ? "本批新增 " : "") +
    visible.length + " 项 · 已标记 " + marks.size + " 项";
  if (batch) {
    const showAll = el("a", reading ? "返回本批候选" : mode === "workshop" ? "查看全部工坊作品" : "查看全部候选");
    const url = new URL(location.href);
    url.searchParams.delete("read");
    if (!reading) url.searchParams.delete("batch");
    showAll.href = url.href;
    $("status").append(" · ", showAll);
  }
  for (let x of visible) {
    let box = el("article", ""),
      link = el("a", ""),
      im = el("img", "");
    im.alt = x.title + " " + x.kind;
    im.loading = "lazy";
    im.src = x.thumb || x.img;
    link.href = x.originalArt?.url || x.img;
    link.target = "_blank";
    link.append(im);
    let media = link;
    if (x.video) {
      const player = el("video", "");
      player.controls = true;
      player.playsInline = true;
      player.preload = "none";
      player.poster = im.src;
      player.src = x.img;
      player.setAttribute("aria-label", x.title);
      media = player;
    }
    let d = el("div", "");
    d.append(el("strong", x.title), el("small", x.kind));
    if (x.variants?.length) media = addEditionPicker(x, d, link, im);
    if (x.workshopVerified && x.publishedAt) d.append(el("small", "工坊首发 " + x.publishedAt));
    if (x.originalArt) {
      const { url, width, height } = x.originalArt;
      const original = el("a", "查看原尺寸插画（" + width + "×" + height + "）");
      original.href = url;
      original.target = "_blank";
      original.rel = "noopener";
      d.append(original);
    }
    if (x.checkFrames?.length) {
      const detail = el("details", "");
      if (x.cleanGallery) detail.className = "art-plates";
      if (reading) detail.open = true;
      else if (x.galleryKey) {
        const reader = el("a", "纯图阅读");
        const url = new URL(location.href);
        url.searchParams.set("batch", x.reviewBatch);
        url.searchParams.set("read", x.galleryKey);
        url.hash = "picks";
        reader.href = url.href;
        d.append(reader);
      }
      detail.append(el("summary", x.galleryLabel || (x.video ? "看原片关键帧" : "看引擎实测截图")));
      for (const [label, url] of x.checkFrames) {
        const a = el("a", ""), shot = el("img", "");
        a.href = url;
        a.target = "_blank";
        shot.alt = label;
        shot.loading = "lazy";
        shot.src = url;
        a.append(shot);
        if (!x.cleanGallery) a.append(el("small", label));
        detail.append(a);
      }
      d.append(detail);
    }
    if (x.reviewClip) {
      const detail = el("details", "");
      const player = el("video", "");
      player.controls = true;
      player.loop = true;
      player.playsInline = true;
      player.preload = "none";
      player.poster = x.reviewClip.poster;
      player.src = x.reviewClip.url;
      player.setAttribute("aria-label", x.title + " · " + x.reviewClip.label);
      detail.ontoggle = () => { if (!detail.open) player.pause(); };
      detail.append(el("summary", x.reviewClip.label), player);
      d.append(detail);
    }
    if (x.reveal) {
      const detail = el("details", "");
      const frame = el("div", "");
      frame.className = "layer-compare";
      const base = el("img", "");
      const overlay = el("img", "");
      for (const [pic, src, alt] of [[base, x.img, "基础层"], [overlay, x.reveal, "滑动显示层"]]) {
        pic.src = src;
        pic.alt = alt;
        pic.loading = "lazy";
        frame.append(pic);
      }
      const slider = el("input", "");
      slider.type = "range";
      slider.value = "0";
      slider.setAttribute("aria-label", "显示第二层的比例");
      const setReveal = value => {
        slider.value = String(value);
        overlay.style.clipPath = `inset(0 ${100 - Number(slider.value)}% 0 0)`;
      };
      setReveal(0);
      slider.oninput = () => setReveal(slider.value);
      const scrub = event => {
        const rect = frame.getBoundingClientRect();
        setReveal(Math.max(0, Math.min(100, (event.clientX - rect.left) * 100 / rect.width)));
      };
      frame.onpointerdown = event => { frame.setPointerCapture(event.pointerId); scrub(event); };
      frame.onpointermove = event => { if (frame.hasPointerCapture(event.pointerId)) scrub(event); };
      detail.append(el("summary", x.workshopVerified ? "对照滑动前后实拍" : "滑动比较原始图层"), frame, slider);
      d.append(detail);
    }
    if (x.source && !x.variants?.some(v => v.source)) {
      let a = el("a", "来源 · " + new URL(x.source).hostname);
      a.href = x.source;
      a.target = "_blank";
      a.rel = "noreferrer";
      d.append(a);
    }
    if (x.story) {
      let detail = el("details", "");
      detail.append(el("summary", "读开场"), el("p", x.story));
      d.append(detail);
    }
    let b = el("button", marks.has(x.id) ? "取消标记" : "标记替换");
    b.onclick = () => {
      marks.has(x.id) ? marks.delete(x.id) : marks.add(x.id);
      localStorage.setItem("nightread-art-review", JSON.stringify([...marks]));
      draw();
    };
    d.append(el("br", ""), b);
    box.append(media, d);
    root.append(box);
  }
}
for (const id of modes)
  $(id).onclick = () => {
    mode = id;
    const url = new URL(location.href);
    url.hash = id;
    url.searchParams.delete("batch");
    url.searchParams.delete("read");
    readingKey = null;
    reviewBatch = null;
    history.replaceState(null, "", url);
    draw();
  };
$("search").oninput = draw;
$("copy").onclick = async () => {
  const s = [...marks].join("\n");
  try {
    await navigator.clipboard.writeText(s);
    $("status").textContent = "已复制 " + marks.size + " 项";
  } catch {
    prompt("复制标记清单", s);
  }
};
try {
  let [lib, extra] = await Promise.all(
    ["api/library", "art-review-data.json"].map(async (p) => {
      const r = await fetch(p, { cache: "no-store" });
      if (!r.ok) throw Error(r.status);
      return r.json();
    }),
  );
  for (let c of lib.cards) {
    let seen = new Set();
    function add(img, kind) {
      if (!img || seen.has(img)) return;
      seen.add(img);
      rows.push({
        group: "used",
        id: c.id + " / " + kind + " / " + img,
        title: c.title || c.name,
        img,
        kind: kind + (extra.facts[img] ? " · " + extra.facts[img] : ""),
        source: extra.sources[img],
        recent: !!extra.sources[img],
        thumb: extra.thumbs?.[img],
      });
    }
    add(c.portrait, "封面");
    add(c.face, "头像");
    for (let x of extra.cast[c.id] || []) add(x.img, x.name);
    for (let x of c.gallery || []) add(x, "套图 " + (seen.size + 1));
    for (let [k, v] of Object.entries(c.assets || {}))
      if (/\.(png|gif|webp|apng|jpe?g)$/i.test(v)) add(v, k);
  }
  rows.push(
    ...extra.picks.map((x) => ({ ...x, thumb: extra.thumbs?.[x.img] })),
    ...(extra.stories || []),
  );
  const visibleIds = new Set(rows.map(row => row.id));
  for (const id of extra.removedMarks || []) {
    if (!visibleIds.has(id)) marks.delete(id);
  }
  localStorage.setItem("nightread-art-review", JSON.stringify([...marks]));
  draw();
} catch (e) {
  $("status").textContent = "读取失败，请刷新页面。" + e.message;
}
