import './style.css';
import { ScanGate, ScanLock, selectHistory, filterEditions, sameIllustration, groupEntries } from './collection.js';
import { toCsv, makeBackup, parseBackup, mergeEntries, saveSafetyCopy, loadSafetyCopy } from './backup.js';
import { priceData, searchName, compactRows } from './playin.js';
import { cardmarketPrices, cardmarketUrl, sourceOf, totalsBySource } from './cardmarket.js';
import { PRICE_RELAY_URL } from './config.js';
import { loadSession, saveSession, loadPriceCache, savePriceCache, PRICE_TTL_MS } from './storage.js';

const $ = (id) => document.getElementById(id);
const els = {
  toggle: $('camera-toggle'), mode: $('scan'), status: $('status'), form: $('lookup-form'), set: $('set-code'),
  number: $('collector-number'),
  count: $('count'), total: $('total'), clear: $('clear-session'), network: $('network')
};

let scanner = null;
let scannerReady = false;
let scannerStarted = false;
let currentCard = null;
let currentPrice = null;
let currentPlayinRows = [];
let audioContext = null;
let currentEntry = null;
let currentFinish = 'normal';
let lookupSequence = 0;
const scanGate = new ScanGate();
let historyLimit = 30;
const openHistory = new Set();
const session = loadSession();
for (const item of session) {
  item.entryId ||= crypto.randomUUID();
  if (!item.prices) { item.prices = { normal:null, foil:null }; item.price = null; item.priceState = 'Ancien tarif à vérifier'; }
  item.finish ||= 'normal';
}
const priceText = (value) => Number.isFinite(value) ? money(value) : '—';
// Crash recovery: iOS reloads a page that runs out of memory. If scanning was active when the
// page was reloaded, remember it and switch to a lighter camera/scan profile.
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};
let crashedLastRun = false;
try { crashedLastRun = sessionStorage.getItem('mtg-scanning') === '1'; sessionStorage.removeItem('mtg-scanning'); } catch {}
if (crashedLastRun) { store.set('mtg-crashes', String(Number(store.get('mtg-crashes') || 0) + 1)); store.set('mtg-light-mode', '1'); }
const lightMode = store.get('mtg-light-mode') === '1';
// Diagnostic switches (Collection > Diagnostic): each turns one suspect off so a crash can be bisected.
const DX = ['nosw', 'noaudio', 'nooverlay', 'minimalui', 'fullres', 'catv2', 'nativevideo', 'nomemcap', 'oldort'];
const DX_DEMO = DX.filter((name) => name !== 'nativevideo' && name !== 'nomemcap' && name !== 'oldort'); // the demo profile never re-enables old behaviours
const dx = Object.fromEntries(DX.map((name) => [name, store.get(`dx-${name}`) === '1']));
const dxActive = DX.filter((name) => dx[name]);
const lightProfile = lightMode && !dx.fullres;
const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
for (const name of dxActive) document.documentElement.classList.add(`dx-${name}`);
const recordError = (message) => store.set('mtg-last-error', `${new Date().toLocaleString('fr-FR')} · ${String(message).slice(0, 160)}`);
// "Black box": the last 40 steps are kept in localStorage so that, after a reload, we can see what ran just before it.
const TRACE_KEY = 'mtg-trace';
function trace(label) {
  try {
    const lines = JSON.parse(localStorage.getItem(TRACE_KEY) || '[]');
    lines.push(`${new Date().toISOString().slice(5, 23).replace('T', ' ')} ${label}`);
    localStorage.setItem(TRACE_KEY, JSON.stringify(lines.slice(-70)));
  } catch {}
}
trace(`load ${performance.getEntriesByType('navigation')[0]?.type || '?'} crashed=${crashedLastRun} light=${lightMode} dx=[${dxActive.join(',') || '-'}] sw=${navigator.serviceWorker?.controller ? 'yes' : 'no'}`);
for (const type of ['pagehide', 'pageshow', 'freeze', 'resume']) window.addEventListener(type, () => trace(type));
navigator.serviceWorker?.addEventListener('controllerchange', () => trace('sw-controllerchange'));
window.addEventListener('error', (event) => recordError(`${event.message} (${(event.filename || '').split('/').pop()}:${event.lineno})`));
window.addEventListener('unhandledrejection', (event) => recordError(event.reason?.message || event.reason));
const bindAll = (name) => document.querySelectorAll(`[data-bind="${name}"]`);
const setBind = (name, text) => bindAll(name).forEach((node) => { node.textContent = text; });
const setPressed = (finish) => document.querySelectorAll('[data-finish]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.finish === finish)));
const currentLanguage = () => document.querySelector('.js-lang').value;
const money = (value) => Number.isFinite(value) ? value.toLocaleString('fr-FR', {style:'currency',currency:'EUR'}) : 'Indisponible';

// Preferences kept on the device.
let defaultFinish = store.get('mtg-default-finish') === 'foil' ? 'foil' : 'normal';
// Where the prices of NEW scans come from: Playin's buy price, or Cardmarket's trend price (via Scryfall, no extra request).
let priceSource = store.get('mtg-price-source') === 'cardmarket' ? 'cardmarket' : 'playin';
// What the card currently shown uses: the source of its own entry if it has one, otherwise the chosen mode.
const activeSource = () => (currentEntry ? sourceOf(currentEntry) : priceSource);
let valueThreshold = (() => { const stored = store.get('mtg-value-threshold'); const n = Number(stored); return stored !== null && Number.isFinite(n) && n >= 0 ? n : 5; })();
// A "pile" is a batch of scans (e.g. one sorting session) with its own subtotal; nothing is deleted when a new one starts.
let batch = (() => {
  try { const saved = JSON.parse(store.get('mtg-batch') || 'null'); if (saved?.id) return saved; } catch {}
  const fresh = { id: crypto.randomUUID(), startedAt: new Date().toISOString() }; store.set('mtg-batch', JSON.stringify(fresh)); return fresh;
})();
const isValuable = (price) => valueThreshold > 0 && Number.isFinite(price) && price >= valueThreshold;
const updateValuable = (price) => document.querySelectorAll('[data-valuable]').forEach((star) => { star.hidden = !isValuable(price); });

function thumbnailFor(item) {
  const thumbnail=document.createElement('div'); thumbnail.className='thumb'; thumbnail.setAttribute('aria-hidden','true');
  if(item.image && /^https:\/\/(cards\.scryfall\.io|images\.scryfall\.io)\//.test(item.image)) { const img=document.createElement('img'); img.src=item.image; img.alt=''; img.loading='lazy'; thumbnail.append(img); }
  else thumbnail.textContent=(item.set||'MTG').toUpperCase();
  return thumbnail;
}

function renderHistory() {
  if ($('collection-view').hidden) return; // no DOM/image churn while scanning
  const focused = document.activeElement;
  const focusEntry = focused?.closest('[data-entry]')?.dataset.entry;
  const focusAction = focused?.dataset.action;
  $('history').replaceChildren();
  const items = selectHistory(session, { search:$('history-search').value, sort:$('history-sort').value, period:$('history-period').value, min:$('history-min').value, max:$('history-max').value, batchId:batch.id, source:$('history-source').value });
  const groups = groupEntries(items);
  const count = groups.reduce((sum, group) => sum + group.quantity, 0);
  const subtotal = groups.reduce((sum, group) => sum + group.total, 0);
  const valuable = valueThreshold > 0 ? groups.reduce((sum, group) => sum + (isValuable(group.rep.price) ? group.quantity : 0), 0) : 0;
  const filtered = items.length !== session.length;
  const parts = [];
  if (session.length && filtered) parts.push(`${count} carte${count===1?'':'s'} · ${money(subtotal)} dans cette sélection`);
  if (valuable) parts.push(`★ ${valuable} de valeur (dès ${money(valueThreshold)})`);
  $('history-summary').textContent = parts.join(' · ');
  $('history-more').hidden = groups.length <= historyLimit;
  if (!groups.length) {
    const empty=document.createElement('div'); empty.className='empty-history';
    const title=document.createElement('strong'); const hint=document.createElement('span');
    if(session.length) { title.textContent='Aucun résultat'; hint.textContent='Aucune carte ne correspond à ces filtres.'; }
    else { title.textContent='Ta collection est vide'; hint.textContent='Scanne une carte : elle apparaîtra ici avec son prix de rachat.'; }
    empty.append(title,hint); $('history').append(empty); $('history').style.display='block';
  } else $('history').style.display='';
  for (const group of groups.slice(0, historyLimit)) {
    const item = group.rep; const quantity = group.quantity;
    const row = document.createElement('details'); row.className = 'history-item'; row.dataset.entry = group.key; row.open = openHistory.has(group.key);
    if (isValuable(item.price)) row.classList.add('is-valuable');
    row.addEventListener('toggle',()=>{if(row.isConnected) row.open?openHistory.add(group.key):openHistory.delete(group.key);});
    const summary=document.createElement('summary'); summary.dataset.action='expand';
    const thumbnail=thumbnailFor(item);
    const body=document.createElement('div'); body.className='history-body';
    const name=document.createElement('strong'); name.textContent=item.name;
    if (isValuable(item.price)) { const star=document.createElement('span'); star.className='star'; star.textContent='★'; star.setAttribute('aria-label','Carte de valeur'); name.append(star); }
    const info=document.createElement('span'); info.className='history-meta'; info.textContent=`${(item.set||'').toUpperCase()} · #${item.number} · ${sourceOf(item)==='cardmarket' ? 'Cardmarket' : (item.language||'Fr').toUpperCase()} · ${item.finish==='foil'?'Foil':'Normal'}`;
    const time=document.createElement('time'); time.className='history-time';
    const date=new Date(item.scannedAt); time.textContent=Number.isNaN(date.getTime())?'Date inconnue':date.toLocaleString('fr-FR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); if(!Number.isNaN(date.getTime())) time.dateTime=date.toISOString();
    body.append(name,info,time);
    const price=document.createElement('div'); price.className='history-price';
    const amount=document.createElement('strong'); amount.textContent=Number.isFinite(item.price)?money(item.price):'—';
    const small=document.createElement('small'); small.textContent = quantity>1 ? `×${quantity}${group.total?` · ${money(group.total)}`:''}` : (Number.isFinite(item.price)?'':item.priceState||'Sans tarif'); price.append(amount,small);
    summary.append(thumbnail,body,price);
    const controls=document.createElement('div'); controls.className='history-details';
    const prices=document.createElement('p'); prices.textContent=`Normal ${priceText(item.prices.normal)} · Foil ${priceText(item.prices.foil)}`;
    const toggle=document.createElement('div'); toggle.className='finish-toggle'; toggle.setAttribute('role','group'); toggle.setAttribute('aria-label',`Finition de ${item.name}`);
    for(const [value,text] of [['normal','Normal'],['foil','Foil']]) {
      const option=document.createElement('button'); option.type='button'; option.dataset.action='finish-'+value; option.textContent=text; option.setAttribute('aria-pressed',String(item.finish===value));
      option.onclick=()=>{ for (const member of group.items) { member.finish=value; member.price=member.prices[value]; if(currentEntry===member){currentFinish=value; paintPrices(member);} } updateSession(); };
      toggle.append(option);
    }
    const remove=document.createElement('button'); remove.type='button'; remove.className='remove'; remove.dataset.action='remove';
    remove.innerHTML='<svg class="i" aria-hidden="true"><use href="#i-trash"/></svg>'; remove.append(quantity>1?'Retirer un exemplaire':'Supprimer la carte');
    remove.onclick=()=>removeOne(group);
    controls.append(prices,toggle,remove);
    if (quantity>1 && group.items.length>1) {
      const all=document.createElement('button'); all.type='button'; all.className='remove remove-all'; all.dataset.action='remove-all'; all.textContent=`Supprimer les ${quantity} exemplaires`;
      all.onclick=()=>removeAll(group); controls.append(all);
    }
    row.append(summary,controls); $('history').append(row);
    if(focusEntry===group.key && focusAction) row.querySelector(`[data-action="${focusAction}"]`)?.focus({preventScroll:true});
  }
}

// Removing is always undoable from a toast.
function removeOne(group) {
  const member = group.items.reduce((latest, other) => session.indexOf(other) > session.indexOf(latest) ? other : latest);
  if ((member.quantity || 1) > 1) {
    member.quantity--; updateSession();
    showToast('Exemplaire retiré', 'Annuler', () => { member.quantity++; updateSession(); });
  } else {
    const index = session.indexOf(member); session.splice(index, 1); if (currentEntry === member) currentEntry = null; updateSession();
    showToast('Carte retirée', 'Annuler', () => { session.splice(Math.min(index, session.length), 0, member); updateSession(); });
  }
}
function removeAll(group) {
  const removed = group.items.map((item) => ({ item, index: session.indexOf(item) })).sort((a, b) => a.index - b.index);
  for (const { item } of [...removed].reverse()) session.splice(session.indexOf(item), 1);
  if (removed.some(({ item }) => item === currentEntry)) currentEntry = null;
  updateSession();
  showToast(`${removed.length} cartes retirées`, 'Annuler', () => { for (const { item, index } of removed) session.splice(Math.min(index, session.length), 0, item); updateSession(); });
}

// One toast for every undo (scan, removal, clearing). It sits at the top so it never covers the scan button.
let toastTimer = null; let toastFn = null;
function showToast(text, cta, fn, ms = 6000) {
  toastFn = fn || null; $('toast-text').textContent = text; $('toast-cta').textContent = fn ? cta : '';
  $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { clearTimeout(toastTimer); toastFn = null; $('toast').hidden = true; }
$('toast').addEventListener('click', () => { const fn = toastFn; hideToast(); fn?.(); });

// Last scans: tap one to bring it back in the sheet (change edition / finish, see its price).
const cardCache = new Map();
function renderRecent() {
  const last = session.slice(-5).reverse();
  $('recent').hidden = !last.length;
  const list = $('recent-list'); list.replaceChildren();
  for (const entry of last) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'recent-item';
    button.setAttribute('aria-pressed', String(entry === currentEntry));
    button.setAttribute('aria-label', `${entry.name}, ${entry.setName || entry.set}, ${Number.isFinite(entry.price) ? money(entry.price) : 'sans prix'} : corriger`);
    button.append(thumbnailFor(entry));
    const price = document.createElement('b'); price.textContent = Number.isFinite(entry.price) ? money(entry.price) : (entry.priceState === 'Recherche…' ? '…' : '—'); button.append(price);
    button.addEventListener('click', () => selectEntry(entry));
    list.append(button);
  }
  const pile = session.filter((entry) => entry.batch === batch.id);
  $('pile-chip').textContent = pile.length ? `Pile ${pile.length} · ${pileTotalText(pile)}` : '';
}
async function selectEntry(entry) {
  if (currentEntry === entry) return;
  try {
    let card = cardCache.get(entry.id);
    if (!card) {
      const response = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(entry.id)}`, { headers: { Accept: 'application/json;q=0.9,*/*;q=0.8' }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Scryfall ${response.status}`);
      card = await response.json(); cardCache.set(entry.id, card);
    }
    lookupSequence++; currentCard = card; currentEntry = entry; currentFinish = entry.finish;
    applySource(); renderCard(card); showEditions(card); if (sourceOf(entry) === 'playin') queryPlayinPrice(card, entry); renderRecent();
  } catch (error) { setStatus(`Carte introuvable : ${error.message}`, true); }
}

// Heat/battery: the recognition engine runs on the CPU. Slow it down when no card is in
// view, and stop the camera after a while without a scan or when the app is backgrounded.
const SCAN_INTERVAL_ACTIVE_MS = lightProfile ? 1000 : 700;
const SCAN_INTERVAL_IDLE_MS = lightProfile ? 1600 : 1200;
const AUTO_PAUSE_MS = 60000;
let scanInterval = SCAN_INTERVAL_ACTIVE_MS;
let emptyResults = 0;
let lastActivity = performance.now();
let idleTimer = null;

// Each analysis of a card that IS in front of the camera is the heavy one (dewarp, embedding, catalogue search).
// Crash reports show the page being killed a few seconds after a card was recognised, while it stayed in view
// and kept being analysed every second. Once a card is recognised we therefore hold off until it leaves the frame
// or a different card shows up, which also gives the browser time to free the memory of the previous analyses.
const SCAN_INTERVAL_HELD_MS = 2500;
let heldKey = null;
const keyOf = (item) => item?.secondaryId || item?.cardId || null;

function tuneScanRate(result, instance) {
  emptyResults = result.cardPresent === false ? emptyResults + 1 : 0;
  if (heldKey && (result.cardPresent === false || (keyOf(result) && keyOf(result) !== heldKey))) heldKey = null;
  const wanted = heldKey ? SCAN_INTERVAL_HELD_MS : (emptyResults >= 3 ? SCAN_INTERVAL_IDLE_MS : SCAN_INTERVAL_ACTIVE_MS);
  if (wanted !== scanInterval) { scanInterval = wanted; instance.updateConfig({ scanIntervalMs: wanted }); }
}
function holdCard(match) {
  heldKey = keyOf(match);
  if (heldKey && scanner && scanInterval !== SCAN_INTERVAL_HELD_MS) { scanInterval = SCAN_INTERVAL_HELD_MS; scanner.updateConfig({ scanIntervalMs: scanInterval }); }
}

// Analyses with the size of the engine's WebAssembly heap, written into the black box (its lines are the ones
// that provably survive a crash). "absent" means the engine did not send the measurement. Empty frames are sampled.
let emptySamples = 0;
function recordMem(result) {
  const empty = result.cardPresent === false;
  if (empty && (emptySamples++ % 5 !== 0)) return;
  const ms = Number.isFinite(result.timing?.totalMs) ? ` ${Math.round(result.timing.totalMs)}ms` : '';
  trace(`analyse ${empty ? 'vide' : 'carte'} wasm=${typeof result.wasmMB === 'number' ? `${result.wasmMB}Mo` : 'absent'}${ms}${heldKey ? ' (attente)' : ''}`);
}

function pauseScanner(message) {
  if (!scannerStarted || !scanner) return;
  scanner.stop(); setCamera(false); setStatus(message);
}

// Canvas preview (15 fps), painted from the hidden <video> with a "cover" crop.
const PREVIEW_INTERVAL_MS = 1000 / 15;
let previewFrame = null;
let previewLast = 0;
function stopPreview() { if (previewFrame !== null) cancelAnimationFrame(previewFrame); previewFrame = null; const canvas = $('preview'); canvas.width = 0; canvas.height = 0; }
function startPreview() {
  stopPreview();
  if (dx.nativevideo) return;
  const canvas = $('preview'); const ctx = canvas.getContext('2d', { alpha: false });
  const draw = (now) => {
    previewFrame = requestAnimationFrame(draw);
    if (now - previewLast < PREVIEW_INTERVAL_MS) return;
    previewLast = now;
    const video = document.querySelector('#cv-scanner video');
    if (!video || !video.videoWidth) return;
    const width = canvas.clientWidth; const height = canvas.clientHeight;
    if (!width || !height) return;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
    const drawWidth = video.videoWidth * scale; const drawHeight = video.videoHeight * scale;
    ctx.drawImage(video, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  };
  previewFrame = requestAnimationFrame(draw);
}

// The WebAssembly heap of the recognition engine never shrinks; terminating its worker is the only way to give
// that memory back. Do it once the camera has been off for a while; the next start reloads the engine from cache.
let releaseTimer = null;
function releaseEngine() {
  if (!scanner || scannerStarted) return;
  try { scanner.dispose(); } catch { /* already gone */ }
  scanner = null; scannerReady = false; els.mode.textContent = 'Moteur en attente'; trace('engine released');
}

function setCamera(running) {
  clearTimeout(releaseTimer); if (!running) releaseTimer = setTimeout(releaseEngine, 20000);
  scannerStarted = running; trace(running ? 'camera start' : 'camera stop');
  $('camera-label').textContent = running ? 'Arrêter le scanner' : 'Démarrer le scanner';
  els.toggle.dataset.running = String(running);
  $('viewfinder').dataset.live = String(running);
  running ? startPreview() : stopPreview();
  try { running ? sessionStorage.setItem('mtg-scanning', '1') : sessionStorage.removeItem('mtg-scanning'); } catch {}
  clearInterval(idleTimer); idleTimer = null;
  if (running) {
    lastActivity = performance.now(); emptyResults = 0; heldKey = null;
    if (scanInterval !== SCAN_INTERVAL_ACTIVE_MS && scanner) { scanInterval = SCAN_INTERVAL_ACTIVE_MS; scanner.updateConfig({ scanIntervalMs: scanInterval }); }
    idleTimer = setInterval(() => { if (performance.now() - lastActivity > AUTO_PAUSE_MS) pauseScanner('Scanner en pause pour éviter que le téléphone chauffe. Touche Démarrer pour reprendre.'); }, 5000);
  }
}
document.addEventListener('visibilitychange', () => { trace(document.hidden ? 'hidden' : 'visible'); if (document.hidden) pauseScanner('Scanner en pause. Touche Démarrer pour reprendre.'); });

function setStatus(message, error = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', error);
}

// "12,30 €" when the pile has a single source, otherwise each total is labelled.
function pileTotalText(items) {
  const t = totalsBySource(items);
  if (t.playin.cards && t.cardmarket.cards) return `${money(t.playin.sum)} Playin · ${money(t.cardmarket.sum)} Cardmarket`;
  return t.cardmarket.cards ? `${money(t.cardmarket.sum)} Cardmarket` : money(t.playin.sum);
}
let safetyTimer = null;
function updateSession() {
  els.count.textContent = session.reduce((sum, item) => sum + (item.quantity || 1), 0);
  $('collection-count').textContent=els.count.textContent;
  const totals = totalsBySource(session);
  els.total.textContent = money(totals.playin.sum);
  $('coll-label').textContent = totals.cardmarket.cards ? 'Valeur de rachat Playin' : 'Valeur de rachat connue';
  $('cm-line').hidden = !totals.cardmarket.cards; $('cm-total').textContent = money(totals.cardmarket.sum);
  const unknown=session.reduce((sum,item)=>sum+(Number.isFinite(item.price)?0:(item.quantity||1)),0);
  $('unpriced').textContent=unknown ? `${unknown} sans tarif confirmé` : '';
  const pile = session.filter((item) => item.batch === batch.id);
  $('pile-line').textContent = pile.length ? `Pile en cours : ${pile.length} carte${pile.length===1?'':'s'} · ${pileTotalText(pile)}` : 'Pile en cours : vide';
  if(!saveSession(session)) setStatus('Stockage plein ou bloqué : la collection ne peut pas être sauvegardée.', true);
  clearTimeout(safetyTimer); safetyTimer = setTimeout(() => { saveSafetyCopy(session); refreshDataLine(); }, 5000); // automatic hourly safety copy, off the scan's critical moment
  renderRecent(); renderHistory();
}

async function loadScanner() {
  if (scanner) return scanner;
  setStatus('Chargement du moteur visuel et du catalogue MTG…');
  try {
    const moduleUrl = new URL('./cv/lib/collectorvision-scanner-applet.mjs', window.location.href);
    moduleUrl.search = `?v=${BUILD_ID}${dx.nomemcap ? '&nocap=1' : ''}`; // the applet copies this query to its worker URL
    const { createCollectorVisionScannerApplet } = await import(/* @vite-ignore */ moduleUrl.href);
    scanner = await createCollectorVisionScannerApplet({
      ...(dx.oldort ? { workerUrl: new URL(`./cv/scanner.worker.old.mjs${moduleUrl.search}`, window.location.href).href } : {}), // never pass `undefined`: it would override the default
      target: '#cv-scanner', autoStart: false, matchThreshold: 0.48, consecutiveMatches: 2,
      scanIntervalMs: SCAN_INTERVAL_ACTIVE_MS, camera: lightProfile ? { width: { ideal: 640 }, height: { ideal: 480 } } : undefined, cooldownMs: 2600, groupBySecondaryId: true, showFpsOverlay: false, overlay: !dx.nooverlay, catalogMode: dx.catv2 ? 'v2' : 'v1', rotationInvariant: !lightProfile,
      onReady() {
        scannerReady = true; trace('engine ready');
        els.mode.textContent = 'Moteur prêt';
        setStatus(scannerStarted ? 'Présente une carte entière à la caméra.' : 'Moteur prêt. Appuie sur Démarrer puis présente une carte entière.');
      },
      onProgress(progress) {
        const label = progress.message || progress.stage || 'Préparation du catalogue';
        setStatus(`${label}… Le premier chargement télécharge environ 40 Mo.`);
      },
      onResult(result, instance) {
        recordMem(result); tuneScanRate(result, instance);
        if(scanGate.observe(result)) {
          instance.bucket?.reset();
          setStatus('Cadre libre. Présente la carte suivante.');
        }
      },
      onCardDetected(result) { handleVisualMatch(result); },
      onError(error) { trace(`engine error ${error.message}`); setStatus(`Scanner visuel : ${error.message}`, true); }
    });
    return scanner;
  } catch (error) {
    setStatus(`Impossible de charger le moteur visuel : ${error.message}`, true);
    throw error;
  }
}

async function toggleScanner() {
  try {
    if (!dx.noaudio) {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === 'suspended') await audioContext.resume();
    }
    const instance = await loadScanner();
    if (scannerStarted) {
      instance.stop(); setCamera(false); setStatus('Scanner arrêté.');
    } else {
      await instance.start(); setCamera(true);
      setStatus(scannerReady ? 'Présente une carte entière à la caméra.' : 'Caméra prête, chargement du modèle…');
    }
  } catch (error) {
    if (error.name === 'NotAllowedError') setStatus('Autorise la caméra dans les réglages Safari.', true);
    else if (error.name === 'NotFoundError') setStatus('Aucune caméra détectée.', true);
    else if (error.name === 'NotReadableError') setStatus('La caméra est utilisée par une autre application.', true);
    else if (!scanner) return;
    else setStatus(`Démarrage impossible : ${error.message}`, true);
  }
}

// One card at a time: no new scan while the previous one is still being identified
// and priced (whether or not a price comes back), then a short pause before the next.
const scanLock = new ScanLock(0);

async function handleVisualMatch(match) {
  if (!scanLock.canScan() || editionsOpen) return; // no new scan while the edition choice is open
  if(!scanGate.accept(match)) return;
  holdCard(match);
  scanLock.start(); lastActivity = performance.now(); trace(`scan detect ${match.cardId?.slice(0, 8)} score=${match.score?.toFixed?.(2)}`);
  const sequence = ++lookupSequence;
  setStatus(`Carte détectée (${Math.round(match.score * 100)} %). Identification…`);
  try {
    const response = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(match.cardId)}`, { headers: { Accept: 'application/json;q=0.9,*/*;q=0.8' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Scryfall ${response.status}`);
    const card = await response.json(); trace('scan scryfall-ok');
    const entry = addCardToSession(card); trace('scan added');
    cardCache.set(card.id, card); if (cardCache.size > 30) cardCache.delete(cardCache.keys().next().value);
    offerUndoAdd(entry);
    let editionsReady = null;
    if(sequence === lookupSequence) {currentCard = card; currentEntry=entry; currentFinish=defaultFinish; applySource(); renderCard(card); editionsReady = showEditions(card); renderRecent();}
    trace('scan rendered'); beep(); trace('scan beep');
    if (navigator.vibrate) navigator.vibrate(80);
    flashScan('success');
    if(sequence===lookupSequence) setStatus(`${card.name} ajoutée ✓ Recherche du prix…`);
    if (entry.source !== 'cardmarket') { trace('scan price-start'); await queryPlayinPrice(card, entry); }
    trace(`scan price-done ${Number.isFinite(entry.price) ? 'ok' : 'none'}`);
    if (!Number.isFinite(entry.price)) { flashScan('warn'); beep('none'); if (navigator.vibrate) navigator.vibrate([60, 60, 60]); }
    if(sequence===lookupSequence) setStatus(`${card.name} ajoutée ✓ ${Number.isFinite(entry.price) ? money(entry.price) : 'Prix indisponible'}. Retire-la pour scanner la suivante.`);
    // Cardmarket mode asks which edition it is (only when the same artwork exists in several editions: that is the real doubt).
    if (entry.source === 'cardmarket' && editionsReady) {
      await editionsReady;
      if (sequence === lookupSequence && currentEntry === entry && currentPrintings.length >= 2) openEditions({ ask: true });
    }
  } catch (error) { trace(`scan error ${error.message}`); setStatus(`Identification impossible : ${error.message}. Retire la carte puis représente-la.`, true); }
  finally { scanLock.finish(); trace('scan end'); }
}

