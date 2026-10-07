// Decision regression set: replays real cases (doctor-cases.jsonl, zone-cases.jsonl) against the local model and
// scores them. Run it after ANY change to prompts, knowledge, schema or model, and compare to the last run.
//
//   node ai/eval/run.mjs                       current model
//   node ai/eval/run.mjs --model qwen3:4b-instruct-2507
//   node ai/eval/run.mjs --only doctor         doctor | zone
//
// Results go to ai/eval/results/<date>-<model>.json (one line per case + summary), so runs can be compared.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configure, currentModel, diagnose, choose } from '../llm.mjs';
import { DOCTOR_RULES } from '../../knowledge/rules.mjs';
configure({ preRules: DOCTOR_RULES }); // on mesure le pipeline reel : regles fixes, puis modele

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
if (arg('model')) configure({ model: arg('model') });
const only = arg('only');
const load = (f) => readFileSync(join(here, f), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const rows = [];
async function run(kind, cases, call) {
  for (const c of cases) {
    const t0 = Date.now();
    const a = await call(c).catch(() => null);
    const got = a ? (a.order ?? a.option) : 'null';
    const ok = c.expect.includes(got);
    rows.push({ kind, id: c.id, category: c.category, expect: c.expect, got, ok, rule: a?.rule ?? null, ms: Date.now() - t0, why: a ? (a.reason ?? '') : '' });
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${kind}/${c.id} -> ${got}${a?.rule ? ` [regle ${a.rule}]` : ''} (attendu ${c.expect.join('|')}) ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}
if (only !== 'zone') await run('doctor', load('doctor-cases.jsonl'), (c) => diagnose(c.input));
if (only !== 'doctor') await run('zone', load('zone-cases.jsonl'), (c) => choose(c.question, c.options, 'zone'));

const by = {};
for (const r of rows) { const k = `${r.kind}/${r.category}`; (by[k] ??= { ok: 0, n: 0 }); by[k].n++; if (r.ok) by[k].ok++; }
const score = rows.filter((r) => r.ok).length;
const msAvg = Math.round(rows.reduce((a, r) => a + r.ms, 0) / Math.max(1, rows.length));
console.log(`\n${currentModel()} : ${score}/${rows.length} (${Math.round((score / Math.max(1, rows.length)) * 100)} %), ${(msAvg / 1000).toFixed(1)} s/decision`);
const llmRows = rows.filter((r) => !r.rule); // les regles fixes gonflent le score : on montre aussi le modele seul
console.log(`  dont regles fixes : ${rows.length - llmRows.length} cas ; modele seul : ${llmRows.filter((r) => r.ok).length}/${llmRows.length}`);
for (const [k, v] of Object.entries(by)) console.log(`  ${k.padEnd(28)} ${v.ok}/${v.n}`);

mkdirSync(join(here, 'results'), { recursive: true });
const file = join(here, 'results', `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${currentModel().replace(/[^\w.-]/g, '_')}.json`);
writeFileSync(file, JSON.stringify({ model: currentModel(), score, total: rows.length, msAvg, by, rows }, null, 1));
console.log(`resultats : ${file}`);
