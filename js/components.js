// The building blocks. Numbers are rough, rounded, real-world-ish figures:
// capacity is requests (or queries) per second, latency is milliseconds of work
// per request, cost is US dollars per month.

export const KINDS = {
  users: {
    tag: "Users",
    label: "Users",
    short: "Your visitors",
    what: "People opening your app. They send a mix of page loads (reads), form submits (writes) and images/CSS/JS (static files).",
    when: "Always here. Connect them to the first thing that receives traffic.",
    examples: "Browsers, mobile apps",
    cost: 0,
  },
  cdn: {
    tag: "CDN",
    label: "CDN",
    short: "Serves static files near users",
    what: "A network of servers around the world that keeps copies of images, CSS and JS close to your users. It answers 95% of static requests itself.",
    when: "When lots of traffic is images, video or scripts. Cheap, fast, and takes load off your servers.",
    examples: "Cloudflare, Akamai, AWS CloudFront",
    cap: 100000,
    lat: 5,
    cost: 50,
    hit: 0.95,
  },
  lb: {
    tag: "Load Balancer",
    label: "Load Balancer",
    short: "Spreads traffic across servers",
    what: "Splits incoming requests evenly across several servers, and stops sending to a server once its health check sees it's down (after about 2 seconds).",
    when: "As soon as one server isn't enough, or you can't afford downtime when a server dies.",
    examples: "Nginx, HAProxy, AWS ALB",
    cap: 20000,
    lat: 2,
    cost: 25,
  },
  server: {
    tag: "Server",
    label: "App Server",
    short: "Runs your code",
    what: "Runs your application code. Serves static files itself if there's no CDN, reads from the cache or database, and writes to the database or a queue.",
    when: "Always needed. Add more of them behind a load balancer to scale out, or pick a bigger size to scale up.",
    examples: "Node.js, Django, Spring Boot on a VM",
    lat: 30,
    sizes: {
      S: { cap: 500, cost: 40 },
      M: { cap: 1000, cost: 80 },
      L: { cap: 2000, cost: 170 },
    },
  },
  cache: {
    tag: "Cache",
    label: "Cache",
    short: "Remembers frequent reads",
    what: "Keeps popular data in memory. A hit is answered in ~2 ms and never reaches the database. Misses fall through to the database.",
    when: "When the database is drowning in reads, especially the same reads over and over.",
    examples: "Redis, Memcached",
    cap: 25000,
    lat: 2,
    cost: 60,
    hit: 0.8,
  },
  db: {
    tag: "Database",
    label: "Database",
    short: "The source of truth",
    what: "Stores your data permanently. Writes are about twice as expensive as reads. If it has read replicas attached, it shares reads with them.",
    when: "Always needed for data. Protect it with a cache, read replicas or a queue. It's usually the first thing to break.",
    examples: "PostgreSQL, MySQL",
    lat: 12,
    sizes: {
      S: { cap: 1000, cost: 70 },
      M: { cap: 2000, cost: 150 },
      L: { cap: 4000, cost: 330 },
    },
  },
  replica: {
    tag: "Replica",
    label: "Read Replica",
    short: "A read-only database copy",
    what: "A copy of the database that can answer reads but not writes. Connect it from the main database and reads get shared between them.",
    when: "When there are far more reads than writes and a cache alone isn't enough.",
    examples: "Postgres streaming replica, Aurora reader",
    cap: 2000,
    lat: 12,
    cost: 120,
  },
  queue: {
    tag: "Queue",
    label: "Message Queue",
    short: "Writes now, processes later",
    what: "Accepts writes instantly and holds them in a line. Workers take them off the line at a steady pace, so traffic spikes don't hit the database all at once.",
    when: "For bursty writes like checkouts, emails and uploads, where the user doesn't need to wait for the work to finish.",
    examples: "Kafka, RabbitMQ, AWS SQS",
    cap: 50000,
    lat: 3,
    cost: 30,
    maxBacklog: 100000,
  },
  worker: {
    tag: "Worker",
    label: "Worker",
    short: "Processes queued jobs",
    what: "Pulls jobs from the queue and writes the results to the database, as fast as it can (600 jobs/s each).",
    when: "Connect from a queue. Add more if the queue keeps growing.",
    examples: "Celery, Sidekiq, AWS Lambda",
    cap: 600,
    lat: 25,
    cost: 50,
  },
};

// Which component can send traffic to which.
export const CONNECTS = {
  users: ["cdn", "lb", "server"],
  cdn: ["lb", "server"],
  lb: ["server", "lb"],
  server: ["cache", "db", "replica", "queue"],
  cache: ["db", "replica"],
  db: ["replica"],
  replica: [],
  queue: ["worker"],
  worker: ["db"],
};

export const PALETTE = ["cdn", "lb", "server", "cache", "db", "replica", "queue", "worker"];

export const DEFAULT_SIZE = "M";

export function capacityOf(node) {
  const k = KINDS[node.type];
  if (k.sizes) return k.sizes[node.size || DEFAULT_SIZE].cap;
  return k.cap || Infinity;
}

export function costOf(node) {
  const k = KINDS[node.type];
  if (k.sizes) return k.sizes[node.size || DEFAULT_SIZE].cost;
  return k.cost || 0;
}

export function hitRateOf(node) {
  return node.hit ?? KINDS[node.type].hit ?? 0;
}

export function canConnect(fromType, toType) {
  return (CONNECTS[fromType] || []).includes(toType);
}

export function connectHint(fromType, toType) {
  const from = KINDS[fromType].label;
  const to = KINDS[toType].label;
  const ok = CONNECTS[fromType] || [];
  if (!ok.length) return `${from} doesn't send traffic anywhere.`;
  if (toType === "users") return "Traffic can't flow back to users.";
  const list = ok.map((t) => KINDS[t].label).join(", ");
  return `${from} can't send to ${to}. It can connect to: ${list}.`;
}

// SVG icons (24×24, stroke = currentColor)
export const ICONS = {
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 13.7c3 .1 5.5 2 5.5 5.3"/>',
  cdn: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.8 5.2 3.8 8.5s-1.2 6.1-3.8 8.5c-2.6-2.4-3.8-5.2-3.8-8.5S9.4 5.9 12 3.5z"/>',
  lb: '<circle cx="5" cy="12" r="2.2"/><circle cx="19" cy="5" r="2.2"/><circle cx="19" cy="12" r="2.2"/><circle cx="19" cy="19" r="2.2"/><path d="M7.2 12h9.6M7 11l10-5M7 13l10 5"/>',
  server: '<rect x="4" y="3.5" width="16" height="7" rx="1.6"/><rect x="4" y="13.5" width="16" height="7" rx="1.6"/><path d="M8 7h.01M8 17h.01M12 7h5M12 17h5"/>',
  cache: '<path d="M13 2.5 5 13.5h6l-1 8 8-11h-6z"/>',
  db: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.6 3.4 2.8 7.5 2.8s7.5-1.2 7.5-2.8v-13M4.5 12c0 1.6 3.4 2.8 7.5 2.8s7.5-1.2 7.5-2.8"/>',
  replica: '<ellipse cx="10" cy="6" rx="6" ry="2.3"/><path d="M4 6v9c0 1.3 2.7 2.3 6 2.3M16 6v4"/><path d="M14 15.5h7M18 12.5l3 3-3 3"/>',
  queue: '<rect x="2.5" y="7" width="4.5" height="10" rx="1"/><rect x="9.75" y="7" width="4.5" height="10" rx="1"/><rect x="17" y="7" width="4.5" height="10" rx="1"/>',
  worker: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
};

export function icon(type, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[type]}</svg>`;
}
