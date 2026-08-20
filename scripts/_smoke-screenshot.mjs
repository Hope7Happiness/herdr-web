#!/usr/bin/env node
// Desktop smoke test: load the UI at phone viewport, verify sessions render,
// live screen appears, key reachability, and take screenshots as evidence.
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const URL = process.argv[2] || 'http://localhost:7930';
const VIEWPORT_WIDTH = Number(process.env.SMOKE_WIDTH || 414);
const VIEWPORT_HEIGHT = Number(process.env.SMOKE_HEIGHT || 896);
const OUT = path.resolve(import.meta.dirname, '../eval-results/smoke-' +
  VIEWPORT_WIDTH + 'x' + VIEWPORT_HEIGHT + '-' +
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
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
  const agent = {
    label: document.querySelector('#agentpick .lbl')?.textContent,
    dot: document.querySelector('#agentpick .status-dot')?.className,
  };
  const rows = document.querySelectorAll('#term .row').length;
  const rowEls = [...document.querySelectorAll('#term .row')];
  const quickKeys = [...document.querySelectorAll('#quickkeys .qk')];
  const quickRail = document.getElementById('quickkeys');
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
    agent, rows, pageScrollY: window.scrollY, vh,
    reach,
    quickKeyCount: quickKeys.length,
    quickRailFits: quickRail.scrollWidth <= quickRail.clientWidth + 1 &&
      quickKeys.every((key) => key.getBoundingClientRect().right <= quickRail.getBoundingClientRect().right + 1),
    termSample: termText.split('\n').slice(-6),
    fontSize: getComputedStyle(term).fontSize,
    sharedRuntimeResize: term.classList.contains('shared-runtime-resize'),
    termClientWidth: term.clientWidth,
    maxRowScrollWidth: Math.max(0, ...rowEls.map((r) => r.scrollWidth)),
    sourceMaxCells: Math.max(0, ...rowEls.map((r) => r.textContent.length)),
  };
});
console.log(JSON.stringify(report, null, 2));

await page.click('#agentpick');
await page.waitForTimeout(150);
const pickerRows = await page.locator('#agent-list .agentrow').count();
await page.screenshot({ path: path.join(OUT, '02-agents.png') });
await page.click('#agent-cancel');

await page.locator('#term').evaluate((el) => {
  el.scrollTop = 0;
  el.dispatchEvent(new Event('scroll'));
});
await page.waitForTimeout(80);
const liveButtonVisible = await page.locator('#livekey').isVisible();
if (liveButtonVisible) await page.click('#livekey');
if (liveButtonVisible) {
  await page.waitForFunction(() => {
    const el = document.getElementById('term');
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  }, null, { timeout: 4000 });
}
const liveButtonWorks = liveButtonVisible && await page.locator('#term').evaluate(
  (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 8,
);
console.log(JSON.stringify({
  liveButtonVisible,
  liveButtonWorks,
  termScroll: await page.locator('#term').evaluate((el) => ({ scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight })),
}, null, 2));

// Type into input and send
await page.fill('#msg', 'test message from smoke');
await page.screenshot({ path: path.join(OUT, '03-typed.png') });

console.log('screenshots in', OUT);
await browser.close();

const ok = report.agent.label && pickerRows > 0 && liveButtonWorks && report.rows > 5 && report.quickKeyCount === 10 && report.quickRailFits &&
  Object.values(report.reach).every((r) => r.inViewport) && report.pageScrollY === 0 &&
  (report.sharedRuntimeResize || report.maxRowScrollWidth <= report.termClientWidth + 1);
console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(ok ? 0 : 1);
