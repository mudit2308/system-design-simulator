import { test } from "node:test";
import assert from "node:assert/strict";
import { createSim, topoOrder, trafficAt, costTotal, HEALTH_CHECK } from "../js/engine.js";
import { insights } from "../js/insights.js";

const node = (id, type, extra = {}) => ({ id, type, x: 0, y: 0, ...extra });
const edge = (from, to) => ({ id: `${from}-${to}`, from, to });
const traffic = (rps, extra = {}) => ({ rps, pattern: "steady", writes: 0, statics: 0, ...extra });

function run(design, seconds = 10) {
  const sim = createSim(design);
  for (let i = 0; i < 30; i++) sim.step(); // warm up
  sim.resetTotals();
  for (let i = 0; i < seconds * 10; i++) sim.step();
  return sim;
}

const near = (actual, expected, tolerance, msg) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${msg ?? ""} expected ${expected} ± ${tolerance}, got ${actual}`);

test("a simple chain serves everything with no errors", () => {
  const sim = run({ nodes: [node("u", "users"), node("s", "server"), node("d", "db")], edges: [edge("u", "s"), edge("s", "d")], traffic: traffic(300, { writes: 0.2 }) });
  const t = sim.totals();
  assert.equal(t.errorRate, 0);
  near(t.done / t.seconds, 300, 1, "throughput");
  // 60 ms internet + ~30 ms server + ~13 ms database
  assert.ok(t.latency > 95 && t.latency < 130, `latency ${t.latency}`);
});

test("users connected to nothing fail with a clear reason", () => {
  const sim = run({ nodes: [node("u", "users")], edges: [], traffic: traffic(100) });
  assert.equal(sim.totals().errorRate, 1);
  assert.match(sim.metrics().reasons[0].reason, /aren't connected/);
});

test("an overloaded server times requests out and latency explodes", () => {
  const sim = run({ nodes: [node("u", "users"), node("s", "server"), node("d", "db", { size: "L" })], edges: [edge("u", "s"), edge("s", "d")], traffic: traffic(2000) });
  const t = sim.totals();
  near(t.errorRate, 0.5, 0.02, "half the traffic is over capacity");
  assert.ok(t.latency > 1500, `latency ${t.latency}`);
  assert.match(sim.metrics().reasons[0].reason, /overloaded/);
});

test("a load balancer splits traffic evenly", () => {
  const d = {
    nodes: [node("u", "users"), node("lb", "lb"), node("a", "server"), node("b", "server"), node("c", "server"), node("d", "db", { size: "L" })],
    edges: [edge("u", "lb"), edge("lb", "a"), edge("lb", "b"), edge("lb", "c"), edge("a", "d"), edge("b", "d"), edge("c", "d")],
    traffic: traffic(2400),
  };
  const sim = run(d);
  for (const id of ["a", "b", "c"]) near(sim.nodeState(id).inRate, 800, 1, id);
  assert.equal(sim.totals().errorRate, 0);
});

test("a read-through cache sends only misses to the database", () => {
  const d = {
    nodes: [node("u", "users"), node("s", "server"), node("c", "cache"), node("d", "db")],
    edges: [edge("u", "s"), edge("s", "c"), edge("c", "d")],
    traffic: traffic(1000),
  };
  const sim = run(d);
  near(sim.nodeState("d").inRate, 200, 1, "80% hit rate");
  d.nodes[2].hit = 0.95;
  near(run(d).nodeState("d").inRate, 50, 1, "95% hit rate");
});

test("a cache-aside setup (server talks to both) behaves the same", () => {
  const d = {
    nodes: [node("u", "users"), node("s", "server"), node("c", "cache"), node("d", "db")],
    edges: [edge("u", "s"), edge("s", "c"), edge("s", "d")],
    traffic: traffic(1000),
  };
  const sim = run(d);
  near(sim.nodeState("d").inRate, 200, 1);
  near(sim.nodeState("c").inRate, 1000, 1, "every read checks the cache first");
  assert.equal(sim.totals().errorRate, 0);
});

test("read replicas share reads by capacity, and writes stay on the primary", () => {
  const d = {
    nodes: [node("u", "users"), node("s", "server", { size: "L" }), node("d", "db"), node("r1", "replica"), node("r2", "replica")],
    edges: [edge("u", "s"), edge("s", "d"), edge("d", "r1"), edge("d", "r2")],
    traffic: traffic(1500, { writes: 0.2 }),
  };
  const sim = run(d);
  near(sim.nodeState("r1").inRate, 400, 1, "a third of the 1,200 reads");
  near(sim.nodeState("d").inRate, 400 + 300, 1, "its share of reads plus all 300 writes");
  assert.equal(sim.totals().errorRate, 0);
});

test("a server that only knows a replica can't write", () => {
  const d = { nodes: [node("u", "users"), node("s", "server"), node("r", "replica")], edges: [edge("u", "s"), edge("s", "r")], traffic: traffic(100, { writes: 0.5 }) };
  const sim = run(d);
  near(sim.totals().errorRate, 0.5, 0.001);
  assert.match(sim.metrics().reasons[0].reason, /replicas can't take writes/i);
});

test("a queue answers writes fast and workers drain it at their own pace", () => {
  const d = {
    nodes: [node("u", "users"), node("s", "server", { size: "L" }), node("q", "queue"), node("w", "worker"), node("d", "db")],
    edges: [edge("u", "s"), edge("s", "q"), edge("q", "w"), edge("w", "d")],
    traffic: traffic(1000, { writes: 1 }),
  };
  const sim = run(d, 10);
  const t = sim.totals();
  assert.equal(t.errorRate, 0);
  assert.ok(t.latency < 120, `writes are acknowledged quickly (${t.latency} ms)`);
  near(t.jobsDone / t.seconds, 600, 5, "one worker = 600 jobs/s");
  assert.ok(sim.nodeState("q").backlog > 3500, "the other 400/s pile up in the queue");

  d.nodes.push(node("w2", "worker"));
  d.edges.push(edge("q", "w2"), edge("w2", "d"));
  for (let i = 0; i < 300; i++) sim.step();
  assert.ok(sim.nodeState("q").backlog < 1, "two workers clear the backlog");
});

test("a CDN answers 95% of static requests", () => {
  const d = {
    nodes: [node("u", "users"), node("cdn", "cdn"), node("s", "server"), node("d", "db")],
    edges: [edge("u", "cdn"), edge("u", "s"), edge("cdn", "s"), edge("s", "d")],
    traffic: traffic(1000, { statics: 0.5 }),
  };
  const sim = run(d);
  near(sim.nodeState("cdn").inRate, 500, 1);
  near(sim.nodeState("s").inRate, 500 + 25, 1, "dynamic traffic plus 5% CDN misses");
  assert.equal(sim.totals().errorRate, 0);
});

test("a load balancer stops sending to a dead server after its health check", () => {
  const d = {
    nodes: [node("u", "users"), node("lb", "lb"), node("a", "server"), node("b", "server"), node("d", "db")],
    edges: [edge("u", "lb"), edge("lb", "a"), edge("lb", "b"), edge("a", "d"), edge("b", "d")],
    traffic: traffic(800),
  };
  const sim = run(d, 2);
  d.nodes[2].down = true;
  sim.resetTotals();
  for (let i = 0; i < HEALTH_CHECK * 10; i++) sim.step();
  near(sim.totals().errorRate, 0.5, 0.01, "before detection, half the traffic hits the dead server");
  sim.resetTotals();
  for (let i = 0; i < 20; i++) sim.step();
  assert.equal(sim.totals().errorRate, 0, "after detection, the survivor takes everything");
  near(sim.nodeState("b").inRate, 800, 1);
});

test("without a load balancer, a dead server takes its share down for good", () => {
  const d = { nodes: [node("u", "users"), node("a", "server", { down: true }), node("d", "db")], edges: [edge("u", "a"), edge("a", "d")], traffic: traffic(100) };
  assert.equal(run(d).totals().errorRate, 1);
});

test("traffic patterns", () => {
  assert.equal(trafficAt(traffic(100), 3), 100);
  near(trafficAt({ rps: 100, pattern: "wave" }, 5), 150, 0.001);
  assert.equal(trafficAt({ rps: 100, pattern: "spikes", spike: 5 }, 6), 500);
  assert.equal(trafficAt({ rps: 100, pattern: "spikes", spike: 5 }, 9), 100);
});

test("cost adds up the monthly price of every component", () => {
  assert.equal(costTotal({ nodes: [node("u", "users"), node("s", "server", { size: "L" }), node("d", "db", { size: "S" }), node("c", "cache")] }), 170 + 70 + 60);
});

test("cycles don't crash the simulation", () => {
  const nodes = [node("u", "users"), node("a", "lb"), node("b", "lb"), node("s", "server"), node("d", "db")];
  const edges = [edge("u", "a"), edge("a", "b"), edge("b", "a"), edge("b", "s"), edge("s", "d")];
  const kids = new Map(nodes.map((n) => [n.id, edges.filter((e) => e.from === n.id).map((e) => nodes.find((x) => x.id === e.to))]));
  assert.equal(topoOrder(nodes, kids).length, nodes.length);
  const sim = run({ nodes, edges, traffic: traffic(100) }, 2);
  assert.ok(Number.isFinite(sim.metrics().latency));
});

test("insights explain overloads in plain English and group copies", () => {
  const d = {
    nodes: [node("u", "users"), node("lb", "lb"), node("a", "server"), node("b", "server"), node("d", "db", { size: "L" })],
    edges: [edge("u", "lb"), edge("lb", "a"), edge("lb", "b"), edge("a", "d"), edge("b", "d")],
    traffic: traffic(4000),
  };
  const list = insights(d, run(d, 3));
  assert.equal(list[0].title, "2 App Servers are overloaded");
  assert.match(list[0].text, /scale out/);
});
