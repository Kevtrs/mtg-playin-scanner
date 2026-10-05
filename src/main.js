import './style.css';

const $ = (id) => document.getElementById(id);
const els = {
  toggle: $('camera-toggle'), mode: $('scan'), status: $('status'), form: $('lookup-form'), set: $('set-code'),
  number: $('collector-number'), result: $('result'), image: $('card-image'), name: $('card-name'), cardSet: $('card-set'),
  meta: $('card-meta'), price: $('playin-price'), priceNote: $('price-note'), playin: $('playin-check'), add: $('add-session'),
  priceLanguage: $('price-language'), count: $('count'), total: $('total'), clear: $('clear-session'), network: $('network')
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
const session = JSON.parse(localStorage.getItem('mtg-session') || '[]');
for (const item of session) {
  item.entryId ||= crypto.randomUUID();
  if (!item.prices) { item.prices = { normal:null, foil:null }; item.price = null; item.priceState = 'Ancien tarif à vérifier'; }
  item.finish ||= 'normal';
}
const money = (value) => Number.isFinite(value) ? value.toLocaleString('fr-FR', {style:'currency',currency:'EUR'}) : 'Indisponible';

function renderHistory() {
  $('history').replaceChildren();
  if (!session.length) $('history').textContent = 'Aucune carte enregistrée.';
  for (const item of [...session].reverse()) {
    const row = document.createElement('article'); row.className = 'history-item';
    const name = document.createElement('strong'); name.textContent = `${item.quantity || 1} × ${item.name}`;
    const info = document.createElement('small'); info.textContent = `${item.set?.toUpperCase()} #${item.number} · ${item.language || 'Fr'} · Mint/Nmint · ${item.priceState || ''}`;
    const prices = document.createElement('span'); prices.textContent = `Normal : ${money(item.prices.normal)} / Foil : ${money(item.prices.foil)}`;
    const select = document.createElement('select'); select.setAttribute('aria-label', `Finition de ${item.name}`);
    for (const [value,label] of [['normal','Normal'],['foil','Foil']]) { const option=document.createElement('option'); option.value=value; option.textContent=label; select.append(option); }
    select.value=item.finish;
    select.onchange=()=>{ item.finish=select.value; item.price=item.prices[item.finish]; if(currentEntry===item){currentFinish=item.finish; paintPrices(item);} updateSession(); };
    const remove = document.createElement('button'); remove.className='remove'; remove.textContent=(item.quantity||1)>1 ? 'Supprimer un exemplaire' : 'Supprimer cette carte';
    remove.onclick=()=>{ if((item.quantity||1)>1) item.quantity--; else session.splice(session.indexOf(item),1); updateSession(); };
    row.append(name,info,prices,select,remove); $('history').append(row);
  }
}

function setStatus(message, error = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', error);
}

function updateSession() {
  els.count.textContent = session.reduce((sum, item) => sum + (item.quantity || 1), 0);
  const sum = session.reduce((acc, item) => acc + (Number(item.price) || 0) * (item.quantity || 1), 0);
  els.total.textContent = sum.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
  const unknown=session.reduce((sum,item)=>sum+(Number.isFinite(item.price)?0:(item.quantity||1)),0);
  $('unpriced').textContent=unknown ? `${unknown} sans tarif confirmé` : '';
  localStorage.setItem('mtg-session', JSON.stringify(session));
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
        els.mode.textContent = 'IA prête';
        setStatus('Moteur prêt. Appuie sur Démarrer puis présente une carte entière.');
      },
      onProgress(progress) {
        const label = progress.message || progress.stage || 'Préparation du catalogue';
        setStatus(`${label}… Le premier chargement télécharge environ 40 Mo.`);
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
      instance.stop(); scannerStarted = false; els.toggle.textContent = 'Démarrer le vrai scanner'; setStatus('Scanner arrêté.');
    } else {
      await instance.start(); scannerStarted = true; els.toggle.textContent = 'Arrêter le scanner';
      setStatus(scannerReady ? 'Présente une carte entière à la caméra.' : 'Caméra prête, chargement du modèle…');
    }
  } catch (error) {
    if (error.name === 'NotAllowedError') setStatus('Autorise la caméra dans les réglages Safari.', true);
  }
}

