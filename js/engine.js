// Traffic simulation engine. Pure logic, no DOM, so it runs in the browser and in Node tests.
//
// It's a "fluid" model: every 100 ms tick, each request type flows through the graph as an
// amount (not individual requests). Every component has a capacity per second; anything above
// it waits in a backlog, which adds latency, and after 2 seconds of backlog, requests time out.
// Latency is carried along with each flow, so the average a user sees is exact for the model.

import { KINDS, capacityOf, costOf, hitRateOf } from "./components.js";

export const DT = 0.1; // seconds per tick
export const TIMEOUT = 2; // seconds a request will wait before giving up
export const HEALTH_CHECK = 2; // seconds before a load balancer notices a dead server
export const NET = { toEdge: 10, toOrigin: 60, edgeToOrigin: 40, internal: 1 };

const TYPES = ["static", "read", "write", "job", "probe"];
const USER_TYPES = new Set(["static", "read", "write"]);
const WINDOW = 30; // ticks of history used for live metrics (3 s)

export function trafficAt(traffic, t) {
  const base = traffic.rps;
  if (traffic.pattern === "wave") return base * (1 + 0.5 * Math.sin((2 * Math.PI * t) / 20));
  if (traffic.pattern === "spikes") {
    const p = t % 10;
    return p >= 5 && p < 8 ? base * (traffic.spike || 5) : base;
  }
  return base;
}

function bucket() {
  const b = {};
  for (const t of TYPES) b[t] = { a: 0, l: 0 };
  return b;
}

function newTick() {
  return { done: 0, lat: 0, failed: 0, jobsDone: 0, jobsFailed: 0, rps: 0, reasons: new Map() };
}

