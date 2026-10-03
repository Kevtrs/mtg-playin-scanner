import './style.css';
import { createWorker } from 'tesseract.js';

const $ = (id) => document.getElementById(id);
const els = {
  video: $('camera'), canvas: $('capture'), placeholder: $('camera-placeholder'), toggle: $('camera-toggle'), scan: $('scan'),
  status: $('status'), form: $('lookup-form'), set: $('set-code'), number: $('collector-number'), result: $('result'),
  image: $('card-image'), name: $('card-name'), cardSet: $('card-set'), meta: $('card-meta'), price: $('playin-price'),
  priceNote: $('price-note'), playin: $('playin-check'), add: $('add-session'), count: $('count'), total: $('total'),
  clear: $('clear-session'), proxy: $('proxy-template'), save: $('save-settings'), network: $('network')
};

let stream = null;
let worker = null;
let currentCard = null;
let currentPrice = null;
let continuous = false;
let scanning = false;
let scanTimer = null;
let lastCardId = null;
let lastOcrSignature = '';
let consecutiveMisses = 0;
let audioContext = null;
const session = JSON.parse(localStorage.getItem('mtg-session') || '[]');
els.proxy.value = localStorage.getItem('playin-proxy') || '';

function setStatus(message, error = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', error);
}

function updateSession() {
  els.count.textContent = session.length;
  const sum = session.reduce((acc, item) => acc + (Number(item.price) || 0), 0);
  els.total.textContent = sum.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
  localStorage.setItem('mtg-session', JSON.stringify(session));
}

async function toggleCamera() {
  if (stream) {
    continuous = false;
    clearTimeout(scanTimer);
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
    els.video.srcObject = null;
    els.placeholder.hidden = false;
    els.scan.disabled = true;
    els.toggle.textContent = 'Démarrer le scan en chaîne';
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Caméra indisponible. Ouvre le site en HTTPS dans Safari.', true);
    return;
  }
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') await audioContext.resume();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    els.video.srcObject = stream;
    await els.video.play();
    els.placeholder.hidden = true;
    els.scan.disabled = false;
    continuous = true;
    els.toggle.textContent = 'Arrêter le scan';
    setStatus('Scan en chaîne actif. Place toute la carte dans le cadre et ne bouge plus.');
    scheduleScan(500);
  } catch (error) {
    setStatus(error.name === 'NotAllowedError' ? 'Autorise la caméra dans les réglages Safari.' : `Caméra impossible : ${error.message}`, true);
  }
}

function scheduleScan(delay = 700) {
  clearTimeout(scanTimer);
  if (continuous && stream) scanTimer = setTimeout(() => scanCard(true), delay);
}

function cardCrop() {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  // The visible guide occupies 76% width and 88% height. object-fit: cover means
  // the video may be cropped; using the same centered ratio keeps OCR inside the card.
  const targetRatio = 63 / 88;
  let height = vh * .88;
  let width = height * targetRatio;
  if (width > vw * .76) { width = vw * .76; height = width / targetRatio; }
  return { x: Math.floor((vw - width) / 2), y: Math.floor((vh - height) / 2), width: Math.floor(width), height: Math.floor(height) };
}

function buildOcrCanvas() {
  const crop = cardCrop();
  const ctx = els.canvas.getContext('2d', { willReadFrequently: true });
  const outputWidth = 1400;
  const topHeight = 260;
  const bottomHeight = 360;
  els.canvas.width = outputWidth;
  els.canvas.height = topHeight + bottomHeight;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
  // Title line, enlarged.
  ctx.drawImage(els.video, crop.x + crop.width * .035, crop.y + crop.height * .025, crop.width * .93, crop.height * .15, 0, 0, outputWidth, topHeight);
  // Collector information and set code, enlarged.
  ctx.drawImage(els.video, crop.x + crop.width * .025, crop.y + crop.height * .79, crop.width * .95, crop.height * .19, 0, topHeight, outputWidth, bottomHeight);
  // Increasing contrast helps small collector text on recent cards.
  const image = ctx.getImageData(0, 0, els.canvas.width, els.canvas.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = .299 * data[i] + .587 * data[i + 1] + .114 * data[i + 2];
    const value = gray > 150 ? 255 : gray < 75 ? 0 : (gray - 75) * 3.4;
    data[i] = data[i + 1] = data[i + 2] = value;
  }
  ctx.putImageData(image, 0, 0);
}

