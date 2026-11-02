// MagicCorporation buy-back prices (rachat.magiccorporation.com), read through its public search API.
//
// READ-ONLY. The only thing this module ever does is `GET /api/search/cards?q=…&edition_id=…&page=…`: no cart, no order,
// no buy-back request, no account, no cookie. (The site's own page also contains cart routes; they are never called.)
//
// Rules below are copied from the site's own JavaScript (rachat.magiccorporation.com/recherche, read on 2026-11-02):
//  - a price <= 0.01 EUR means "sur devis" (manual estimate), never "buy-back 0.01 EUR"
//  - French needs a French name AND a French price above 0.01; English needs `en_blocked` false AND a price above 0.01
//  - a card with neither language sellable is "sur devis", unless `low_value` ("non rachetée à l'unité") or `not_bought`
//  - foil is sellable only if has_foil_vf / has_foil_vo says so (the foil price columns can be filled anyway)
//  - purchase quantity limits per price band (12 / 8 / 4 copies)
// Prices are for NM condition (coefficient 1), the same as Playin's Mint/Nmint, so the two shops are comparable.
import { MC_EDITIONS } from './mc-editions.js';

export const MC_API = 'https://rachat.magiccorporation.com/api/search/cards';
export const QUOTE_THRESHOLD = 0.01;
export const MC_RESULT_TTL_MS = 6 * 3600 * 1000;
const PAGE_TTL_MS = 10 * 60 * 1000;
const MAX_PAGES = 4;
const MAX_CACHED_RESULTS = 150;
const CACHE_KEY = 'mtg-mc-cache';
const LEARNED_KEY = 'mtg-mc-learned';

// ───────────────────────── names, numbers, editions ─────────────────────────

// Front face only: "Emeritus of Conflict /Lightning Bolt" is NOT "Lightning Bolt", whereas "Delver of Secrets" is the front of its two-faced card.
export const frontFace = (name) => String(name ?? '').split(/\s*\/+\s*/)[0];

