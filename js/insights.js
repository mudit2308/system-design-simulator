// Turns raw simulation numbers into plain-English explanations and advice.

import { KINDS } from "./components.js";
import { HEALTH_CHECK } from "./engine.js";

export function displayNames(nodes, field = "label") {
  const counts = {};
  for (const n of nodes) counts[n.type] = (counts[n.type] || 0) + 1;
  const seen = {};
  const names = new Map();
  for (const n of nodes) {
    seen[n.type] = (seen[n.type] || 0) + 1;
    const base = KINDS[n.type][field];
    names.set(n.id, counts[n.type] > 1 ? `${base} ${seen[n.type]}` : base);
  }
  return names;
}

function overloadAdvice(node, sim, design) {
  switch (node.type) {
    case "server":
      return "Add more App Servers behind a Load Balancer (scale out), or pick a bigger size (scale up).";
    case "db": {
      const s = sim.nodeState(node.id);
      const reads = s ? s.back.read.a + 1 : 1;
      const writes = s ? (s.back.write.a + s.back.job.a) * 2 : 0;
      return reads >= writes
        ? "Most of its work is reads. Add a Cache in front, or Read Replicas behind it."
        : "Most of its work is writes. Put a Message Queue + Workers in front, or use a bigger size.";
    }
    case "replica":
      return "Add another Read Replica, or a Cache so fewer reads get this far.";
    case "lb":
      return "Even load balancers have limits. Split traffic across two of them.";
    case "cache":
      return "Add a second Cache.";
    case "worker":
      return "Add more Workers.";
    case "cdn":
      return "That's a lot of traffic. Add a second CDN.";
    default:
      return "";
  }
}