export function createSim(design) {
  const state = new Map(); // node id -> runtime state
  const edgeRate = new Map(); // "from>to" -> { static, read, write, job, total } per second (smoothed)
  let window = [];
  let total = newTick();
  let totalTime = 0;
  let t = 0;

  function st(node) {
    let s = state.get(node.id);
    if (!s) {
      s = { inc: bucket(), back: bucket(), prevLoad: 0, util: 0, utilS: 0, inRate: 0, lat: 0, backlog: 0, drops: 0, jobs: 0, downAt: null };
      state.set(node.id, s);
    }
    return s;
  }

  function step() {
    t = +(t + DT).toFixed(4);
    const { nodes, edges, traffic } = design;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const kids = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) {
      if (byId.has(e.from) && byId.has(e.to)) kids.get(e.from).push(byId.get(e.to));
    }
    for (const id of state.keys()) if (!byId.has(id)) state.delete(id);
    for (const n of nodes) {
      const s = st(n);
      if (n.down && s.downAt === null) s.downAt = t;
      if (!n.down) s.downAt = null;
      s.drops = 0;
    }

    const tick = newTick();
    const edgeNow = new Map();

    const isDb = (n) => n.type === "db" || n.type === "replica";
    const looksHealthy = (n) => !n.down || t - st(n).downAt < HEALTH_CHECK;

    function forward(from, to, type, a, l, extra) {
      if (a <= 1e-9) return;
      const s = st(to);
      s.inc[type].a += a;
      s.inc[type].l += l + a * extra;
      const key = `${from.id}>${to.id}`;
      let f = edgeNow.get(key);
      if (!f) edgeNow.set(key, (f = { static: 0, read: 0, write: 0, job: 0 }));
      f[type === "probe" ? "read" : type] += a;
    }
    function split(from, targets, type, a, l, extra) {
      const share = 1 / targets.length;
      for (const to of targets) forward(from, to, type, a * share, l * share, extra);
    }
    function complete(type, a, l) {
      if (a <= 0) return;
      if (type === "job") tick.jobsDone += a;
      else if (USER_TYPES.has(type)) {
        tick.done += a;
        tick.lat += l;
      }
    }
    function fail(node, type, a, reason) {
      if (a <= 1e-9 || type === "probe") return;
      st(node).drops += a;
      if (type === "job") tick.jobsFailed += a;
      else tick.failed += a;
      const key = `${node.id}|${reason}`;
      tick.reasons.set(key, (tick.reasons.get(key) || 0) + a);
    }

    // ---- what each component does with requests it has finished working on ----
    function route(n, type, a, l) {
      const ks = kids.get(n.id);
      const label = KINDS[n.type].label;
      switch (n.type) {
        case "cdn": {
          let rest = a;
          let restL = l;
          if (type === "static") {
            const hit = hitRateOf(n);
            complete("static", a * hit, l * hit);
            rest = a * (1 - hit);
            restL = l * (1 - hit);
          }
          if (ks.length) split(n, ks, type, rest, restL, NET.edgeToOrigin);
          else fail(n, type, rest, "CDN has no origin server behind it");
          return;
        }
        case "lb": {
          const ok = ks.filter(looksHealthy);
          if (ok.length) split(n, ok, type, a, l, NET.internal);
          else fail(n, type, a, ks.length ? "Load balancer has no healthy servers left" : "Load balancer isn't connected to any servers");
          return;
        }
        case "server": {
          if (type === "static") return complete("static", a, l);
          if (type === "read") return serverRead(n, ks, a, l);
          if (type === "write" || type === "job") return serverWrite(n, ks, type, a, l);
          return;
        }
        case "cache": {
          if (type === "probe") return;
          if (type !== "read") return fail(n, type, a, "Caches only answer reads");
          const dbs = ks.filter(isDb);
          if (!dbs.length) return complete("read", a, l); // the server already split hits and misses
          const hit = hitRateOf(n);
          complete("read", a * hit, l * hit);
          split(n, dbs, "read", a * (1 - hit), l * (1 - hit), NET.internal);
          return;
        }
        case "db":
          if (type !== "probe") complete(type, a, l);
          return;
        case "replica":
          if (type === "read") complete("read", a, l);
          else if (type !== "probe") fail(n, type, a, "Read replicas can't take writes");
          return;
        case "worker": {
          const dbs = ks.filter((k) => k.type === "db");
          if (dbs.length) split(n, dbs, "job", a, l, NET.internal);
          else fail(n, "job", a, "Worker has no database to write to");
          return;
        }
        default:
          fail(n, type, a, `${label} can't handle this`);
      }
    }

    function serverRead(n, ks, a, l) {
      const caches = ks.filter((k) => k.type === "cache");
      const dbs = ks.filter(isDb);
      if (caches.length) {
        const per = a / caches.length;
        const perL = l / caches.length;
        for (const c of caches) {
          const readThrough = kids.get(c.id).some(isDb);
          if (readThrough || c.down) {
            forward(n, c, "read", per, perL, NET.internal);
            continue;
          }
          // Cache-aside: ask the cache, and on a miss ask the database ourselves.
          const hit = hitRateOf(c);
          forward(n, c, "read", per * hit, perL * hit, NET.internal);
          const miss = per * (1 - hit);
          forward(n, c, "probe", miss, 0, 0);
          if (dbs.length) split(n, dbs, "read", miss, perL * (1 - hit), NET.internal + KINDS.cache.lat + NET.internal);
          else fail(n, "read", miss, "Cache missed and the server has no database to ask");
        }
        return;
      }
      if (dbs.length) split(n, dbs, "read", a, l, NET.internal);
      else fail(n, "read", a, "App server has no database to read from");
    }

    function serverWrite(n, ks, type, a, l) {
      const queues = ks.filter((k) => k.type === "queue");
      if (queues.length) return split(n, queues, type, a, l, NET.internal);
      const dbs = ks.filter((k) => k.type === "db");
      if (dbs.length) return split(n, dbs, type, a, l, NET.internal);
      fail(n, type, a, ks.some((k) => k.type === "replica") ? "Read replicas can't take writes, so connect a Database" : "App server has no database to write to");
    }

    // ---- per-component processing ----
    function emitUsers(u) {
      const rps = trafficAt(traffic, t);
      tick.rps += rps;
      const amount = rps * DT;
      const stat = amount * (traffic.statics || 0);
      const write = (amount - stat) * (traffic.writes || 0);
      const read = amount - stat - write;
      const ks = kids.get(u.id);
      const cdns = ks.filter((k) => k.type === "cdn");
      const others = ks.filter((k) => k.type !== "cdn");
      const send = (type, a) => {
        if (a <= 0) return;
        const viaCdn = type === "static" ? cdns.length > 0 : others.length === 0;
        const targets = viaCdn ? cdns : others;
        if (!targets.length) return fail(u, type, a, "Users aren't connected to anything yet");
        split(u, targets, type, a, 0, viaCdn ? NET.toEdge : NET.toOrigin);
      };
      send("static", stat);
      send("read", read);
      send("write", write);
      const s = st(u);
      s.inRate = rps;
    }

    function processQueue(n) {
      const s = st(n);
      const k = KINDS.queue;
      let arrivals = 0;
      for (const type of TYPES) {
        const { a, l } = s.inc[type];
        s.inc[type] = { a: 0, l: 0 };
        if (a <= 0) continue;
        arrivals += a;
        if (n.down) {
          fail(n, type, a, "Queue is down");
          continue;
        }
        if (type !== "write" && type !== "job") {
          fail(n, type, a, "Queues only take writes");
          continue;
        }
        const accept = Math.min(a, Math.max(0, k.maxBacklog - s.jobs));
        s.jobs += accept;
        if (type === "write") complete("write", accept, l * (accept / a) + accept * k.lat);
        fail(n, type, a - accept, "Queue is full, so writes are rejected");
      }
      s.inRate = arrivals / DT;
      s.util = s.inRate / k.cap;
      s.lat = k.lat;
      if (!n.down) {
        const workers = kids.get(n.id).filter((w) => w.type === "worker" && !w.down);
        const capSum = workers.reduce((sum, w) => sum + capacityOf(w) * DT, 0);
        const pull = Math.min(s.jobs, capSum);
        for (const w of workers) forward(n, w, "job", (pull * capacityOf(w) * DT) / capSum, 0, NET.internal);
        s.jobs -= pull;
      }
      s.backlog = s.jobs;
    }

    function processNode(n) {
      const s = st(n);
      const k = KINDS[n.type];
      const C = capacityOf(n);

      // A database shares incoming reads with its read replicas, by capacity.
      if (n.type === "db" && !n.down && s.inc.read.a > 0) {
        const reps = kids.get(n.id).filter((r) => r.type === "replica" && looksHealthy(r));
        if (reps.length) {
          const totalCap = C + reps.reduce((sum, r) => sum + capacityOf(r), 0);
          const { a, l } = s.inc.read;
          for (const r of reps) {
            const share = capacityOf(r) / totalCap;
            forward(n, r, "read", a * share, l * share, NET.internal);
          }
          s.inc.read = { a: (a * C) / totalCap, l: (l * C) / totalCap };
        }
      }

      const weight = (type) => (isDb(n) && (type === "write" || type === "job") ? 2 : 1);
      let arrivals = 0;
      let arrivalLoad = 0;
      for (const type of TYPES) {
        const inc = s.inc[type];
        arrivals += inc.a;
        arrivalLoad += inc.a * weight(type);
        s.back[type].a += inc.a;
        s.back[type].l += inc.l;
        s.inc[type] = { a: 0, l: 0 };
      }
      s.inRate = arrivals / DT;

      if (n.down) {
        for (const type of TYPES) {
          fail(n, type, s.back[type].a, `${k.label} is down`);
          s.back[type] = { a: 0, l: 0 };
        }
        s.util = 0;
        s.prevLoad = 0;
        s.backlog = 0;
        s.lat = 0;
        return;
      }

      let load = 0;
      for (const type of TYPES) load += s.back[type].a * weight(type);
      const f = load > 0 ? Math.min(1, (C * DT) / load) : 1;
      const util = arrivalLoad / DT / C;
      const u = Math.min(util, 0.95);
      const waitMs = (s.prevLoad / C) * 1000;
      const nodeLat = k.lat * (1 + (0.6 * u) / (1 - u)) + waitMs;

      for (const type of TYPES) {
        const b = s.back[type];
        const pa = b.a * f;
        const pl = b.l * f;
        b.a -= pa;
        b.l -= pl;
        if (pa > 1e-9) route(n, type, pa, pl + pa * nodeLat);
      }

      // Anything that has waited too long times out.
      let rest = 0;
      for (const type of TYPES) rest += s.back[type].a * weight(type);
      const maxLoad = C * TIMEOUT;
      if (rest > maxLoad) {
        const d = (rest - maxLoad) / rest;
        for (const type of TYPES) {
          const b = s.back[type];
          fail(n, type, b.a * d, `${k.label} is overloaded, so requests time out`);
          b.a *= 1 - d;
          b.l *= 1 - d;
        }
        rest = maxLoad;
      }
      s.prevLoad = rest;
      s.util = util;
      s.lat = nodeLat;
      s.backlog = TYPES.reduce((sum, type) => sum + s.back[type].a, 0);
    }

    for (const n of topoOrder(nodes, kids)) {
      if (n.type === "users") emitUsers(n);
      else if (n.type === "queue") processQueue(n);
      else processNode(n);
    }

    for (const n of nodes) {
      const s = st(n);
      s.utilS = s.utilS * 0.75 + (n.down ? 0 : s.util) * 0.25;
    }

    // Smoothed per-edge flow for the animation.
    const seen = new Set();
    for (const [key, f] of edgeNow) {
      seen.add(key);
      const r = edgeRate.get(key) || { static: 0, read: 0, write: 0, job: 0, total: 0 };
      let tot = 0;
      for (const type of ["static", "read", "write", "job"]) {
        r[type] = r[type] * 0.7 + (f[type] / DT) * 0.3;
        tot += r[type];
      }
      r.total = tot;
      edgeRate.set(key, r);
    }
    for (const [key, r] of edgeRate) {
      if (seen.has(key)) continue;
      for (const type of ["static", "read", "write", "job"]) r[type] *= 0.7;
      r.total = r.static + r.read + r.write + r.job;
      if (r.total < 0.01) edgeRate.delete(key);
    }

    window.push(tick);
    if (window.length > WINDOW) window.shift();
    for (const key of ["done", "lat", "failed", "jobsDone", "jobsFailed"]) total[key] += tick[key];
    totalTime += DT;
  }

  function metrics() {
    let done = 0, lat = 0, failed = 0, rps = 0, jobsFailed = 0;
    const reasons = new Map();
    for (const tk of window) {
      done += tk.done;
      lat += tk.lat;
      failed += tk.failed;
      rps += tk.rps;
      jobsFailed += tk.jobsFailed;
      for (const [k, v] of tk.reasons) reasons.set(k, (reasons.get(k) || 0) + v);
    }
    const secs = Math.max(window.length * DT, DT);
    let jobsBacklog = 0;
    for (const n of design.nodes) if (n.type === "queue") jobsBacklog += st(n).jobs;
    return {
      throughput: done / secs,
      offered: rps / Math.max(window.length, 1),
      latency: done > 0 ? lat / done : 0,
      errorRate: done + failed > 0 ? failed / (done + failed) : 0,
      failedPerSec: failed / secs,
      jobsFailedPerSec: jobsFailed / secs,
      jobsBacklog,
      cost: costTotal(design),
      reasons: [...reasons].map(([k, amount]) => {
        const i = k.indexOf("|");
        return { node: k.slice(0, i), reason: k.slice(i + 1), perSec: amount / secs };
      }).sort((a, b) => b.perSec - a.perSec),
    };
  }

  // Totals since the last reset(), used to grade challenges.
  function totals() {
    return {
      seconds: totalTime,
      latency: total.done > 0 ? total.lat / total.done : 0,
      errorRate: total.done + total.failed > 0 ? total.failed / (total.done + total.failed) : 0,
      done: total.done,
      failed: total.failed,
      jobsDone: total.jobsDone,
      jobsFailed: total.jobsFailed,
    };
  }

  function resetTotals() {
    total = newTick();
    totalTime = 0;
  }

  function reset() {
    state.clear();
    edgeRate.clear();
    window = [];
    resetTotals();
    t = 0;
  }

  return {
    design,
    step,
    metrics,
    totals,
    resetTotals,
    reset,
    nodeState: (id) => state.get(id),
    edgeRate: (from, to) => edgeRate.get(`${from}>${to}`),
    get time() {
      return t;
    },
  };
}

export function costTotal(design) {
  return design.nodes.reduce((sum, n) => sum + costOf(n), 0);
}

// Kahn's algorithm; anything stuck in a cycle goes last (its input arrives next tick).
export function topoOrder(nodes, kids) {
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const n of nodes) for (const k of kids.get(n.id)) indeg.set(k.id, indeg.get(k.id) + 1);
  const ready = nodes.filter((n) => indeg.get(n.id) === 0);
  const out = [];
  const done = new Set();
  while (ready.length) {
    const n = ready.shift();
    out.push(n);
    done.add(n.id);
    for (const k of kids.get(n.id)) {
      indeg.set(k.id, indeg.get(k.id) - 1);
      if (indeg.get(k.id) === 0) ready.push(k);
    }
  }
  for (const n of nodes) if (!done.has(n.id)) out.push(n);
  return out;
}
