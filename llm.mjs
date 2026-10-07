// Local LLM advisor (Ollama, CPU only so the GPU stays free for games).
//
// The model never drives the browser: it picks one option out of a list built by the deterministic engine, or
// explains a page, and every answer is schema-checked. Any failure (Ollama down, timeout, bad JSON) returns null and
// the bot carries on with its own decision.
import { readFileSync, existsSync } from 'node:fs';

const URL = 'http://127.0.0.1:11434/api/chat';
const MODEL = 'qwen2.5:7b-instruct';
// CPU only (num_gpu 0), 4 threads so a game keeps the rest, kept in RAM 30 min to skip the ~12 s reload
const OPTIONS = { num_gpu: 0, num_thread: 4, num_ctx: 4096, num_predict: 160, temperature: 0 };
const KEEP_ALIVE = '30m';
const TIMEOUT_MS = 90000;

const coach = () => (existsSync('coach.txt') ? readFileSync('coach.txt', 'utf8') : '');

async function chat(system, user, schema) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(URL, {
      method: 'POST',
      signal: ctrl.signal,
      body: JSON.stringify({
        model: MODEL, stream: false, keep_alive: KEEP_ALIVE, format: schema, options: OPTIONS,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
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
 * Ask the model to choose one option.
 * @param {string} question  the situation, in plain words, with the numbers that matter
 * @param {{ id: string, label: string }[]} options  only valid, already-filtered choices
 * @returns {Promise<{ option: string, confidence: number, reason: string } | null>}
 */
export async function choose(question, options) {
  if (!options.length) return null;
  const ids = options.map((o) => o.id);
  const schema = {
    type: 'object',
    properties: { option: { type: 'string', enum: ids }, confidence: { type: 'number' }, reason: { type: 'string' } },
    required: ['option', 'confidence', 'reason'],
  };
  const user = `${question}\n\nOptions :\n${options.map((o) => `${o.id}) ${o.label}`).join('\n')}\n\nChoisis une option. Raison en une phrase.`;
  const a = await chat(coach(), user, schema);
  if (!a || !ids.includes(a.option)) return null;
  return { option: a.option, confidence: Math.max(0, Math.min(1, +a.confidence || 0)), reason: String(a.reason ?? '').slice(0, 300) };
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
 * Free conversation for the dashboard: kil asks, the model answers with the coaching and the bot's live state.
 * Read-only: the answer is text, nothing is executed.
 * @param {{ role: 'user' | 'assistant', content: string }[]} messages
 * @param {string} state  short description of what the bot is doing now
 */
export async function converse(messages, state) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const system = `${coach()}\n\nTu reponds a kil dans son tableau de bord. Tu ne peux rien executer : tu expliques et tu conseilles, court et concret.\n\nEtat actuel du bot :\n${state}`;
    const r = await fetch(URL, {
      method: 'POST',
      signal: ctrl.signal,
      body: JSON.stringify({ model: MODEL, stream: false, keep_alive: KEEP_ALIVE, options: { ...OPTIONS, num_predict: 400, temperature: 0.3 }, messages: [{ role: 'system', content: system }, ...messages] }),
    });
    if (!r.ok) return null;
    return String((await r.json()).message?.content ?? '').trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
  return chat(coach(), user, schema);
}
