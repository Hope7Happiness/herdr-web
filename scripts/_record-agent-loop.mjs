#!/usr/bin/env node
// Desktop demo of the browser→agent loop: take control of the agent's browser,
// hit a bug, send the page's errors to the agent, watch it fix them, then pick
// an element to aim the next prompt. Records docs/media/agent-loop.webm.
import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import path from 'node:path';
import fs from 'node:fs';

const URL = process.argv[2] || 'http://localhost:7930';
const CDP = process.env.HERDR_WEB_CDP_PORT || '9555';
const OUT = path.resolve(import.meta.dirname, '../docs/media');
fs.mkdirSync(OUT, { recursive: true });

// A second CDP client, only to read element rects from the live (overridden)
// layout so the demo taps land where a human would tap.
async function cdp() {
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
  const t = list.find((x) => x.type === 'page');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const send = (method, params) => new Promise((res) => {
    const i = ++id;
    const h = (d) => { const m = JSON.parse(d); if (m.id === i) { ws.off('message', h); res(m.result); } };
    ws.on('message', h);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Runtime.enable');
  const rects = async () => JSON.parse((await send('Runtime.evaluate', {
    expression: 'JSON.stringify({b: document.getElementById("add").getBoundingClientRect(), h: document.querySelector("h1").getBoundingClientRect(), n: document.getElementById("count").textContent})',
    returnByValue: true,
  })).result.value);
  return { rects, close: () => ws.close() };
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
  serviceWorkers: 'block',
});
const page = await ctx.newPage();
const marks = {};
await page.goto(`${URL}/?_t=${Date.now()}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const t0 = Date.now();
const mark = (k) => { marks[k] = Date.now() - t0; };

// Agent pane on the left for the whole clip.
await page.evaluate(() => selectPane('wF:p2'));
await page.waitForTimeout(1500);
await page.click('#castbtn');
await page.waitForTimeout(6500);
mark('watching');
await page.waitForTimeout(2500);

// Take control, then use the app until it breaks.
await page.evaluate(() => setCastMode('control'));
await page.waitForTimeout(1800);
mark('control');
const c = await cdp();
const r = await c.rects();
const bx = Math.round(r.b.x + r.b.width / 2);
const by = Math.round(r.b.y + r.b.height / 2);
for (let i = 0; i < 3; i++) {
  await page.evaluate(([x, y]) => castSend({ type: 'mouse', action: 'click', x, y }), [bx, by]);
  await page.waitForTimeout(1100);
}
await page.waitForTimeout(2200);
mark('broke');

// Hand the page's own errors to the agent.
await page.click('#castbar .chip:has-text("page error")');
await page.waitForTimeout(2200);
mark('errorsInPrompt');
await page.click('#send');
mark('sent');

// The agent edits the source; live-reload repaints the cast.
const deadline = Date.now() + 90000; // bad take should fail fast, not make a 4-minute video
let fixed = false;
while (Date.now() < deadline && !fixed) {
  await page.waitForTimeout(3000);
  const cur = await c.rects().catch(() => null);
  if (!cur) continue;
  // Counting past 1 is only possible once the bug is gone.
  await page.evaluate(([x, y]) => castSend({ type: 'mouse', action: 'click', x, y }), [bx, by]);
  await page.waitForTimeout(900);
  const after = await c.rects().catch(() => null);
  fixed = !!after && Number(after.n) >= 2;
}
mark('fixed');
await page.waitForTimeout(2500);

// Aim the next prompt at an element by tapping it.
await page.evaluate(() => setPickMode(true));
await page.waitForTimeout(1500);
const r2 = await c.rects();
await page.evaluate(([x, y]) => castSend({ type: 'pick', x, y }),
  [Math.round(r2.h.x + r2.h.width / 2), Math.round(r2.h.y + r2.h.height / 2)]);
await page.waitForTimeout(2600);
mark('picked');

// Hand control back.
await page.evaluate(() => setCastMode('watch'));
await page.waitForTimeout(3000);
mark('handback');

c.close();
await ctx.close();
await browser.close();
const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.webm'));
const newest = files.map((f) => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
fs.renameSync(path.join(OUT, newest.f), path.join(OUT, 'agent-loop.webm'));
fs.writeFileSync(path.join(OUT, '.agent-loop.marks.json'), JSON.stringify(marks));
console.log(JSON.stringify({ saved: 'docs/media/agent-loop.webm', marks, fixed }));
