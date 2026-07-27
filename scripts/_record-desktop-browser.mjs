#!/usr/bin/env node
// Desktop demo of the integrated browser: agent on the left, the real page it
// is building on the right — the layout a terminal plugin can only approximate
// with a pixel stream. Records to docs/media/desktop-browser.webm.
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const URL = process.argv[2] || 'http://localhost:7930';
const OUT = path.resolve(import.meta.dirname, '../docs/media');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
  serviceWorkers: 'block',
});
const page = await ctx.newPage();
const marks = {};
const mark = (k) => { marks[k] = Date.now() - t0; };

await page.goto(URL + '?_t=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const t0 = Date.now();

// 1. The dev-server pane: a plain localhost URL in agent output.
await page.evaluate(() => selectPane('wF:p1'));
await page.waitForTimeout(2600);

// 2. Click it — no modifier, no port typing — and the split opens.
await page.click('.row-link');
await page.waitForTimeout(3800);
mark('preview');

// 3. It is the real page: its JavaScript runs.
for (let i = 0; i < 3; i++) {
  await page.frameLocator('#pvframe').locator('#add').click();
  await page.waitForTimeout(700);
}
await page.waitForTimeout(1200);

// 4. Text is text, not pixels — select the heading.
await page.frameLocator('#pvframe').locator('h1').dblclick();
await page.waitForTimeout(1800);

// 5. Ask the agent (left) to restyle the app, and watch the page reload itself.
await page.evaluate(() => selectPane('wF:p2'));
await page.waitForTimeout(1500);
await page.click('#msg');
await page.type('#msg', 'In styles.css set .n color and the button background to #4ade80, then stop.', { delay: 42 });
await page.waitForTimeout(500);
await page.click('#send');
mark('promptSent');
await page.waitForTimeout(2000);

// Wait for the live-reload to repaint the preview green (bounded).
const deadline = Date.now() + 150000;
let green = false;
while (Date.now() < deadline && !green) {
  await page.waitForTimeout(2500);
  green = await page.frameLocator('#pvframe').locator('#count')
    .evaluate((el) => getComputedStyle(el).color.includes('74, 222, 128')).catch(() => false);
}
mark('green');
await page.waitForTimeout(3500);

// 6. Cast: the same pane can host a real Chrome for anything the proxy cannot frame.
await page.click('#castbtn');
await page.waitForTimeout(6500);
mark('cast');
await page.mouse.move(960, 500);
for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 320); await page.waitForTimeout(600); }
await page.waitForTimeout(2500);

await ctx.close();
await browser.close();
const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.webm'));
const newest = files.map((f) => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
fs.renameSync(path.join(OUT, newest.f), path.join(OUT, 'desktop-browser.webm'));
// Captions are generated from these marks, so a slower/faster agent run does
// not desynchronise the subtitles.
fs.writeFileSync(path.join(OUT, '.desktop-browser.marks.json'), JSON.stringify(marks));
console.log(JSON.stringify({ saved: 'docs/media/desktop-browser.webm', marks, green }));
