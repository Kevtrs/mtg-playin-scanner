// Automatic crash lab. Each step is written to localStorage BEFORE it runs and updated every second.
// If the page is killed (no `pagehide`), the next load knows exactly which step died, after how many
// seconds, and the last engine memory reading, then offers to continue with the next step.
const KEY = 'lab-state-v1';
const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const STEPS = [
  { id: 'engine-still', title: 'Moteur seul, image fixe', help: 'Aucune caméra. Le moteur analyse une photo de carte.', secs: 15, run: engineStill },
  { id: 'camera-only', title: 'Caméra seule, sans moteur', help: 'Autorise la caméra si le téléphone le demande.', secs: 15, run: (c) => cameraSteps(c, { engine: false, preview: true }) },
  { id: 'camera-engine', title: 'Caméra + moteur (comme l’application)', help: 'Pose une carte Magic bien à plat devant la caméra arrière, sans bouger.', secs: 25, run: (c) => cameraSteps(c, { engine: true, preview: true }) },
  { id: 'camera-engine-nopreview', title: 'Caméra + moteur, sans aperçu à l’écran', help: 'Garde la carte devant la caméra (l’écran restera noir).', secs: 20, run: (c) => cameraSteps(c, { engine: true, preview: false }) },
  { id: 'camera-engine-small', title: 'Caméra + moteur, images réduites (480 px)', help: 'Garde la carte devant la caméra.', secs: 20, run: (c) => cameraSteps(c, { engine: true, preview: true, width: 480 }) },
  { id: 'camera-engine-lite', title: 'Caméra basse résolution + images réduites + 1 analyse / 2 s', help: 'Garde la carte devant la caméra.', secs: 20, run: (c) => cameraSteps(c, { engine: true, preview: true, width: 480, lowCam: true, interval: 2000 }) },
];

const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
let st = load();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* storage unavailable */ } };
const fresh = () => ({ startedAt: new Date().toISOString(), idx: 0, results: [], cur: null, cleanExit: false });

// ── a step that was running when the page died ──
if (st && st.cur) {
  const c = st.cur;
  st.results.push({ id: c.id, status: st.cleanExit ? 'stop' : 'crash', secs: c.beat, wasmMB: c.wasmMB, note: c.note, last: c.last });
  st.cur = null; st.idx += 1; save();
}
window.addEventListener('pagehide', () => { if (st && st.cur) { st.cleanExit = true; save(); } });

// ── engine + camera helpers ──
let resources = [];
const track = (r) => { resources.push(r); return r; };
async function cleanup() {
  for (const r of resources.splice(0)) { try { await r(); } catch { /* already closed */ } }
}

async function startEngine(ctx) {
  const manifest = await (await fetch('../cv/assets/manifest.json')).json();
  const worker = new Worker(`../cv/scanner.worker.mjs?v=lab`, { type: 'module' });
  track(() => worker.terminate());
  const eng = { ready: false, error: null, analyses: 0, busy: false, lastMs: 0, present: 0 };
  worker.onmessage = (event) => {
    const d = event.data;
    if (d.type === 'ready') eng.ready = true;
    else if (d.type === 'result') {
      eng.analyses += 1; eng.busy = false; eng.lastMs = Math.round(d.timing?.totalMs || 0); if (d.cardPresent) eng.present += 1;
      if (typeof d.wasmMB === 'number') ctx.wasm(d.wasmMB);
    } else if (d.type === 'error') { eng.error = d.message; eng.busy = false; }
  };
  worker.onerror = (e) => { eng.error = `worker : ${e.message || 'erreur'}`; };
  worker.postMessage({ type: 'init', manifest, assetBasePath: new URL('../cv/assets', location.href).href, enableWebGpu: false, catalogMode: 'v1', rotationInvariant: false, minCornerConfidence: 0.02 });
  ctx.note('chargement du moteur…');
  for (let i = 0; i < 240 && !eng.ready && !eng.error; i++) await wait(250);
  if (eng.error) throw new Error(eng.error);
  if (!eng.ready) throw new Error('le moteur ne démarre pas (60 s)');
  eng.send = async (canvas) => {
    const bitmap = await createImageBitmap(canvas);
    eng.busy = true; worker.postMessage({ type: 'frame', bitmap, captureRequested: false, includeDebugBitmaps: false }, [bitmap]);
  };
  return eng;
}

