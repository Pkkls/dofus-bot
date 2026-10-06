import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

// Dump lecture seule de pages du jeu dans dump/ (texte + controles avec leur HTML court).
mkdirSync('dump', { recursive: true });
const ctx = await chromium.launchPersistentContext('profile', { headless: true });
const page = ctx.pages()[0] ?? await ctx.newPage();
for (const path of process.argv.slice(2)) {
  await page.goto('https://dofusmasters.houk.fr/' + path);
  await page.waitForTimeout(9000);
  const main = await page.locator('body').innerText().catch(() => '');
  const ctrls = await page.locator('button, a, select, input').evaluateAll((els) =>
    els.map((e) => `${e.tagName}${e.disabled ? ' [disabled]' : ''} ${e.getAttribute('href') || ''} "${(e.innerText || e.value || '').replace(/\s+/g, ' ').slice(0, 90)}" ${e.title || e.getAttribute('aria-label') || ''}`));
  writeFileSync(`dump/${path.replace(/\W/g, "_")}.txt`, `URL ${page.url()}\n\n${main}\n\n=== CONTROLS\n${ctrls.join('\n')}`);
  console.log(path, page.url(), main.length, ctrls.length);
}
await ctx.close();
