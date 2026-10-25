import { KINDS, PALETTE, canConnect, connectHint, capacityOf, costOf, hitRateOf, icon } from "./components.js";
import { createSim, DT, costTotal } from "./engine.js";
import { CHALLENGES, designFor, createRun, cloneDesign, WARMUP, DURATION } from "./challenges.js";
import { TEMPLATES } from "./templates.js";
import { insights, displayNames } from "./insights.js";

const W = 1200;
const H = 680;
const NODE_W = 150;
const NODE_H = 64;
const COLORS = { read: "#38bdf8", write: "#fbbf24", static: "#a3e635", job: "#c084fc", fail: "#fb5a6e" };
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt = (v) => {
  if (!isFinite(v)) return "∞";
  if (v >= 10000) return `${(v / 1000).toFixed(v >= 100000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return Math.round(v).toLocaleString("en-US");
};
const money = (v) => `$${Math.round(v).toLocaleString("en-US")}`;

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`sds:${key}`);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`sds:${key}`, JSON.stringify(value));
    } catch {}
  },
};

const app = {
  mode: "challenge",
  level: 0,
  design: null,
  sim: null,
  run: null,
  selected: null,
  playing: true,
  speed: 1,
  prevSpeed: 1,
  hint: false,
  progress: store.get("progress", {}),
  adds: 0,
};

const els = {
  app: $("#app"),
  stage: $("#stage"),
  world: $("#world"),
  edges: $("#edge-layer"),
  temp: $("#temp-edge"),
  nodes: $("#nodes"),
  canvas: $("#particles"),
  chart: $("#chart"),
  mission: $("#mission"),
  inspector: $("#inspector"),
  insights: $("#insights"),
  toast: $("#toast"),
};
const nodeEls = new Map();
let scale = 1;

// ---------------------------------------------------------------- design helpers

function byId(id) {
  return app.design.nodes.find((n) => n.id === id);
}

function sanitize(d) {
  const nodes = (d.nodes || []).filter((n) => KINDS[n.type] && typeof n.id === "string").map((n) => ({
    id: n.id,
    type: n.type,
    x: clamp(+n.x || W / 2, NODE_W / 2 + 4, W - NODE_W / 2 - 4),
    y: clamp(+n.y || H / 2, NODE_H / 2 + 4, H - NODE_H / 2 - 4),
    ...(KINDS[n.type].sizes ? { size: ["S", "M", "L"].includes(n.size) ? n.size : "M" } : {}),
    ...(n.type === "cache" && n.hit ? { hit: clamp(+n.hit, 0.5, 0.99) } : {}),
  }));
  if (!nodes.some((n) => n.type === "users")) nodes.unshift({ id: "users", type: "users", x: 110, y: 340 });
  const ids = new Set(nodes.map((n) => n.id));
  const type = new Map(nodes.map((n) => [n.id, n.type]));
  const seen = new Set();
  const edges = (d.edges || []).filter((e) => {
    const key = `${e.from}>${e.to}`;
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to || seen.has(key)) return false;
    seen.add(key);
    return canConnect(type.get(e.from), type.get(e.to));
  }).map((e) => ({ id: e.id || `${e.from}-${e.to}`, from: e.from, to: e.to }));
  const t = d.traffic || {};
  const traffic = {
    rps: clamp(+t.rps || 500, 10, 50000),
    pattern: ["steady", "wave", "spikes"].includes(t.pattern) ? t.pattern : "steady",
    writes: clamp(+t.writes || 0, 0, 0.9),
    statics: clamp(+t.statics || 0, 0, 0.7),
    ...(t.spike ? { spike: +t.spike } : {}),
  };
  return { nodes, edges, traffic };
}

let saveTimer = 0;
function saved() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const d = { nodes: app.design.nodes.map(({ down, ...n }) => n), edges: app.design.edges, traffic: app.design.traffic };
    if (app.mode === "challenge") store.set(`level:${CHALLENGES[app.level].id}`, d);
    else store.set("sandbox", d);
  }, 250);
}

function setDesign(d) {
  app.design = d;
  app.sim = createSim(d);
  app.selected = null;
  particles.length = 0;
  sparks.length = 0;
  resetHistory();
  renderAll();
}

function openLevel(i) {
  app.mode = "challenge";
  app.level = clamp(i, 0, CHALLENGES.length - 1);
  const ch = CHALLENGES[app.level];
  const savedDesign = store.get(`level:${ch.id}`);
  const d = savedDesign ? sanitize(savedDesign) : designFor(ch);
  d.traffic = { ...ch.traffic };
  app.hint = false;
  syncMode();
  setDesign(d);
  renderLevels();
  renderMission();
  syncTraffic();
  store.set("last", { mode: "challenge", level: app.level });
}

function openSandbox(d) {
  app.mode = "sandbox";
  syncMode();
  setDesign(sanitize(d || store.get("sandbox") || TEMPLATES[2].design()));
  syncTraffic();
  saved();
  store.set("last", { mode: "sandbox" });
}

function restartLevel() {
  const ch = CHALLENGES[app.level];
  store.set(`level:${ch.id}`, null);
  openLevel(app.level);
  toast("Level restarted");
}

function syncMode() {
  els.app.dataset.mode = app.mode;
  for (const tab of $$(".modes [role=tab]")) tab.setAttribute("aria-selected", String(tab.dataset.mode === app.mode));
}

function newId(type) {
  let i = app.design.nodes.length;
  let id;
  do id = `${type}${++i}`;
  while (app.design.nodes.some((n) => n.id === id));
  return id;
}

function freeSpot() {
  const nodes = app.design.nodes;
  const spots = [];
  for (let x = 220; x <= W - 90; x += 70) for (let y = 70; y <= H - 50; y += 66) spots.push({ x, y });
  spots.sort((a, b) => Math.hypot(a.x - 700, (a.y - 340) * 1.6) - Math.hypot(b.x - 700, (b.y - 340) * 1.6));
  return spots.find((p) => nodes.every((n) => Math.abs(n.x - p.x) > NODE_W + 18 || Math.abs(n.y - p.y) > NODE_H + 14)) || { x: 700 + Math.random() * 60, y: 340 + Math.random() * 60 };
}

function overlaps(n, x, y) {
  return app.design.nodes.some((o) => o !== n && Math.abs(o.x - x) < NODE_W + 14 && Math.abs(o.y - y) < NODE_H + 12);
}

// If a component lands on top of another, slide it to the nearest free spot.
function settle(n) {
  if (!overlaps(n, n.x, n.y)) return;
  const lo = { x: NODE_W / 2 + 4, y: NODE_H / 2 + 4 };
  const hi = { x: W - NODE_W / 2 - 14, y: H - NODE_H / 2 - 4 };
  for (let r = 30; r < 700; r += 30) {
    for (let a = 0; a < 16; a++) {
      const x = clamp(n.x + Math.cos((a / 16) * Math.PI * 2) * r * 1.6, lo.x, hi.x);
      const y = clamp(n.y + Math.sin((a / 16) * Math.PI * 2) * r, lo.y, hi.y);
      if (!overlaps(n, x, y)) {
        n.x = x;
        n.y = y;
        return;
      }
    }
  }
}

function busy() {
  toast("Wait for the test to finish");
  return true;
}

function addNode(type, at) {
  if (app.run) return busy();
  const p = at || freeSpot();
  const n = { id: newId(type), type, x: clamp(p.x, NODE_W / 2 + 4, W - NODE_W / 2 - 4), y: clamp(p.y, NODE_H / 2 + 4, H - NODE_H / 2 - 4) };
  if (KINDS[type].sizes) n.size = "M";
  app.design.nodes.push(n);
  settle(n);
  renderNodes();
  renderEdges();
  nodeEls.get(n.id)?.classList.add("new");
  layout();
  select({ kind: "node", id: n.id });
  saved();
  if (app.adds++ < 2) toast(`${KINDS[type].label} added. Drag from its ● handle to connect it.`);
}

function deleteNode(id) {
  if (app.run) return busy();
  const n = byId(id);
  if (!n) return;
  if (n.type === "users") return toast("Users stay. They're the reason you're building this 🙂");
  app.design.nodes = app.design.nodes.filter((x) => x.id !== id);
  app.design.edges = app.design.edges.filter((e) => e.from !== id && e.to !== id);
  select(null);
  renderNodes();
  renderEdges();
  layout();
  saved();
}

function connect(fromId, toId) {
  if (app.run) return busy();
  const a = byId(fromId);
  const b = byId(toId);
  if (!a || !b || a === b) return;
  if (app.design.edges.some((e) => e.from === a.id && e.to === b.id)) return toast("Those are already connected");
  if (!canConnect(a.type, b.type)) return toast(connectHint(a.type, b.type));
  app.design.edges.push({ id: `${a.id}-${b.id}`, from: a.id, to: b.id });
  renderEdges();
  renderInspector();
  saved();
}

function deleteEdge(id) {
  if (app.run) return busy();
  app.design.edges = app.design.edges.filter((e) => e.id !== id);
  if (app.selected?.kind === "edge") select(null);
  renderEdges();
  renderInspector();
  saved();
}

function setDown(n, down) {
  n.down = down;
  renderInspector();
  updateLive();
}

function breakServer() {
  if (app.run) return busy();
  const alive = app.design.nodes.filter((n) => n.type === "server" && !n.down);
  if (!alive.length) return toast("No running servers to break");
  alive.sort((a, b) => (app.sim.nodeState(b.id)?.inRate || 0) - (app.sim.nodeState(a.id)?.inRate || 0));
  setDown(alive[0], true);
  toast(`💥 ${displayNames(app.design.nodes).get(alive[0].id)} crashed!`);
}

function reviveAll() {
  for (const n of app.design.nodes) n.down = false;
  renderInspector();
  updateLive();
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  renderNodes();
  renderEdges();
  renderInspector();
  layout();
  updateLive();
}

function renderNodes() {
  const names = displayNames(app.design.nodes, "tag");
  const keep = new Set();
  for (const n of app.design.nodes) {
    keep.add(n.id);
    let el = nodeEls.get(n.id);
    if (!el || el.dataset.type !== n.type) {
      el?.remove();
      el = document.createElement("div");
      el.className = `node t-${n.type}`;
      el.dataset.id = n.id;
      el.dataset.type = n.type;
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      el.innerHTML =
        `<div class="n-head"><span class="n-icon">${icon(n.type, 18)}</span><span class="n-name"></span>${KINDS[n.type].sizes ? '<span class="n-size"></span>' : ""}</div>` +
        `<div class="n-stat"><span class="n-rps"></span><span class="n-util"></span></div><div class="n-bar"><i></i></div>` +
        (n.type !== "replica" ? '<button class="port" tabindex="-1" aria-hidden="true" title="Drag to connect"></button>' : "");
      el.addEventListener("animationend", () => el.classList.remove("new"));
      els.nodes.appendChild(el);
      nodeEls.set(n.id, el);
    }
    el.querySelector(".n-name").textContent = names.get(n.id);
    const size = el.querySelector(".n-size");
    if (size) size.textContent = n.size || "M";
    el.classList.toggle("selected", app.selected?.kind === "node" && app.selected.id === n.id);
    positionNode(el, n);
  }
  for (const [id, el] of nodeEls) {
    if (!keep.has(id)) {
      el.remove();
      nodeEls.delete(id);
    }
  }
}

function positionNode(el, n) {
  el.style.left = `${n.x - NODE_W / 2}px`;
  el.style.top = `${n.y - NODE_H / 2}px`;
}

function edgePoints(a, b) {
  const sx = a.x + NODE_W / 2;
  const sy = a.y;
  const tx = b.x - NODE_W / 2 - 5;
  const ty = b.y;
  const dx = Math.max(55, Math.abs(tx - sx) / 2);
  return [sx, sy, sx + dx, sy, tx - dx, ty, tx, ty];
}
const pathD = (p) => `M${p[0]} ${p[1]} C${p[2]} ${p[3]} ${p[4]} ${p[5]} ${p[6]} ${p[7]}`;
function bez(p, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p[0] + b * p[2] + c * p[4] + d * p[6], y: a * p[1] + b * p[3] + c * p[5] + d * p[7] };
}

const edgeGeo = new Map();
function renderEdges() {
  const nodes = new Map(app.design.nodes.map((n) => [n.id, n]));
  edgeGeo.clear();
  let html = "";
  for (const e of app.design.edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (!a || !b) continue;
    const p = edgePoints(a, b);
    const len = Math.hypot(p[6] - p[0], p[7] - p[1]) * 1.15 + 20;
    edgeGeo.set(e.id, { p, len, e });
    const sel = app.selected?.kind === "edge" && app.selected.id === e.id;
    html += `<g class="edge${sel ? " selected" : ""}" data-id="${e.id}"><path class="e-hit" d="${pathD(p)}"/><path class="e-line" d="${pathD(p)}" marker-end="url(#arrow)"/></g>`;
  }
  els.edges.innerHTML = html;
  $("#stage-empty").hidden = app.design.nodes.length > 1 && app.design.edges.length > 0;
  $(".edge-del", els.nodes)?.remove();
  if (app.selected?.kind === "edge" && edgeGeo.has(app.selected.id)) {
    const { p } = edgeGeo.get(app.selected.id);
    const mid = bez(p, 0.5);
    const btn = document.createElement("button");
    btn.className = "edge-del";
    btn.textContent = "✕";
    btn.setAttribute("aria-label", "Delete this connection");
    btn.style.left = `${mid.x}px`;
    btn.style.top = `${mid.y}px`;
    btn.addEventListener("click", () => deleteEdge(app.selected.id));
    els.nodes.appendChild(btn);
  }
  updateEdgeLive();
}

function updateEdgeLive() {
  for (const g of els.edges.children) {
    const geo = edgeGeo.get(g.dataset.id);
    if (!geo) continue;
    const r = app.sim.edgeRate(geo.e.from, geo.e.to);
    const flow = r ? r.total : 0;
    const on = flow > 0.5;
    g.classList.toggle("on", on);
    const line = g.lastChild;
    line.style.strokeWidth = on ? (2 + Math.min(3, Math.log10(1 + flow) * 0.9)).toFixed(2) : "";
    line.setAttribute("marker-end", on ? "url(#arrow-on)" : "url(#arrow)");
  }
}

function select(sel) {
  app.selected = sel;
  for (const [id, el] of nodeEls) el.classList.toggle("selected", sel?.kind === "node" && sel.id === id);
  renderEdges();
  renderInspector();
}

// ---------------------------------------------------------------- live UI

function updateLive() {
  const { design, sim } = app;
  const names = displayNames(design.nodes);
  for (const n of design.nodes) {
    const el = nodeEls.get(n.id);
    if (!el) continue;
    const s = sim.nodeState(n.id);
    const rpsEl = el.querySelector(".n-rps");
    const utilEl = el.querySelector(".n-util");
    const bar = el.querySelector(".n-bar i");
    let util = 0;
    if (n.type === "users") {
      rpsEl.textContent = `${fmt(s?.inRate || 0)} req/s`;
      utilEl.textContent = "";
    } else if (n.type === "queue") {
      const backlog = s?.backlog || 0;
      rpsEl.textContent = `${fmt(s?.inRate || 0)}/s`;
      utilEl.textContent = `${fmt(backlog)} queued`;
      util = backlog / KINDS.queue.maxBacklog;
      bar.style.width = `${Math.min(100, Math.max(backlog > 0 ? 3 : 0, util * 100))}%`;
    } else {
      util = s?.utilS || 0;
      rpsEl.textContent = `${fmt(s?.inRate || 0)}/s`;
      utilEl.textContent = n.down ? "" : `${Math.round(util * 100)}%`;
      bar.style.width = `${Math.min(100, util * 100)}%`;
    }
    el.classList.toggle("down", !!n.down);
    el.classList.toggle("hot", !n.down && n.type !== "queue" && util >= 0.97);
    el.classList.toggle("warm", !n.down && util >= 0.75 && util < 0.97);
    el.setAttribute("aria-label", `${names.get(n.id)}${n.down ? ", down" : n.type === "users" ? "" : `, ${Math.round(util * 100)}% busy`}. Press Enter for details.`);
  }
  updateEdgeLive();

  const m = sim.metrics();
  const ch = app.mode === "challenge" ? CHALLENGES[app.level] : null;
  setTile("m-throughput", fmt(m.throughput), "");
  setTile("m-latency", m.throughput > 0 ? fmt(m.latency) : "–", m.throughput <= 0 ? "" : m.latency <= (ch?.goals.latency || 200) ? "ok" : m.latency < 600 ? "warn" : "bad");
  const errPct = m.errorRate * 100;
  setTile("m-errors", `${errPct < 10 && errPct > 0 ? errPct.toFixed(1) : Math.round(errPct)}%`, m.throughput + m.failedPerSec <= 0 ? "" : m.errorRate <= (ch?.goals.errors ?? 0.01) ? "ok" : m.errorRate < 0.1 ? "warn" : "bad");
  setTile("m-cost", money(m.cost), ch ? (m.cost <= ch.goals.budget ? "ok" : "bad") : "");

  pushHistory(m);
  drawChart();

  if (ch) updateGoals(ch, m);
  if (!app.run) $("#btn-revive").hidden = !design.nodes.some((n) => n.down);
  if (!els.inspector.hidden) updateInspectorStats();
  renderInsights();
}

function setTile(id, value, state) {
  const tile = document.getElementById(id);
  tile.querySelector("b").textContent = value;
  tile.className = `tile ${state}`;
}

let insightTimer = 0;
function renderInsights() {
  const now = performance.now();
  if (now - insightTimer < 900) return;
  insightTimer = now;
  const list = insights(app.design, app.sim, { sandbox: app.mode === "sandbox" });
  els.insights.innerHTML = list
    .map((i) => `<li class="ins ${i.level}"><span class="i-icon" aria-hidden="true">${i.icon}</span><div><b>${i.title}</b><p>${i.text}</p></div></li>`)
    .join("");
}

// ---------------------------------------------------------------- chart

const hist = [];
let lastHistory = 0;
function resetHistory() {
  hist.length = 0;
  lastHistory = 0;
}
function pushHistory(m) {
  const now = performance.now();
  if (now - lastHistory < 240) return;
  lastHistory = now;
  hist.push({ served: m.throughput, offered: m.offered, lat: m.latency, err: m.errorRate });
  if (hist.length > 240) hist.shift();
}

function drawChart() {
  const c = els.chart;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (!w) return;
  if (c.width !== Math.round(w * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (h / 4) * i + 0.5);
    ctx.lineTo(w, (h / 4) * i + 0.5);
    ctx.stroke();
  }
  if (hist.length < 2) return;
  const n = 240;
  const x = (i) => w - (hist.length - 1 - i) * (w / (n - 1));
  const pad = 8;
  const maxServed = Math.max(10, ...hist.map((p) => Math.max(p.served, p.offered))) * 1.1;
  const maxLat = Math.max(300, ...hist.map((p) => p.lat)) * 1.1;
  const area = (val, max, fill) => {
    ctx.beginPath();
    ctx.moveTo(x(0), h);
    hist.forEach((p, i) => ctx.lineTo(x(i), h - pad - (val(p) / max) * (h - pad * 2)));
    ctx.lineTo(x(hist.length - 1), h);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  area((p) => p.served, maxServed, "rgba(56,189,248,0.22)");
  area((p) => p.err, 1, "rgba(251,90,110,0.45)");
  ctx.beginPath();
  hist.forEach((p, i) => {
    const y = h - pad - (p.lat / maxLat) * (h - pad * 2);
    i ? ctx.lineTo(x(i), y) : ctx.moveTo(x(i), y);
  });
  ctx.strokeStyle = COLORS.write;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = "600 10px JetBrains Mono, monospace";
  ctx.fillStyle = "rgba(231,235,245,0.55)";
  ctx.textAlign = "left";
  ctx.fillText(`${fmt(maxServed / 1.1)} req/s`, 6, 13);
  ctx.textAlign = "right";
  ctx.fillText(`${fmt(maxLat / 1.1)} ms`, w - 6, 13);
}

// ---------------------------------------------------------------- particles

const particles = [];
const sparks = [];
const spawnAcc = new Map();
const dropRate = new Map();

function pickType(r) {
  let x = Math.random() * r.total;
  for (const t of ["read", "write", "static", "job"]) {
    x -= r[t];
    if (x <= 0) return t;
  }
  return "read";
}

function updateParticles(dt) {
  const k = reduceMotion ? 0.3 : 1;
  for (const [id, geo] of edgeGeo) {
    const r = app.sim.edgeRate(geo.e.from, geo.e.to);
    if (!r || r.total < 0.3) continue;
    const rate = Math.min(26, 1.2 + 5 * Math.log10(1 + r.total)) * k;
    let acc = (spawnAcc.get(id) || 0) + rate * dt;
    while (acc >= 1 && particles.length < 900) {
      acc -= 1;
      particles.push({ id, t: 0, v: 230 / geo.len, type: pickType(r), j: (Math.random() - 0.5) * 5 });
    }
    spawnAcc.set(id, acc % 1);
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.t += p.v * dt;
    if (p.t >= 1 || !edgeGeo.has(p.id)) particles.splice(i, 1);
  }
  for (const n of app.design.nodes) {
    const s = app.sim.nodeState(n.id);
    const d = (dropRate.get(n.id) || 0) * 0.85 + ((s?.drops || 0) / DT) * 0.15;
    dropRate.set(n.id, d);
    if (d < 0.5) continue;
    let acc = (spawnAcc.get(`x${n.id}`) || 0) + Math.min(22, 2 + 4 * Math.log10(1 + d)) * k * dt;
    while (acc >= 1 && sparks.length < 300) {
      acc -= 1;
      sparks.push({ x: n.x + (Math.random() - 0.5) * NODE_W * 0.7, y: n.y + NODE_H / 2 - 4, vx: (Math.random() - 0.5) * 50, vy: 30 + Math.random() * 60, life: 1 });
    }
    spawnAcc.set(`x${n.id}`, acc % 1);
  }
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vy += 90 * dt;
    s.life -= dt * 1.2;
    if (s.life <= 0) sparks.splice(i, 1);
  }
}

function drawParticles() {
  const ctx = els.canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  for (const p of particles) {
    const geo = edgeGeo.get(p.id);
    if (!geo) continue;
    const pt = bez(geo.p, p.t);
    const fade = Math.min(1, p.t * 6, (1 - p.t) * 6);
    ctx.globalAlpha = 0.18 * fade;
    ctx.fillStyle = COLORS[p.type];
    ctx.beginPath();
    ctx.arc(pt.x, pt.y + p.j, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = fade;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y + p.j, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = COLORS.fail;
  for (const s of sparks) {
    ctx.globalAlpha = Math.max(0, s.life) * 0.9;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- layout

let view = { x0: 0, y0: 0, x1: W, y1: H };
function contentBox() {
  const ns = app.design.nodes;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of ns) {
    x0 = Math.min(x0, n.x - NODE_W / 2 - 40);
    x1 = Math.max(x1, n.x + NODE_W / 2 + 50);
    y0 = Math.min(y0, n.y - NODE_H / 2 - 40);
    y1 = Math.max(y1, n.y + NODE_H / 2 + 40);
  }
  const grow = (a, b, min, max) => {
    if (b - a < min) {
      const c = (a + b) / 2;
      a = c - min / 2;
      b = c + min / 2;
    }
    if (a < 0) (b -= a), (a = 0);
    if (b > max) (a -= b - max), (b = max);
    return [Math.max(0, a), Math.min(max, b)];
  };
  [x0, x1] = grow(x0, x1, 760, W);
  [y0, y1] = grow(y0, y1, 430, H);
  return { x0, y0, x1, y1 };
}

function layout() {
  const sw = els.stage.clientWidth;
  const sh = els.stage.clientHeight;
  if (!sw || !sh || !app.design) return;
  let box = contentBox();
  let s = Math.min(sw / (box.x1 - box.x0), sh / (box.y1 - box.y0), 1.15);
  const scroll = s < 0.45;
  if (scroll) {
    box = { x0: 0, y0: 0, x1: W, y1: H };
    s = Math.min(0.6, sh / H);
  }
  scale = s;
  els.stage.classList.toggle("scroll", scroll);
  const ox = scroll ? 0 : (sw - (box.x1 - box.x0) * s) / 2 - box.x0 * s;
  const oy = scroll ? 0 : (sh - (box.y1 - box.y0) * s) / 2 - box.y0 * s;
  view = { x0: Math.max(0, -ox / s), y0: Math.max(0, -oy / s), x1: Math.min(W, (sw - ox) / s), y1: Math.min(H, (sh - oy) / s) };
  els.world.style.transform = `translate(${ox}px, ${oy}px) scale(${s})`;
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.round(W * s * dpr);
  if (els.canvas.width !== cw) {
    els.canvas.width = cw;
    els.canvas.height = Math.round(H * s * dpr);
  }
  drawParticles();
}

function worldPoint(e) {
  const r = els.world.getBoundingClientRect();
  return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
}

// ---------------------------------------------------------------- interactions

function nodeAt(e) {
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  return hit?.closest?.(".node");
}

els.nodes.addEventListener("pointerdown", (e) => {
  const el = e.target.closest(".node");
  if (!el || e.button > 0) return;
  if (app.run) return busy();
  const n = byId(el.dataset.id);
  if (!n) return;
  e.preventDefault();
  if (e.target.closest(".port")) return startConnect(e, n);
  startDrag(e, n, el);
});

function startDrag(e, n, el) {
  const p0 = worldPoint(e);
  const off = { x: p0.x - n.x, y: p0.y - n.y };
  let moved = false;
  const move = (ev) => {
    const p = worldPoint(ev);
    if (!moved && Math.hypot(p.x - p0.x, p.y - p0.y) < 4) return;
    moved = true;
    el.classList.add("dragging");
    n.x = clamp(p.x - off.x, view.x0 + NODE_W / 2 + 4, view.x1 - NODE_W / 2 - 14);
    n.y = clamp(p.y - off.y, view.y0 + NODE_H / 2 + 4, view.y1 - NODE_H / 2 - 4);
    positionNode(el, n);
    renderEdges();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    el.classList.remove("dragging");
    if (moved) {
      settle(n);
      positionNode(el, n);
      renderEdges();
      saved();
      layout();
    }
    else {
      select({ kind: "node", id: n.id });
      el.focus({ preventScroll: true });
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function startConnect(e, from) {
  let target = null;
  const start = { x: from.x + NODE_W / 2, y: from.y };
  const clear = () => {
    for (const el of nodeEls.values()) el.classList.remove("drop-ok", "drop-bad");
  };
  const move = (ev) => {
    const p = worldPoint(ev);
    const dx = Math.max(40, Math.abs(p.x - start.x) / 2);
    clear();
    const el = nodeAt(ev);
    target = el && el.dataset.id !== from.id ? byId(el.dataset.id) : null;
    const ok = target && canConnect(from.type, target.type);
    if (target) el.classList.add(ok ? "drop-ok" : "drop-bad");
    els.temp.classList.toggle("bad", !!target && !ok);
    els.temp.setAttribute("d", `M${start.x} ${start.y} C${start.x + dx} ${start.y} ${p.x - dx} ${p.y} ${p.x} ${p.y}`);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    els.temp.setAttribute("d", "");
    clear();
    if (target) connect(from.id, target.id);
    else toast("Drop the line onto another component to connect them");
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  move(e);
}

els.edges.addEventListener("click", (e) => {
  const g = e.target.closest(".edge");
  if (g) select({ kind: "edge", id: g.dataset.id });
});

els.stage.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".node, .edge, .edge-del")) return;
  if (app.selected) select(null);
});

els.nodes.addEventListener("keydown", (e) => {
  const el = e.target.closest(".node");
  if (!el) return;
  const n = byId(el.dataset.id);
  const step = e.shiftKey ? 40 : 10;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key]) {
    e.preventDefault();
    if (app.run) return;
    n.x = clamp(n.x + moves[e.key][0], NODE_W / 2 + 4, W - NODE_W / 2 - 4);
    n.y = clamp(n.y + moves[e.key][1], NODE_H / 2 + 4, H - NODE_H / 2 - 4);
    positionNode(el, n);
    renderEdges();
    layout();
    saved();
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    select({ kind: "node", id: n.id });
  }
});

document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, select, textarea, dialog")) return;
  if ((e.key === "Delete" || e.key === "Backspace") && app.selected) {
    e.preventDefault();
    if (app.selected.kind === "node") deleteNode(app.selected.id);
    else deleteEdge(app.selected.id);
  } else if (e.key === "Escape" && app.selected) {
    select(null);
  }
});

// Palette: click to add, or drag onto the canvas.
function renderPalette() {
  $("#palette").innerHTML = PALETTE.map((type) => {
    const k = KINDS[type];
    const spec = k.sizes ? `${money(k.sizes.M.cost)} · ${fmt(k.sizes.M.cap)}/s` : `${money(k.cost)} · ${fmt(k.cap)}/s`;
    return `<button class="pal t-${type}" data-type="${type}" title="${k.short}"><span class="pal-icon">${icon(type, 20)}</span><span><b>${k.label}</b><small>${spec}</small></span></button>`;
  }).join("");
}

$("#palette").addEventListener("pointerdown", (e) => {
  const card = e.target.closest(".pal");
  if (!card || e.button > 0) return;
  const type = card.dataset.type;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let ghost = null;
  const move = (ev) => {
    if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8) return;
    if (!ghost) {
      ghost = card.cloneNode(true);
      ghost.classList.add("drag-ghost");
      ghost.style.width = `${card.offsetWidth}px`;
      document.body.appendChild(ghost);
    }
    ghost.style.left = `${ev.clientX}px`;
    ghost.style.top = `${ev.clientY}px`;
  };
  const up = (ev) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    if (!ghost) return; // a plain click is handled by the click event
    ghost.remove();
    const r = els.stage.getBoundingClientRect();
    if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) addNode(type, worldPoint(ev));
    card.dataset.dragged = "1";
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
});
$("#palette").addEventListener("click", (e) => {
  const card = e.target.closest(".pal");
  if (!card) return;
  if (card.dataset.dragged) {
    delete card.dataset.dragged;
    return;
  }
  addNode(card.dataset.type);
});

// ---------------------------------------------------------------- inspector

function renderInspector() {
  const sel = app.selected;
  const n = sel?.kind === "node" ? byId(sel.id) : null;
  if (!n) {
    els.inspector.hidden = true;
    els.inspector.innerHTML = "";
    return;
  }
  const k = KINDS[n.type];
  const name = displayNames(app.design.nodes).get(n.id);
  const out = app.design.edges.filter((e) => e.from === n.id);
  const names = displayNames(app.design.nodes);
  const options = app.design.nodes.filter((o) => o.id !== n.id && canConnect(n.type, o.type) && !out.some((e) => e.to === o.id));
  const sizes = k.sizes
    ? `<div class="insp-row"><span>Size</span><div class="sizes">${Object.entries(k.sizes)
        .map(([s, v]) => `<button data-size="${s}" aria-pressed="${(n.size || "M") === s}"><b>${s}</b><small>${fmt(v.cap)}/s</small><small>${money(v.cost)}</small></button>`)
        .join("")}</div></div>`
    : "";
  const hit = n.type === "cache"
    ? `<div class="insp-row"><span>Hit rate: <output id="hit-out">${Math.round(hitRateOf(n) * 100)}%</output> of reads found in the cache</span><input type="range" id="hit" min="50" max="99" value="${Math.round(hitRateOf(n) * 100)}" aria-label="Cache hit rate"></div>`
    : "";
  const conns = n.type !== "replica"
    ? `<div class="insp-row"><span>Sends traffic to</span><div class="chips">${out.length ? out.map((e) => `<span class="chip">${names.get(e.to)}<button data-unlink="${e.id}" aria-label="Disconnect ${names.get(e.to)}">×</button></span>`).join("") : '<span class="chip" style="padding-right:9px">nothing yet</span>'}</div>
      ${options.length ? `<select id="connect-to" aria-label="Connect to" style="margin-top:7px;width:100%"><option value="">+ Connect to…</option>${options.map((o) => `<option value="${o.id}">${names.get(o.id)}</option>`).join("")}</select>` : ""}</div>`
    : "";
  els.inspector.hidden = false;
  els.inspector.innerHTML = `
    <div class="insp-head t-${n.type}"><span class="pal-icon">${icon(n.type, 20)}</span><div><h3>${name}</h3><small>${k.short}</small></div><button class="insp-close" aria-label="Close details">×</button></div>
    <p class="insp-what">${k.what}</p>
    <dl class="insp-stats" id="insp-stats"></dl>
    ${sizes}${hit}${conns}
    <p class="insp-examples"><b>Real world:</b> ${k.examples}</p>
    <p class="insp-examples"><b>Use it when:</b> ${k.when}</p>
    ${n.type !== "users" ? `<div class="insp-actions"><button class="ghost" data-act="down">${n.down ? "🩹 Revive" : "💥 Crash it"}</button><button class="ghost danger" data-act="delete">🗑 Delete</button></div>` : ""}`;
  updateInspectorStats();
}

function updateInspectorStats() {
  const n = app.selected?.kind === "node" ? byId(app.selected.id) : null;
  const box = $("#insp-stats");
  if (!n || !box) return;
  const s = app.sim.nodeState(n.id) || {};
  const stat = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  if (n.type === "users") {
    box.innerHTML = stat("Sending", `${fmt(s.inRate || 0)}/s`) + stat("Mix", `${Math.round(app.design.traffic.writes * 100)}% writes`);
    return;
  }
  const cap = capacityOf(n);
  const drops = dropRate.get(n.id) || 0;
  box.innerHTML =
    stat("Incoming", `${fmt(s.inRate || 0)}/s`) +
    (n.type === "queue" ? stat("Waiting jobs", fmt(s.backlog || 0)) : stat("Busy", n.down ? "down" : `${Math.round((s.utilS || 0) * 100)}%`)) +
    stat("Capacity", `${fmt(cap)}/s`) +
    stat("Adds", `${n.down ? "–" : fmt(s.lat || KINDS[n.type].lat)} ms`) +
    stat("Failing", `${fmt(drops)}/s`) +
    stat("Cost", `${money(costOf(n))}/mo`);
}

els.inspector.addEventListener("click", (e) => {
  const n = app.selected?.kind === "node" ? byId(app.selected.id) : null;
  if (!n) return;
  if (e.target.closest(".insp-close")) return select(null);
  const size = e.target.closest("[data-size]");
  if (size) {
    if (app.run) return busy();
    n.size = size.dataset.size;
    renderNodes();
    renderInspector();
    saved();
    return;
  }
  const unlink = e.target.closest("[data-unlink]");
  if (unlink) return deleteEdge(unlink.dataset.unlink);
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "delete") deleteNode(n.id);
  if (act === "down") {
    if (app.run) return busy();
    setDown(n, !n.down);
  }
});
els.inspector.addEventListener("input", (e) => {
  const n = app.selected?.kind === "node" ? byId(app.selected.id) : null;
  if (!n || e.target.id !== "hit") return;
  n.hit = +e.target.value / 100;
  $("#hit-out").textContent = `${e.target.value}%`;
  saved();
});
els.inspector.addEventListener("change", (e) => {
  const n = app.selected?.kind === "node" ? byId(app.selected.id) : null;
  if (n && e.target.id === "connect-to" && e.target.value) connect(n.id, e.target.value);
});

// ---------------------------------------------------------------- traffic controls

const rpsFromSlider = (v) => {
  const raw = 10 * Math.pow(5000, v / 1000);
  const step = raw < 100 ? 5 : raw < 1000 ? 10 : raw < 10000 ? 100 : 500;
  return Math.max(10, Math.round(raw / step) * step);
};
const sliderFromRps = (r) => Math.round((1000 * Math.log(r / 10)) / Math.log(5000));

function syncTraffic() {
  const t = app.design.traffic;
  const locked = app.mode === "challenge";
  $("#rps").value = sliderFromRps(t.rps);
  $("#rps-out").textContent = `${fmt(t.rps)} req/s`;
  $("#pattern").value = t.pattern;
  $("#writes").value = Math.round(t.writes * 100);
  $("#writes-out").textContent = `${Math.round(t.writes * 100)}%`;
  $("#statics").value = Math.round(t.statics * 100);
  $("#statics-out").textContent = `${Math.round(t.statics * 100)}%`;
  for (const id of ["rps", "pattern", "writes", "statics"]) document.getElementById(id).disabled = locked;
  $("#trafficbar").classList.toggle("locked", locked);
  $("#traffic-lock").hidden = !locked;
}

$("#rps").addEventListener("input", (e) => {
  app.design.traffic.rps = rpsFromSlider(+e.target.value);
  $("#rps-out").textContent = `${fmt(app.design.traffic.rps)} req/s`;
  saved();
});
$("#pattern").addEventListener("change", (e) => {
  app.design.traffic.pattern = e.target.value;
  saved();
});
$("#writes").addEventListener("input", (e) => {
  app.design.traffic.writes = +e.target.value / 100;
  $("#writes-out").textContent = `${e.target.value}%`;
  saved();
});
$("#statics").addEventListener("input", (e) => {
  app.design.traffic.statics = +e.target.value / 100;
  $("#statics-out").textContent = `${e.target.value}%`;
  saved();
});

// ---------------------------------------------------------------- toolbar

function setSpeed(v) {
  app.speed = v;
  for (const b of $$("[data-speed]")) b.setAttribute("aria-pressed", String(+b.dataset.speed === v));
}
function setPlaying(on) {
  app.playing = on;
  const b = $("#btn-play");
  b.textContent = on ? "❚❚" : "▶";
  b.setAttribute("aria-label", on ? "Pause" : "Play");
}
$("#btn-play").addEventListener("click", () => setPlaying(!app.playing));
$$("[data-speed]").forEach((b) => b.addEventListener("click", () => !app.run && setSpeed(+b.dataset.speed)));
$("#btn-chaos").addEventListener("click", breakServer);
$("#btn-revive").addEventListener("click", reviveAll);
$("#btn-reset").addEventListener("click", () => {
  if (app.run) return busy();
  app.sim.reset();
  resetHistory();
  particles.length = 0;
  sparks.length = 0;
  toast("Queues and stats cleared");
});

// ---------------------------------------------------------------- challenges

function starsHtml(count, total = 3) {
  return Array.from({ length: total }, (_, i) => `<span class="${i < count ? "on" : ""}">★</span>`).join("");
}

function renderLevels() {
  const nav = $("#level-pills");
  if (!nav) return;
  nav.innerHTML = CHALLENGES.map((ch, i) => {
    const stars = app.progress[ch.id] || 0;
    const current = i === app.level;
    return `<button class="pill${stars ? " passed" : ""}" data-level="${i}" aria-current="${current}" title="${ch.title}${stars ? ` (${stars}★)` : ""}" aria-label="Level ${i + 1}: ${ch.title}${stars ? `, ${stars} of 3 stars` : ""}">${i + 1}${stars ? `<small>${"★".repeat(stars)}</small>` : ""}</button>`;
  }).join("");
}

els.mission.addEventListener("click", (e) => {
  const b = e.target.closest("[data-level]");
  if (!b || app.run) return;
  openLevel(+b.dataset.level);
});

function renderMission() {
  const ch = CHALLENGES[app.level];
  const g = ch.goals;
  els.mission.innerHTML = `
    <nav class="level-pills" id="level-pills" aria-label="Levels"></nav>
    <p class="m-kicker">Level ${app.level + 1} of ${CHALLENGES.length} · ${ch.concept}</p>
    <h2 id="mission-title">${ch.title}</h2>
    <p class="m-story">${ch.story}</p>
    <p class="m-task"><b>Your task:</b> ${ch.task}</p>
    <ul class="goals" aria-label="Goals">
      <li class="goal" data-goal="latency"><span class="g-dot" aria-hidden="true">✕</span><span>Response time under ${g.latency} ms</span><span class="g-now"></span></li>
      <li class="goal" data-goal="errors"><span class="g-dot" aria-hidden="true">✕</span><span>Under ${g.errors * 100}% failed requests</span><span class="g-now"></span></li>
      <li class="goal" data-goal="budget"><span class="g-dot" aria-hidden="true">✕</span><span>Cost under ${money(g.budget)}/month</span><span class="g-now"></span></li>
    </ul>
    ${ch.chaos ? `<p class="m-story">⚠️ During the test, your busiest server crashes at ${ch.chaos.at}s.</p>` : ""}
    ${ch.traffic.pattern === "spikes" ? `<p class="m-story">📈 Traffic spikes ${ch.traffic.spike}× for 3 seconds out of every 10.</p>` : ""}
    <div class="m-actions" id="m-actions">
      <button class="primary" id="btn-test">▶ Run the test</button>
      <button class="ghost" id="btn-hint" aria-expanded="${app.hint}">💡 Hint</button>
      <button class="ghost" id="btn-restart" aria-label="Restart level" title="Restart level">↺</button>
    </div>
    <p class="m-hint" id="m-hint" ${app.hint ? "" : "hidden"}>${ch.hint}</p>`;
  $("#btn-test").addEventListener("click", startTest);
  $("#btn-hint").addEventListener("click", () => {
    app.hint = !app.hint;
    $("#m-hint").hidden = !app.hint;
    $("#btn-hint").setAttribute("aria-expanded", String(app.hint));
  });
  $("#btn-restart").addEventListener("click", () => !app.run && restartLevel());
  renderLevels();
  updateGoals(ch, app.sim.metrics());
}

function updateGoals(ch, m) {
  const g = ch.goals;
  const live = m.throughput > 0;
  const rows = {
    latency: [live && m.latency <= g.latency, live ? `${fmt(m.latency)} ms` : "–"],
    errors: [live && m.errorRate <= g.errors, `${(m.errorRate * 100).toFixed(m.errorRate < 0.1 ? 1 : 0)}%`],
    budget: [m.cost <= g.budget, money(m.cost)],
  };
  for (const [id, [ok, text]] of Object.entries(rows)) {
    const li = els.mission.querySelector(`[data-goal="${id}"]`);
    if (!li) continue;
    li.classList.toggle("ok", ok);
    li.querySelector(".g-dot").textContent = ok ? "✓" : "✕";
    li.querySelector(".g-now").textContent = `now ${text}`;
  }
  if (app.run) {
    const secs = app.run.progress * (WARMUP + DURATION);
    const bar = $("#test-progress");
    if (bar) {
      bar.querySelector("i").style.width = `${app.run.progress * 100}%`;
      bar.querySelector("span").textContent = secs < WARMUP ? "Warming up…" : `Testing… ${Math.min(DURATION, Math.floor(secs - WARMUP))}s / ${DURATION}s`;
    }
  }
}

function startTest() {
  if (app.run) return;
  const ch = CHALLENGES[app.level];
  select(null);
  app.run = createRun(app.design, ch, app.sim);
  resetHistory();
  particles.length = 0;
  app.prevSpeed = app.speed;
  setSpeed(4);
  setPlaying(true);
  els.stage.classList.add("locked");
  for (const id of ["btn-chaos", "btn-revive", "btn-reset"]) document.getElementById(id).disabled = true;
  $("#m-actions").innerHTML = `<div class="progress" id="test-progress" role="progressbar" aria-label="Test progress"><i></i><span>Warming up…</span></div>`;
}

function finishTest() {
  const ch = CHALLENGES[app.level];
  const run = app.run;
  const res = run.result();
  const advice = insights(app.design, app.sim, { limit: 2 }).filter((i) => i.level === "bad" || i.level === "warn");
  app.run = null;
  if (run.killed) run.killed.down = false;
  setSpeed(app.prevSpeed);
  els.stage.classList.remove("locked");
  for (const id of ["btn-chaos", "btn-revive", "btn-reset"]) document.getElementById(id).disabled = false;
  if (res.pass && res.stars > (app.progress[ch.id] || 0)) {
    app.progress[ch.id] = res.stars;
    store.set("progress", app.progress);
  }
  renderLevels();
  renderMission();
  showResult(ch, res, advice, run.killed);
}

function showResult(ch, res, advice, killed) {
  const last = app.level === CHALLENGES.length - 1;
  const fmtVal = (c) => (c.id === "latency" ? `${fmt(c.value)} ms` : c.id === "errors" ? `${(c.value * 100).toFixed(2)}%` : money(c.value));
  const fmtTarget = (c) => (c.id === "latency" ? `under ${c.target} ms` : c.id === "errors" ? `under ${c.target * 100}%` : `under ${money(c.target)}`);
  const checks = res.checks.map((c) => `<li class="${c.pass ? "pass" : "fail"}"><span aria-hidden="true">${c.pass ? "✅" : "❌"}</span><span>${c.label} <small style="color:var(--dim)">(${fmtTarget(c)})</small></span><span class="val">${fmtVal(c)}</span></li>`).join("");
  const body = $("#result-body");
  if (res.pass) {
    body.innerHTML = `
      <p class="eyebrow">Level ${app.level + 1} passed</p>
      <h2 id="result-title">${last ? "🏆 You finished every level!" : "🎉 Your design survived!"}</h2>
      <div class="result-stars" aria-label="${res.stars} of 3 stars">${starsHtml(res.stars)}</div>
      <p class="star-key">★ passed · ★ under 85% of the budget · ★ fast (under ⅔ of the time limit)</p>
      <ul class="result-checks">${checks}</ul>
      ${killed ? `<p class="star-key">💥 ${displayNames(app.design.nodes).get(killed.id)} was crashed during the test, and your design kept going.</p>` : ""}
      <p class="lesson"><b>What you learned:</b> ${ch.lesson}</p>
      <div class="dialog-actions">
        ${last ? '<button class="primary" data-res="sandbox">Play in the sandbox</button>' : '<button class="primary" data-res="next">Next level →</button>'}
        <button class="ghost" data-res="close">${res.stars < 3 ? "Improve my score" : "Stay here"}</button>
      </div>`;
  } else {
    body.innerHTML = `
      <p class="eyebrow">Not yet</p>
      <h2 id="result-title">Your design didn't make it</h2>
      <ul class="result-checks">${checks}</ul>
      ${advice.length ? `<ul id="result-advice" style="list-style:none;padding:0;margin:0 0 14px;display:grid;gap:7px">${advice.map((i) => `<li class="ins ${i.level}"><span class="i-icon" aria-hidden="true">${i.icon}</span><div><b>${i.title}</b><p>${i.text}</p></div></li>`).join("")}</ul>` : ""}
      <p class="m-hint">💡 ${ch.hint}</p>
      <div class="dialog-actions" style="margin-top:16px"><button class="primary" data-res="close">Try again</button></div>`;
  }
  const dlg = $("#result");
  dlg.showModal();
  if (!reduceMotion && res.pass) confetti();
}

$("#result").addEventListener("click", (e) => {
  const dlg = $("#result");
  if (e.target === dlg) return dlg.close();
  const act = e.target.closest("[data-res]")?.dataset.res;
  if (!act) return;
  dlg.close();
  if (act === "next") openLevel(app.level + 1);
  if (act === "sandbox") openSandbox(TEMPLATES[3].design());
});

function confetti() {
  const colors = Object.values(COLORS);
  for (let i = 0; i < 70; i++) {
    const p = document.createElement("i");
    p.style.cssText = `position:fixed;z-index:70;left:${50 + (Math.random() - 0.5) * 30}vw;top:40vh;width:7px;height:11px;border-radius:2px;background:${colors[i % colors.length]};pointer-events:none`;
    document.body.appendChild(p);
    const dx = (Math.random() - 0.5) * 700;
    const dy = -200 - Math.random() * 300;
    p.animate(
      [{ transform: "translate(0,0) rotate(0)", opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) rotate(${Math.random() * 720}deg)`, opacity: 1, offset: 0.45 }, { transform: `translate(${dx * 1.2}px, ${dy + 700}px) rotate(${Math.random() * 1080}deg)`, opacity: 0 }],
      { duration: 1800 + Math.random() * 800, easing: "cubic-bezier(.2,.7,.4,1)" },
    ).onfinish = () => p.remove();
  }
}

