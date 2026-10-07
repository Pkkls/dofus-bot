// Local LLM advisor (Ollama, CPU only so the GPU stays free for games).
//
// The model never drives the browser. It reads a knowledge pack written for small models (knowledge/*.kb, plus
// knowledge/learned.kb that the bot writes from its own verified fixes), then either picks one option from a list the
// engine built, diagnoses a bug and gives one order from the orders feasible right now, or answers kil in the
// dashboard. One zod schema per call both constrains decoding (Ollama `format`) and validates the answer: constrained
// decoding removes format errors, not meaning errors, so the engine still pre-filters options and checks orders.
// Any failure (Ollama down, timeout, invalid answer) returns null and the bot carries on.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { z } from 'zod';
import { similar, formatCases } from './retrieve.mjs';

const URL = 'http://127.0.0.1:11434/api/chat';
// Generic across games: the game supplies its knowledge files; the model can be swapped (eval, other machines).
let MODEL = process.env.LLM_MODEL || 'qwen2.5:7b-instruct';
let KB_FILES = ['knowledge/dofusmasters.kb', 'knowledge/game.kb', 'knowledge/learned.kb'];
let PRE_RULES = []; // regles certaines fournies par le jeu ({ id, test(input), order, why }), appliquees avant le modele
/** @param {{ model?: string, kbFiles?: string[], preRules?: object[] }} c */
export function configure(c) { if (c.model) MODEL = c.model; if (c.kbFiles) KB_FILES = c.kbFiles; if (c.preRules) PRE_RULES = c.preRules; }
export const currentModel = () => MODEL;
// CPU only (num_gpu 0), 4 threads so a game keeps the rest, kept in RAM 30 min to skip the ~12 s reload
const OPTIONS = { num_gpu: 0, num_thread: 4, num_ctx: 4096, num_predict: 200, temperature: 0 };
const KEEP_ALIVE = '30m';
const TIMEOUT_MS = 90000;

/** Orders the model may give when the bot is sick. Everything that spends, sells, breaks or resets is absent on purpose. */
export const ORDERS = ['attendre', 'f5', 'zone', 'spots', 'xphard', 'deck', 'aventure', 'boss', 'site', 'pause', 'alerter'];

// Knowledge pack: "### id | point, point" headers. A call only carries the sections tagged for its decision point,
// so the prompt stays inside a 4k context. Re-parsed when a file changes, so it can be edited (or learned) live.
const kbCache = new Map();
function sections(file) {
  if (!existsSync(file)) return [];
  const mtime = statSync(file).mtimeMs;
  const hit = kbCache.get(file);
  if (hit?.mtime === mtime) return hit.sections;
  const parsed = readFileSync(file, 'utf8').split(/^### /m).filter((b) => b.trim()).map((block) => {
    const [head, ...body] = block.split('\n');
    const [, tags = 'all'] = head.split('|');
    return { tags: tags.split(',').map((t) => t.trim()), text: body.join('\n').trim() };
  });
  kbCache.set(file, { mtime, sections: parsed });
  return parsed;
}
const knowledge = (point) => KB_FILES.flatMap(sections).filter((s) => s.tags.includes('all') || s.tags.includes(point)).map((s) => s.text).join('\n\n');

const confidence = z.number().transform((x) => Math.max(0, Math.min(1, x)));
const text = (n) => z.string().transform((s) => s.trim().slice(0, n));

/** One call: zod schema -> JSON schema for Ollama, then the same schema validates the answer. */
async function ask(point, messages, schema, extra = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(URL, {
      method: 'POST',
      signal: ctrl.signal,
      body: JSON.stringify({
        model: MODEL, stream: false, keep_alive: KEEP_ALIVE, format: z.toJSONSchema(schema, { io: 'input' }), options: { ...OPTIONS, ...extra },
        messages: [{ role: 'system', content: knowledge(point) }, ...(typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages)],
      }),
    });
    if (!r.ok) return null;
    const raw = JSON.parse((await r.json()).message?.content ?? 'null');
    const out = schema.safeParse(raw);
    return out.success ? out.data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pick one option out of a clean list built by the engine.
 * @param {string} question  the situation, with the numbers that matter
 * @param {{ id: string, label: string }[]} options
 * @param {'zone' | 'unblock'} point  which knowledge to load
 * @returns {Promise<{ option: string, confidence: number, reason: string } | null>}
 */
export async function choose(question, options, point = 'zone') {
  if (!options.length) return null;
  const schema = z.object({ option: z.enum(options.map((o) => o.id)), confidence, reason: text(300) });
  const user = `${question}\n\nOptions :\n${options.map((o) => `${o.id}) ${o.label}`).join('\n')}\n\nChoisis une option. Raison en une phrase.`;
  return ask(point, user, schema);
}

/**
 * The bot is sick: read the symptom, reason with the knowledge pack, give one order.
 * The schema enum is `allowed`: only orders the bot can really carry out right now, so an invented or impossible
 * order cannot even be expressed. `history` is what already worked or failed on this kind of symptom.
 * @param {{ symptom: string, log: string[], page: string, state: string, tried: string[], allowed: string[], history: string }} s
 * @returns {Promise<{ diagnostic: string, order: string, confidence: number, reason: string } | null>}
 */