function addCardToSession(card) {
  const item = { entryId:crypto.randomUUID(), id: card.id, name: card.name, image:imageOf(card), set: card.set, number: card.collector_number, setName: card.set_name, promo: card.promo, fullArt: card.full_art, frameEffects: card.frame_effects, price: null, quantity: 1, prices:{normal:null,foil:null}, finish:defaultFinish, language:currentLanguage(), priceState:'Recherche…', scannedAt:new Date().toISOString(), batch:batch.id, source: priceSource };
  if (priceSource === 'cardmarket') { item.prices = cardmarketPrices(card); item.price = item.prices[item.finish]; item.priceState = ''; }
  session.push(item);
  updateSession();
  return item;
}

function beep(kind = 'ok') {
  if (!audioContext) return;
  const tones = kind === 'none' ? [440, 330] : [880];
  tones.forEach((frequency, index) => {
    const start = audioContext.currentTime + index * 0.16;
    const oscillator = audioContext.createOscillator(); const gain = audioContext.createGain(); oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(.08, start); gain.gain.exponentialRampToValueAtTime(.001, start + .12);
    oscillator.connect(gain).connect(audioContext.destination); oscillator.start(start); oscillator.stop(start + .12);
  });
}
function flashScan(kind) { const flash = $('scan-flash'); flash.classList.add(kind); setTimeout(() => flash.classList.remove(kind), 320); }
function offerUndoAdd(entry) {
  showToast(`${entry.name} ajoutée`, 'Annuler', () => {
    const index = session.indexOf(entry); if (index >= 0) session.splice(index, 1);
    if (currentEntry === entry) currentEntry = null;
    updateSession(); setStatus(`${entry.name} retirée. Retire-la du cadre avant de la rescanner.`);
  });
}

