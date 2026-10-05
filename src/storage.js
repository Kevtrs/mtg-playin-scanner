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
