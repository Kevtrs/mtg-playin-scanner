import './style.css';

const $ = (id) => document.getElementById(id);
const els = {
  toggle: $('camera-toggle'), mode: $('scan'), status: $('status'), form: $('lookup-form'), set: $('set-code'),
  number: $('collector-number'), result: $('result'), image: $('card-image'), name: $('card-name'), cardSet: $('card-set'),
  meta: $('card-meta'), price: $('playin-price'), priceNote: $('price-note'), playin: $('playin-check'), add: $('add-session'),
  count: $('count'), total: $('total'), clear: $('clear-session'), proxy: $('proxy-template'), save: $('save-settings'), network: $('network')
};

let scanner = null;
let scannerReady = false;
let scannerStarted = false;
let currentCard = null;
let currentPrice = null;
let audioContext = null;
const session = JSON.parse(localStorage.getItem('mtg-session') || '[]');
els.proxy.value = localStorage.getItem('playin-proxy') || '';

function setStatus(message, error = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', error);
}

function updateSession() {
  els.count.textContent = session.reduce((sum, item) => sum + (item.quantity || 1), 0);
  const sum = session.reduce((acc, item) => acc + (Number(item.price) || 0) * (item.quantity || 1), 0);
  els.total.textContent = sum.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
  localStorage.setItem('mtg-session', JSON.stringify(session));
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
  setStatus(`Carte détectée (${Math.round(match.score * 100)} %). Identification…`);
  try {
    const response = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(match.cardId)}`, { headers: { Accept: 'application/json;q=0.9,*/*;q=0.8' } });
    if (!response.ok) throw new Error(`Scryfall ${response.status}`);
    const card = await response.json(); currentCard = card; currentPrice = null;
    renderCard(card, false); addCardToSession(card); beep();
    if (navigator.vibrate) navigator.vibrate(80);
    const flash = $('scan-flash'); flash.classList.add('success'); setTimeout(() => flash.classList.remove('success'), 260);
    setStatus(`${card.name} reconnue ✓ Présente la suivante.`);
  } catch (error) { setStatus(`Carte détectée, mais identification impossible : ${error.message}`, true); }
}

function addCardToSession(card) {
  const last = session[session.length - 1];
  if (last?.id === card.id) last.quantity = (last.quantity || 1) + 1;
  else session.push({ id: card.id, name: card.name, set: card.set, number: card.collector_number, price: null, quantity: 1 });
  updateSession();
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
    currentCard = await response.json(); currentPrice = null; renderCard(currentCard); setStatus('Carte identifiée.');
  } catch (error) { setStatus(`Identification impossible : ${error.message}.`, true); }
}

function renderCard(card, shouldScroll = true) {
  const face = card.card_faces?.[0] || card; els.image.src = face.image_uris?.normal || face.image_uris?.small || ''; els.image.alt = card.name;
  els.name.textContent = card.printed_name || card.name; els.cardSet.textContent = card.set_name;
  els.meta.textContent = `${card.set.toUpperCase()} · #${card.collector_number} · ${card.lang.toUpperCase()}${card.foil ? ' · foil possible' : ''}`;
  els.price.textContent = 'À vérifier'; els.priceNote.textContent = 'Le prix exact dépend de la langue, de l’état et du foil.';
  els.result.hidden = false; if (shouldScroll) els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function playinSearchUrl(card) { return `https://rachat.play-in.com/recherche?search=${encodeURIComponent(card.name)}`; }
async function checkPlayin() {
  if (!currentCard) return;
  const playinUrl = playinSearchUrl(currentCard); const template = els.proxy.value.trim();
  if (!template) { window.open(playinUrl, '_blank', 'noopener'); return setStatus('Recherche Playin ouverte.'); }
  const proxyUrl = template.includes('{url}') ? template.replace('{url}', encodeURIComponent(playinUrl)) : `${template}${encodeURIComponent(playinUrl)}`;
  try {
    const response = await fetch(proxyUrl); if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text(); const match = new DOMParser().parseFromString(html, 'text/html').body.textContent.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*€/);
    if (!match) throw new Error('prix non reconnu'); currentPrice = Number(match[1].replace(',', '.'));
    els.price.textContent = currentPrice.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
  } catch (error) { setStatus(`Prix automatique indisponible : ${error.message}.`, true); window.open(playinUrl, '_blank', 'noopener'); }
}

els.toggle.addEventListener('click', toggleScanner);
els.form.addEventListener('submit', (event) => { event.preventDefault(); lookupCard(els.set.value, els.number.value); });
els.playin.addEventListener('click', checkPlayin);
els.add.addEventListener('click', () => { if (currentCard) { addCardToSession(currentCard); setStatus(`${currentCard.name} ajoutée.`); } });
els.clear.addEventListener('click', () => { session.length = 0; updateSession(); });
els.save.addEventListener('click', () => { localStorage.setItem('playin-proxy', els.proxy.value.trim()); setStatus('Réglage enregistré.'); });
function updateNetwork() { els.network.textContent = navigator.onLine ? 'En ligne' : 'Hors ligne'; els.network.classList.toggle('offline', !navigator.onLine); }
window.addEventListener('online', updateNetwork); window.addEventListener('offline', updateNetwork); updateNetwork(); updateSession();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent); const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
if (isiOS && !standalone && !sessionStorage.getItem('install-dismissed')) $('install-help').hidden = false;
$('close-install').addEventListener('click', () => { $('install-help').hidden = true; sessionStorage.setItem('install-dismissed', '1'); });