async function handleVisualMatch(match) {
  const sequence = ++lookupSequence;
  setStatus(`Carte détectée (${Math.round(match.score * 100)} %). Identification…`);
  try {
    const response = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(match.cardId)}`, { headers: { Accept: 'application/json;q=0.9,*/*;q=0.8' } });
    if (!response.ok) throw new Error(`Scryfall ${response.status}`);
    const card = await response.json();
    const entry = addCardToSession(card);
    if(sequence === lookupSequence) {currentCard = card; currentEntry=entry; currentFinish='normal'; renderCard(card, false);}
    beep(); queryPlayinPrice(card, entry);
    if (navigator.vibrate) navigator.vibrate(80);
    const flash = $('scan-flash'); flash.classList.add('success'); setTimeout(() => flash.classList.remove('success'), 260);
    setStatus(`${card.name} reconnue ✓ Présente la suivante.`);
  } catch (error) { setStatus(`Carte détectée, mais identification impossible : ${error.message}`, true); }
}

function addCardToSession(card) {
  const item = { entryId:crypto.randomUUID(), id: card.id, name: card.name, set: card.set, number: card.collector_number, price: null, quantity: 1, prices:{normal:null,foil:null}, finish:'normal', language:els.priceLanguage.value, priceState:'Recherche…', scannedAt:new Date().toISOString() };
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

async function lookupCard(set, number) {
  set = set.trim().toLowerCase(); number = number.trim();
  if (!set || !number) return setStatus('Indique le code d’édition et le numéro.', true);
  setStatus('Identification via Scryfall…'); els.result.hidden = true;
  try {
    const response = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(set)}/${encodeURIComponent(number)}`, { headers: { Accept: 'application/json;q=0.9,*/*;q=0.8' } });
    if (!response.ok) throw new Error(response.status === 404 ? 'carte introuvable' : `Scryfall ${response.status}`);
    currentCard = await response.json(); currentEntry=null; currentFinish='normal'; currentPrice = null; renderCard(currentCard); queryPlayinPrice(currentCard); setStatus('Carte identifiée.');
  } catch (error) { setStatus(`Identification impossible : ${error.message}.`, true); }
}

function renderCard(card, shouldScroll = true) {
  $('overlay-name').textContent=card.printed_name || card.name;
  $('foil-price').textContent='Recherche…';
  $('choose-normal').setAttribute('aria-pressed','true'); $('choose-foil').setAttribute('aria-pressed','false');
  const face = card.card_faces?.[0] || card; els.image.src = face.image_uris?.normal || face.image_uris?.small || ''; els.image.alt = card.name;
  els.name.textContent = card.printed_name || card.name; els.cardSet.textContent = card.set_name;
  els.meta.textContent = `${card.set.toUpperCase()} · #${card.collector_number} · ${card.lang.toUpperCase()}${card.foil ? ' · foil possible' : ''}`;
  els.price.textContent = 'Recherche…'; els.priceNote.textContent = 'Recherche de la bonne impression sur Playin.';
  els.result.hidden = false;
}

function directPlayinUrl(card) { return `https://rachat.play-in.com/magic/result.php?r=${encodeURIComponent(card.name)}`; }

function normalizedWords(value) {
  const stop = new Set(['the', 'of', 'at', 'and', 'a', 'le', 'la', 'les', 'de', 'des', 'du', 'au', 'aux', 'et', 'edition', 'ed']);
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((word) => word && !stop.has(word));
}

function printingScore(row, card) {
  const wanted = new Set(normalizedWords(card.set_name));
  const found = normalizedWords(row.edition);
  let score = found.reduce((sum, word) => sum + (wanted.has(word) ? Math.max(2, word.length) : 0), 0);
  const setNorm = normalizedWords(card.set_name).join(' ');
  const editionNorm = found.join(' ');
  if (setNorm === editionNorm) score += 50;
  if (row.nameEn.toLowerCase() === card.name.toLowerCase()) score += 8;
  const special = card.promo || card.full_art || card.frame_effects?.some((effect) => ['extendedart', 'showcase', 'inverted', 'etched'].includes(effect));
  const extras = /extra|promo|showcase|special|borderless|etendue|extended/i.test(row.edition + ' ' + row.nameEn);
  if (special === extras) score += 5;
  return score;
}

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