// Returns up to `limit` items: { level: "bad" | "warn" | "good" | "info", icon, title, text }
export function insights(design, sim, opts = {}) {
  const limit = opts.limit ?? 4;
  const m = sim.metrics();
  const names = displayNames(design.nodes);
  const byId = new Map(design.nodes.map((n) => [n.id, n]));
  const out = [];
  const seenNodes = new Set();

  // 1. Why requests are failing, worst first. Same problem on several copies = one message.
  const groups = new Map();
  for (const r of m.reasons) {
    if (r.perSec < Math.max(0.5, m.offered * 0.002)) continue;
    const node = byId.get(r.node);
    if (!node) continue;
    const kind = r.reason.includes("overloaded") ? "overloaded" : r.reason.includes("is down") ? "down" : r.reason;
    const key = `${node.type}|${kind}`;
    const g = groups.get(key) || { node, kind, reason: r.reason, nodes: [], perSec: 0 };
    if (!g.nodes.includes(node)) g.nodes.push(node);
    g.perSec += r.perSec;
    groups.set(key, g);
  }
  for (const g of [...groups.values()].sort((a, b) => b.perSec - a.perSec)) {
    const { node, kind } = g;
    for (const x of g.nodes) seenNodes.add(x.id);
    const many = g.nodes.length > 1;
    const name = many ? `${g.nodes.length} ${KINDS[node.type].label}s` : names.get(node.id);
    const n = Math.round(g.perSec).toLocaleString("en-US");
    if (kind === "overloaded") {
      out.push({ level: "bad", icon: "🔥", title: `${name} ${many ? "are" : "is"} overloaded`, text: `${n} requests/s are timing out. ${overloadAdvice(node, sim, design)}` });
    } else if (kind === "down") {
      const parents = design.edges.filter((e) => e.to === node.id).map((e) => byId.get(e.from));
      const behindLb = parents.some((p) => p && p.type === "lb");
      out.push({
        level: "bad",
        icon: "💥",
        title: `${name} ${many ? "are" : "is"} down`,
        text: behindLb
          ? `Requests sent to it fail until the load balancer's health check notices (about ${HEALTH_CHECK}s).`
          : `Everything sent to it fails. It's a single point of failure. Put 2+ of them behind a Load Balancer.`,
      });
    } else {
      out.push({ level: "bad", icon: "⛔", title: g.reason, text: `${n} requests/s fail at ${name}.` });
    }
  }

  // 2. A load balancer successfully routing around a dead server.
  for (const n of design.nodes) {
    if (!n.down || seenNodes.has(n.id)) continue;
    const parents = design.edges.filter((e) => e.to === n.id).map((e) => byId.get(e.from));
    if (parents.some((p) => p && p.type === "lb")) {
      out.push({ level: "good", icon: "🛡️", title: `Load balancer routed around ${names.get(n.id)}`, text: "Its health check noticed the crash and the other servers took over. That's redundancy working." });
    } else {
      out.push({ level: "bad", icon: "💥", title: `${names.get(n.id)} is down`, text: "Revive it, or design so one failure doesn't matter." });
    }
    seenNodes.add(n.id);
  }

  // 3. Components close to their limit.
  const hot = design.nodes
    .filter((n) => !n.down && !seenNodes.has(n.id) && n.type !== "users" && n.type !== "queue")
    .map((n) => ({ n, u: sim.nodeState(n.id)?.utilS || 0 }))
    .filter((x) => x.u >= 0.8)
    .sort((a, b) => b.u - a.u);
  const hotTypes = new Map();
  for (const h of hot) if (!hotTypes.has(h.n.type)) hotTypes.set(h.n.type, hot.filter((x) => x.n.type === h.n.type));
  for (const list of [...hotTypes.values()].slice(0, 2)) {
    const { n, u } = list[0];
    const title = list.length > 1 ? `${list.length} ${KINDS[n.type].label}s are at ${Math.round(u * 100)}%` : `${names.get(n.id)} is at ${Math.round(u * 100)}%`;
    out.push({ level: "warn", icon: "🌡️", title, text: `Response time climbs steeply as anything nears 100%. ${overloadAdvice(n, sim, design)}` });
  }

  // 4. Queue backlog.
  for (const n of design.nodes) {
    if (n.type !== "queue") continue;
    const s = sim.nodeState(n.id);
    if (!s || s.backlog < 500) continue;
    const workers = design.edges.filter((e) => e.from === n.id).length;
    out.push({
      level: workers ? "warn" : "bad",
      icon: "📬",
      title: `${Math.round(s.backlog).toLocaleString("en-US")} jobs waiting in the queue`,
      text: workers ? "Writes are accepted instantly, but workers are behind. That's fine for a spike. If it keeps growing, add a Worker." : "Nothing is taking jobs off the queue. Connect it to a Worker, and the Worker to a Database.",
    });
  }

  // 5. Static files without a CDN.
  const t = design.traffic;
  if ((t.statics || 0) >= 0.2 && !design.nodes.some((n) => n.type === "cdn") && m.throughput > 0) {
    out.push({ level: "info", icon: "🌍", title: `${Math.round(t.statics * 100)}% of requests are static files`, text: "Images, CSS and JS are hitting your servers. A CDN would answer them from close to the user, faster and cheaper." });
  }

  // 6. Slow but working.
  if (m.latency > 400 && m.errorRate < 0.01) {
    out.push({ level: "warn", icon: "🐢", title: `Responses take ${Math.round(m.latency)} ms`, text: "Nothing is failing yet, but users feel anything over ~300 ms. Something is queueing." });
  }

  if (!out.length && m.throughput > 0) {
    out.push({
      level: "good",
      icon: "✅",
      title: "Everything is healthy",
      text: opts.sandbox ? "All components are under 80%. Push the traffic slider up and find the first thing that breaks." : "No failures and nothing close to its limit.",
    });
  }
  if (!out.length) {
    out.push({ level: "info", icon: "💡", title: "No traffic is being served yet", text: "Connect Users to a server, and the server to a database." });
  }
  return out.slice(0, limit);
}
