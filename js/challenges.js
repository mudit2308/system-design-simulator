// Six levels, each teaching one system design idea. A level is graded by running the
// simulation for 20 seconds (after a 3 second warm-up) and checking the goals.

import { createSim, costTotal } from "./engine.js";

export const WARMUP = 3;
export const DURATION = 20;

const n = (id, type, x, y, extra = {}) => ({ id, type, x, y, ...extra });
const e = (from, to) => ({ id: `${from}-${to}`, from, to });

export const CHALLENGES = [
  {
    id: "first-site",
    title: "Your first website",
    concept: "Client → Server → Database",
    story: "You just launched a small app. 200 people a second are visiting, but nothing is connected yet, so every request fails.",
    task: "Add a Database, then drag from each component's ● handle to connect Users → App Server → Database.",
    hint: "Drag the Database from the left panel. Then drag from the dot on the right edge of Users onto the App Server, and from the App Server onto the Database.",
    lesson: "Every web app starts like this: a client talks to a server, and the server keeps data in a database. Everything else in system design exists to help this simple chain survive more traffic.",
    traffic: { rps: 200, pattern: "steady", writes: 0.2, statics: 0.1 },
    goals: { latency: 200, errors: 0.01, budget: 300 },
    start: {
      nodes: [n("users", "users", 200, 330), n("app", "server", 560, 330)],
      edges: [],
    },
  },
  {
    id: "viral",
    title: "You went viral",
    concept: "Horizontal scaling",
    story: "A big creator shared your app. Traffic jumped to 2,500 requests a second, and one server can only handle 1,000. Users are getting timeouts.",
    task: "Put a Load Balancer in front and spread the traffic across more App Servers.",
    hint: "Users → Load Balancer → 3 App Servers, and connect every server to the Database. Even the largest server (2,000 req/s) can't do this alone.",
    lesson: "Scaling up (a bigger machine) has a ceiling. Scaling out (more machines behind a load balancer) keeps going, and it's how almost every large site grows.",
    traffic: { rps: 2500, pattern: "steady", writes: 0.1, statics: 0.1 },
    goals: { latency: 250, errors: 0.01, budget: 700 },
    start: {
      nodes: [n("users", "users", 130, 330), n("app", "server", 480, 330), n("db", "db", 830, 330, { size: "L" })],
      edges: [e("users", "app"), e("app", "db")],
    },
  },
  {
    id: "db-fire",
    title: "The database is on fire",
    concept: "Caching",
    story: "You have plenty of servers now, but every page load asks the database the same questions. 6,000 requests a second, 95% of them reads, and the database can do 2,000.",
    task: "Stop the database from melting without blowing the budget.",
    hint: "Add a Cache. Connect every App Server to it, and the Cache to the Database. With an 80% hit rate, only 1 in 5 reads still reaches the database. A bigger database alone won't be enough.",
    lesson: "Reads usually outnumber writes 10 to 1, and most of them ask for the same popular data. A cache in memory answers those in about 2 ms and is far cheaper than more database power.",
    traffic: { rps: 6000, pattern: "steady", writes: 0.05, statics: 0 },
    goals: { latency: 250, errors: 0.01, budget: 1000 },
    start: {
      nodes: [
        n("users", "users", 100, 330),
        n("lb", "lb", 310, 330),
        n("app1", "server", 520, 120, { size: "L" }),
        n("app2", "server", 520, 260, { size: "L" }),
        n("app3", "server", 520, 400, { size: "L" }),
        n("app4", "server", 520, 540, { size: "L" }),
        n("db", "db", 930, 330),
      ],
      edges: [e("users", "lb"), e("lb", "app1"), e("lb", "app2"), e("lb", "app3"), e("lb", "app4"), e("app1", "db"), e("app2", "db"), e("app3", "db"), e("app4", "db")],
    },
  },
  {
    id: "crash",
    title: "Servers crash. Stay up.",
    concept: "Redundancy (N+1)",
    story: "Machines fail. 8 seconds into the test, your busiest App Server will die. Right now that's your only server.",
    task: "Design it so losing any one server doesn't take the site down.",
    hint: "Use a Load Balancer with enough servers that the rest can carry the full 2,000 req/s after one dies. Two big ones won't do it: the survivor would be at 100%. Try four Medium servers.",
    lesson: "Plan for N+1: enough capacity to lose one machine and still be fine. Load balancers health-check servers and route around dead ones, so a few requests fail during the switch-over, then everything recovers.",
    traffic: { rps: 2000, pattern: "steady", writes: 0.1, statics: 0 },
    goals: { latency: 250, errors: 0.05, budget: 800 },
    chaos: { at: 8, kill: "busiest-server" },
    start: {
      nodes: [n("users", "users", 130, 330), n("app", "server", 480, 330, { size: "L" }), n("db", "db", 830, 330, { size: "L" })],
      edges: [e("users", "app"), e("app", "db")],
    },
  },
  {
    id: "flash-sale",
    title: "Flash sale checkout",
    concept: "Message queues",
    story: "Every 10 seconds a flash sale drops and checkouts jump 5×, from 800 to 4,000 a second. 80% are writes (orders), and the database falls over during each spike.",
    task: "Absorb the spikes so customers get a fast \"order placed\" and the database works at a steady pace.",
    hint: "Connect the App Servers to a Message Queue and add 2 Workers that write to the Database. Writes go to the queue, while reads still go straight to the database.",
    lesson: "A queue decouples \"accept the order\" from \"process the order\". Users get an instant reply, and workers drain the backlog at a pace the database can handle. Too many workers would just move the spike back onto the database.",
    traffic: { rps: 800, pattern: "spikes", spike: 5, writes: 0.8, statics: 0 },
    goals: { latency: 250, errors: 0.01, budget: 1200 },
    start: {
      nodes: [
        n("users", "users", 100, 330),
        n("lb", "lb", 310, 330),
        n("app1", "server", 520, 120, { size: "L" }),
        n("app2", "server", 520, 260, { size: "L" }),
        n("app3", "server", 520, 400, { size: "L" }),
        n("app4", "server", 520, 540, { size: "L" }),
        n("db", "db", 1010, 330, { size: "L" }),
      ],
      edges: [e("users", "lb"), e("lb", "app1"), e("lb", "app2"), e("lb", "app3"), e("lb", "app4"), e("app1", "db"), e("app2", "db"), e("app3", "db"), e("app4", "db")],
    },
  },
  {
    id: "big-sale",
    title: "Big Billion Day",
    concept: "Put it all together",
    story: "The biggest sale of the year: 15,000 requests a second. 40% are product images and scripts, 55% are page reads and 5% are orders. You start with nothing but users.",
    task: "Design the whole system from scratch, within budget.",
    hint: "A CDN takes the static files (connect Users → CDN and CDN → Load Balancer for misses). Then a Load Balancer, about a dozen Medium servers, a Cache, and a Database big enough for the misses and orders.",
    lesson: "Real architectures are layers, each one protecting the next: the CDN shields your servers, the load balancer spreads the work, the cache shields the database. You just designed what large e-commerce sites run.",
    traffic: { rps: 15000, pattern: "steady", writes: 0.0833, statics: 0.4 },
    goals: { latency: 250, errors: 0.01, budget: 1500 },
    start: { nodes: [n("users", "users", 90, 330)], edges: [] },
  },
];

