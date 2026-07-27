#!/usr/bin/env node
// Upload specific mp4s through the issue #1 comment editor (logged-in debug
// Chrome over CDP) and print the asset-URL mapping. The comment itself is
// posted afterwards via `gh issue comment` with the captured URLs.
import { chromium } from '@playwright/test';
import path from 'node:path';

const issue = process.env.MEDIA_ISSUE || '3';
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: _upload-media-comment.mjs <file.mp4>...'); process.exit(2); }

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = await browser.contexts()[0].newPage();
try {
  await page.goto(`https://github.com/eyalev/herdr-web/issues/${issue}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3500);

  const body = page.locator('textarea[placeholder*="comment"], textarea[aria-label*="Comment"], textarea[placeholder*="Type your"]').last();
  await body.click();
  await body.fill('');

  for (const f of files) {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      page.locator('button:has-text("Add Files")').last().click(),
    ]);
    await chooser.setFiles(path.resolve(f));
    await page.waitForFunction(
      () => ![...document.querySelectorAll('textarea')].some((t) => /Uploading/i.test(t.value)),
      null, { timeout: 180000 }
    );
    await page.waitForTimeout(1000);
    console.error('uploaded', f);
  }

  const text = await body.inputValue();
  const urls = [...text.matchAll(/https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9-]+/g)].map((m) => m[0]);
  const mapping = Object.fromEntries(files.map((f, i) => [path.basename(f), urls[i]]));
  console.log(JSON.stringify({ mapping }, null, 2));
} finally {
  await page.close();
  browser.close();
}
