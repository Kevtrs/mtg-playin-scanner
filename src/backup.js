// Collection export (CSV for Excel/Numbers), backup file (JSON) and the automatic safety copy.
const APP = 'mtg-playin-scanner';
export const BACKUP_VERSION = 1;
const SAFETY_KEY = 'mtg-session-backup';
const SAFETY_EVERY_MS = 60 * 60 * 1000;
const SCRYFALL_IMAGE = /^https:\/\/(cards|images)\.scryfall\.io\//;

const cell = (value) => { const text = String(value ?? ''); return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
const decimal = (value) => Number.isFinite(value) ? value.toFixed(2).replace('.', ',') : '';

// Semicolon-separated with a BOM and decimal commas: opens correctly in French Excel and Numbers.
export function toCsv(session) {
  const header = ['Nom', 'Édition', 'Code', 'Numéro', 'Langue', 'Finition', 'Prix unitaire (€)', 'Quantité', 'Total (€)', 'Date du scan'];
  const rows = session.map((item) => {
    const quantity = item.quantity || 1; const price = Number.isFinite(item.price) ? item.price : null;
    return [item.name, item.setName || '', (item.set || '').toUpperCase(), item.number, (item.language || 'Fr').toUpperCase(), item.finish === 'foil' ? 'Foil' : 'Normal', decimal(price), quantity, price === null ? '' : decimal(price * quantity), item.scannedAt || ''].map(cell).join(';');
  });
  return '﻿' + [header.map(cell).join(';'), ...rows].join('\r\n') + '\r\n';
}

export function makeBackup(session, now = new Date()) {
  return JSON.stringify({ app: APP, version: BACKUP_VERSION, exportedAt: now.toISOString(), count: session.length, session });
}

// Keeps only the fields the app knows, so a hand-edited or foreign file cannot inject anything odd.
function sanitize(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || typeof entry.id !== 'string') return null;
  const number = (value) => (Number.isFinite(value) ? value : null);
  const prices = entry.prices && typeof entry.prices === 'object'
    ? { normal: number(entry.prices.normal), foil: number(entry.prices.foil), edition: typeof entry.prices.edition === 'string' ? entry.prices.edition : '', matched: entry.prices.matched, ambiguous: entry.prices.ambiguous }
    : { normal: null, foil: null };
  return {
    entryId: typeof entry.entryId === 'string' ? entry.entryId : null, id: entry.id, name: entry.name.slice(0, 200),
    image: typeof entry.image === 'string' && SCRYFALL_IMAGE.test(entry.image) ? entry.image : '',
    set: String(entry.set ?? '').slice(0, 12), number: String(entry.number ?? '').slice(0, 16),
    setName: typeof entry.setName === 'string' ? entry.setName.slice(0, 120) : undefined,
    promo: entry.promo, fullArt: entry.fullArt, frameEffects: Array.isArray(entry.frameEffects) ? entry.frameEffects.filter((e) => typeof e === 'string') : undefined,
    price: number(entry.price), quantity: Number.isInteger(entry.quantity) && entry.quantity > 0 ? entry.quantity : 1, prices,
    finish: entry.finish === 'foil' ? 'foil' : 'normal', language: entry.language === 'En' ? 'En' : 'Fr',
    priceState: typeof entry.priceState === 'string' ? entry.priceState : '', scannedAt: typeof entry.scannedAt === 'string' ? entry.scannedAt : undefined,
    batch: typeof entry.batch === 'string' ? entry.batch : undefined,
  };
}

export function parseBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, error: 'Ce fichier n’est pas une sauvegarde lisible.' }; }
  if (!data || data.app !== APP || !Array.isArray(data.session)) return { ok: false, error: 'Ce fichier n’est pas une sauvegarde de cette application.' };
  const entries = data.session.map(sanitize).filter(Boolean);
  return { ok: true, entries, exportedAt: data.exportedAt || null, skipped: data.session.length - entries.length };
}

// Adds the entries the collection does not already have (matched by entry id). Never removes or overwrites.
export function mergeEntries(session, incoming, makeId) {
  const known = new Set(session.map((entry) => entry.entryId));
  let added = 0;
  for (const entry of incoming) {
    if (entry.entryId && known.has(entry.entryId)) continue;
    entry.entryId ||= makeId();
    session.push(entry); known.add(entry.entryId); added += 1;
  }
  return added;
}

// Automatic safety copy: at most once an hour, and always before a destructive action (force = true).
export function saveSafetyCopy(session, storage = globalThis.localStorage, now = Date.now(), force = false) {
  if (!session.length) return false;
  try {
    const previous = JSON.parse(storage.getItem(SAFETY_KEY) || 'null');
    if (!force && previous && now - previous.savedAt < SAFETY_EVERY_MS) return false;
    storage.setItem(SAFETY_KEY, JSON.stringify({ savedAt: now, session }));
    return true;
  } catch { return false; }
}
export function loadSafetyCopy(storage = globalThis.localStorage) {
  try {
    const copy = JSON.parse(storage.getItem(SAFETY_KEY) || 'null');
    if (!copy || !Array.isArray(copy.session)) return null;
    return { savedAt: copy.savedAt, entries: copy.session.map(sanitize).filter(Boolean) };
  } catch { return null; }
}