// ---------------------------------------------------------------- templates, modes, share, help

function renderTemplates() {
  $("#template-list").innerHTML = TEMPLATES.map((t) => `<button data-template="${t.id}">${t.title}<small>${t.note}</small></button>`).join("");
}
$("#template-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-template]");
  if (!b) return;
  openSandbox(TEMPLATES.find((t) => t.id === b.dataset.template).design());
  toast(`Loaded "${TEMPLATES.find((t) => t.id === b.dataset.template).title}"`);
});

$$(".modes [role=tab]").forEach((tab) =>
  tab.addEventListener("click", () => {
    if (app.run || tab.dataset.mode === app.mode) return;
    if (tab.dataset.mode === "challenge") openLevel(app.level);
    else openSandbox();
  }),
);

function encodeDesign(d) {
  const ids = d.nodes.map((n) => n.id);
  const o = {
    n: d.nodes.map((n) => [n.type, Math.round(n.x), Math.round(n.y), n.size || "", n.hit ?? ""]),
    e: d.edges.map((e) => [ids.indexOf(e.from), ids.indexOf(e.to)]),
    t: [d.traffic.rps, d.traffic.pattern, d.traffic.writes, d.traffic.statics],
  };
  return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeDesign(s) {
  try {
    const o = JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))));
    const nodes = o.n.map(([type, x, y, size, hit], i) => ({ id: `${type}${i}`, type, x, y, size: size || undefined, hit: hit === "" ? undefined : hit }));
    const edges = o.e.map(([a, b]) => ({ from: nodes[a]?.id, to: nodes[b]?.id }));
    const [rps, pattern, writes, statics] = o.t;
    return sanitize({ nodes, edges, traffic: { rps, pattern, writes, statics } });
  } catch {
    return null;
  }
}