async function engineStill(ctx) {
  const eng = await startEngine(ctx);
  const img = new Image(); img.src = '../cv/assets/samples/mtg-sample.jpg'; await img.decode();
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
  const g = canvas.getContext('2d'); g.fillStyle = '#1b1f27'; g.fillRect(0, 0, 640, 480);
  const h = 480, w = img.width * h / img.height; g.drawImage(img, (640 - w) / 2, 0, w, h);
  const end = performance.now() + ctx.secs * 1000;
  while (performance.now() < end) {
    if (!eng.busy) await eng.send(canvas);
    ctx.note(`${eng.analyses} analyses, ${eng.lastMs} ms chacune`);
    await wait(900);
    if (eng.error) throw new Error(eng.error);
  }
  ctx.last(`${eng.analyses} analyses`);
}

async function cameraSteps(ctx, o) {
  const preview = $('preview'); preview.style.display = o.preview ? 'block' : 'none';
  const eng = o.engine ? await startEngine(ctx) : null;
  const video = $('v');
  const constraints = { video: { facingMode: 'environment', width: { ideal: o.lowCam ? 640 : 1280 }, height: { ideal: o.lowCam ? 480 : 720 } }, audio: false };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  track(() => { stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; preview.width = 0; preview.height = 0; });
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  await video.play();
  await new Promise((r) => { if (video.videoWidth) r(); else video.onloadedmetadata = () => r(); });
  const vw = video.videoWidth, vh = video.videoHeight;
  const cap = document.createElement('canvas');
  const scale = o.width ? o.width / vw : 1; cap.width = Math.round(vw * scale); cap.height = Math.round(vh * scale);
  const cg = cap.getContext('2d');
  const pg = preview.getContext('2d', { alpha: false });
  let raf = 0, lastDraw = 0;
  const draw = (now) => {
    raf = requestAnimationFrame(draw);
    if (!o.preview || now - lastDraw < 66) return; lastDraw = now;
    const W = preview.clientWidth, H = preview.clientHeight;
    if (preview.width !== W || preview.height !== H) { preview.width = W; preview.height = H; }
    const s = Math.max(W / vw, H / vh); pg.drawImage(video, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s);
  };
  raf = requestAnimationFrame(draw); track(() => cancelAnimationFrame(raf));
  ctx.last(`caméra ${vw}×${vh}${o.width ? `, images envoyées ${cap.width}×${cap.height}` : ''}`);
  const interval = o.interval || 700;
  const end = performance.now() + ctx.secs * 1000;
  while (performance.now() < end) {
    cg.drawImage(video, 0, 0, cap.width, cap.height);
    if (eng) { if (!eng.busy) await eng.send(cap); if (eng.error) throw new Error(eng.error); }
    else { const b = await createImageBitmap(cap); b.close(); }
    ctx.note(`caméra ${vw}×${vh}${eng ? ` · ${eng.analyses} analyses (${eng.present} avec carte), ${eng.lastMs} ms` : ''}`);
    await wait(interval);
  }
}

// ── step runner ──
async function runStep(index) {
  const step = STEPS[index];
  const t0 = performance.now();
  st.cleanExit = false; st.cur = { id: step.id, beat: 0, wasmMB: null, note: '', last: '' }; save();
  $('current').hidden = false; $('cur-title').textContent = `Étape ${index + 1} sur ${STEPS.length} : ${step.title}`; $('cur-help').textContent = step.help;
  const ctx = {
    secs: step.secs,
    note: (text) => { st.cur.note = text; },
    wasm: (mb) => { st.cur.wasmMB = mb; },
    last: (text) => { st.cur.last = text; },
  };
  const beat = setInterval(() => {
    st.cur.beat = Math.round((performance.now() - t0) / 1000); save();
    $('cur-bar').style.transform = `scaleX(${Math.min(1, st.cur.beat / (step.secs + 8))})`;
    $('cur-info').textContent = `${st.cur.beat} s · ${st.cur.note || ''}${st.cur.wasmMB != null ? ` · mémoire du moteur ${st.cur.wasmMB} Mo` : ''}`;
  }, 1000);
  let status = 'ok', note = '';
  try { await step.run(ctx); } catch (error) { status = 'error'; note = String(error.message || error); }
  clearInterval(beat);
  const c = st.cur;
  st.results.push({ id: step.id, status, secs: Math.round((performance.now() - t0) / 1000), wasmMB: c.wasmMB, note: note || c.note, last: c.last });
  st.cur = null; st.idx = index + 1; save();
  await cleanup(); $('preview').style.display = 'none';
  await wait(2500);
}

