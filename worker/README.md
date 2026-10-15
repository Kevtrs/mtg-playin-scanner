# Relais de prix Playin (optionnel)

Petit Cloudflare Worker gratuit qui récupère la page de prix Playin à la place du relais public Jina :
plus rapide (visé : 0,4 à 0,8 s au lieu de ~1,2 s) et avec un cache partagé de 6 h.
Il s'identifie comme `MTGPlayinScanner/1.0` (pas de faux navigateur).

## Déployer (une fois, 5 minutes)

1. Crée un compte gratuit sur https://dash.cloudflare.com
2. Dans ce dossier :
   ```bash
   cd worker
   npx wrangler login
   npx wrangler deploy
   ```
3. Wrangler affiche une adresse du type `https://mtg-playin-price-relay.<ton-compte>.workers.dev`.
4. Dans `src/config.js`, mets cette adresse dans `PRICE_RELAY_URL`, puis pousse sur `main`.

Tant que `PRICE_RELAY_URL` est vide, l'app utilise Jina comme avant. Si le relais échoue, l'app retombe sur Jina.

## Tester en local

```bash
npx wrangler dev
curl "http://127.0.0.1:8787/price?name=Sol%20Ring" | head -c 300
```
