// Browser tests: load the real page in Chromium and play level 1 like a user would.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".html": "text/html" };
const BASE = "http://sds.test/";

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function open(viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "sds.test") return route.abort();
    const file = join(ROOT, url.pathname === "/" ? "index.html" : url.pathname);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ body: readFileSync(file), contentType: TYPES[extname(file)] || "application/octet-stream" });
  });
  await page.goto(BASE);
  return { page, errors };
}

async function dragPort(page, fromId, toId) {
  const port = await page.locator(`.node[data-id="${fromId}"] .port`).boundingBox();
  const to = await page.locator(`.node[data-id="${toId}"]`).boundingBox();
  await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
}

test("first visit shows the welcome dialog and a live sandbox", async () => {
  const { page, errors } = await open();
  assert.ok(await page.locator("#welcome[open]").isVisible());
  await page.click("#welcome-sandbox");
  await page.waitForTimeout(1500);
  assert.ok((await page.locator(".node").count()) >= 5, "a template is loaded");
  const served = await page.locator("#m-throughput b").textContent();
  assert.ok(parseInt(served.replace(/,/g, ""), 10) > 0, `traffic is flowing (${served})`);
  assert.deepEqual(errors, []);
  await page.close();
});

test("level 1 can be solved by dragging and connecting", async () => {
  const { page, errors } = await open();
  await page.click("#welcome-challenges");
  await page.waitForTimeout(500);

  const card = await page.locator('.pal[data-type="db"]').boundingBox();
  const stage = await page.locator("#stage").boundingBox();
  await page.mouse.move(card.x + 30, card.y + 20);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * 0.8, stage.y + stage.height * 0.7, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const db = await page.locator('.node[data-type="db"]').getAttribute("data-id");

  await dragPort(page, "users", "app");
  await dragPort(page, "app", db);
  assert.equal(await page.locator(".edge").count(), 2);

  // An impossible connection is refused with an explanation.
  await dragPort(page, db, "users");
  assert.equal(await page.locator(".edge").count(), 2);
  assert.match(await page.locator("#toast").textContent(), /can't flow back/);

  await page.click("#btn-test");
  await page.waitForSelector("#result[open]", { timeout: 20000 });
  assert.match(await page.locator("#result-title").textContent(), /survived/);
  assert.equal(await page.locator(".result-stars .on").count(), 3);
  await page.click('[data-res="next"]');
  assert.match(await page.locator("#mission-title").textContent(), /viral/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("crashing a server and sharing a design", async () => {
  const { page, errors } = await open();
  await page.click("#welcome-sandbox");
  await page.click('[data-template="classic"]');
  await page.waitForTimeout(800);
  await page.click("#btn-chaos");
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".node.down").count(), 1);
  await page.click("#btn-revive");
  assert.equal(await page.locator(".node.down").count(), 0);

  const nodes = await page.locator(".node").count();
  const edges = await page.locator(".edge").count();
  const link = await page.evaluate(() => window.__sds.encodeDesign(window.__sds.app.design));
  await page.goto(`${BASE}#d=${link}`);
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".node").count(), nodes);
  assert.equal(await page.locator(".edge").count(), edges);
  assert.deepEqual(errors, []);
  await page.close();
});

test("no horizontal page scroll on a phone", async () => {
  const { page, errors } = await open({ width: 390, height: 844 });
  await page.click("#welcome-sandbox");
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  assert.deepEqual(errors, []);
  await page.close();
});