const LAST_SET_KEY = 'mtg-last-set';
const setSearchStatus = (message, error = false) => { $('search-status').textContent = message; $('search-status').classList.toggle('error', error); };
let numberDone = false;

async function lookupCard(set, number) {
  set = set.trim().toLowerCase(); number = number.trim().replace(/^0+(?=\d)/, '');
  if (!set || !number) return setSearchStatus('Indique l’édition et le numéro.', true);
  try { localStorage.setItem(LAST_SET_KEY, set); } catch {}
  numberDone = true; els.number.blur();
  setSearchStatus('Identification via Scryfall…'); $('search-result').hidden = true;
  try {
    const response = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(set)}/${encodeURIComponent(number)}`, { headers: { Accept: 'application/json;q=0.9,*/*;q=0.8' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(response.status === 404 ? `aucune carte ${set.toUpperCase()} n° ${number}` : `Scryfall ${response.status}`);
    currentCard = await response.json(); currentEntry=null; currentFinish=defaultFinish; applySource(); renderCard(currentCard); if (priceSource === 'playin') queryPlayinPrice(currentCard); showEditions(currentCard);
    $('search-result').hidden = false; setSearchStatus('Carte trouvée.');
  } catch (error) { setSearchStatus(`Identification impossible : ${error.message}.`, true); }
}

const imageOf = (card) => card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || '';
const SCRYFALL_IMAGE = /^https:\/\/(cards|images)\.scryfall\.io\//;

function renderCardInfo(card) {
  setBind('name', card.printed_name || card.name);
  setBind('meta', `${card.set_name} · ${card.set.toUpperCase()} #${card.collector_number}`);
  const src = imageOf(card);
  bindAll('thumb').forEach((thumb) => {
    thumb.replaceChildren();
    if (SCRYFALL_IMAGE.test(src)) { const img = document.createElement('img'); img.alt = ''; img.src = src; thumb.append(img); }
  });
}

