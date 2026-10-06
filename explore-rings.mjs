import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

// Sonde lecture seule : structure de la grille d'inventaire (anneaux) et panneau de detail. Aucun Equiper/Vendre.
mkdirSync('dump', { recursive: true });
const ctx = await chromium.launchPersistentContext('profile', { headless: true });
const page = ctx.pages()[0] ?? await ctx.newPage();
// (test : images non bloquees)
await page.goto('https://dofusmasters.houk.fr/inventaire');
await page.getByText('Équipement porté').waitFor({ timeout: 60000 });
const main = page.locator('main');
const cb = main.locator('input[type=checkbox]').first();
if (!(await cb.isChecked())) await cb.check();
await main.locator('button').filter({ hasText: /^Anneau\s*\d+$/ }).first().click();
await page.waitForTimeout(1500);
const items = main.locator('button:has(img)').filter({ hasNotText: /\b(?!FUSION\b)[A-Za-zÀ-ÿ]{3,}/ });
const html = await items.evaluateAll((els) => els.slice(0, 40).map((e, i) => `${i}: txt=${JSON.stringify(e.innerText)} alt=${e.querySelector('img')?.alt} cls=${e.className.slice(0, 60)}`));
let out = `count=${await items.count()}\n${html.join('\n')}\n`;
// premier bouton dont l'image a un alt d'objet (pas un emplacement porte) : on prend le 20e pour etre dans la grille
for (const i of [20, 21, 22]) {
  await items.nth(i).click(); await page.waitForTimeout(800);
  const body = await page.locator('body').innerText(); const dlg = await page.locator('[role=dialog], dialog, [aria-modal]').evaluateAll((els) => els.map((e) => e.tagName + ' ' + (e.getAttribute('role') || '') + ' ' + e.innerText.slice(0, 1500)));
  out += `\n===== clic ${i} (alt=${await items.nth(i).locator('img').getAttribute('alt')})\nDIALOGS: ${JSON.stringify(dlg)}\nBODY-HORS-MAIN: ${body.replace(await main.innerText(), '[MAIN]').slice(0, 2500)}\n`;
}
writeFileSync('dump/rings.txt', out);
console.log('ok');
await ctx.close();
