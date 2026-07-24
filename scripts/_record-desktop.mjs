#!/usr/bin/env node
// Desktop demo recording: drives the UI in headless Chromium with video
// capture. Output: docs/media/desktop.webm (convert with ffmpeg after).
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
await page.goto(URL + '?_t=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

// Select the main agent tab
await page.evaluate(() => selectPane('w3:p1'));
await page.waitForTimeout(2000);

// Type a prompt and send
await page.click('#msg');
await page.type('#msg', 'Which files make up this project? One short line each.', { delay: 55 });
await page.waitForTimeout(600);
await page.click('#send');

// Watch the response stream in
await page.waitForTimeout(16000);

// Scroll into history with the wheel, then back to live
await page.hover('#term');
for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(350); }
await page.waitForTimeout(1800);
await page.click('#livekey');
await page.waitForTimeout(2000);

// Peek at another workspace tab and come back
const tabs = await page.$$('.tab');
if (tabs.length > 1) {
  await tabs[1].click();
  await page.waitForTimeout(2500);
  await (await page.$$('.tab'))[0].click();
  await page.waitForTimeout(2000);
}

await ctx.close(); // flushes the video
await browser.close();
const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.webm'));
const newest = files.map((f) => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
fs.renameSync(path.join(OUT, newest.f), path.join(OUT, 'desktop.webm'));
console.log('saved docs/media/desktop.webm');