function renderCard(card) {
  renderCardInfo(card);
  setPressed(currentFinish); updateValuable(null);
  if (activeSource() === 'cardmarket') { paintCardmarket(); return; } // the price is already in the card data: nothing to wait for
  setBind('normal', '…'); setBind('foil', '…'); setBind('note', 'Recherche du prix de rachat sur Playin…');
}

// ── Editions: offered on demand, and only for printings that share the scanned card's illustration ──
const printingsCache = new Map();
let currentPrintings = [];
let editionFilter = '';
let playinSettled = false; // true once the Playin request for the current card is over (success or not)
let editionsOpen = false;
let editionsAsk = false;
let zoomList = [];
let zoomIndex = 0;
const normalImageOf = (c) => c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal || '';
const slimPrinting = (c) => ({ id: c.id, oracle_id: c.oracle_id, name: c.name, printed_name: c.printed_name, set: c.set, set_name: c.set_name, collector_number: c.collector_number, lang: c.lang, released_at: c.released_at, promo: c.promo, full_art: c.full_art, frame_effects: c.frame_effects, foil: c.foil, prices: { eur: c.prices?.eur ?? null, eur_foil: c.prices?.eur_foil ?? null }, purchase_uris: { cardmarket: c.purchase_uris?.cardmarket ?? null }, illustration_id: c.illustration_id || c.card_faces?.[0]?.illustration_id, image_uris: { small: imageOf(c), normal: normalImageOf(c) }, prints_search_uri: c.prints_search_uri });

