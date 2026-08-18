#!/usr/bin/env node
// Desktop smoke test: load the UI at phone viewport, verify sessions render,
// live screen appears, key reachability, and take screenshots as evidence.
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const URL = process.argv[2] || 'http://localhost:7930';
const OUT = path.resolve(import.meta.dirname, '../eval-results/smoke-' +
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 414, height: 896 },
  serviceWorkers: 'block',
});
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[browser-error]', m.text().slice(0, 300));
});
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

await page.goto(URL + '?_t=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(OUT, '01-loaded.png') });

const report = await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('.tab')].map((t) => ({
    label: t.querySelector('.lbl')?.textContent,
    dot: t.querySelector('.dot')?.className,
    active: t.classList.contains('active'),
  }));
  const rows = document.querySelectorAll('#term .row').length;
  const rowEls = [...document.querySelectorAll('#term .row')];
  const termText = [...document.querySelectorAll('#term .row')].map((r) => r.textContent).join('\n');
  const term = document.getElementById('term');
  // Reachability: every quick key + input + send must be inside the viewport.
  const vh = window.innerHeight;
  const reach = {};
  for (const [name, el] of Object.entries({
    input: document.getElementById('msg'),
    send: document.getElementById('send'),
    firstQk: document.querySelector('.qk'),
    tabbar: document.getElementById('tabbar'),
  })) {
    const r = el.getBoundingClientRect();
    reach[name] = { top: Math.round(r.top), bottom: Math.round(r.bottom), inViewport: r.top >= 0 && r.bottom <= vh && r.height > 0 };
  }
  return {
    tabs, rows, pageScrollY: window.scrollY, vh,
    reach,
    termSample: termText.split('\n').slice(-6),
    fontSize: document.getElementById('term').style.fontSize,
    sharedRuntimeResize: term.classList.contains('shared-runtime-resize'),
    termClientWidth: term.clientWidth,
    maxRowScrollWidth: Math.max(0, ...rowEls.map((r) => r.scrollWidth)),
    sourceMaxCells: Math.max(0, ...rowEls.map((r) => r.textContent.length)),
  };
});
console.log(JSON.stringify(report, null, 2));

// Type into input and send
await page.fill('#msg', 'test message from smoke');
await page.screenshot({ path: path.join(OUT, '02-typed.png') });

console.log('screenshots in', OUT);
await browser.close();

const ok = report.tabs.length > 0 && report.rows > 5 &&
  Object.values(report.reach).every((r) => r.inViewport) && report.pageScrollY === 0 &&
  (report.sharedRuntimeResize || report.maxRowScrollWidth <= report.termClientWidth + 1);
console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(ok ? 0 : 1);