export function cloneDesign(d) {
  return JSON.parse(JSON.stringify(d));
}

export function designFor(ch) {
  const d = cloneDesign(ch.start);
  d.traffic = { ...ch.traffic };
  return d;
}

// A graded run. The UI steps it frame by frame, and tests run it to the end at once.
export function createRun(design, ch, sim = createSim(design)) {
  sim.reset();
  for (const node of design.nodes) node.down = false;
  let killed = null;
  let maxCost = costTotal(design);
  let steps = 0;
  const total = Math.round((WARMUP + DURATION) * 10);

  return {
    sim,
    get progress() {
      return steps / total;
    },
    get done() {
      return steps >= total;
    },
    get killed() {
      return killed;
    },
    step() {
      if (steps >= total) return;
      steps++;
      if (ch.chaos && !killed && sim.time + 0.1 >= ch.chaos.at) {
        const servers = design.nodes.filter((x) => x.type === "server" && !x.down);
        if (servers.length) {
          servers.sort((a, b) => (sim.nodeState(b.id)?.inRate || 0) - (sim.nodeState(a.id)?.inRate || 0));
          killed = servers[0];
          killed.down = true;
        }
      }
      sim.step();
      if (steps === Math.round(WARMUP * 10)) sim.resetTotals();
      maxCost = Math.max(maxCost, costTotal(design));
    },
    result() {
      return grade(ch, sim.totals(), maxCost);
    },
  };
}

export function grade(ch, totals, cost) {
  const g = ch.goals;
  const checks = [
    { id: "latency", label: "Average response time", value: totals.latency, target: g.latency, pass: totals.latency > 0 && totals.latency <= g.latency },
    { id: "errors", label: "Failed requests", value: totals.errorRate, target: g.errors, pass: totals.done > 0 && totals.errorRate <= g.errors },
    { id: "budget", label: "Monthly cost", value: cost, target: g.budget, pass: cost <= g.budget },
  ];
  const pass = checks.every((c) => c.pass);
  let stars = 0;
  if (pass) {
    stars = 1;
    if (cost <= g.budget * 0.85) stars++;
    if (totals.latency <= g.latency * 0.65) stars++;
  }
  return { pass, stars, checks, totals, cost };
}

export function evaluate(design, ch) {
  const run = createRun(design, ch);
  while (!run.done) run.step();
  return { ...run.result(), killed: run.killed };
}