async function loadPrintings(card) {
  const key = card.oracle_id || card.id;
  if (printingsCache.has(key)) return printingsCache.get(key);
  if (!card.prints_search_uri) return [slimPrinting(card)];
  const response = await fetch(card.prints_search_uri, { headers: { Accept: 'application/json;q=0.9,*/*;q=0.8' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Scryfall ${response.status}`);
  const list = (await response.json()).data.filter((c) => imageOf(c)).map(slimPrinting);
  printingsCache.set(key, list);
  return list;
}

// Looks up the doubtful editions in the background; nothing opens by itself, only a button appears.
async function showEditions(card) {
  currentPrintings = []; editionFilter = ''; closeEditions(); updateEditionsButtons();
  try {
    const list = await loadPrintings(card);
    if (!currentCard || searchName(currentCard) !== searchName(card)) return; // the user moved on
    const scanned = list.find((p) => p.id === card.id) || slimPrinting(card);
    const siblings = sameIllustration(list, scanned).filter((p) => p.id !== scanned.id);
    currentPrintings = siblings.length ? [scanned, ...siblings] : [];
    updateEditionsButtons();
  } catch (error) { trace(`editions error ${error.message}`); }
}

function updateEditionsButtons() {
  const count = currentPrintings.length;
  document.querySelectorAll('.js-ed-open').forEach((button) => { button.hidden = count < 2; button.querySelector('.ed-open-count').textContent = String(count); });
}

const editionPrices = (printing) => currentPlayinRows.length ? priceData(printing, currentPlayinRows, currentLanguage()) : null;
const editionPriceText = (printing, finish) => { if (activeSource() === 'cardmarket') return priceText(cardmarketPrices(printing)[finish]); const prices = editionPrices(printing); return prices ? priceText(prices[finish]) : (playinSettled ? '—' : '…'); };

function renderEditions(scrollToSelected = false) {
  updateEditionsButtons();
  if (!$('ed-zoom').hidden) renderZoom();
  if ($('ed-sheet').hidden) return;
  const { shown, hidden } = filterEditions(currentPrintings, editionFilter);
  const finish = currentEntry?.finish || currentFinish;
  $('ed-filter-wrap').hidden = currentPrintings.length <= 8;
  $('ed-title').textContent = editionsAsk ? `Quelle édition ? (${currentPrintings.length})` : `Éditions (${currentPrintings.length})`;
  $('ed-hint').hidden = !editionsAsk;
  if (editionsAsk) $('ed-hint').textContent = `Touche une carte pour la voir en grand et la choisir. Ferme pour garder l’édition scannée (${(currentEntry?.set || '').toUpperCase()} #${currentEntry?.number ?? ''}).`;
  const strip = $('ed-strip'); strip.replaceChildren();
  shown.forEach((printing, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'ed'; button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(printing.id === currentCard?.id)); button.dataset.id = printing.id;
    button.setAttribute('aria-label', `${printing.set_name} ${printing.set.toUpperCase()} numéro ${printing.collector_number} : voir en grand`);
    const frame = document.createElement('div'); frame.className = 'ed-img';
    if (SCRYFALL_IMAGE.test(imageOf(printing))) { const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.src = imageOf(printing); frame.append(img); }
    const set = document.createElement('div'); set.className = 'ed-set';
    const icon = document.createElement('img'); icon.alt = ''; icon.loading = 'lazy'; icon.src = `https://svgs.scryfall.io/sets/${encodeURIComponent(printing.set)}.svg`; icon.onerror = () => icon.remove();
    set.append(icon, `${printing.set.toUpperCase()} #${printing.collector_number}`);
    const name = document.createElement('div'); name.className = 'ed-name'; name.textContent = printing.set_name;
    const price = document.createElement('div'); price.className = 'ed-price'; price.textContent = editionPriceText(printing, finish);
    button.append(frame, set, name, price);
    button.addEventListener('click', () => openZoom(shown, index));
    strip.append(button);
  });
  if (!shown.length) { const none = document.createElement('div'); none.className = 'ed-more'; none.textContent = 'Aucune édition ne correspond.'; strip.append(none); }
  if (hidden) { const more = document.createElement('div'); more.className = 'ed-more'; more.textContent = `+${hidden} autres : filtre pour les voir`; strip.append(more); }
  if (scrollToSelected) strip.querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function openEditions({ ask = false } = {}) {
  if (currentPrintings.length < 2) return;
  editionsOpen = true; editionsAsk = ask;
  $('ed-sheet').hidden = false;
  document.querySelectorAll('.js-ed-open').forEach((button) => button.setAttribute('aria-expanded', 'true'));
  renderEditions(true);
}
function closeEditions() {
  closeZoom();
  editionsOpen = false; editionsAsk = false;
  $('ed-sheet').hidden = true;
  document.querySelectorAll('.js-ed-open').forEach((button) => button.setAttribute('aria-expanded', 'false'));
}

// Full-size view: swipe or use the arrows to flip between editions and compare them with the real card.
function openZoom(list, index) { zoomList = list; zoomIndex = index; $('ed-zoom').hidden = false; renderZoom(); $('ed-zoom-choose').focus({ preventScroll: true }); }
function closeZoom() { $('ed-zoom').hidden = true; $('ed-zoom-img').removeAttribute('src'); }
function stepZoom(delta) { const next = zoomIndex + delta; if (next < 0 || next >= zoomList.length) return; zoomIndex = next; renderZoom(); }
function renderZoom() {
  const printing = zoomList[zoomIndex]; if (!printing) return;
  const big = normalImageOf(printing) || imageOf(printing);
  const img = $('ed-zoom-img'); img.alt = `${printing.printed_name || printing.name}, ${printing.set_name}`;
  if (SCRYFALL_IMAGE.test(big) && img.getAttribute('src') !== big) img.src = big;
  for (const neighbour of [zoomList[zoomIndex + 1], zoomList[zoomIndex - 1]]) { // warm the next card so flipping is instant
    const url = neighbour && normalImageOf(neighbour); if (url && SCRYFALL_IMAGE.test(url)) new Image().src = url;
  }
  $('ed-zoom-count').textContent = `${zoomIndex + 1} / ${zoomList.length}`;
  $('ed-zoom-set').textContent = `${printing.set_name} · ${printing.set.toUpperCase()} #${printing.collector_number}`;
  $('ed-zoom-prices').textContent = `Normal ${editionPriceText(printing, 'normal')} · Foil ${editionPriceText(printing, 'foil')}`;
  $('ed-zoom-prev').disabled = zoomIndex === 0; $('ed-zoom-next').disabled = zoomIndex === zoomList.length - 1;
  const current = printing.id === currentCard?.id; const choose = $('ed-zoom-choose');
  choose.disabled = current; choose.textContent = current ? '✓ Édition actuelle' : 'Choisir cette édition';
}
function chooseFromZoom() { const printing = zoomList[zoomIndex]; if (!printing) return; chooseEdition(printing); closeEditions(); }

function chooseEdition(printing) {
  if (!printing || printing.id === currentCard?.id) return;
  currentCard = printing;
  if (currentEntry) Object.assign(currentEntry, { id: printing.id, image: imageOf(printing), set: printing.set, number: printing.collector_number, setName: printing.set_name, promo: printing.promo, fullArt: printing.full_art, frameEffects: printing.frame_effects });
  renderCardInfo(printing);
  if (activeSource() === 'cardmarket') paintCardmarket();
  else if (currentPlayinRows.length) showBestPlayinPrice(); else { const none = playinSettled ? '—' : '…'; setBind('normal', none); setBind('foil', none); }
  trace(`edition ${printing.set}#${printing.collector_number}`);
  renderEditions(); updateSession();
}
document.querySelectorAll('.js-ed-open').forEach((button) => button.addEventListener('click', () => ($('ed-sheet').hidden ? openEditions() : closeEditions())));
$('ed-close').addEventListener('click', closeEditions);
$('ed-filter-input').addEventListener('input', () => { editionFilter = $('ed-filter-input').value; renderEditions(); });
$('ed-zoom-close').addEventListener('click', closeZoom);
$('ed-zoom-prev').addEventListener('click', () => stepZoom(-1));
$('ed-zoom-next').addEventListener('click', () => stepZoom(1));
$('ed-zoom-choose').addEventListener('click', chooseFromZoom);
{
  let touchStartX = null;
  const stage = $('ed-zoom-stage');
  stage.addEventListener('touchstart', (event) => { touchStartX = event.changedTouches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', (event) => {
    if (touchStartX === null) return;
    const dx = event.changedTouches[0].clientX - touchStartX; touchStartX = null;
    if (Math.abs(dx) > 40) stepZoom(dx < 0 ? 1 : -1);
  }, { passive: true });
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { if (!$('ed-zoom').hidden) closeZoom(); else if (!$('ed-sheet').hidden) closeEditions(); }
  else if (!$('ed-zoom').hidden && event.key === 'ArrowRight') stepZoom(1);
  else if (!$('ed-zoom').hidden && event.key === 'ArrowLeft') stepZoom(-1);
});

function directPlayinUrl(card) { return `https://rachat.play-in.com/magic/result.php?r=${encodeURIComponent(searchName(card))}`; }

function parsePlayinRows(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('.filterElement.cards')].map((row) => {
    const names = [...row.querySelectorAll('.name_hover')].map((node) => node.textContent.trim());
    const edition = row.querySelector('.ext img')?.getAttribute('title')?.trim() || '';
    const variants = [...row.querySelectorAll('select.update_variation_sell option[data-prix]')].map((option) => ({
      label: option.textContent.replace(/\s+/g, ' ').trim(),
      price: Number(option.dataset.prix),
      foil: option.dataset.foil === 'O'
    }));
    return { nameFr: names[0] || '', nameEn: names[1] || names[0] || '', edition, variants };
  }).filter((row) => row.variants.length);
}

function paintPrices(item) {
  setBind('normal', priceText(item.prices.normal)); setBind('foil', priceText(item.prices.foil)); updateValuable(item.prices[item.finish]);
  if (item.prices.source === 'cardmarket') {
    setBind('note', `${item.prices.edition || 'Édition inconnue'} · Cardmarket, tendance (prix du jour) · ${item.finish==='foil'?'Foil':'Normal'} compté dans le total.${Number.isFinite(item.prices[item.finish])?'':` Pas de prix ${item.finish==='foil'?'Foil':'Normal'} pour cette édition.`}`);
    setPressed(item.finish); return;
  }
  if (item.prices.matched === false) {
    setBind('note', item.prices.ambiguous ? 'Plusieurs éditions Playin correspondent : pas de prix. Vérifie sur Playin.' : 'Cette édition n’a pas de ligne équivalente chez Playin : pas de prix.');
    setPressed(item.finish); return;
  }
  setBind('note', `${item.prices.edition || 'Édition inconnue'} · ${item.language.toUpperCase()} Mint/Nmint · ${item.finish==='foil'?'Foil':'Normal'} compté dans le total. Vérifie l’édition.${Number.isFinite(item.prices[item.finish])?'':` Pas de tarif ${item.finish==='foil'?'Foil':'Normal'}.`}`);
  setPressed(item.finish);
}
function showBestPlayinPrice() {
  if(!currentCard || !currentPlayinRows.length) return;
  const item=currentEntry || {finish:currentFinish};
  item.language=currentLanguage(); item.prices=priceData(currentCard,currentPlayinRows,item.language); item.price=item.prices[item.finish];
  if (currentEntry) item.priceState = ''; // the lookup is over, whether or not a tariff exists
  paintPrices(item); updateSession();
}

function paintCardmarket() {
  if (!currentCard) return;
  const item = currentEntry || { finish: currentFinish, language: currentLanguage() };
  item.prices = cardmarketPrices(currentCard); item.price = item.prices[item.finish];
  if (currentEntry) item.priceState = '';
  paintPrices(item); updateSession();
}
const refreshPrices = () => (activeSource() === 'cardmarket' ? paintCardmarket() : showBestPlayinPrice());

const playinCache = loadPriceCache();
let priceSaveTimer = null;
function rememberRows(key, rows) {
  const compact = compactRows(rows);
  playinCache.set(key, { t: Date.now(), rows: compact });
  clearTimeout(priceSaveTimer); priceSaveTimer = setTimeout(() => savePriceCache(playinCache), 3000); // off the scan's critical moment
  return compact;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPlayinRows(name) {
  const key = name.toLowerCase();
  const cached = playinCache.get(key);
  if (cached && Date.now() - cached.t < PRICE_TTL_MS) return cached.rows;
  const readerUrl = `https://r.jina.ai/https://rachat.play-in.com/magic/result.php?r=${encodeURIComponent(name)}`;
  if (PRICE_RELAY_URL) {
    try {
      const response = await fetch(`${PRICE_RELAY_URL}/price?name=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(6000) });
      if (response.ok) {
        const rows = parsePlayinRows(await response.text());
        if (rows.length) return rememberRows(key, rows);
      }
    } catch { /* relay down or blocked: fall back to the public reader below */ }
  }
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      // Fast path (benchmarked ~2x quicker): no headless browser, only the price rows. If it fails, retry with the plain reader.
      const headers = attempt === 0 ? { 'X-Return-Format': 'html', 'X-Engine': 'direct', 'X-Target-Selector': '.filterElement.cards' } : { 'X-Return-Format': 'html' };
      const response = await fetch(readerUrl, { headers, signal: AbortSignal.timeout(10000) });
      if (response.status === 429 || response.status >= 500) throw new Error(`relais HTTP ${response.status}`);
      if (!response.ok) throw new Error(`relais HTTP ${response.status}`);
      const rows = parsePlayinRows(await response.text());
      if (!rows.length) throw new Error('aucun tarif trouvé');
      return rememberRows(key, rows);
    } catch (error) {
      lastError = error;
      if (error.message === 'aucun tarif trouvé') break;
      await sleep(1500 * 2 ** attempt);
    }
  }
  throw lastError;
}

const entryPrinting = (entry, fallback) => ({ name: entry.name, set_name: entry.setName ?? fallback.set_name, promo: entry.promo ?? fallback.promo, full_art: entry.fullArt ?? fallback.full_art, frame_effects: entry.frameEffects ?? fallback.frame_effects });

async function queryPlayinPrice(card, entry = null) {
  const sameCard = () => currentCard && searchName(currentCard) === searchName(card);
  if(sameCard()) { currentPlayinRows = []; playinSettled = false; }
  try {
    const rows = await fetchPlayinRows(searchName(card));
    if(entry) { entry.prices=priceData(entryPrinting(entry, card),rows,entry.language); entry.price=entry.prices[entry.finish]; entry.priceState=''; updateSession(); }
    if(sameCard()) {currentPlayinRows=rows; playinSettled=true; showBestPlayinPrice(); renderEditions();}
  } catch (error) {
    if(entry) {entry.priceState='Prix indisponible'; updateSession();}
    if(sameCard()) {playinSettled=true; updateValuable(null); setBind('normal','—'); setBind('foil','—'); setBind('note', `Prix indisponible : Playin n’a pas répondu (${error.message}).`); renderEditions();}
  }
}

function checkPlayin() {
  if (!currentCard) return;
  const url = activeSource() === 'cardmarket'
    ? (cardmarketUrl(currentCard) || `https://www.cardmarket.com/fr/Magic/Products/Search?searchString=${encodeURIComponent(searchName(currentCard))}`)
    : directPlayinUrl(currentCard);
  window.open(url, '_blank', 'noopener');
}

els.toggle.addEventListener('click', toggleScanner);
els.form.addEventListener('submit', (event) => { event.preventDefault(); lookupCard(els.set.value, els.number.value); });
document.querySelectorAll('.js-playin').forEach((button) => button.addEventListener('click', checkPlayin));
document.querySelectorAll('.js-lang').forEach((select) => select.addEventListener('change', () => { document.querySelectorAll('.js-lang').forEach((other) => { other.value = select.value; }); refreshPrices(); }));
document.querySelectorAll('.js-add').forEach((button) => button.addEventListener('click', () => { if (currentCard) { currentEntry=addCardToSession(currentCard); currentEntry.finish=currentFinish; if (currentEntry.source === 'cardmarket') paintCardmarket(); else if(currentPlayinRows.length) showBestPlayinPrice(); else queryPlayinPrice(currentCard,currentEntry); setStatus(`${currentCard.name} ajoutée.`); setSearchStatus(`${currentCard.name} ajoutée à la collection ✓`); offerUndoAdd(currentEntry); } }));
document.querySelectorAll('[data-finish]').forEach((button) => button.addEventListener('click',()=>{const finish=button.dataset.finish; currentFinish=finish; if(currentEntry) currentEntry.finish=finish; setPressed(finish); refreshPrices();}));
els.clear.addEventListener('click', () => {
  if (!confirm('Vider toute la collection ? Une copie de sécurité est gardée et tu pourras annuler.')) return;
  saveSafetyCopy(session, undefined, Date.now(), true);
  const removed = session.splice(0, session.length); currentEntry = null; updateSession(); refreshDataLine();
  showToast(`${removed.length} cartes retirées`, 'Annuler', () => { session.push(...removed); updateSession(); }, 10000);
});
for(const id of ['history-search','history-min','history-max']) $(id).addEventListener('input',()=>{historyLimit=30; renderHistory();});
for(const id of ['history-sort','history-period','history-source']) $(id).addEventListener('change',()=>{historyLimit=30; renderHistory();});
$('value-threshold').value = String(valueThreshold);
$('value-threshold').addEventListener('input',()=>{ const n=Number($('value-threshold').value); valueThreshold = $('value-threshold').value!=='' && Number.isFinite(n) && n>=0 ? n : 5; store.set('mtg-value-threshold', String(valueThreshold)); renderHistory(); renderRecent(); updateValuable(currentEntry ? currentEntry.price : null); });
$('reset-filters').addEventListener('click',()=>{for(const id of ['history-search','history-min','history-max']) $(id).value=''; $('history-sort').value='newest'; $('history-period').value='all'; $('history-source').value='all'; historyLimit=30; renderHistory();});
$('history-more').addEventListener('click',()=>{historyLimit+=30; renderHistory();});
for(const [button,panel] of [['more-toggle','more-panel'],['filters-toggle','filters']]) $(button).addEventListener('click',()=>{const open=$(panel).hidden; $(panel).hidden=!open; $(button).setAttribute('aria-expanded',String(open));});
const VIEWS = ['scanner','search','collection'];
for(const view of VIEWS) $('tab-'+view).addEventListener('click',()=>{
  for(const name of VIEWS) {$(name+'-view').hidden=name!==view; $('tab-'+name).setAttribute('aria-current',name===view?'page':'false'); $('tab-'+name).setAttribute('aria-selected',String(name===view));}
  if(view!=='scanner' && scannerStarted) {scanner.stop(); setCamera(false); setStatus('Scanner en pause.');}
  if(view==='collection') renderHistory();
  window.scrollTo({top:0,behavior:'instant'});
});
// Fast entry: tap the number field again after a search to clear it and reopen the digit keypad.
els.number.addEventListener('focus', () => { if (numberDone) { els.number.value = ''; numberDone = false; } });
els.set.addEventListener('focus', () => els.set.select());
try { els.set.value = (localStorage.getItem(LAST_SET_KEY) || '').toUpperCase(); } catch {}
// Ask the browser not to evict the saved collection under storage pressure.
navigator.storage?.persist?.().catch(() => {});
function updateNetwork() { els.network.textContent = navigator.onLine ? 'En ligne' : 'Hors ligne'; els.network.classList.toggle('offline', !navigator.onLine); }
window.addEventListener('online', updateNetwork); window.addEventListener('offline', updateNetwork); updateNetwork(); updateSession();
if ('serviceWorker' in navigator) {
  if (dx.nosw) {
    // Like the official CollectorVision demo on iOS: no service worker at all.
    navigator.serviceWorker.getRegistrations().then(async (registrations) => {
      const wasControlled = Boolean(navigator.serviceWorker.controller);
      for (const registration of registrations) await registration.unregister();
      for (const key of await caches.keys()) if (key.startsWith('mtg-playin')) await caches.delete(key);
      if (wasControlled && !sessionStorage.getItem('mtg-nosw-reloaded')) { sessionStorage.setItem('mtg-nosw-reloaded', '1'); location.reload(); }
    }).catch(() => {});
  } else window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
}
const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent); const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
if (isiOS && !standalone && !sessionStorage.getItem('install-dismissed')) $('install-help').hidden = false;
$('close-install').addEventListener('click', () => { $('install-help').hidden = true; sessionStorage.setItem('install-dismissed', '1'); });

// Diagnostic + battery/memory profile switch (Collection tab footer).
$('light-mode').checked = lightMode;
$('light-mode').addEventListener('change', () => { store.set('mtg-light-mode', $('light-mode').checked ? '1' : '0'); location.reload(); });
const diagnosticText = () => [
  `Version: ${document.querySelector('script[type=module]')?.src.split('/').pop() || 'dev'} · iOS: ${navigator.userAgent.match(/OS ([\d_]+)/)?.[1]?.replace(/_/g, '.') || '?'} · mode économie: ${lightMode ? 'oui' : 'non'}`,
  `Plantages détectés : ${store.get('mtg-crashes') || 0}`,
  `Dernière erreur : ${store.get('mtg-last-error') || 'aucune'}`,
  `Collection : ${session.length} cartes`,
  `Interrupteurs actifs : ${dxActive.join(', ') || 'aucun'}`,
  `Cartes à l'envers : ${lightProfile ? 'non reconnues (mode économie)' : 'reconnues'}`,
  '--- dernières étapes ---', ...JSON.parse(store.get(TRACE_KEY) || '[]'),
].join('\n');
$('trace').textContent = diagnosticText();
$('copy-diagnostic').addEventListener('click', async () => {
  const text = diagnosticText();
  try { await navigator.clipboard.writeText(text); $('copy-diagnostic').textContent = 'Copié ✓'; }
  catch { $('trace').textContent = text; $('copy-diagnostic').textContent = 'Sélectionne le texte ci-dessus'; }
});
if (crashedLastRun) setStatus('L’app a été rechargée par le système pendant le scan (cause non confirmée). Mode économie activé.', true);

// Diagnostic switches UI. Any change reloads the app so the new profile applies from a clean start.
for (const name of DX) {
  const box = $(`dx-${name}`); box.checked = dx[name];
  box.addEventListener('change', () => { store.set(`dx-${name}`, box.checked ? '1' : '0'); sessionStorage.removeItem('mtg-nosw-reloaded'); location.reload(); });
}
$('dx-demo').addEventListener('click', () => {
  const allOn = DX_DEMO.every((name) => dx[name]);
  for (const name of DX) store.set(`dx-${name}`, DX_DEMO.includes(name) && !allOn ? '1' : '0');
  sessionStorage.removeItem('mtg-nosw-reloaded'); location.reload();
});
$('dx-demo').textContent = DX_DEMO.every((name) => dx[name]) ? 'Remettre le profil normal' : 'Profil « démo » (tout désactiver)';

// ── Foil by default: the next scans are counted as Foil until switched back ──
currentFinish = defaultFinish; setPressed(currentFinish);
function updateFoilButtons() { document.querySelectorAll('.js-foil-default').forEach((button) => button.setAttribute('aria-pressed', String(defaultFinish === 'foil'))); }
document.querySelectorAll('.js-foil-default').forEach((button) => button.addEventListener('click', () => {
  defaultFinish = defaultFinish === 'foil' ? 'normal' : 'foil'; store.set('mtg-default-finish', defaultFinish); updateFoilButtons();
  showToast(defaultFinish === 'foil' ? 'Prochains scans comptés en Foil' : 'Prochains scans comptés en Normal', '', null, 2500);
}));
updateFoilButtons();

// ── Piles ──
$('new-pile').addEventListener('click', () => {
  batch = { id: crypto.randomUUID(), startedAt: new Date().toISOString() }; store.set('mtg-batch', JSON.stringify(batch));
  updateSession(); showToast('Nouvelle pile commencée', '', null, 3000);
});

// ── Export, backup and restore ──
const dataStatus = (message, error = false) => { $('data-status').textContent = message; $('data-status').classList.toggle('error', error); };
const dateStamp = () => new Date().toISOString().slice(0, 10);
const whenText = (value) => new Date(value).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
// On iPhone the share sheet offers "Save to Files"; elsewhere a normal download.
async function deliverFile(filename, text, type) {
  const blob = new Blob([text], { type });
  try {
    const file = new File([blob], filename, { type });
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return true; }
  } catch (error) { if (error.name === 'AbortError') return false; }
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}
function refreshDataLine() {
  const copy = loadSafetyCopy(); const last = store.get('mtg-last-export');
  $('safety-line').textContent = `Dernier export : ${last ? whenText(last) : 'jamais'}. Copie automatique : ${copy ? `${whenText(copy.savedAt)} · ${copy.entries.length} cartes` : 'aucune'}. La copie automatique reste sur ce téléphone ; le fichier exporté est la vraie protection.`;
  $('restore-safety').hidden = !copy;
}
$('export-csv').addEventListener('click', async () => {
  if (!session.length) return dataStatus('La collection est vide.', true);
  if (await deliverFile(`collection-magic-${dateStamp()}.csv`, toCsv(session), 'text/csv;charset=utf-8')) { store.set('mtg-last-export', new Date().toISOString()); dataStatus(`${session.length} lignes exportées.`); refreshDataLine(); }
});
$('export-backup').addEventListener('click', async () => {
  if (!session.length) return dataStatus('La collection est vide.', true);
  if (await deliverFile(`sauvegarde-mtg-${dateStamp()}.json`, makeBackup(session), 'application/json')) { store.set('mtg-last-export', new Date().toISOString()); dataStatus('Sauvegarde exportée. Garde-la dans Fichiers ou envoie-la-toi.'); refreshDataLine(); }
});
$('import-backup').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0]; $('import-file').value = ''; if (!file) return;
  const parsed = parseBackup(await file.text());
  if (!parsed.ok) return dataStatus(parsed.error, true);
  saveSafetyCopy(session, undefined, Date.now(), true);
  const added = mergeEntries(session, parsed.entries, () => crypto.randomUUID()); updateSession(); refreshDataLine();
  dataStatus(added ? `${added} carte${added > 1 ? 's' : ''} restaurée${added > 1 ? 's' : ''}${parsed.skipped ? ` (${parsed.skipped} ignorée${parsed.skipped > 1 ? 's' : ''})` : ''}. Rien n'a été supprimé.` : 'Rien à ajouter : toutes ces cartes sont déjà dans la collection.');
});
$('restore-safety').addEventListener('click', () => {
  const copy = loadSafetyCopy(); if (!copy) return;
  const added = mergeEntries(session, copy.entries, () => crypto.randomUUID()); updateSession();
  dataStatus(added ? `${added} carte${added > 1 ? 's' : ''} récupérée${added > 1 ? 's' : ''}.` : 'Rien à récupérer : la collection contient déjà tout.');
});
refreshDataLine();

// ── Theme: dark by default, light or automatic on request ──
function applyTheme(pref) {
  document.documentElement.dataset.theme = pref; store.set('mtg-theme', pref);
  const dark = pref === 'dark' || (pref === 'auto' && !matchMedia('(prefers-color-scheme: light)').matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0b0f15' : '#f6f7fb';
  document.querySelector('meta[name="color-scheme"]').content = pref === 'dark' ? 'dark' : pref === 'light' ? 'light' : 'dark light';
}
$('theme-select').value = document.documentElement.dataset.theme || 'dark';
$('theme-select').addEventListener('change', () => applyTheme($('theme-select').value));
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => applyTheme(document.documentElement.dataset.theme || 'dark'));
applyTheme(document.documentElement.dataset.theme || 'dark');

// ── First launch: explain the three steps in the camera placeholder ──
$('onboarding').hidden = session.length > 0;

// ── Price source: Playin buy price / Cardmarket trend ──
function applySource() {
  document.documentElement.dataset.source = activeSource();
  document.querySelectorAll('.js-source').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.source === priceSource)));
  document.querySelectorAll('.js-playin .ext-label').forEach((label) => { label.textContent = activeSource() === 'cardmarket' ? 'Voir sur Cardmarket' : 'Voir sur Playin'; });
}
document.querySelectorAll('.js-source').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.source === priceSource) return;
  priceSource = button.dataset.source; store.set('mtg-price-source', priceSource);
  if (currentCard && !currentEntry) { applySource(); renderCard(currentCard); if (priceSource === 'playin') queryPlayinPrice(currentCard); }
  applySource();
}));
applySource();
