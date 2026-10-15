const KEY = 'mtg-session';

// A corrupt or unavailable store must never prevent the app from starting,
// and corrupt data is kept aside instead of being overwritten.
export function loadSession(storage = globalThis.localStorage) {
  let raw = null;
  try { raw = storage.getItem(KEY); } catch { return []; }
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('not an array');
    return data.filter((item) => item && typeof item === 'object');
  } catch {
    try { storage.setItem(KEY + '-corrupt-backup', raw); } catch {}
    return [];
  }
}

export function saveSession(session, storage = globalThis.localStorage) {
  try { storage.setItem(KEY, JSON.stringify(session)); return true; } catch { return false; }
}

// Playin buy prices change slowly: keep parsed rows per card name so a card seen again
// (duplicates, basic lands, a later session) is priced instantly, even offline.
const PRICE_KEY = 'mtg-price-cache';
export const PRICE_TTL_MS = 12 * 3600 * 1000;
const PRICE_MAX_ENTRIES = 120;

export function loadPriceCache(storage = globalThis.localStorage, now = Date.now()) {
  const cache = new Map();
  try {
    const data = JSON.parse(storage.getItem(PRICE_KEY) || '{}');
    for (const [key, entry] of Object.entries(data)) {
      if (entry && Array.isArray(entry.rows) && now - entry.t < PRICE_TTL_MS) cache.set(key, entry);
    }
  } catch { /* unreadable cache is just an empty cache */ }
  return cache;
}

export function savePriceCache(cache, storage = globalThis.localStorage) {
  let entries = [...cache.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, PRICE_MAX_ENTRIES);
  for (let attempt = 0; attempt < 3; attempt++) {
    try { storage.setItem(PRICE_KEY, JSON.stringify(Object.fromEntries(entries))); return true; }
    catch { entries = entries.slice(0, Math.floor(entries.length / 2)); } // quota: keep the newest half
  }
  return false;
}
