// Local LLM advisor (Ollama, CPU only so the GPU stays free for games).
//
// The model never drives the browser. It reads a knowledge pack written for small models (knowledge/*.kb), then
// either picks one option from a list the engine built, diagnoses a bug and gives one order from a whitelist, or
// answers kil in the dashboard. Every answer is schema-checked; any failure returns null and the bot carries on.
import { readFileSync, existsSync, statSync } from 'node:fs';

const URL = 'http://127.0.0.1:11434/api/chat';
const MODEL = 'qwen2.5:7b-instruct';
const KB_FILE = 'knowledge/dofusmasters.kb';
// CPU only (num_gpu 0), 4 threads so a game keeps the rest, kept in RAM 30 min to skip the ~12 s reload
const OPTIONS = { num_gpu: 0, num_thread: 4, num_ctx: 4096, num_predict: 200, temperature: 0 };
const KEEP_ALIVE = '30m';
const TIMEOUT_MS = 90000;

/** Orders the model may give when the bot is sick. Everything that spends, sells, breaks or resets is absent on purpose. */
export const ORDERS = ['attendre', 'f5', 'zone', 'spots', 'xphard', 'deck', 'aventure', 'boss', 'site', 'pause', 'alerter'];

// Knowledge pack: "### id | point, point" headers. A call only carries the sections tagged for its decision point,
// so the prompt stays well inside a 4k context.
let kbCache = { mtime: 0, sections: [] };
function knowledge(point) {
  if (!existsSync(KB_FILE)) return '';
  const mtime = statSync(KB_FILE).mtimeMs; // re-parsed only when the file changes, so it can be edited live
  if (mtime !== kbCache.mtime) {
    kbCache = {
      mtime,
      sections: readFileSync(KB_FILE, 'utf8').split(/^### /m).filter(Boolean).map((block) => {
        const [head, ...body] = block.split('\n');
        const [, tags = 'all'] = head.split('|');
        return { tags: tags.split(',').map((t) => t.trim()), text: body.join('\n').trim() };
      }),
    };
  }
  return kbCache.sections.filter((s) => s.tags.includes('all') || s.tags.includes(point)).map((s) => s.text).join('\n\n');
}

async function chat(point, user, schema, extra = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(URL, {
      method: 'POST',
      signal: ctrl.signal,
      body: JSON.stringify({
        model: MODEL, stream: false, keep_alive: KEEP_ALIVE, format: schema, options: { ...OPTIONS, ...extra },
        messages: [{ role: 'system', content: knowledge(point) }, ...(Array.isArray(user) ? user : [{ role: 'user', content: user }])],
      }),
    });
    if (!r.ok) return null;
    const out = JSON.parse((await r.json()).message?.content ?? 'null');
    return out && typeof out === 'object' ? out : null;
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
  const ids = options.map((o) => o.id);
  const schema = {
    type: 'object',
    properties: { option: { type: 'string', enum: ids }, confidence: { type: 'number' }, reason: { type: 'string' } },
    required: ['option', 'confidence', 'reason'],
  };
  const user = `${question}\n\nOptions :\n${options.map((o) => `${o.id}) ${o.label}`).join('\n')}\n\nChoisis une option. Raison en une phrase.`;
  const a = await chat(point, user, schema);
  if (!a || !ids.includes(a.option)) return null;
  return { option: a.option, confidence: clamp01(a.confidence), reason: String(a.reason ?? '').slice(0, 300) };
}

/**
 * The bot is sick: read the symptom, reason with the knowledge pack, give one order from ORDERS.
 * The schema enum is `allowed`: only orders the bot can really carry out right now, so the model cannot answer
 * anything else (an invented or impossible order is not even expressible).
 * @param {{ symptom: string, log: string[], page: string, state: string, tried: string[], allowed: string[] }} s
 * @returns {Promise<{ diagnostic: string, order: string, confidence: number, reason: string } | null>}
 */
export async function diagnose({ symptom, log, page, state, tried, allowed }) {
  const orders = allowed.filter((o) => ORDERS.includes(o));
  if (!orders.length) return null;
  const schema = {
    type: 'object',
    properties: { diagnostic: { type: 'string' }, order: { type: 'string', enum: orders }, confidence: { type: 'number' }, reason: { type: 'string' } },
    required: ['diagnostic', 'order', 'confidence', 'reason'],
  };
  const user = [
    `Symptome : ${symptom}`,
    `Etat du bot : ${state}`,
    `Ordres possibles MAINTENANT (aucun autre) : ${orders.join(', ')}`,
    `Ordres deja donnes pour ce symptome : ${tried.length ? tried.join(', ') : 'aucun'}`,
    `Dernieres lignes du log :\n${log.slice(-15).join('\n')}`,
    `Texte de la page :\n${page.slice(0, 1200)}`,
    'Raisonne comme indique (symptome, indices, cause, dedans ou dehors, ordre, deja essaye), puis reponds en JSON.',
  ].join('\n\n');
  const a = await chat('order', user, schema);
  if (!a || !orders.includes(a.order)) return null;
  return { diagnostic: String(a.diagnostic ?? '').slice(0, 300), order: a.order, confidence: clamp01(a.confidence), reason: String(a.reason ?? '').slice(0, 300) };
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
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' }, order: { type: 'string', enum: ['aucun', ...ORDERS.filter((o) => o !== 'alerter')] } },
    required: ['answer', 'order'],
  };
  const turns = [
    { role: 'user', content: `Etat actuel du bot (pour repondre) :\n${state}\n\nReponds a kil court et concret. Si un ordre aiderait, mets-le dans "order", sinon "aucun". Tu n'executes rien : kil cliquera.` },
    { role: 'assistant', content: '{"answer":"Compris, je reponds a partir de cet etat.","order":"aucun"}' },
    ...messages,
  ];
  const a = await chat('chat', turns, schema, { num_predict: 400, temperature: 0.3 });
  if (!a || typeof a.answer !== 'string') return null;
  return { answer: a.answer.trim(), order: ORDERS.includes(a.order) ? a.order : 'aucun' };
}

/**
 * Ask the model what a new page element is for and whether the bot should care.
 * @returns {Promise<{ purpose: string, useful: boolean, readOnly: boolean, suggestion: string } | null>}
 */
export async function explain(change, pageText) {
  const schema = {
    type: 'object',
    properties: { purpose: { type: 'string' }, useful: { type: 'boolean' }, readOnly: { type: 'boolean' }, suggestion: { type: 'string' } },
    required: ['purpose', 'useful', 'readOnly', 'suggestion'],
  };
  const user = `Nouveaute detectee sur le site : ${change}\n\nExtrait de la page :\n${pageText.slice(0, 2500)}\n\n`
    + 'A quoi sert cet element ? Est-il utile pour gagner de l XP ou du stuff ? Est-ce en lecture seule (onglet, filtre, affichage) ou une action qui modifie le compte ? Suggestion en une phrase.';
  return chat('chat', user, schema);
}

const clamp01 = (x) => Math.max(0, Math.min(1, +x || 0));