function parseOcr(text) {
  const upper = text.toUpperCase().replace(/[|]/g, 'I');
  const combined = upper.match(/\b([A-Z0-9]{2,6})\s*[-•:]?\s*(\d{1,4}[A-Z]?)\s*\/\s*\d{1,4}\b/);
  if (combined) return { set: combined[1], number: combined[2] };
  const set = upper.match(/\b[A-Z][A-Z0-9]{2,5}\b/);
  const number = upper.match(/\b(\d{1,4}[A-Z]?)\s*\/\s*\d{1,4}\b/);
  return { set: set?.[0] || '', number: number?.[1] || '' };
}

async function scanCard(automatic = false) {
  if (!stream || scanning) return;
  scanning = true;
  els.scan.disabled = true;
  try {
    buildOcrCanvas();
    if (!automatic || !worker) setStatus('Lecture de la carte… le premier passage peut être plus long.');
    worker ||= await createWorker('eng');
    const result = await worker.recognize(els.canvas);
    const rawText = result.data.text.trim();
    const signature = rawText.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 80);
    if (automatic && signature && signature === lastOcrSignature) return;
    const parsed = parseOcr(rawText);
    els.set.value = parsed.set;
    els.number.value = parsed.number;
    let card = null;
    if (parsed.set && parsed.number) card = await fetchExactCard(parsed.set, parsed.number);
    if (!card) card = await fetchCardByOcrName(rawText);
    if (!card) {
      consecutiveMisses += 1;
      if (consecutiveMisses >= 3) {
        // A gap means the previous card was removed. This allows several copies
        // of the same printing to be scanned one after another without duplicates.
        lastCardId = null;
        lastOcrSignature = '';
      }
      if (!automatic) setStatus('Carte non reconnue. Rapproche-la, évite les reflets et réessaie.', true);
      return;
    }
    consecutiveMisses = 0;
    lastOcrSignature = signature;
    await acceptScannedCard(card);
  } catch (error) {
    if (!automatic) setStatus(`Lecture impossible : ${error.message}`, true);
  } finally {
    scanning = false;
    els.scan.disabled = !stream;
    scheduleScan(lastCardId ? 1000 : 550);
  }
}

async function fetchExactCard(set, number) {
  const response = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(set.toLowerCase())}/${encodeURIComponent(number)}`, { headers: { Accept: 'application/json;q=0.9,*/*;q=0.8' } });
  return response.ok ? response.json() : null;
}

function candidateNames(text) {
  return text.split(/\r?\n/).map((line) => line.replace(/[^\p{L}\p{N}',’\- ]/gu, ' ').replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 3 && line.length <= 55 && /\p{L}/u.test(line))
    .slice(0, 4);
}

async function fetchCardByOcrName(text) {
  for (const name of candidateNames(text)) {
    const response = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`, { headers: { Accept: 'application/json;q=0.9,*/*;q=0.8' } });
    if (response.ok) return response.json();
    await new Promise((resolve) => setTimeout(resolve, 110));
  }
  return null;
}

async function acceptScannedCard(card) {
  currentCard = card;
  currentPrice = null;
  renderCard(card, false);
  if (card.id !== lastCardId) {
    lastCardId = card.id;
    if (!session.some((item, index) => index === session.length - 1 && item.id === card.id)) {
      session.push({ id: card.id, name: card.name, set: card.set, number: card.collector_number, price: null });
      updateSession();
    }
    beep();
    const flash = $('scan-flash');
    flash.classList.add('success');
    setTimeout(() => flash.classList.remove('success'), 260);
    if (navigator.vibrate) navigator.vibrate(80);
  }
  setStatus(`${card.name} reconnue ✓ Retire-la et présente la suivante.`);
}

function beep() {
  if (!audioContext) return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.frequency.value = 880;
  gain.gain.setValueAtTime(.08, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .12);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + .12);
}

