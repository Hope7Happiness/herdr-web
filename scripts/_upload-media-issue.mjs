#!/usr/bin/env node
// Upload demo mp4s as GitHub issue attachments (via the logged-in debug
// Chrome over CDP) so docs can embed them as inline video players.
// Outputs JSON mapping filename -> user-attachments asset URL.
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const MEDIA = path.resolve(import.meta.dirname, '../docs/media');
const files = fs.readdirSync(MEDIA).filter((f) => f.endsWith('.mp4')).sort();
console.error('uploading:', files.join(', '));

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
try {
  await page.goto('https://github.com/eyalev/herdr-web/issues/new', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3500);

  await page.locator('input[aria-label="Add a title"]').fill('Demo videos (media hosting)');

  const body = page.locator('textarea[placeholder*="Type your description"]');
  await body.click();
  await body.fill('Hosts the demo videos referenced by README.md and docs/demos.md as inline-playable attachments. Do not delete.\n\n');

  for (const f of files) {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      page.locator('button:has-text("Add Files")').click(),
    ]);
    await chooser.setFiles(path.join(MEDIA, f));
    await page.waitForFunction(
      (sel) => {
        const t = document.querySelector(sel);
        return t && !/Uploading/i.test(t.value);
      },
      'textarea[placeholder*="Type your description"]',
      { timeout: 180000 }
    );
    await page.waitForTimeout(1000);
    console.error('uploaded', f);
  }

  const text = await body.inputValue();
  const urls = [...text.matchAll(/https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9-]+/g)].map((m) => m[0]);
  if (urls.length !== files.length) {
    console.error('URL count mismatch!', urls.length, 'vs', files.length, '\nbody:\n', text);
    process.exit(1);
  }
  const mapping = Object.fromEntries(files.map((f, i) => [f, urls[i]]));
  // Print BEFORE submitting — a failed submit must not lose the URLs.
  console.log(JSON.stringify({ mapping }, null, 2));

  const labeled = 'Hosts the demo videos referenced by README.md and docs/demos.md as inline-playable attachments. Do not delete.\n\n'
    + files.map((f) => `### ${f}\n\n${mapping[f]}\n`).join('\n');
  await body.fill(labeled);
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/issues\/\d+/, { timeout: 30000 });
  console.error('issue:', page.url());
  console.log(JSON.stringify({ issue: page.url() }));
} finally {
  await page.close();
  browser.close();
}