export function nameKey(name) {
  return frontFace(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[’‘`´]/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();
}

export const numberKey = (value) => String(value ?? '').trim().toLowerCase().replace(/[★☆†‡*\s]/g, '').replace(/^0+(?=.)/, '');

// Scryfall set code <-> MagicCorporation edition ids (a few sets map to several ids). Built once from the snapshot table.
const IDS_BY_SET = (() => {
  const map = new Map();
  for (const [id, entry] of Object.entries(MC_EDITIONS)) {
    const set = entry[1]; if (!set) continue;
    (map.get(set) ?? map.set(set, []).get(set)).push(Number(id));
  }
  return map;
})();

// 'same' | 'other' | 'unknown'. An edition that cannot be tied to a Scryfall set is never guessed.
export function editionVerdict(edition, card, learned = {}) {
  const set = String(card?.set ?? '').toLowerCase();
  const entry = MC_EDITIONS[edition?.id];
  if (entry) return entry[1] ? (entry[1] === set ? 'same' : 'other') : 'unknown';
  if (learned[edition?.id]) return learned[edition.id] === set ? 'same' : 'other';
  const code = String(edition?.code ?? '').toLowerCase();
  return code && code === set ? 'same' : 'unknown';
}

const numberingUnreliable = (edition) => Boolean(MC_EDITIONS[edition?.id]?.[3]);

// Which MagicCorporation rows are THE printing of this Scryfall card? Name, edition AND number must agree.
export function matchPrinting(candidates, card, learned = {}) {
  const wantName = nameKey(card?.name);
  const wantNumber = numberKey(card?.collector_number);
  const named = (candidates || []).filter((c) => nameKey(c.name) === wantName);
  const sameEdition = []; const unknownEdition = [];
  for (const c of named) {
    const verdict = editionVerdict(c.edition, card, learned);
    if (verdict === 'same') sameEdition.push(c); else if (verdict === 'unknown') unknownEdition.push(c);
  }
  const exact = sameEdition.filter((c) => wantNumber && numberKey(c.number) === wantNumber);
  if (exact.length === 1) return { status: 'ok', card: exact[0] };
  if (exact.length > 1) return { status: 'verify', reason: 'ambiguous', candidates: exact };
  const noNumber = sameEdition.filter((c) => !numberKey(c.number));
  if (noNumber.length) return { status: 'verify', reason: 'no-number', candidates: noNumber };
  const renumbered = sameEdition.filter((c) => numberingUnreliable(c.edition));
  if (renumbered.length) return { status: 'verify', reason: 'numbering', candidates: renumbered };
  const unconfirmed = unknownEdition.filter((c) => wantNumber && numberKey(c.number) === wantNumber);
  if (unconfirmed.length) return { status: 'verify', reason: 'edition', candidates: unconfirmed };
  return { status: 'absent' }; // other printings of that card exist, this one is not listed
}

// ───────────────────────── prices and availability ─────────────────────────

const money = (value) => { const n = Number.parseFloat(value); return Number.isFinite(n) ? n : 0; };

// The few fields the rules need, whatever the API returns.
export function normalizeCard(raw) {
  return {
    id: raw?.id ?? null, name: String(raw?.name ?? ''), number: String(raw?.number ?? ''),
    edition: { id: raw?.edition?.id ?? null, code: String(raw?.edition?.code ?? ''), name: String(raw?.edition?.name ?? '') },
    nameFr: String(raw?.name_fr ?? ''),
    enBlocked: Boolean(raw?.en_blocked), notBought: Boolean(raw?.not_bought), lowValue: Boolean(raw?.low_value),
    vf: money(raw?.buyback_price_vf), vo: money(raw?.buyback_price_vo), fvf: money(raw?.buyback_price_foil_vf), fvo: money(raw?.buyback_price_foil_vo),
    foilVf: Boolean(raw?.has_foil_vf), foilVo: Boolean(raw?.has_foil_vo),
  };
}

export const canSellInFr = (c) => Boolean(c.nameFr) && c.vf > QUOTE_THRESHOLD;
export const canSellInEn = (c) => !c.enBlocked && c.vo > QUOTE_THRESHOLD;

// Purchase limit per card, as announced by the site's own page.
export function maxQuantity(price) {
  if (!(price > QUOTE_THRESHOLD)) return 0;
  if (price < 3) return 12;
  if (price < 10) return 8;
  return 4;
}

// The offer for ONE language and finish. States: price | quote | notBought | lowValue | unavailable | noFoil.
export function offerFor(card, language, finish) {
  if (!card) return null;
  const fr = language !== 'En';
  if (card.notBought) return { state: 'notBought' };
  const frOk = canSellInFr(card); const enOk = canSellInEn(card);
  if (!frOk && !enOk) return card.lowValue ? { state: 'lowValue' } : { state: 'quote' };
  if (fr ? !frOk : !enOk) {
    const reason = fr ? (card.nameFr ? 'quote' : 'noFrench') : (card.enBlocked ? 'enBlocked' : 'quote');
    const alt = fr ? { language: 'En', price: card.vo } : { language: 'Fr', price: card.vf };
    return { state: 'unavailable', reason, alt };
  }
  if (finish === 'foil') {
    if (!(fr ? card.foilVf : card.foilVo)) return { state: 'noFoil' };
    const price = fr ? card.fvf : card.fvo;
    return price > QUOTE_THRESHOLD ? { state: 'price', price, limit: maxQuantity(price) } : { state: 'quote', foil: true };
  }
  const price = fr ? card.vf : card.vo;
  return { state: 'price', price, limit: maxQuantity(price) };
}

// Best offer among shops that actually gave a number for the same printing, language and finish.
export function compareOffers(playin, magic) {
  const a = Number.isFinite(playin) ? playin : null; const b = Number.isFinite(magic) ? magic : null;
  if (a === null && b === null) return { best: null, only: false, diff: 0 };
  if (a === null) return { best: 'mc', only: true, diff: 0 };
  if (b === null) return { best: 'playin', only: true, diff: 0 };
  const diff = Math.round((b - a) * 100) / 100;
  if (Math.abs(diff) < 0.005) return { best: 'tie', only: false, diff: 0 };
  return { best: diff > 0 ? 'mc' : 'playin', only: false, diff: Math.abs(diff) };
}

// French wording for every state (the UI never invents its own).
export function stateLabel(offer) {
  if (!offer) return '—';
  switch (offer.state) {
    case 'quote': return offer.foil ? 'Foil sur devis' : 'Sur devis';
    case 'notBought': return 'Non rachetée';
    case 'lowValue': return 'Non rachetée à l’unité';
    case 'noFoil': return 'Foil non racheté';
    case 'unavailable': return { noFrench: 'Pas de version FR', enBlocked: 'Anglais non racheté', quote: 'Sur devis' }[offer.reason] || 'Indisponible';
    default: return '—';
  }
}
export const resultLabel = (status) => ({
  loading: 'Recherche…', verify: 'Correspondance à vérifier', absent: 'Impression non listée', error: 'Indisponible', unchecked: 'Non vérifiée',
}[status] || '—');

// ───────────────────────── per-entry snapshot (kept with the collection) ─────────────────────────

export function snapshotResult(result) {
  if (!result || !['ok', 'verify', 'absent'].includes(result.status)) return null;
  const out = { v: 1, status: result.status, at: result.at ?? Date.now() };
  if (result.status === 'ok') out.card = result.card;
  if (result.status === 'verify') {
    out.reason = String(result.reason || '');
    out.candidates = (result.candidates || []).slice(0, 3).map((c) => ({ id: c.id, number: c.number, edition: c.edition }));
  }
  return out;
}

// Accepts only the exact shape this module writes (backups come from files, so they are untrusted).
export function sanitizeMc(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || !['ok', 'verify', 'absent'].includes(raw.status)) return undefined;
  const text = (value, max = 120) => String(value ?? '').slice(0, max);
  const num = (value) => (Number.isFinite(value) && value >= 0 && value < 100000 ? value : 0);
  const edition = (e) => ({ id: Number.isInteger(e?.id) ? e.id : null, code: text(e?.code, 12), name: text(e?.name) });
  const out = { v: 1, status: raw.status, at: Number.isFinite(raw.at) ? raw.at : 0 };
  if (raw.status === 'ok') {
    const c = raw.card; if (!c || typeof c !== 'object') return undefined;
    out.card = { id: Number.isInteger(c.id) ? c.id : null, name: text(c.name), number: text(c.number, 16), edition: edition(c.edition), nameFr: text(c.nameFr),
      enBlocked: c.enBlocked === true, notBought: c.notBought === true, lowValue: c.lowValue === true,
      vf: num(c.vf), vo: num(c.vo), fvf: num(c.fvf), fvo: num(c.fvo), foilVf: c.foilVf === true, foilVo: c.foilVo === true };
  }
  if (raw.status === 'verify') {
    out.reason = text(raw.reason, 20);
    out.candidates = Array.isArray(raw.candidates) ? raw.candidates.slice(0, 3).map((c) => ({ id: Number.isInteger(c?.id) ? c.id : null, number: text(c?.number, 16), edition: edition(c?.edition) })) : [];
  }
  return out;
}

// What an entry could sell for at each shop, for its own language and finish.
export function entryComparison(entry) {
  const playin = Number.isFinite(entry?.price) ? entry.price : null;
  const result = entry?.mc;
  const offer = result?.status === 'ok' ? offerFor(result.card, entry.language, entry.finish) : null;
  const magic = offer?.state === 'price' ? offer.price : null;
  return { playin, offer, magic, status: result?.status || 'unchecked', ...compareOffers(playin, magic) };
}

const VERIFY_REASONS = {
  ambiguous: 'Plusieurs lignes identiques chez MagicCorporation',
  'no-number': 'Numéro absent chez MagicCorporation',
  numbering: 'Numérotation différente de Scryfall pour cette édition',
  edition: 'Édition non reliée à coup sûr',
  'too-many': 'Trop de résultats pour cette carte',
};

// What the sheet shows for one card: per finish the MagicCorporation figure (a price, or why there is none), which shop pays
// more, and a one-line note. `playin` holds Playin's numbers for the same printing, language and finish.
export function mcPanel(result, { language = 'Fr', playin = {} } = {}) {
  const status = result?.status || 'unchecked';
  const out = { status, finishes: {}, note: '', canRetry: status === 'error' || status === 'unchecked' };
  for (const finish of ['normal', 'foil']) {
    const mine = Number.isFinite(playin[finish]) ? playin[finish] : null;
    const offer = status === 'ok' ? offerFor(result.card, language, finish) : null;
    const price = offer?.state === 'price' ? offer.price : null;
    out.finishes[finish] = { price, offer, text: price !== null ? '' : (offer ? stateLabel(offer) : resultLabel(status)), ...compareOffers(mine, price) };
  }
  if (status === 'ok') {
    const c = result.card; const notes = [`${c.edition.name || c.edition.code} n°${c.number}`];
    const shown = out.finishes.normal.offer?.state === 'price' ? out.finishes.normal.offer : out.finishes.foil.offer;
    if (shown?.limit) notes.push(`${shown.limit} exemplaires max par envoi`);
    for (const finish of ['normal', 'foil']) { const alt = out.finishes[finish].offer?.alt; if (alt) { notes.push(`${alt.language.toUpperCase()} : ${alt.price.toFixed(2).replace('.', ',')} €`); break; } }
    out.note = notes.join(' · ');
  } else if (status === 'verify') out.note = `${VERIFY_REASONS[result.reason] || 'Correspondance incertaine'} : vérifie sur MagicCorporation.`;
  else if (status === 'absent') out.note = 'Cette impression n’est pas dans la liste de rachat de MagicCorporation.';
  else if (status === 'error') out.note = result.message || 'MagicCorporation ne répond pas. Playin n’est pas affecté.';
  return out;
}

// Totals per shop and with the best offer for every card. Cards without any usable number are counted, never silently priced.
export function comparisonTotals(entries) {
  const t = {
    cards: 0, playin: { sum: 0, cards: 0 }, mc: { sum: 0, cards: 0 }, best: { sum: 0, cards: 0, unknown: 0 },
    mcStates: { ok: 0, quote: 0, notBought: 0, lowValue: 0, unavailable: 0, noFoil: 0, verify: 0, absent: 0, unchecked: 0 }, overLimit: 0,
  };
  for (const entry of entries) {
    if (entry?.source === 'cardmarket') continue; // Cardmarket trend prices are another kind of price
    const quantity = entry.quantity || 1; const c = entryComparison(entry);
    t.cards += quantity;
    if (c.playin !== null) { t.playin.sum += c.playin * quantity; t.playin.cards += quantity; }
    if (c.magic !== null) {
      t.mc.sum += c.magic * quantity; t.mc.cards += quantity; t.mcStates.ok += quantity;
      if (c.offer.limit && quantity > c.offer.limit) t.overLimit += quantity - c.offer.limit;
    } else if (c.offer) t.mcStates[c.offer.state] = (t.mcStates[c.offer.state] || 0) + quantity;
    else t.mcStates[c.status === 'ok' ? 'unchecked' : c.status] = (t.mcStates[c.status === 'ok' ? 'unchecked' : c.status] || 0) + quantity;
    const best = Math.max(c.playin ?? -1, c.magic ?? -1);
    if (best >= 0) { t.best.sum += best * quantity; t.best.cards += quantity; } else t.best.unknown += quantity;
  }
  return t;
}

// ───────────────────────── network: queue, cache, dedupe, 429 ─────────────────────────

export class McError extends Error {
  constructor(code, message) { super(message); this.name = 'McError'; this.code = code; }
}

// Only this URL shape is ever built: fixed endpoint, whitelisted parameters, GET.
export function buildSearchUrl({ q, editionId, page = 1 }) {
  const params = new URLSearchParams();
  if (q) params.set('q', String(q).slice(0, 120));
  if (editionId !== undefined && editionId !== null) {
    if (!Number.isInteger(editionId) || editionId <= 0) throw new McError('bad-request', 'edition_id invalide');
    params.set('edition_id', String(editionId));
  }
  params.set('page', String(Math.max(1, Math.min(50, Math.trunc(page) || 1))));
  params.set('non_rachetees', '1');
  return `${MC_API}?${params}`;
}

const safeStorage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const readJson = (storage, key, fallback) => { try { return JSON.parse(storage?.getItem(key) || 'null') ?? fallback; } catch { return fallback; } };
const writeJson = (storage, key, value) => { try { storage?.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };

export function createMcClient(options = {}) {
  const {
    fetchImpl = (...args) => globalThis.fetch(...args),
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    storage = safeStorage(),
    minGapMs = 1300,          // 46 per minute at most...
    maxPerWindow = 40,        // ...and 40 per rolling minute: the site allows 60 per minute (per address, window measured at about 60 s)
    windowMs = 60000,
    timeoutMs = 9000,
    maxRetries = 3,
    breakerAfter = 3,
    breakerMs = 60000,
  } = options;

  const cacheEntries = new Map(Object.entries(readJson(storage, CACHE_KEY, {})));
  const learned = readJson(storage, LEARNED_KEY, {});
  const pages = new Map();       // request key -> { at, data }
  const inflightPages = new Map();
  const inflightLookups = new Map();
  const queue = [];
  const starts = [];
  const listeners = new Set();
  let cooldownUntil = 0; let backoff = 0; let breakerUntil = 0; let failures = 0; let pumping = false; let lastStart = 0;
  let requests = 0;

  const state = () => ({ pending: queue.length + (pumping ? 1 : 0), cooldownUntil, breakerUntil, requests });
  const notify = (extra = {}) => { for (const listener of listeners) { try { listener({ ...state(), ...extra }); } catch { /* a broken listener must not stop the queue */ } } };

  function saveCache() {
    const keep = [...cacheEntries.entries()].sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, MAX_CACHED_RESULTS);
    cacheEntries.clear(); for (const [k, v] of keep) cacheEntries.set(k, v);
    let obj = Object.fromEntries(cacheEntries);
    for (let i = 0; i < 3 && !writeJson(storage, CACHE_KEY, obj); i++) { // quota: keep the newest half
      const half = keep.slice(0, Math.floor(keep.length / 2 ** (i + 1))); obj = Object.fromEntries(half);
    }
  }

  function waitTime() {
    const t = now();
    const windowStarts = starts.filter((s) => t - s < windowMs);
    starts.length = 0; starts.push(...windowStarts);
    const gap = lastStart + minGapMs - t;
    const window = windowStarts.length >= maxPerWindow ? windowStarts[0] + windowMs - t : 0;
    return Math.max(0, cooldownUntil - t, gap, window);
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const wait = waitTime();
        if (wait > 0) { notify({ waiting: true, waitMs: wait }); await sleep(wait); continue; }
        const job = queue.shift();
        starts.push(now()); lastStart = now(); requests += 1;
        notify();
        await runJob(job);
      }
    } finally { pumping = false; notify({ idle: true }); }
  }

  async function runJob(job) {
    let response;
    try {
      response = await fetchImpl(job.url, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) { return fail(job, new McError('unavailable', `MagicCorporation ne répond pas (${error?.message || 'réseau'})`)); }
    if (response.status === 429) {
      const header = Number(response.headers?.get?.('Retry-After')); // not readable from a browser (CORS), readable in tests / other runtimes
      backoff = Number.isFinite(header) && header > 0 ? header * 1000 : Math.min(300000, backoff ? backoff * 2 : 30000);
      cooldownUntil = now() + backoff;
      if (job.retries < maxRetries) { job.retries += 1; queue.unshift(job); notify({ rateLimited: true }); return undefined; }
      return job.reject(new McError('rate-limited', 'Limite de requêtes MagicCorporation atteinte'));
    }
    if (!response.ok) return fail(job, new McError('unavailable', `MagicCorporation a répondu HTTP ${response.status}`));
    let body;
    try { body = await response.json(); } catch { return fail(job, new McError('unavailable', 'Réponse MagicCorporation illisible')); }
    failures = 0; backoff = 0;
    return job.resolve({
      cards: (Array.isArray(body?.data) ? body.data : []).map(normalizeCard),
      page: Number(body?.current_page) || 1, lastPage: Number(body?.last_page) || 1, total: Number(body?.total) || 0,
      tooShort: body?.too_short === true,
    });
  }

  function fail(job, error) {
    failures += 1;
    if (failures >= breakerAfter) breakerUntil = now() + breakerMs;
    if (job.attempts < 1) { job.attempts += 1; queue.unshift(job); cooldownUntil = Math.max(cooldownUntil, now() + 1500); return undefined; }
    return job.reject(error);
  }

  function requestPage(query, { fresh = false } = {}) {
    const url = buildSearchUrl(query);
    const cached = pages.get(url);
    if (!fresh && cached && now() - cached.at < PAGE_TTL_MS) return Promise.resolve(cached.data);
    if (inflightPages.has(url)) return inflightPages.get(url);                       // same request already waiting: share it
    if (now() < breakerUntil) return Promise.reject(new McError('unavailable', 'MagicCorporation est momentanément indisponible'));
    const promise = new Promise((resolve, reject) => { queue.push({ url, resolve, reject, retries: 0, attempts: 0 }); pump(); })
      .then((data) => { pages.set(url, { at: now(), data }); return data; })
      .finally(() => inflightPages.delete(url));
    inflightPages.set(url, promise);
    return promise;
  }

  const resultKey = (card) => `${String(card.set).toLowerCase()}|${numberKey(card.collector_number)}|${nameKey(card.name)}`;

  async function search(card, fresh) {
    const q = frontFace(card.name);
    const set = String(card.set || '').toLowerCase();
    const ids = IDS_BY_SET.get(set) ?? (learned[set] ? [learned[set]] : []);
    const found = [];
    const collect = async (query) => {
      let page = 1; let last = 1;
      do {
        const data = await requestPage({ ...query, page }, { fresh });
        found.push(...data.cards); last = data.lastPage; page += 1;
        if (matchPrinting(found, card, learnedMap()).status === 'ok') return true;
      } while (page <= last && page <= MAX_PAGES);
      return page > last; // true when every page was read
    };
    if (ids.length) { let complete = true; for (const id of ids) complete = (await collect({ q, editionId: id })) && complete; return { found, complete }; }
    return { found, complete: await collect({ q }) };
  }

  const learnedMap = () => {
    const map = {};
    for (const [set, id] of Object.entries(learned)) map[id] = set;
    return map;
  };

  async function lookup(card, { force = false } = {}) {
    if (!card?.name || !card?.set) throw new McError('bad-request', 'Carte incomplète');
    const key = resultKey(card);
    const cached = cacheEntries.get(key);
    if (!force && cached && now() - cached.at < MC_RESULT_TTL_MS) return { ...cached, cached: true };
    if (inflightLookups.has(key)) return inflightLookups.get(key);
    const promise = (async () => {
      const { found, complete } = await search(card, force);
      let match = matchPrinting(found, card, learnedMap());
      if (match.status === 'absent' && !complete) match = { status: 'verify', reason: 'too-many', candidates: [] };
      const result = { status: match.status, at: now() };
      if (match.status === 'ok') {
        result.card = match.card;
        const set = String(card.set).toLowerCase();
        if (match.card.edition.id && !MC_EDITIONS[match.card.edition.id] && !learned[set]) { learned[set] = match.card.edition.id; writeJson(storage, LEARNED_KEY, learned); }
      } else if (match.status === 'verify') { result.reason = match.reason; result.candidates = match.candidates; }
      const stored = snapshotResult(result);
      cacheEntries.set(key, stored); saveCache();
      return result;
    })().finally(() => inflightLookups.delete(key));
    inflightLookups.set(key, promise);
    return promise;
  }

  return {
    lookup, requestPage,
    cached: (card) => { const c = cacheEntries.get(resultKey(card)); return c && now() - c.at < MC_RESULT_TTL_MS ? c : null; },
    onStatus: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    state, clearBreaker: () => { breakerUntil = 0; failures = 0; },
  };
}