function priceData(card, rows, language) {
  const bestRow = [...rows].sort((a,b)=>printingScore(b,card)-printingScore(a,card))[0];
  const variants = bestRow?.variants.filter(v=>v.label.startsWith(language+' ') && /Mint\/Nmint/i.test(v.label)) || [];
  return {normal:variants.find(v=>!v.foil)?.price ?? null, foil:variants.find(v=>v.foil)?.price ?? null, edition:bestRow?.edition || ''};
}

function paintPrices(item) {
  els.price.textContent=money(item.prices.normal); $('foil-price').textContent=money(item.prices.foil);
  els.priceNote.textContent=`${item.prices.edition || ''} · ${item.language} Mint/Nmint · ${item.finish==='foil'?'Foil':'Normal'} pour le total. Édition à vérifier.`;
  $('choose-normal').setAttribute('aria-pressed',String(item.finish==='normal'));
  $('choose-foil').setAttribute('aria-pressed',String(item.finish==='foil'));
}
function showBestPlayinPrice() {
  if(!currentCard || !currentPlayinRows.length) return;
  const item=currentEntry || {finish:currentFinish};
  item.language=els.priceLanguage.value; item.prices=priceData(currentCard,currentPlayinRows,item.language); item.price=item.prices[item.finish];
  paintPrices(item); updateSession();
}

async function queryPlayinPrice(card, entry = null) {
  if(currentCard===card) currentPlayinRows = [];
  const sourceUrl = `http://rachat.play-in.com/magic/result.php?r=${encodeURIComponent(card.name)}`;
  const readerUrl = `https://r.jina.ai/${sourceUrl}`;
  try {
    const response = await fetch(readerUrl, { headers: { 'X-Return-Format': 'html' } });
    if (!response.ok) throw new Error(`relais HTTP ${response.status}`);
    const rows = parsePlayinRows(await response.text());
    if (!rows.length) throw new Error('aucun tarif trouvé');
    if(entry) { entry.prices=priceData(card,rows,entry.language); entry.price=entry.prices[entry.finish]; entry.priceState=''; updateSession(); }
    if(currentCard===card) {currentPlayinRows=rows; showBestPlayinPrice();}
  } catch (error) {
    if(entry) {entry.priceState='Prix indisponible'; updateSession();}
    if(currentCard===card) {els.price.textContent = 'Indisponible'; $('foil-price').textContent='Indisponible'; els.priceNote.textContent = `Playin n’a pas répondu (${error.message}).`;}
  }
}

function checkPlayin() {
  if (currentCard) window.open(directPlayinUrl(currentCard), '_blank', 'noopener');
}

els.toggle.addEventListener('click', toggleScanner);
els.form.addEventListener('submit', (event) => { event.preventDefault(); lookupCard(els.set.value, els.number.value); });
els.playin.addEventListener('click', checkPlayin);
els.priceLanguage.addEventListener('change', showBestPlayinPrice);
els.add.addEventListener('click', () => { if (currentCard) { currentEntry=addCardToSession(currentCard); currentEntry.finish=currentFinish; if(currentPlayinRows.length) showBestPlayinPrice(); else queryPlayinPrice(currentCard,currentEntry); setStatus(`${currentCard.name} ajoutée.`); } });
for(const finish of ['normal','foil']) $('choose-'+finish).addEventListener('click',()=>{currentFinish=finish; if(currentEntry) currentEntry.finish=finish; showBestPlayinPrice();});
els.clear.addEventListener('click', () => { session.length = 0; updateSession(); });
function updateNetwork() { els.network.textContent = navigator.onLine ? 'En ligne' : 'Hors ligne'; els.network.classList.toggle('offline', !navigator.onLine); }
window.addEventListener('online', updateNetwork); window.addEventListener('offline', updateNetwork); updateNetwork(); updateSession();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent); const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
if (isiOS && !standalone && !sessionStorage.getItem('install-dismissed')) $('install-help').hidden = false;
$('close-install').addEventListener('click', () => { $('install-help').hidden = true; sessionStorage.setItem('install-dismissed', '1'); });
