import { test } from "node:test";
import assert from "node:assert/strict";
import { CHALLENGES, designFor, evaluate } from "../js/challenges.js";

const byId = Object.fromEntries(CHALLENGES.map((c) => [c.id, c]));
const node = (id, type, extra = {}) => ({ id, type, x: 0, y: 0, ...extra });
const edge = (from, to) => ({ id: `${from}-${to}`, from, to });

function servers(count, size, prefix = "s") {
  return Array.from({ length: count }, (_, i) => node(`${prefix}${i}`, "server", { size }));
}

// One working answer for every level, so we know each level is actually solvable.
const SOLUTIONS = {
  "first-site"(d) {
    d.nodes.push(node("db", "db"));
    d.edges.push(edge("users", "app"), edge("app", "db"));
  },
  viral(d) {
    d.nodes = d.nodes.filter((x) => x.id !== "app");
    d.edges = [];
    const ss = servers(3, "M");
    d.nodes.push(node("lb", "lb"), ...ss);
    d.edges.push(edge("users", "lb"), ...ss.map((s) => edge("lb", s.id)), ...ss.map((s) => edge(s.id, "db")));
  },
  "db-fire"(d) {
    d.nodes.push(node("cache", "cache"));
    d.edges.push(...["app1", "app2", "app3", "app4"].map((s) => edge(s, "cache")), edge("cache", "db"));
  },
  crash(d) {
    d.nodes = d.nodes.filter((x) => x.id !== "app");
    d.edges = [];
    const ss = servers(4, "M");
    d.nodes.push(node("lb", "lb"), ...ss);
    d.edges.push(edge("users", "lb"), ...ss.map((s) => edge("lb", s.id)), ...ss.map((s) => edge(s.id, "db")));
  },
  "flash-sale"(d) {
    d.nodes.push(node("q", "queue"), node("w1", "worker"), node("w2", "worker"));
    d.edges.push(...["app1", "app2", "app3", "app4"].map((s) => edge(s, "q")), edge("q", "w1"), edge("q", "w2"), edge("w1", "db"), edge("w2", "db"));
  },
  "big-sale"(d) {
    const ss = servers(12, "M");
    d.nodes.push(node("cdn", "cdn"), node("lb", "lb"), ...ss, node("cache", "cache"), node("db", "db", { size: "L" }));
    d.edges.push(edge("users", "cdn"), edge("users", "lb"), edge("cdn", "lb"), ...ss.map((s) => edge("lb", s.id)), ...ss.map((s) => edge(s.id, "cache")), ...ss.map((s) => edge(s.id, "db")), edge("cache", "db"));
  },
};

for (const ch of CHALLENGES) {
  test(`${ch.title}: the starting design fails`, () => {
    const r = evaluate(designFor(ch), ch);
    assert.equal(r.pass, false, JSON.stringify(r.checks));
  });

  test(`${ch.title}: a correct design passes`, () => {
    const d = designFor(ch);
    SOLUTIONS[ch.id](d);
    const r = evaluate(d, ch);
    assert.equal(r.pass, true, JSON.stringify(r.checks.map((c) => [c.id, +c.value.toFixed(4), c.target])));
  });
}

// The "obvious but wrong" answers each level is designed to teach against.
test("viral: one big server is not enough", () => {
  const ch = byId.viral;
  const d = designFor(ch);
  d.nodes.find((x) => x.id === "app").size = "L";
  assert.equal(evaluate(d, ch).pass, false);
});

test("db-fire: a bigger database alone is not enough", () => {
  const ch = byId["db-fire"];
  const d = designFor(ch);
  d.nodes.find((x) => x.id === "db").size = "L";
  assert.equal(evaluate(d, ch).pass, false);
});

test("crash: two large servers are not N+1", () => {
  const ch = byId.crash;
  const d = designFor(ch);
  SOLUTIONS.crash(d);
  d.nodes = d.nodes.filter((x) => !["s2", "s3"].includes(x.id));
  d.edges = d.edges.filter((x) => !["s2", "s3"].includes(x.to) && !["s2", "s3"].includes(x.from));
  for (const x of d.nodes) if (x.type === "server") x.size = "L";
  const r = evaluate(d, ch);
  assert.equal(r.pass, false);
  assert.ok(r.killed, "a server was killed");
});

test("big-sale: without a CDN it can't fit the budget", () => {
  const ch = byId["big-sale"];
  const d = designFor(ch);
  SOLUTIONS["big-sale"](d);
  d.nodes = d.nodes.filter((x) => x.type !== "cdn");
  d.edges = d.edges.filter((x) => x.from !== "cdn" && x.to !== "cdn");
  assert.equal(evaluate(d, ch).pass, false);
});