$("#btn-share").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}#d=${encodeDesign(app.design)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("🔗 Link copied. Anyone who opens it gets your exact design.");
  } catch {
    window.prompt("Copy this link:", url);
  }
});

const welcome = $("#welcome");
$("#btn-help").addEventListener("click", () => welcome.showModal());
$("#welcome-challenges").addEventListener("click", () => {
  welcome.close();
  openLevel(0);
});
$("#welcome-sandbox").addEventListener("click", () => welcome.close());
welcome.addEventListener("close", () => store.set("welcomed", true));
welcome.addEventListener("click", (e) => e.target === welcome && welcome.close());

let toastTimer = 0;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2800);
}

// ---------------------------------------------------------------- main loop

let last = performance.now();
let acc = 0;
let uiAcc = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (app.playing) {
    acc += dt * app.speed;
    let steps = 0;
    while (acc >= DT && steps < 60) {
      if (app.run) app.run.step();
      else app.sim.step();
      acc -= DT;
      steps++;
    }
    updateParticles(dt * Math.min(app.speed, 2));
  }
  drawParticles();
  uiAcc += dt;
  if (uiAcc >= 0.2) {
    uiAcc = 0;
    updateLive();
  }
  if (app.run && app.run.done) finishTest();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- start

renderPalette();
renderTemplates();
const shared = location.hash.startsWith("#d=") ? decodeDesign(location.hash.slice(3)) : null;
const lastVisit = store.get("last");
if (shared) {
  openSandbox(shared);
  history.replaceState?.(null, "", location.pathname);
  toast("Loaded a shared design");
} else if (lastVisit?.mode === "challenge") {
  openLevel(lastVisit.level || 0);
} else {
  openSandbox(lastVisit ? undefined : TEMPLATES[2].design());
}
renderLevels();
new ResizeObserver(() => layout()).observe(els.stage);
window.addEventListener("resize", layout);
if (!store.get("welcomed") && !shared) welcome.showModal();
requestAnimationFrame(frame);

// Exposed for automated tests.
window.__sds = { app, openLevel, openSandbox, addNode, connect, encodeDesign, decodeDesign, cloneDesign, costTotal };
