// Petit relais pour les prix de rachat Playin (Cloudflare Worker).
// GET /price?name=<nom de carte>  ->  page de résultats Playin (HTML), avec CORS.
// Il s'identifie honnêtement auprès de Playin et met les réponses en cache 6 h.

const ALLOWED_ORIGINS = ['https://kevtrs.github.io', 'http://localhost:5173', 'http://127.0.0.1:5173'];
const UA = 'MTGPlayinScanner/1.0 (outil personnel de consultation de prix; https://github.com/Kevtrs/mtg-playin-scanner)';
const CACHE_SECONDS = 6 * 3600;

function cors(request) {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env, ctx) {
    const headers = cors(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET') return new Response('Méthode non autorisée', { status: 405, headers });

    const url = new URL(request.url);
    if (url.pathname !== '/price') return new Response('Introuvable', { status: 404, headers });
    const name = (url.searchParams.get('name') || '').trim();
    if (!name || name.length > 120) return new Response('Nom de carte invalide', { status: 400, headers });

    const target = `https://rachat.play-in.com/magic/result.php?r=${encodeURIComponent(name)}`;
    const cacheKey = new Request(target);
    const cache = caches.default;
    let response = await cache.match(cacheKey);
    if (!response) {
      const upstream = await fetch(target, { headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9' } });
      if (!upstream.ok) return new Response(`Playin a répondu ${upstream.status}`, { status: 502, headers });
      response = new Response(upstream.body, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    const out = new Response(response.body, response);
    for (const [key, value] of Object.entries(headers)) out.headers.set(key, value);
    out.headers.set('X-Relay-Cache', response.headers.has('Age') ? 'HIT' : 'MISS');
    return out;
  },
};