async function lookupCard(set, number) {
  set = set.trim().toLowerCase();
  number = number.trim();
  if (!set || !number) return setStatus('Indique le code d’édition et le numéro.', true);
  setStatus('Identification via Scryfall…');
  els.result.hidden = true;
  try {
    const response = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(set)}/${encodeURIComponent(number)}`, { headers: { Accept: 'application/json;q=0.9,*/*;q=0.8' } });
    if (!response.ok) throw new Error(response.status === 404 ? 'carte introuvable' : `Scryfall ${response.status}`);
    currentCard = await response.json();
    currentPrice = null;
    renderCard(currentCard);
    setStatus('Carte identifiée. Vérifie ensuite son prix Playin.');
  } catch (error) {
    setStatus(`Identification impossible : ${error.message}. Vérifie les deux champs.`, true);
  }
}

function renderCard(card, shouldScroll = true) {
  const face = card.card_faces?.[0] || card;
  els.image.src = face.image_uris?.normal || face.image_uris?.small || '';
  els.image.alt = card.name;
  els.name.textContent = card.printed_name || card.name;
  els.cardSet.textContent = card.set_name;
  els.meta.textContent = `${card.set.toUpperCase()} · #${card.collector_number} · ${card.lang.toUpperCase()}${card.foil ? ' · foil possible' : ''}`;
  els.price.textContent = 'À vérifier';
  els.priceNote.textContent = 'Le prix exact dépend de la langue, de l’état et du foil.';
  els.result.hidden = false;
  if (shouldScroll) els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function playinSearchUrl(card) {
  return `https://rachat.play-in.com/recherche?search=${encodeURIComponent(card.name)}`;
}

async function checkPlayin() {
  if (!currentCard) return;
  const playinUrl = playinSearchUrl(currentCard);
  const template = els.proxy.value.trim();
  if (!template) {
    window.open(playinUrl, '_blank', 'noopener');
    setStatus('Recherche Playin ouverte. Reviens ici pour continuer les scans.');
    return;
  }
  const proxyUrl = template.includes('{url}') ? template.replace('{url}', encodeURIComponent(playinUrl)) : `${template}${encodeURIComponent(playinUrl)}`;
  setStatus('Lecture de Playin via le proxy configuré…');
  try {
    const response = await fetch(proxyUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const price = extractPrice(html, currentCard.name);
    if (price == null) throw new Error('prix exact non reconnu');
    currentPrice = price;
    els.price.textContent = price.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
    els.priceNote.textContent = 'Prix détecté automatiquement : vérifie langue, état et finition sur Playin.';
    setStatus('Prix trouvé. Vérifie la variante avant de l’ajouter.');
  } catch (error) {
    setStatus(`Proxy utilisable, mais ${error.message}. Ouverture de Playin.`, true);
    window.open(playinUrl, '_blank', 'noopener');
  }
}

function extractPrice(html, cardName) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const normalized = cardName.toLowerCase();
  const nodes = [...doc.querySelectorAll('article, li, tr, .item, .product, .card')];
  const candidate = nodes.find((node) => node.textContent.toLowerCase().includes(normalized));
  const text = (candidate || doc.body).textContent;
  const match = text.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*€/);
  return match ? Number(match[1].replace(',', '.')) : null;
}

els.toggle.addEventListener('click', toggleCamera);
els.scan.addEventListener('click', () => scanCard(false));
els.form.addEventListener('submit', (event) => { event.preventDefault(); lookupCard(els.set.value, els.number.value); });
els.playin.addEventListener('click', checkPlayin);
els.add.addEventListener('click', () => {
  if (!currentCard) return;
  session.push({ id: currentCard.id, name: currentCard.name, set: currentCard.set, number: currentCard.collector_number, price: currentPrice });
  updateSession();
  setStatus(`${currentCard.name} ajoutée à la session.`);
});
els.clear.addEventListener('click', () => { session.length = 0; updateSession(); });
els.save.addEventListener('click', () => { localStorage.setItem('playin-proxy', els.proxy.value.trim()); setStatus('Réglage enregistré sur cet appareil.'); });

function updateNetwork() {
  els.network.textContent = navigator.onLine ? 'En ligne' : 'Hors ligne';
  els.network.classList.toggle('offline', !navigator.onLine);
}
window.addEventListener('online', updateNetwork);
window.addEventListener('offline', updateNetwork);
updateNetwork();
updateSession();

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
if (isiOS && !standalone && !sessionStorage.getItem('install-dismissed')) $('install-help').hidden = false;
$('close-install').addEventListener('click', () => { $('install-help').hidden = true; sessionStorage.setItem('install-dismissed', '1'); });
