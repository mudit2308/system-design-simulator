// Starting points for the sandbox.

const n = (id, type, x, y, extra = {}) => ({ id, type, x, y, ...extra });
const e = (from, to) => ({ id: `${from}-${to}`, from, to });
const fan = (from, tos) => tos.map((to) => e(from, to));
const into = (froms, to) => froms.map((from) => e(from, to));

export const TEMPLATES = [
  {
    id: "blank",
    title: "Blank",
    note: "Just users",
    design: () => ({ nodes: [n("users", "users", 110, 340)], edges: [], traffic: { rps: 500, pattern: "steady", writes: 0.1, statics: 0.1 } }),
  },
  {
    id: "simple",
    title: "Simple",
    note: "1 server, 1 DB",
    design: () => ({
      nodes: [n("users", "users", 200, 340), n("app", "server", 500, 340), n("db", "db", 800, 340)],
      edges: [e("users", "app"), e("app", "db")],
      traffic: { rps: 400, pattern: "steady", writes: 0.1, statics: 0.1 },
    }),
  },
  {
    id: "classic",
    title: "Classic web app",
    note: "LB, servers, cache",
    design: () => {
      const apps = ["app1", "app2", "app3"];
      return {
        nodes: [
          n("users", "users", 110, 340),
          n("lb", "lb", 320, 340),
          n("app1", "server", 530, 200),
          n("app2", "server", 530, 340),
          n("app3", "server", 530, 480),
          n("cache", "cache", 750, 230),
          n("db", "db", 930, 400),
        ],
        edges: [e("users", "lb"), ...fan("lb", apps), ...into(apps, "cache"), ...into(apps, "db"), e("cache", "db")],
        traffic: { rps: 2000, pattern: "wave", writes: 0.1, statics: 0.1 },
      };
    },
  },
  {
    id: "scale",
    title: "At scale",
    note: "CDN, replicas, queue",
    design: () => {
      const apps = ["app1", "app2", "app3", "app4", "app5"];
      return {
        nodes: [
          n("users", "users", 90, 340),
          n("cdn", "cdn", 290, 150),
          n("lb", "lb", 290, 400),
          ...apps.map((id, i) => n(id, "server", 500, 80 + i * 125, { size: "L" })),
          n("cache", "cache", 720, 130),
          n("db", "db", 760, 330, { size: "L" }),
          n("rep1", "replica", 980, 250),
          n("rep2", "replica", 980, 410),
          n("queue", "queue", 720, 560),
          n("w1", "worker", 940, 540),
          n("w2", "worker", 940, 630),
        ],
        edges: [
          e("users", "cdn"),
          e("users", "lb"),
          e("cdn", "lb"),
          ...fan("lb", apps),
          ...into(apps, "cache"),
          ...into(apps, "queue"),
          e("cache", "db"),
          e("db", "rep1"),
          e("db", "rep2"),
          e("queue", "w1"),
          e("queue", "w2"),
          e("w1", "db"),
          e("w2", "db"),
        ],
        traffic: { rps: 9000, pattern: "steady", writes: 0.1, statics: 0.35 },
      };
    },
  },
];