// ── report ──
const label = (r) => ({ ok: 'a tenu', crash: 'PAGE TUÉE', error: 'erreur', stop: 'interrompu (écran verrouillé ou changement d’app ?)' })[r.status];
function conclusion(R) {
  const by = Object.fromEntries(R.map((r) => [r.id, r]));
  const ok = (id) => by[id]?.status === 'ok'; const bad = (id) => by[id] && by[id].status !== 'ok';
  const lines = [];
  if (bad('engine-still')) lines.push('Le moteur de reconnaissance fait planter la page À LUI SEUL, sans caméra. Le problème est la mémoire du moteur sur ce téléphone.');
  else if (bad('camera-only')) lines.push('La caméra seule fait planter la page, sans moteur : le problème est l’affichage ou la capture de la caméra, pas la reconnaissance.');
  else if (bad('camera-engine')) {
    lines.push('Le moteur seul tient, la caméra seule tient, mais les deux ensemble font planter la page (comme dans l’application).');
    if (ok('camera-engine-nopreview')) lines.push('Sans aperçu à l’écran, ça tient : c’est l’affichage de la caméra qui fait la différence.');
    if (ok('camera-engine-small')) lines.push('Avec des images réduites à 480 px, ça tient : la solution est de réduire la taille des images envoyées au moteur.');
    else if (ok('camera-engine-lite')) lines.push('Avec caméra basse résolution, images réduites et une analyse toutes les 2 s, ça tient : on peut livrer ce réglage.');
    if (!ok('camera-engine-nopreview') && !ok('camera-engine-small') && !ok('camera-engine-lite')) lines.push('Aucune variante ne tient : même légère, la combinaison caméra + moteur est trop lourde pour ce téléphone dans Safari.');
  } else if (R.every((r) => r.status === 'ok')) lines.push('Tout a tenu pendant ce test. Le plantage dépend de quelque chose que l’application fait en plus (prix, collection, éditions…).');
  else lines.push('Résultats mélangés : voir le détail ci-dessus.');
  return lines;
}
function report() {
  const R = st.results;
  const out = [`Test du scanner du ${new Date(st.startedAt).toLocaleString('fr-FR')}`, `Téléphone : ${navigator.userAgent}`, `Écran ${screen.width}×${screen.height} @${devicePixelRatio} · cœurs ${navigator.hardwareConcurrency ?? '?'}`, ''];
  STEPS.forEach((s, i) => {
    const r = R.find((x) => x.id === s.id);
    out.push(`${i + 1}. ${s.title} : ${r ? `${label(r)} (${r.secs} s${r.wasmMB != null ? `, moteur ${r.wasmMB} Mo` : ''})${r.last ? ` — ${r.last}` : ''}${r.status === 'error' ? ` — ${r.note}` : ''}` : 'non fait'}`);
  });
  out.push('', 'Conclusion :', ...conclusion(R).map((l) => `- ${l}`));
  return out.join('\n');
}
function render() {
  const list = $('steps'); list.replaceChildren();
  STEPS.forEach((s, i) => {
    const r = st?.results.find((x) => x.id === s.id);
    const li = document.createElement('li'); li.className = r ? r.status : (st?.cur?.id === s.id ? 'run' : '');
    const dot = document.createElement('b'); dot.className = 's'; dot.textContent = r ? { ok: '✓', crash: '✗', error: '!', stop: '…' }[r.status] : String(i + 1);
    const text = document.createElement('span'); text.textContent = `${s.title} — ${r ? `${label(r)}${r.status === 'crash' ? ` après ${r.secs} s` : ''}` : 'à faire'}`;
    li.append(dot, text); list.append(li);
  });
}

async function drive() {
  $('go').hidden = true; $('intro').hidden = true;
  try { await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  while (st.idx < STEPS.length) { render(); await runStep(st.idx); }
  finish();
}
function finish() {
  $('current').hidden = true; $('go').hidden = true; $('intro').hidden = true; render();
  $('report').textContent = report(); $('done').hidden = false;
}

$('go').addEventListener('click', () => { if (!st || st.idx >= STEPS.length) { st = fresh(); save(); } drive(); });
$('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('report').textContent); $('copy').textContent = 'Copié ✓'; } catch { $('copy').textContent = 'Sélectionne le texte au-dessus'; } });
$('again').addEventListener('click', () => { st = fresh(); save(); $('done').hidden = true; $('intro').hidden = false; $('go').hidden = false; $('go').textContent = 'Lancer le test'; render(); });

render();
if (st && st.idx >= STEPS.length) finish();
else if (st && st.results.length) {
  const last = st.results[st.results.length - 1];
  $('intro').textContent = last.status === 'crash'
    ? `La page vient d’être tuée pendant l’étape « ${STEPS.find((s) => s.id === last.id)?.title} », après ${last.secs} s. C’est une information utile : touche « Continuer » pour passer à l’étape suivante.`
    : 'Le test est en cours. Touche « Continuer » pour reprendre.';
  $('go').textContent = 'Continuer le test';
}
