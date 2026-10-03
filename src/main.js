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
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
    els.video.srcObject = null;
    els.placeholder.hidden = false;
    els.scan.disabled = true;
    els.toggle.textContent = 'Ouvrir la caméra';
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Caméra indisponible. Ouvre le site en HTTPS dans Safari.', true);
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    els.video.srcObject = stream;
    await els.video.play();
    els.placeholder.hidden = true;
    els.scan.disabled = false;
    els.toggle.textContent = 'Fermer la caméra';
    setStatus('Caméra prête. Cadre le bas de la carte puis touche Scanner.');
  } catch (error) {
    setStatus(error.name === 'NotAllowedError' ? 'Autorise la caméra dans les réglages Safari.' : `Caméra impossible : ${error.message}`, true);
  }
}

function parseOcr(text) {
  const upper = text.toUpperCase().replace(/[|]/g, 'I');
  const combined = upper.match(/\b([A-Z0-9]{2,6})\s*[-•:]?\s*(\d{1,4}[A-Z]?)\s*\/\s*\d{1,4}\b/);
  if (combined) return { set: combined[1], number: combined[2] };
  const set = upper.match(/\b[A-Z][A-Z0-9]{2,5}\b/);
  const number = upper.match(/\b(\d{1,4}[A-Z]?)\s*\/\s*\d{1,4}\b/);
  return { set: set?.[0] || '', number: number?.[1] || '' };
}

async function scanCard() {
  if (!stream) return;
  els.scan.disabled = true;
  try {
    const vw = els.video.videoWidth;
    const vh = els.video.videoHeight;
    const cropY = Math.floor(vh * 0.68);
    els.canvas.width = vw;
    els.canvas.height = vh - cropY;
    els.canvas.getContext('2d').drawImage(els.video, 0, cropY, vw, vh - cropY, 0, 0, vw, vh - cropY);
    setStatus('Lecture du bas de la carte… premier scan un peu plus long.');
    worker ||= await createWorker('eng');
    const result = await worker.recognize(els.canvas);
    const parsed = parseOcr(result.data.text);
    els.set.value = parsed.set;
    els.number.value = parsed.number;
    if (!parsed.set || !parsed.number) {
      setStatus('Lecture incertaine : corrige le code et le numéro ci-dessous.', true);
      return;
    }
    await lookupCard(parsed.set, parsed.number);
  } catch (error) {
    setStatus(`OCR impossible : ${error.message}`, true);
  } finally {
    els.scan.disabled = !stream;
  }
}

async function lookupCard(set, number) {
  set = set.trim().toLowerCase();
  number = number.trim();
  if (!set || !number) return setStatus('Indique le code d’édition et le numéro.', true);
  setStatus('Identification via Scryfall…');
  els.result.hidden = true;
  try {
    const response = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(set)}/${encodeURIComponent(number)}`);
    if (!response.ok) throw new Error(response.status === 404 ? 'carte introuvable' : `Scryfall ${response.status}`);
    currentCard = await response.json();
    currentPrice = null;
    renderCard(currentCard);
    setStatus('Carte identifiée. Vérifie ensuite son prix Playin.');
  } catch (error) {
    setStatus(`Identification impossible : ${error.message}. Vérifie les deux champs.`, true);
  }
}

function renderCard(card) {
  const face = card.card_faces?.[0] || card;
  els.image.src = face.image_uris?.normal || face.image_uris?.small || '';
  els.image.alt = card.name;
  els.name.textContent = card.printed_name || card.name;
  els.cardSet.textContent = card.set_name;
  els.meta.textContent = `${card.set.toUpperCase()} · #${card.collector_number} · ${card.lang.toUpperCase()}${card.foil ? ' · foil possible' : ''}`;
  els.price.textContent = 'À vérifier';
  els.priceNote.textContent = 'Le prix exact dépend de la langue, de l’état et du foil.';
  els.result.hidden = false;
  els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
els.scan.addEventListener('click', scanCard);
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
