import './style.css';
import { ScanGate, ScanLock, selectHistory } from './collection.js';
import { priceData, searchName } from './playin.js';
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
const SCAN_INTERVAL_ACTIVE_MS = 700;
const SCAN_INTERVAL_IDLE_MS = 1200;
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

function setCamera(running) {
  scannerStarted = running;
  $('camera-label').textContent = running ? 'Arrêter le scanner' : 'Démarrer le scanner';
  els.toggle.dataset.running = String(running);
  $('viewfinder').dataset.live = String(running);
  clearInterval(idleTimer); idleTimer = null;
  if (running) {
    lastActivity = performance.now(); emptyResults = 0;
    if (scanInterval !== SCAN_INTERVAL_ACTIVE_MS && scanner) { scanInterval = SCAN_INTERVAL_ACTIVE_MS; scanner.updateConfig({ scanIntervalMs: scanInterval }); }
    idleTimer = setInterval(() => { if (performance.now() - lastActivity > AUTO_PAUSE_MS) pauseScanner('Scanner en pause pour éviter que le téléphone chauffe. Touche Démarrer pour reprendre.'); }, 5000);
  }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseScanner('Scanner en pause. Touche Démarrer pour reprendre.'); });

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
      scanIntervalMs: 700, cooldownMs: 2600, groupBySecondaryId: true, showFpsOverlay: false, overlay: true,
      onReady() {
        scannerReady = true;
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
      onError(error) { setStatus(`Scanner visuel : ${error.message}`, true); }
    });
    return scanner;
  } catch (error) {
    setStatus(`Impossible de charger le moteur visuel : ${error.message}`, true);
    throw error;
  }
}

async function toggleScanner() {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') await audioContext.resume();
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
const scanLock = new ScanLock(2000);

async function handleVisualMatch(match) {
  if (!scanLock.canScan()) return;
  if(!scanGate.accept(match)) return;
  scanLock.start(); lastActivity = performance.now();
  const sequence = ++lookupSequence;
  setStatus(`Carte détectée (${Math.round(match.score * 100)} %). Identification…`);
  try {
    const response = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(match.cardId)}`, { headers: { Accept: 'application/json;q=0.9,*/*;q=0.8' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Scryfall ${response.status}`);
    const card = await response.json();
    const entry = addCardToSession(card);
    if(sequence === lookupSequence) {currentCard = card; currentEntry=entry; currentFinish='normal'; renderCard(card);}
    beep();
    if (navigator.vibrate) navigator.vibrate(80);
    const flash = $('scan-flash'); flash.classList.add('success'); setTimeout(() => flash.classList.remove('success'), 260);
    if(sequence===lookupSequence) setStatus(`${card.name} ajoutée ✓ Recherche du prix…`);
    await queryPlayinPrice(card, entry);
    if(sequence===lookupSequence) setStatus(`${card.name} ajoutée ✓ ${Number.isFinite(entry.price) ? money(entry.price) : 'Prix indisponible'}. Retire-la pour scanner la suivante.`);
  } catch (error) { setStatus(`Identification impossible : ${error.message}. Retire la carte puis représente-la.`, true); }
  finally { scanLock.finish(); }
}

function addCardToSession(card) {
  const item = { entryId:crypto.randomUUID(), id: card.id, name: card.name, image:card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || '', set: card.set, number: card.collector_number, price: null, quantity: 1, prices:{normal:null,foil:null}, finish:'normal', language:currentLanguage(), priceState:'Recherche…', scannedAt:new Date().toISOString() };
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
    currentCard = await response.json(); currentEntry=null; currentFinish='normal'; renderCard(currentCard); queryPlayinPrice(currentCard);
    $('search-result').hidden = false; setSearchStatus('Carte trouvée.');
  } catch (error) { setSearchStatus(`Identification impossible : ${error.message}.`, true); }
}

function renderCard(card) {
  setBind('name', card.printed_name || card.name);
  setBind('meta', `${card.set_name} · ${card.set.toUpperCase()} #${card.collector_number}`);
  const face = card.card_faces?.[0] || card; const src = face.image_uris?.small || card.image_uris?.small || '';
  bindAll('thumb').forEach((thumb) => {
    thumb.replaceChildren();
    if (/^https:\/\/(cards|images)\.scryfall\.io\//.test(src)) { const img = document.createElement('img'); img.alt = ''; img.src = src; thumb.append(img); }
  });
  setBind('normal', '…'); setBind('foil', '…'); setBind('note', 'Recherche du prix de rachat sur Playin…');
  setPressed('normal');
}

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
        if (rows.length) { playinCache.set(key, { t: Date.now(), rows }); savePriceCache(playinCache); return rows; }
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
      playinCache.set(key, { t: Date.now(), rows }); savePriceCache(playinCache);
      return rows;
    } catch (error) {
      lastError = error;
      if (error.message === 'aucun tarif trouvé') break;
      await sleep(1500 * 2 ** attempt);
    }
  }
  throw lastError;
}

async function queryPlayinPrice(card, entry = null) {
  if(currentCard===card) currentPlayinRows = [];
  try {
    const rows = await fetchPlayinRows(searchName(card));
    if(entry) { entry.prices=priceData(card,rows,entry.language); entry.price=entry.prices[entry.finish]; entry.priceState=''; updateSession(); }
    if(currentCard===card) {currentPlayinRows=rows; showBestPlayinPrice();}
  } catch (error) {
    if(entry) {entry.priceState='Prix indisponible'; updateSession();}
    if(currentCard===card) {setBind('normal','—'); setBind('foil','—'); setBind('note', `Prix indisponible : Playin n’a pas répondu (${error.message}).`);}
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
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent); const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
if (isiOS && !standalone && !sessionStorage.getItem('install-dismissed')) $('install-help').hidden = false;
$('close-install').addEventListener('click', () => { $('install-help').hidden = true; sessionStorage.setItem('install-dismissed', '1'); });