export async function diagnose({ symptom, log, page, state, tried, allowed, history }) {
  const orders = allowed.filter((o) => ORDERS.includes(o));
  if (!orders.length) return null;
  // regles certaines du jeu d'abord : le modele n'est consulte que si aucune ne s'applique
  for (const r of PRE_RULES) {
    if ((r.order === 'alerter' || orders.includes(r.order)) && r.test({ symptom, log, page, state, tried, history })) {
      return { diagnostic: r.why, order: r.order, confidence: 1, reason: `regle fixe "${r.id}" (sans IA)`, rule: r.id };
    }
  }
  const schema = z.object({ diagnostic: text(300), order: z.enum(orders), confidence, reason: text(300) });
  // Ordre voulu : le contexte brut d'abord, les faits decisifs (historique, deja essaye, ordres possibles) a la FIN,
  // juste avant la question : un petit modele retient surtout le debut et la fin du prompt (Lost in the Middle).
  // L'historique est pre-digere en code : on ne lui demande pas de compter.
  const cured = (history ?? '').split(';').map((h) => h.match(/^\s*(\w+)\s*:\s*(\d+)\s*gueri\s*\/\s*(\d+)/)).filter(Boolean)
    .filter(([, o, ok, ko]) => +ok > +ko && orders.includes(o)).map(([, o]) => o);
  const failed = [...new Set(tried)].filter((o) => tried.filter((t) => t === o).length >= 2);
  const cases = await similar(`${symptom}. ${log.slice(-6).join(' ')} ${page.slice(0, 400)}`, 3);
  const user = [
    `Texte de la page :\n${page.slice(0, 1200)}`,
    `Dernieres lignes du log :\n${log.slice(-15).join('\n')}`,
    `Etat du bot : ${state}`,
    formatCases(cases),
    `SYMPTOME : ${symptom}`,
    `HISTORIQUE sur ce symptome : ${history || 'rien encore'}`,
    cured.length ? `>>> L'HISTORIQUE DIT : l'ordre "${cured[0]}" a deja gueri ce symptome. Choisis-le sauf preuve contraire dans le log.` : '',
    failed.length ? `>>> DEJA RATE 2 FOIS, NE PAS REDONNER : ${failed.join(', ')}` : `Ordres deja donnes : ${tried.length ? tried.join(', ') : 'aucun'}`,
    `ORDRES POSSIBLES MAINTENANT (aucun autre) : ${orders.join(', ')}`,
    'Raisonne (symptome, indices, cause, dedans ou dehors, historique, ordre), puis reponds en JSON.',
  ].filter(Boolean).join('\n\n');
  return ask('order', user, schema);
}

/** Ollama reachable? Model loaded, and where (RAM vs VRAM). Never throws. */
export async function status() {
  try {
    const ps = await fetch(URL.replace('/api/chat', '/api/ps'), { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
    const m = (ps.models ?? []).find((x) => x.name === MODEL);
    return { up: true, model: MODEL, loaded: !!m, ramBytes: m ? m.size - (m.size_vram ?? 0) : 0, vramBytes: m?.size_vram ?? 0, cpuOnly: OPTIONS.num_gpu === 0 };
  } catch {
    return { up: false, model: MODEL, loaded: false, ramBytes: 0, vramBytes: 0, cpuOnly: OPTIONS.num_gpu === 0 };
  }
}

/**
 * Dashboard conversation: kil asks, the model answers with the knowledge pack and the bot's live state, and may
 * suggest one order that kil can run with a click. Nothing is executed here.
 * @param {{ role: 'user' | 'assistant', content: string }[]} messages
 * @param {string} state
 * @returns {Promise<{ answer: string, order: string } | null>}
 */
export async function converse(messages, state) {
  const schema = z.object({ answer: text(2000), order: z.enum(['aucun', ...ORDERS.filter((o) => o !== 'alerter')]) });
  const turns = [
    { role: 'user', content: `Etat actuel du bot (pour repondre) :\n${state}\n\nReponds a kil court et concret. Si un ordre aiderait, mets-le dans "order", sinon "aucun". Tu n'executes rien : kil cliquera.` },
    { role: 'assistant', content: '{"answer":"Compris, je reponds a partir de cet etat.","order":"aucun"}' },
    ...messages,
  ];
  return ask('chat', turns, schema, { num_predict: 400, temperature: 0.3 });
}

/**
 * Ask the model what a new page element is for and whether the bot should care.
 * @returns {Promise<{ purpose: string, useful: boolean, readOnly: boolean, suggestion: string } | null>}
 */
export async function explain(change, pageText) {
  const schema = z.object({ purpose: text(300), useful: z.boolean(), readOnly: z.boolean(), suggestion: text(300) });
  const user = `Nouveaute detectee sur le site : ${change}\n\nExtrait de la page :\n${pageText.slice(0, 2500)}\n\n`
    + 'A quoi sert cet element ? Est-il utile pour gagner de l XP ou du stuff ? Est-ce en lecture seule (onglet, filtre, affichage) ou une action qui modifie le compte ? Suggestion en une phrase.';
  return ask('chat', user, schema);
}
