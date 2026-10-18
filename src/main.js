import './style.css';
import { ScanGate, ScanLock, selectHistory, filterEditions } from './collection.js';
import { priceData, searchName, compactRows } from './playin.js';
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
let lastRemoved = null;
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
const DX = ['nosw', 'noaudio', 'nooverlay', 'minimalui', 'fullres', 'catv2', 'nativevideo'];
const DX_DEMO = DX.filter((name) => name !== 'nativevideo'); // the demo profile never re-enables the old native video
const dx = Object.fromEntries(DX.map((name) => [name, store.get(`dx-${name}`) === '1']));
const dxActive = DX.filter((name) => dx[name]);
const lightProfile = lightMode && !dx.fullres;
for (const name of dxActive) document.documentElement.classList.add(`dx-${name}`);
const recordError = (message) => store.set('mtg-last-error', `${new Date().toLocaleString('fr-FR')} · ${String(message).slice(0, 160)}`);
// "Black box": the last 40 steps are kept in localStorage so that, after a reload, we can see what ran just before it.
const TRACE_KEY = 'mtg-trace';
function trace(label) {
  try {
    const lines = JSON.parse(localStorage.getItem(TRACE_KEY) || '[]');
    lines.push(`${new Date().toISOString().slice(5, 23).replace('T', ' ')} ${label}`);
    localStorage.setItem(TRACE_KEY, JSON.stringify(lines.slice(-40)));
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
  const items=selectHistory(session, { search:$('history-search').value, sort:$('history-sort').value, period:$('history-period').value, min:$('history-min').value, max:$('history-max').value });
  const count=items.reduce((sum,item)=>sum+(item.quantity||1),0);
  const subtotal=items.reduce((sum,item)=>sum+(Number.isFinite(item.price)?item.price*(item.quantity||1):0),0);
  const filtered=items.length!==session.length;
  $('history-summary').textContent=session.length && filtered ? `${count} carte${count===1?'':'s'} · ${money(subtotal)} dans cette sélection` : '';
  $('history-more').hidden=items.length<=historyLimit;
  if (!items.length) {
    const empty=document.createElement('div'); empty.className='empty-history';
    const title=document.createElement('strong'); const hint=document.createElement('span');
    if(session.length) { title.textContent='Aucun résultat'; hint.textContent='Aucune carte ne correspond à ces filtres.'; }
    else { title.textContent='Ta collection est vide'; hint.textContent='Scanne une carte : elle apparaîtra ici avec son prix de rachat.'; }
    empty.append(title,hint); $('history').append(empty); $('history').style.display='block';
  } else $('history').style.display='';
  for (const item of items.slice(0,historyLimit)) {
    const row = document.createElement('details'); row.className = 'history-item'; row.dataset.entry=item.entryId; row.open=openHistory.has(item.entryId);
    row.addEventListener('toggle',()=>{if(row.isConnected) row.open?openHistory.add(item.entryId):openHistory.delete(item.entryId);});
    const summary=document.createElement('summary'); summary.dataset.action='expand';
    const thumbnail=thumbnailFor(item);
    const body=document.createElement('div'); body.className='history-body';
    const name=document.createElement('strong'); name.textContent=item.name;
    const info=document.createElement('span'); info.className='history-meta'; info.textContent=`${(item.set||'').toUpperCase()} · #${item.number} · ${(item.language||'Fr').toUpperCase()} · ${item.finish==='foil'?'Foil':'Normal'}`;
    const time=document.createElement('time'); time.className='history-time';
    const date=new Date(item.scannedAt); time.textContent=Number.isNaN(date.getTime())?'Date inconnue':date.toLocaleString('fr-FR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); if(!Number.isNaN(date.getTime())) time.dateTime=date.toISOString();
    body.append(name,info,time);
    const price=document.createElement('div'); price.className='history-price';
    const amount=document.createElement('strong'); amount.textContent=Number.isFinite(item.price)?money(item.price):'—';
    const quantity=document.createElement('small'); quantity.textContent=(item.quantity||1)>1?`×${item.quantity}`:(Number.isFinite(item.price)?'':item.priceState||'Sans tarif'); price.append(amount,quantity);
    summary.append(thumbnail,body,price);
    const controls=document.createElement('div'); controls.className='history-details';
    const prices=document.createElement('p'); prices.textContent=`Normal ${priceText(item.prices.normal)} · Foil ${priceText(item.prices.foil)}`;
    const toggle=document.createElement('div'); toggle.className='finish-toggle'; toggle.setAttribute('role','group'); toggle.setAttribute('aria-label',`Finition de ${item.name}`);
    for(const [value,text] of [['normal','Normal'],['foil','Foil']]) {
      const option=document.createElement('button'); option.type='button'; option.dataset.action='finish-'+value; option.textContent=text; option.setAttribute('aria-pressed',String(item.finish===value));
      option.onclick=()=>{item.finish=value; item.price=item.prices[item.finish]; if(currentEntry===item){currentFinish=item.finish; paintPrices(item);} updateSession();};
      toggle.append(option);
    }
    const remove=document.createElement('button'); remove.type='button'; remove.className='remove'; remove.dataset.action='remove';
    remove.innerHTML='<svg class="i" aria-hidden="true"><use href="#i-trash"/></svg>'; remove.append((item.quantity||1)>1?'Retirer un exemplaire':'Supprimer la carte');
    remove.onclick=()=>{lastRemoved={item,index:session.indexOf(item),decrement:(item.quantity||1)>1}; if(lastRemoved.decrement) item.quantity--; else session.splice(lastRemoved.index,1); updateSession(); showUndo();};
    controls.append(prices,toggle,remove); row.append(summary,controls); $('history').append(row);
    if(focusEntry===item.entryId && focusAction) row.querySelector(`[data-action="${focusAction}"]`)?.focus({preventScroll:true});
  }
}

let undoTimer = null;
function showUndo() { $('undo-delete').hidden=false; clearTimeout(undoTimer); undoTimer=setTimeout(()=>{ $('undo-delete').hidden=true; lastRemoved=null; }, 6000); }

// Heat/battery: the recognition engine runs on the CPU. Slow it down when no card is in
// view, and stop the camera after a while without a scan or when the app is backgrounded.
const SCAN_INTERVAL_ACTIVE_MS = lightProfile ? 1000 : 700;
const SCAN_INTERVAL_IDLE_MS = lightProfile ? 1600 : 1200;
const AUTO_PAUSE_MS = 60000;
let scanInterval = SCAN_INTERVAL_ACTIVE_MS;
let emptyResults = 0;
let lastActivity = performance.now();
let idleTimer = null;

function tuneScanRate(result, instance) {
  emptyResults = result.cardPresent === false ? emptyResults + 1 : 0;
  const wanted = emptyResults >= 3 ? SCAN_INTERVAL_IDLE_MS : SCAN_INTERVAL_ACTIVE_MS;
  if (wanted !== scanInterval) { scanInterval = wanted; instance.updateConfig({ scanIntervalMs: wanted }); }
}

function pauseScanner(message) {
  if (!scannerStarted || !scanner) return;
  scanner.stop(); setCamera(false); setStatus(message);
}

// Canvas preview (15 fps), painted from the hidden <video> with a "cover" crop.
const PREVIEW_INTERVAL_MS = 1000 / 15;
let previewFrame = null;
let previewLast = 0;
function stopPreview() { if (previewFrame !== null) cancelAnimationFrame(previewFrame); previewFrame = null; }
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

function setCamera(running) {
  scannerStarted = running; trace(running ? 'camera start' : 'camera stop');
  $('camera-label').textContent = running ? 'Arrêter le scanner' : 'Démarrer le scanner';
  els.toggle.dataset.running = String(running);
  $('viewfinder').dataset.live = String(running);
  running ? startPreview() : stopPreview();
  try { running ? sessionStorage.setItem('mtg-scanning', '1') : sessionStorage.removeItem('mtg-scanning'); } catch {}
  clearInterval(idleTimer); idleTimer = null;
  if (running) {
    lastActivity = performance.now(); emptyResults = 0;
    if (scanInterval !== SCAN_INTERVAL_ACTIVE_MS && scanner) { scanInterval = SCAN_INTERVAL_ACTIVE_MS; scanner.updateConfig({ scanIntervalMs: scanInterval }); }
    idleTimer = setInterval(() => { if (performance.now() - lastActivity > AUTO_PAUSE_MS) pauseScanner('Scanner en pause pour éviter que le téléphone chauffe. Touche Démarrer pour reprendre.'); }, 5000);
  }
}
document.addEventListener('visibilitychange', () => { trace(document.hidden ? 'hidden' : 'visible'); if (document.hidden) pauseScanner('Scanner en pause. Touche Démarrer pour reprendre.'); });

function setStatus(message, error = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', error);
}

function updateSession() {
  els.count.textContent = session.reduce((sum, item) => sum + (item.quantity || 1), 0);
  $('collection-count').textContent=els.count.textContent;
  const sum = session.reduce((acc, item) => acc + (Number(item.price) || 0) * (item.quantity || 1), 0);
  els.total.textContent = sum.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
  const unknown=session.reduce((sum,item)=>sum+(Number.isFinite(item.price)?0:(item.quantity||1)),0);
  $('unpriced').textContent=unknown ? `${unknown} sans tarif confirmé` : '';
  if(!saveSession(session)) setStatus('Stockage plein ou bloqué : la collection ne peut pas être sauvegardée.', true);
  renderHistory();
}

async function loadScanner() {
  if (scanner) return scanner;
  setStatus('Chargement du moteur visuel et du catalogue MTG…');
  try {
    const moduleUrl = new URL('./cv/lib/collectorvision-scanner-applet.mjs', window.location.href).href;
    const { createCollectorVisionScannerApplet } = await import(/* @vite-ignore */ moduleUrl);
    scanner = await createCollectorVisionScannerApplet({
      target: '#cv-scanner', autoStart: false, matchThreshold: 0.48, consecutiveMatches: 2,
      scanIntervalMs: SCAN_INTERVAL_ACTIVE_MS, camera: lightProfile ? { width: { ideal: 640 }, height: { ideal: 480 } } : undefined, cooldownMs: 2600, groupBySecondaryId: true, showFpsOverlay: false, overlay: !dx.nooverlay, catalogMode: dx.catv2 ? 'v2' : 'v1',
      onReady() {
        scannerReady = true; trace('engine ready');
        els.mode.textContent = 'Moteur prêt';
        setStatus('Moteur prêt. Appuie sur Démarrer puis présente une carte entière.');
      },
      onProgress(progress) {
        const label = progress.message || progress.stage || 'Préparation du catalogue';
        setStatus(`${label}… Le premier chargement télécharge environ 40 Mo.`);
      },
      onResult(result, instance) {
        tuneScanRate(result, instance);
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
  if (!scanLock.canScan()) return;
  if(!scanGate.accept(match)) return;
  scanLock.start(); lastActivity = performance.now(); trace(`scan detect ${match.cardId?.slice(0, 8)} score=${match.score?.toFixed?.(2)}`);
  const sequence = ++lookupSequence;
  setStatus(`Carte détectée (${Math.round(match.score * 100)} %). Identification…`);
  try {
    const response = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(match.cardId)}`, { headers: { Accept: 'application/json;q=0.9,*/*;q=0.8' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Scryfall ${response.status}`);
    const card = await response.json(); trace('scan scryfall-ok');
    const entry = addCardToSession(card); trace('scan added');
    if(sequence === lookupSequence) {currentCard = card; currentEntry=entry; currentFinish='normal'; renderCard(card); showEditions(card);}
    trace('scan rendered'); beep(); trace('scan beep');
    if (navigator.vibrate) navigator.vibrate(80);
    const flash = $('scan-flash'); flash.classList.add('success'); setTimeout(() => flash.classList.remove('success'), 260);
    if(sequence===lookupSequence) setStatus(`${card.name} ajoutée ✓ Recherche du prix…`);
    trace('scan price-start');
    await queryPlayinPrice(card, entry); trace(`scan price-done ${Number.isFinite(entry.price) ? 'ok' : 'none'}`);
    if(sequence===lookupSequence) setStatus(`${card.name} ajoutée ✓ ${Number.isFinite(entry.price) ? money(entry.price) : 'Prix indisponible'}. Retire-la pour scanner la suivante.`);
  } catch (error) { trace(`scan error ${error.message}`); setStatus(`Identification impossible : ${error.message}. Retire la carte puis représente-la.`, true); }
  finally { scanLock.finish(); trace('scan end'); }
}

function addCardToSession(card) {
  const item = { entryId:crypto.randomUUID(), id: card.id, name: card.name, image:imageOf(card), set: card.set, number: card.collector_number, setName: card.set_name, promo: card.promo, fullArt: card.full_art, frameEffects: card.frame_effects, price: null, quantity: 1, prices:{normal:null,foil:null}, finish:'normal', language:currentLanguage(), priceState:'Recherche…', scannedAt:new Date().toISOString() };
  session.push(item);
  updateSession();
  return item;
}

function beep() {
  if (!audioContext) return;
  const oscillator = audioContext.createOscillator(); const gain = audioContext.createGain(); oscillator.frequency.value = 880;
  gain.gain.setValueAtTime(.08, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .12);
  oscillator.connect(gain).connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime + .12);
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
    currentCard = await response.json(); currentEntry=null; currentFinish='normal'; renderCard(currentCard); queryPlayinPrice(currentCard); showEditions(currentCard);
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
  setBind('normal', '…'); setBind('foil', '…'); setBind('note', 'Recherche du prix de rachat sur Playin…');
  setPressed('normal');
}

// ── Editions strip: every printing of the card, with its own Playin price ──
const printingsCache = new Map();
let currentPrintings = [];
let editionFilter = '';
let playinSettled = false; // true once the Playin request for the current card is over (success or not)
const slimPrinting = (c) => ({ id: c.id, oracle_id: c.oracle_id, name: c.name, printed_name: c.printed_name, set: c.set, set_name: c.set_name, collector_number: c.collector_number, lang: c.lang, released_at: c.released_at, promo: c.promo, full_art: c.full_art, frame_effects: c.frame_effects, foil: c.foil, image_uris: { small: imageOf(c) }, prints_search_uri: c.prints_search_uri });

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

async function showEditions(card) {
  currentPrintings = []; editionFilter = '';
  document.querySelectorAll('.js-ed-filter').forEach((input) => { input.value = ''; });
  renderEditions();
  try {
    let list = await loadPrintings(card);
    if (!currentCard || searchName(currentCard) !== searchName(card)) return; // the user moved on
    // The scanned printing comes first, then the others from newest to oldest (as Scryfall returns them).
    const scanned = list.find((p) => p.id === card.id) || slimPrinting(card);
    currentPrintings = [scanned, ...list.filter((p) => p.id !== card.id)];
    renderEditions(true);
  } catch (error) { trace(`editions error ${error.message}`); }
}

function renderEditions(scrollToSelected = false) {
  const many = currentPrintings.length > 1;
  const { shown, hidden } = filterEditions(currentPrintings, editionFilter);
  const lang = currentLanguage();
  const finish = currentEntry?.finish || currentFinish;
  document.querySelectorAll('[data-editions]').forEach((box) => {
    box.hidden = !many;
    box.querySelector('.ed-filter').hidden = currentPrintings.length <= 8;
    const strip = box.querySelector('.ed-strip');
    strip.replaceChildren();
    for (const printing of shown) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'ed'; button.setAttribute('role', 'option');
      const selected = printing.id === currentCard?.id; button.setAttribute('aria-selected', String(selected)); button.dataset.id = printing.id;
      button.setAttribute('aria-label', `${printing.set_name} ${printing.set.toUpperCase()} numéro ${printing.collector_number}`);
      const frame = document.createElement('div'); frame.className = 'ed-img';
      if (SCRYFALL_IMAGE.test(imageOf(printing))) { const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.src = imageOf(printing); frame.append(img); }
      const set = document.createElement('div'); set.className = 'ed-set';
      const icon = document.createElement('img'); icon.alt = ''; icon.loading = 'lazy'; icon.src = `https://svgs.scryfall.io/sets/${encodeURIComponent(printing.set)}.svg`; icon.onerror = () => icon.remove();
      set.append(icon, `${printing.set.toUpperCase()} #${printing.collector_number}`);
      const name = document.createElement('div'); name.className = 'ed-name'; name.textContent = printing.set_name;
      const price = document.createElement('div'); price.className = 'ed-price';
      price.textContent = currentPlayinRows.length ? priceText(priceData(printing, currentPlayinRows, lang)[finish]) : (playinSettled ? '—' : '…');
      button.append(frame, set, name, price);
      button.addEventListener('click', () => chooseEdition(printing));
      strip.append(button);
    }
    if (!shown.length) { const none = document.createElement('div'); none.className = 'ed-more'; none.textContent = 'Aucune édition ne correspond.'; strip.append(none); }
    if (hidden) { const more = document.createElement('div'); more.className = 'ed-more'; more.textContent = `+${hidden} autres : filtre pour les voir`; strip.append(more); }
    if (scrollToSelected) strip.querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  });
}

function chooseEdition(printing) {
  if (!printing || printing.id === currentCard?.id) return;
  currentCard = printing;
  if (currentEntry) Object.assign(currentEntry, { id: printing.id, image: imageOf(printing), set: printing.set, number: printing.collector_number, setName: printing.set_name, promo: printing.promo, fullArt: printing.full_art, frameEffects: printing.frame_effects });
  renderCardInfo(printing);
  if (currentPlayinRows.length) showBestPlayinPrice(); else { setBind('normal', '…'); setBind('foil', '…'); }
  trace(`edition ${printing.set}#${printing.collector_number}`);
  renderEditions(); updateSession();
}
document.querySelectorAll('.js-ed-filter').forEach((input) => input.addEventListener('input', () => {
  editionFilter = input.value; document.querySelectorAll('.js-ed-filter').forEach((other) => { if (other !== input) other.value = input.value; }); renderEditions();
}));

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
  setBind('normal', priceText(item.prices.normal)); setBind('foil', priceText(item.prices.foil));
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
  paintPrices(item); updateSession();
}

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
    if(sameCard()) {playinSettled=true; setBind('normal','—'); setBind('foil','—'); setBind('note', `Prix indisponible : Playin n’a pas répondu (${error.message}).`); renderEditions();}
  }
}

