// Few-shot by similarity: instead of fixed examples (which a small model copies blindly), each call gets the 2-3 past
// incidents closest to the current situation, with their REAL outcome. Embeddings come from Ollama's
// nomic-embed-text on the CPU and are cached on disk. Generic: the corpus is a JSONL file supplied by the game.
//
// Corpus line: { "symptom": "...", "clues": "...", "order": "f5", "outcome": "gueri" | "sans effet", "why": "..." }
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const EMBED_URL = 'http://127.0.0.1:11434/api/embed';
const EMBED_MODEL = 'nomic-embed-text';
let CORPUS = 'knowledge/incidents.jsonl';
let CACHE = 'knowledge/.embeddings.json';
/** @param {{ corpus?: string, cache?: string }} c */
export function configureRetrieval(c) { if (c.corpus) CORPUS = c.corpus; if (c.cache) CACHE = c.cache; }

let cache = null;
const loadCache = () => (cache ??= existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {});

async function embed(texts) {
  const r = await fetch(EMBED_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, keep_alive: '30m', options: { num_gpu: 0, num_thread: 4 } }),
  });
  if (!r.ok) throw new Error(`embed ${r.status}`);
  return (await r.json()).embeddings;
}

const cosine = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / Math.sqrt(na * nb || 1); };
const docText = (x) => `search_document: ${x.symptom}. ${x.clues ?? ''}`;

export function incidents() {
  if (!existsSync(CORPUS)) return [];
  return readFileSync(CORPUS, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** Record a real outcome (called by the bot after reflection), so the corpus grows with experience. */
export function remember(x) { appendFileSync(CORPUS, JSON.stringify({ ...x, at: new Date().toISOString().slice(0, 16) }) + '\n'); }

/**
 * The k past incidents most similar to `situation`. Never throws: on any failure returns [] and the call goes on
 * without examples.
 */
export async function similar(situation, k = 3) {
  try {
    const all = incidents();
    if (!all.length) return [];
    const C = loadCache();
    const missing = [...new Set(all.map(docText).filter((t) => !C[t]))];
    if (missing.length) {
      const vecs = await embed(missing);
      missing.forEach((t, i) => { C[t] = vecs[i]; });
      writeFileSync(CACHE, JSON.stringify(C));
    }
    const [q] = await embed([`search_query: ${situation.slice(0, 1500)}`]);
    return all.map((x) => ({ x, s: cosine(q, C[docText(x)]) })).sort((a, b) => b.s - a.s).slice(0, k).map(({ x, s }) => ({ ...x, score: +s.toFixed(3) }));
  } catch {
    return [];
  }
}

/** Format for the prompt: past cases are evidence, not answer templates. */
export const formatCases = (cases) => cases.length
  ? `CAS PASSES LES PLUS PROCHES (resultat REEL, a comparer, pas a recopier) :\n${cases.map((c, i) => `${i + 1}. "${c.symptom}" (${c.clues ?? ''}) -> ordre ${c.order} -> ${c.outcome}${c.why ? ` : ${c.why}` : ''}`).join('\n')}`
  : '';
