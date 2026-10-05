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

export function selectHistory(items, filters = {}, now = new Date()) {
  const query = (filters.search || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const min = filters.min === '' || filters.min == null ? null : Number(filters.min);
  const max = filters.max === '' || filters.max == null ? null : Number(filters.max);
  let since = null;
  if (filters.period === 'today') since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (filters.period === '7d') since = now.getTime() - 7 * 86400000;
  if (filters.period === '30d') since = now.getTime() - 30 * 86400000;
  return items.map((item,index)=>({item,index})).filter(({item})=>{
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
