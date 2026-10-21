// Camera detections are not inventory quantities. A held card is counted once,
// regardless of how often the recognition engine confirms it.
export class ScanGate {
  constructor() { this.key = null; this.emptySince = null; this.emptyFrames = 0; }
  observe(result, now = performance.now()) {
    // Poor focus or an uncertain match is NOT proof that the card was removed.
    if (result.cardPresent !== false) {
      this.emptySince = null; this.emptyFrames = 0; return false;
    }
    this.emptySince ??= now;
    this.emptyFrames++;
    if (this.key && this.emptyFrames >= 3 && now - this.emptySince >= 1200) {
      this.key = null; return true;
    }
    return false;
  }
  accept(match) {
    const key = match.secondaryId || match.cardId;
    if (!key || key === this.key) return false;
    this.key = key; this.emptySince = null; this.emptyFrames = 0;
    return true;
  }
}

// One card at a time: refuses new scans while one is in progress and for a pause after it ends.
export class ScanLock {
  constructor(pauseMs = 2000) { this.pauseMs = pauseMs; this.busy = false; this.pausedUntil = 0; }
  canScan(now = performance.now()) { return !this.busy && now >= this.pausedUntil; }
  start() { this.busy = true; }
  finish(now = performance.now()) { this.busy = false; this.pausedUntil = now + this.pauseMs; }
}

export function selectHistory(items, filters = {}, now = new Date()) {
  const query = (filters.search || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const min = filters.min === '' || filters.min == null ? null : Number(filters.min);
  const max = filters.max === '' || filters.max == null ? null : Number(filters.max);
  let since = null;
  if (filters.period === 'today') since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (filters.period === '7d') since = now.getTime() - 7 * 86400000;
  if (filters.period === '30d') since = now.getTime() - 30 * 86400000;
  return items.map((item,index)=>({item,index})).filter(({item})=>{
    if (filters.period === 'batch' && item.batch !== filters.batchId) return false;
    const text = `${item.name} ${item.set} ${item.number}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    if (!text.includes(query)) return false;
    if (min !== null && (!Number.isFinite(item.price) || item.price < min)) return false;
    if (max !== null && (!Number.isFinite(item.price) || item.price > max)) return false;
    const time = Date.parse(item.scannedAt);
    if (since !== null && (!Number.isFinite(time) || time < since)) return false;
    return true;
  }).sort((a,b)=>{
    if (filters.sort?.startsWith('price')) {
      const ak=Number.isFinite(a.item.price), bk=Number.isFinite(b.item.price);
      if(ak!==bk) return ak ? -1 : 1; // Missing prices always last, including descending.
      if(ak && a.item.price!==b.item.price) return (a.item.price-b.item.price)*(filters.sort==='price-asc'?1:-1);
    }
    const at=Date.parse(a.item.scannedAt), bt=Date.parse(b.item.scannedAt);
    if(Number.isFinite(at)!==Number.isFinite(bt)) return Number.isFinite(at)?-1:1;
    const difference=Number.isFinite(at)&&Number.isFinite(bt) ? at-bt : a.index-b.index;
    return (difference || a.index-b.index)*(filters.sort==='oldest'?1:-1);
  }).map(({item})=>item);
}

// Editions strip: keep the printings whose set name, set code or collector number match the query.
export function filterEditions(printings, query, limit = 40) {
  const fold = (text) => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const words = fold(query).split(/\s+/).filter(Boolean);
  const matches = printings.filter((p) => {
    const haystack = fold(`${p.set_name} ${p.set} ${p.collector_number}`);
    return words.every((word) => haystack.includes(word));
  });
  return { shown: matches.slice(0, limit), hidden: Math.max(0, matches.length - limit) };
}

// The recognition engine tells apart printings with different artwork. The only real doubt is between
// printings of the SAME illustration (same art, different edition): those are the only ones to offer.
export const illustrationOf = (card) => card?.illustration_id || card?.card_faces?.[0]?.illustration_id || null;
export function sameIllustration(printings, card) {
  const art = illustrationOf(card);
  if (!art) return [];
  return printings.filter((p) => illustrationOf(p) === art);
}

// Several scans of the same printing (same finish and language) are shown as one line with a quantity.
export function groupEntries(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.id}|${item.finish || 'normal'}|${item.language || 'Fr'}`;
    const quantity = item.quantity || 1; const total = Number.isFinite(item.price) ? item.price * quantity : 0;
    const known = groups.get(key);
    if (known) { known.items.push(item); known.quantity += quantity; known.total += total; if (!Number.isFinite(item.price)) known.unpriced += quantity; }
    else groups.set(key, { key, rep: item, items: [item], quantity, total, unpriced: Number.isFinite(item.price) ? 0 : quantity });
  }
  return [...groups.values()];
}