function checkPlayin() {
  if (currentCard) window.open(directPlayinUrl(currentCard), '_blank', 'noopener');
}

els.toggle.addEventListener('click', toggleScanner);
els.form.addEventListener('submit', (event) => { event.preventDefault(); lookupCard(els.set.value, els.number.value); });
document.querySelectorAll('.js-playin').forEach((button) => button.addEventListener('click', checkPlayin));
document.querySelectorAll('.js-lang').forEach((select) => select.addEventListener('change', () => { document.querySelectorAll('.js-lang').forEach((other) => { other.value = select.value; }); showBestPlayinPrice(); }));
document.querySelectorAll('.js-add').forEach((button) => button.addEventListener('click', () => { if (currentCard) { currentEntry=addCardToSession(currentCard); currentEntry.finish=currentFinish; if(currentPlayinRows.length) showBestPlayinPrice(); else queryPlayinPrice(currentCard,currentEntry); setStatus(`${currentCard.name} ajoutée.`); setSearchStatus(`${currentCard.name} ajoutée à la collection ✓`); } }));
document.querySelectorAll('[data-finish]').forEach((button) => button.addEventListener('click',()=>{const finish=button.dataset.finish; currentFinish=finish; if(currentEntry) currentEntry.finish=finish; setPressed(finish); showBestPlayinPrice();}));
els.clear.addEventListener('click', () => { if(confirm('Supprimer toutes les cartes de la collection ?')) {session.length = 0; lastRemoved=null; $('undo-delete').hidden=true; updateSession();} });
for(const id of ['history-search','history-min','history-max']) $(id).addEventListener('input',()=>{historyLimit=30; renderHistory();});
for(const id of ['history-sort','history-period']) $(id).addEventListener('change',()=>{historyLimit=30; renderHistory();});
$('reset-filters').addEventListener('click',()=>{for(const id of ['history-search','history-min','history-max']) $(id).value=''; $('history-sort').value='newest'; $('history-period').value='all'; historyLimit=30; renderHistory();});
$('history-more').addEventListener('click',()=>{historyLimit+=30; renderHistory();});
$('undo-delete').addEventListener('click',()=>{if(lastRemoved){if(lastRemoved.decrement) lastRemoved.item.quantity++; else session.splice(Math.min(lastRemoved.index,session.length),0,lastRemoved.item); lastRemoved=null; updateSession();} clearTimeout(undoTimer); $('undo-delete').hidden=true;});
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
  for (const name of DX) store.set(`dx-${name}`, allOn || name === 'nativevideo' ? '0' : '1');
  sessionStorage.removeItem('mtg-nosw-reloaded'); location.reload();
});
$('dx-demo').textContent = DX_DEMO.every((name) => dx[name]) ? 'Remettre le profil normal' : 'Profil « démo » (tout désactiver)';
