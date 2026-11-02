import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  MC_API, buildSearchUrl, frontFace, nameKey, numberKey, editionVerdict, matchPrinting, normalizeCard, offerFor, maxQuantity,
  compareOffers, stateLabel, mcPanel, snapshotResult, sanitizeMc, entryComparison, comparisonTotals, createMcClient, McError,
} from '../src/magiccorporation.js';
import {parseBackup, makeBackup, toCsv} from '../src/backup.js';

// ── fixtures shaped like the real API (records taken from rachat.magiccorporation.com/api/search/cards) ──
const raw = (o = {}) => ({
  id: 189, name: 'Lightning Bolt', name_fr: 'Foudre', number: '208', edition: {id: 10, name: '4ème Édition', code: '4E'},
  buyback_price_vf: 2, buyback_price_vo: 2, buyback_price_foil_vf: 2, buyback_price_foil_vo: 2,
  has_foil_vf: false, has_foil_vo: false, en_blocked: false, not_bought: false, low_value: false, nm_only: true, ...o,
});
const LB_4E = raw();                                                                            // 4th Edition, FR/EN 2 EUR
const LB_REVISED = raw({id: 190, number: '162', edition: {id: 5, name: '3ème Édition', code: 'R'}});
const LB_BETA = raw({id: 191, number: '162', edition: {id: 2, name: 'Beta', code: 'B'}, buyback_price_vf: 0.01, buyback_price_vo: 0.01});
const LB_M10 = raw({id: 192, number: '146', edition: {id: 99, name: 'Magic 2010', code: 'M10'}, buyback_price_vf: 1.5, buyback_price_vo: 0, en_blocked: true});
const GALA = raw({id: 65639, name: 'Gala Greeters', name_fr: "Personnel d'accueil du gala", number: '148', edition: {id: 275, name: 'Les rues de la Nouvelle-Capenna', code: 'SNC'},
  buyback_price_vf: 0.3, buyback_price_vo: 0, buyback_price_foil_vf: 0.3, buyback_price_foil_vo: 0, en_blocked: true});
const GALA_431 = raw({...GALA, id: 65995, number: '431', buyback_price_vf: 0.7, buyback_price_foil_vf: 0.7});
const STM = raw({id: 5001, number: '42', edition: {id: 257, name: 'Strixhaven Mystical Archive', code: 'STM'}, buyback_price_vf: 0.6, buyback_price_vo: 0, buyback_price_foil_vf: 3.5, buyback_price_foil_vo: 0, en_blocked: true});

const card = (name, set, number) => ({name, set, collector_number: number});
const LB_CARD_4ED = card('Lightning Bolt', '4ed', '208');
const cards = (...list) => list.map(normalizeCard);

// ── request shape ──
test('only GET search URLs with whitelisted parameters are ever built', () => {
  const url = new URL(buildSearchUrl({q: 'Lightning Bolt', editionId: 10, page: 2}));
  assert.equal(`${url.origin}${url.pathname}`, MC_API);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['edition_id', 'non_rachetees', 'page', 'q']);
  assert.equal(url.searchParams.get('q'), 'Lightning Bolt'); assert.equal(url.searchParams.get('edition_id'), '10'); assert.equal(url.searchParams.get('page'), '2');
  assert.equal(new URL(buildSearchUrl({q: 'x'})).searchParams.has('edition_id'), false);
  assert.equal(new URL(buildSearchUrl({q: 'x', page: 9999})).searchParams.get('page'), '50');
  assert.equal(new URL(buildSearchUrl({q: 'x', page: -3})).searchParams.get('page'), '1');
  assert.throws(() => buildSearchUrl({q: 'x', editionId: '10; DROP'}), McError);
  assert.throws(() => buildSearchUrl({q: 'x', editionId: -1}), McError);
});

test('names and numbers are compared on the front face, without accents or punctuation', () => {
  assert.equal(nameKey("Lim-Dûl’s Vault"), nameKey("Lim-Dul's Vault"));
  assert.equal(nameKey('Delver of Secrets // Insectile Aberration'), 'delver of secrets');
  assert.equal(frontFace('Emeritus of Conflict /Lightning Bolt'), 'Emeritus of Conflict');
  assert.equal(numberKey('0042'), '42'); assert.equal(numberKey(' 12A '), '12a'); assert.equal(numberKey(null), ''); assert.equal(numberKey('0'), '0');
});

// ── matching: name + edition + number, never another printing ──
test('exact match: the 4th Edition Lightning Bolt is found among other printings (MagicCorporation says 4E, Scryfall says 4ed)', () => {
  const m = matchPrinting(cards(LB_M10, LB_REVISED, LB_4E, LB_BETA), LB_CARD_4ED);
  assert.equal(m.status, 'ok'); assert.equal(m.card.edition.code, '4E'); assert.equal(m.card.number, '208');
});

test('Revised (R) is Scryfall 3ed and matches on name and number', () => {
  assert.equal(matchPrinting(cards(LB_REVISED), card('Lightning Bolt', '3ed', '162')).status, 'ok');
});

test('wrong edition: the same name and number in ANOTHER edition is never taken', () => {
  const m = matchPrinting(cards(LB_BETA), card('Lightning Bolt', '3ed', '162')); // Beta #162 has the same number as Revised #162
  assert.equal(m.status, 'absent');
  assert.equal(editionVerdict({id: 2, code: 'B'}, card('x', '3ed', '1')), 'other');
  assert.equal(editionVerdict({id: 2, code: 'B'}, card('x', 'leb', '1')), 'same');
});

test('right edition but another printing (different number) is not taken', () => {
  const m = matchPrinting(cards(GALA_431), card('Gala Greeters', 'snc', '148'));
  assert.equal(m.status, 'absent');
  const both = matchPrinting(cards(GALA_431, GALA), card('Gala Greeters', 'snc', '148'));
  assert.equal(both.status, 'ok'); assert.equal(both.card.number, '148'); assert.equal(both.card.vf, 0.3);
});

test('an edition that cannot be tied to a Scryfall set gives "correspondance à vérifier", not a price', () => {
  const unknown = raw({edition: {id: 999999, name: 'Édition inconnue', code: 'ZZZ'}});
  const m = matchPrinting(cards(unknown), LB_CARD_4ED);
  assert.equal(m.status, 'verify'); assert.equal(m.reason, 'edition'); assert.equal(m.candidates.length, 1);
  assert.equal(matchPrinting(cards(raw({edition: {id: 999999, name: 'x', code: '4ED'}})), LB_CARD_4ED).status, 'ok'); // a code that does equal Scryfall's is enough for a NEW set
});

test('two identical rows are ambiguous: verify, never pick one', () => {
  const m = matchPrinting(cards(LB_4E, raw({id: 777})), LB_CARD_4ED);
  assert.equal(m.status, 'verify'); assert.equal(m.reason, 'ambiguous');
});

test('numbering differs (Renaissance #1 vs #2): accepted only when it is the single row of that name in that edition', () => {
  const alabaster = raw({id: 1, name: 'Alabaster Potion', name_fr: 'Potion d’albâtre', number: '1', edition: {id: 16, name: 'Renaissance', code: 'RE'}});
  const one = matchPrinting(cards(alabaster), card('Alabaster Potion', 'ren', '2'));
  assert.equal(one.status, 'ok'); assert.equal(one.loose, true);
  assert.equal(matchPrinting(cards(alabaster), card('Alabaster Potion', 'ren', '1')).loose, undefined); // exact number: not loose
  const twin = raw({id: 2, name: 'Alabaster Potion', number: '7', edition: {id: 16, name: 'Renaissance', code: 'RE'}});
  assert.equal(matchPrinting(cards(alabaster, twin), card('Alabaster Potion', 'ren', '2')).status, 'verify'); // two rows: never pick one
});

test('MagicCorporation number "0" (8th Edition) matches Scryfall S3 when it is the only row of that name in the edition', () => {
  const octopus = raw({id: 7, name: 'Giant Octopus', name_fr: 'Pieuvre géante', number: '0', edition: {id: 49, name: '8ème Édition', code: '8E'}, buyback_price_vf: 0.1, buyback_price_vo: 0});
  const other = raw({id: 8, name: 'Giant Octopus', number: '77', edition: {id: 41, name: '7ème Édition', code: '7E'}});
  const m = matchPrinting(cards(other, octopus), card('Giant Octopus', '8ed', 'S3'));
  assert.equal(m.status, 'ok'); assert.equal(m.card.vf, 0.1); assert.equal(m.loose, true);
  assert.equal(matchPrinting(cards(other), card('Giant Octopus', '8ed', 'S3')).status, 'absent'); // only another edition listed
  assert.match(mcPanel({status: 'ok', loose: true, card: normalizeCard(octopus)}).note, /numéro différent/);
  assert.equal(sanitizeMc(snapshotResult({status: 'ok', loose: true, card: normalizeCard(octopus)})).loose, true);
});

test('a card with a different front face is not the same card (Emeritus of Conflict /Lightning Bolt)', () => {
  const sos = raw({id: 5, name: 'Emeritus of Conflict /Lightning Bolt', number: '113', edition: {id: 344, name: 'Les secrets de Strixhaven', code: 'SOS'}});
  assert.equal(matchPrinting(cards(sos), card('Lightning Bolt', 'sos', '113')).status, 'absent');
  assert.equal(matchPrinting(cards(sos), card('Emeritus of Conflict // Lightning Bolt', 'sos', '113')).status, 'ok');
});

// ── availability rules (copied from the site's own JavaScript) ──
test('2 EUR in FR and EN, normal', () => {
  const c = normalizeCard(LB_4E);
  assert.deepEqual(offerFor(c, 'Fr', 'normal'), {state: 'price', price: 2, limit: 12});
  assert.deepEqual(offerFor(c, 'En', 'normal'), {state: 'price', price: 2, limit: 12});
});

test('English blocked: FR is bought, EN is not, and the French price is offered as the alternative', () => {
  const c = normalizeCard(GALA);
  assert.equal(offerFor(c, 'Fr', 'normal').price, 0.3);
  const en = offerFor(c, 'En', 'normal');
  assert.equal(en.state, 'unavailable'); assert.equal(en.reason, 'enBlocked'); assert.deepEqual(en.alt, {language: 'Fr', price: 0.3});
  assert.equal(stateLabel(en), 'Anglais non racheté');
});

test('foil is unavailable when has_foil says so, even though the foil price columns are filled', () => {
  const c = normalizeCard(STM); // foil price 3.5 but has_foil_vf false
  assert.equal(offerFor(c, 'Fr', 'foil').state, 'noFoil');
  assert.equal(stateLabel(offerFor(c, 'Fr', 'foil')), 'Foil non racheté');
  assert.equal(offerFor(c, 'Fr', 'normal').price, 0.6);
  const foil = normalizeCard(raw({has_foil_vf: true, buyback_price_foil_vf: 3.5}));
  assert.equal(offerFor(foil, 'Fr', 'foil').price, 3.5);
  assert.equal(offerFor(normalizeCard(raw({has_foil_vf: true, buyback_price_foil_vf: 0.01})), 'Fr', 'foil').state, 'quote'); // foil on quote
  assert.equal(offerFor(normalizeCard(raw({has_foil_vo: true, buyback_price_foil_vo: 4})), 'En', 'foil').price, 4);
});

test('a price of 0.01 EUR or less is "sur devis", never "rachat 0,01 €"', () => {
  for (const price of [0.01, 0, 0.005]) {
    const c = normalizeCard(raw({buyback_price_vf: price, buyback_price_vo: price}));
    assert.deepEqual(offerFor(c, 'Fr', 'normal'), {state: 'quote'}); assert.equal(stateLabel(offerFor(c, 'Fr', 'normal')), 'Sur devis');
  }
  assert.equal(offerFor(normalizeCard(raw({buyback_price_vf: 0.02})), 'Fr', 'normal').price, 0.02);
  assert.equal(offerFor(normalizeCard(raw({buyback_price_vf: '0.50'})), 'Fr', 'normal').price, 0.5); // prices may arrive as strings
});

test('not bought and low value (not bought individually) are not quotes', () => {
  const none = {buyback_price_vf: 0, buyback_price_vo: 0, buyback_price_foil_vf: 0, buyback_price_foil_vo: 0};
  assert.deepEqual(offerFor(normalizeCard(raw({...none, not_bought: true})), 'Fr', 'normal'), {state: 'notBought'});
  assert.deepEqual(offerFor(normalizeCard(raw({...none, low_value: true})), 'Fr', 'normal'), {state: 'lowValue'});
  assert.equal(stateLabel({state: 'lowValue'}), 'Non rachetée à l’unité');
  assert.equal(offerFor(normalizeCard(raw({not_bought: true})), 'Fr', 'normal').state, 'notBought'); // flagged not bought: no price, whatever the columns say
});

test('French needs a French name AND a price above 0.01; the other language is offered as an alternative', () => {
  const noFr = normalizeCard(raw({name_fr: null, buyback_price_vf: 5, buyback_price_vo: 1}));
  const fr = offerFor(noFr, 'Fr', 'normal');
  assert.equal(fr.state, 'unavailable'); assert.equal(fr.reason, 'noFrench'); assert.deepEqual(fr.alt, {language: 'En', price: 1});
  assert.equal(offerFor(noFr, 'En', 'normal').price, 1);
  const cheapFr = normalizeCard(raw({buyback_price_vf: 0.01, buyback_price_vo: 3}));
  assert.equal(offerFor(cheapFr, 'Fr', 'normal').reason, 'quote');
});

test('purchase limits follow the price bands announced by the site', () => {
  assert.deepEqual([0, 0.01, 0.5, 2.99, 3, 9.99, 10, 70].map(maxQuantity), [0, 0, 12, 12, 8, 8, 4, 4]);
});

test('best offer: highest comparable number wins, a missing number never wins, equal is a tie', () => {
  assert.deepEqual(compareOffers(1, 2), {best: 'mc', only: false, diff: 1});
  assert.deepEqual(compareOffers(3, 2), {best: 'playin', only: false, diff: 1});
  assert.deepEqual(compareOffers(2, 2).best, 'tie');
  assert.deepEqual(compareOffers(null, 2), {best: 'mc', only: true, diff: 0});
  assert.deepEqual(compareOffers(2, null), {best: 'playin', only: true, diff: 0});
  assert.deepEqual(compareOffers(null, null).best, null);
  assert.equal(compareOffers(0.1 + 0.2, 0.3).best, 'tie');
});

// ── history is preserved ──
test('backups keep entries without MagicCorporation data untouched and sanitise the data they carry', () => {
  const ok = {v: 1, status: 'ok', at: 5, card: normalizeCard(LB_4E)};
  const entries = [
    {entryId: 'old', id: 'a', name: 'Old entry', set: 'lea', number: '1', price: 1, quantity: 2, prices: {normal: 1, foil: null}, finish: 'normal', language: 'Fr'},
    {entryId: 'new', id: 'b', name: 'New entry', set: '4ed', number: '208', price: 1, quantity: 1, prices: {normal: 1, foil: null}, finish: 'normal', language: 'Fr', mc: ok},
  ];
  const back = parseBackup(makeBackup(entries));
  assert.equal(back.ok, true); assert.equal(back.entries.length, 2);
  assert.equal(back.entries[0].name, 'Old entry'); assert.equal(back.entries[0].quantity, 2); assert.equal('mc' in back.entries[0] && back.entries[0].mc !== undefined, false);
  assert.equal(back.entries[1].mc.card.vf, 2);
  const hostile = {v: 1, status: 'ok', at: 1, card: {id: '<script>', name: 'x'.repeat(5000), number: '1', edition: {id: 'a', code: 'x'.repeat(99), name: 1}, vf: -5, vo: 'bad', nameFr: null}};
  const clean = sanitizeMc(hostile);
  assert.equal(clean.card.name.length, 120); assert.equal(clean.card.vf, 0); assert.equal(clean.card.vo, 0); assert.equal(clean.card.id, null); assert.equal(clean.card.edition.code.length, 12);
  assert.equal(sanitizeMc({v: 2, status: 'ok'}), undefined); assert.equal(sanitizeMc('x'), undefined); assert.equal(sanitizeMc({v: 1, status: 'weird'}), undefined);
  assert.equal(sanitizeMc({v: 1, status: 'ok', at: 1}), undefined); // "ok" without a card is rejected
  const verify = sanitizeMc({v: 1, status: 'verify', reason: 'edition', candidates: [{id: 3, number: '4', edition: {id: 1, code: 'A', name: 'Alpha'}}, null]});
  assert.equal(verify.status, 'verify'); assert.equal(verify.candidates.length, 2);
});

test('the CSV export gains the MagicCorporation columns without changing the earlier ones', () => {
  const entry = {entryId: 'e', id: 'a', name: 'Foudre', set: '4ed', number: '208', price: 1, quantity: 1, prices: {normal: 1, foil: null}, finish: 'normal', language: 'Fr', mc: {v: 1, status: 'ok', at: 1, card: normalizeCard(LB_4E)}};
  const csv = toCsv([entry, {...entry, entryId: 'f', mc: undefined}]).trim().split('\r\n');
  assert.ok(csv[0].includes(';MagicCorporation (€);Statut MagicCorporation;Meilleure offre;Source des prix'));
  assert.ok(csv[1].endsWith(';2,00;Racheté;Playin;Playin (rachat)') || csv[1].endsWith(';2,00;Racheté;MagicCorporation;Playin (rachat)'));
  assert.ok(csv[2].endsWith(';;Non vérifiée;;Playin (rachat)'));
});

// ── per-entry comparison and totals ──
const entry = (o = {}) => ({entryId: Math.random().toString(36), id: 'a', name: 'X', set: '4ed', number: '208', price: 1, quantity: 1, prices: {normal: 1, foil: 4}, finish: 'normal', language: 'Fr', ...o});
const mcOk = (rawCard) => ({v: 1, status: 'ok', at: 1, card: normalizeCard(rawCard)});

test('totals per shop and with the best offer for each card; unknown prices are counted, never silently priced', () => {
  const t = comparisonTotals([
    entry({price: 1, mc: mcOk(LB_4E)}),                                      // Playin 1, MC 2 -> best 2
    entry({price: 5, mc: mcOk(LB_4E)}),                                      // Playin 5, MC 2 -> best 5
    entry({price: null}),                                                     // nothing checked, no Playin price
    entry({price: 3, quantity: 2}),                                           // Playin only (MC not checked), x2
    entry({price: null, mc: mcOk(GALA)}),                                     // MC only: FR 0.30
    entry({price: 1, mc: {v: 1, status: 'verify', at: 1, reason: 'edition', candidates: []}}),
    entry({price: 1, mc: {v: 1, status: 'absent', at: 1}}),
    entry({price: 9, source: 'cardmarket'}),                                  // another kind of price: left out
  ]);
  assert.equal(t.cards, 8);
  assert.deepEqual(t.playin, {sum: 1 + 5 + 6 + 1 + 1, cards: 6});
  assert.equal(Math.round(t.mc.sum * 100) / 100, 4.3); assert.equal(t.mc.cards, 3);
  assert.deepEqual([t.mcStates.verify, t.mcStates.absent, t.mcStates.unchecked], [1, 1, 3]);
  assert.equal(Math.round(t.best.sum * 100) / 100, 2 + 5 + 6 + 0.3 + 1 + 1); assert.deepEqual([t.best.cards, t.best.unknown], [7, 1]);
});

test('totals flag quantities above the purchase limit instead of hiding it', () => {
  const t = comparisonTotals([entry({quantity: 15, price: 1, mc: mcOk(LB_4E)})]);
  assert.equal(t.mc.sum, 30); assert.equal(t.overLimit, 3);
});

test('totals and comparison follow the entry language and finish', () => {
  const stored = mcOk(GALA);
  assert.equal(entryComparison(entry({language: 'Fr', mc: stored})).magic, 0.3);
  const en = entryComparison(entry({language: 'En', mc: stored}));
  assert.equal(en.magic, null); assert.equal(en.offer.reason, 'enBlocked');
  assert.equal(entryComparison(entry({finish: 'foil', mc: mcOk(STM)})).offer.state, 'noFoil');
});

// ── network client ──
const clock = () => { let t = 5_000_000; return {now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; }}; };
const memStorage = () => ({d: {}, getItem(k) { return k in this.d ? this.d[k] : null; }, setItem(k, v) { this.d[k] = String(v); }});
const server = (handler) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const response = await handler(new URL(url), calls.length);
    calls.push({url: String(url), init, at: undefined});
    if (response instanceof Error) throw response;
    return {ok: response.status >= 200 && response.status < 300, status: response.status, headers: {get: (k) => response.headers?.[k] ?? null}, json: async () => response.body};
  };
  return {calls, fetchImpl};
};
const pageOf = (list, page = 1, last = 1) => ({status: 200, body: {data: list, current_page: page, last_page: last, total: list.length * last}});
const make = (handler, extra = {}) => { const c = clock(); const s = server(handler); const storage = extra.storage ?? memStorage(); return {...c, ...s, storage, client: createMcClient({fetchImpl: s.fetchImpl, now: c.now, sleep: c.sleep, storage, ...extra})}; };

test('a known set is searched by name AND edition id: one request, one page', async () => {
  const t = make(() => pageOf([LB_4E]));
  const r = await t.client.lookup(LB_CARD_4ED);
  assert.equal(r.status, 'ok'); assert.equal(r.card.edition.code, '4E');
  assert.equal(t.calls.length, 1);
  const u = new URL(t.calls[0].url); assert.equal(u.searchParams.get('edition_id'), '10'); assert.equal(u.searchParams.get('q'), 'Lightning Bolt');
});

test('every request is a plain GET to the search endpoint: no cart, no body, no cookies', async () => {
  const t = make(() => pageOf([LB_4E]));
  await t.client.lookup(LB_CARD_4ED); await t.client.lookup(card('Gala Greeters', 'snc', '148'));
  for (const c of t.calls) {
    assert.ok(c.url.startsWith(MC_API + '?'), c.url);
    assert.equal(c.init.method, 'GET'); assert.equal(c.init.body, undefined); assert.equal(c.init.credentials, 'omit');
    assert.deepEqual(c.init.headers, {Accept: 'application/json'});
  }
});

test('identical lookups made at the same time share ONE request', async () => {
  const t = make(() => pageOf([LB_4E]));
  const [a, b, c] = await Promise.all([t.client.lookup(LB_CARD_4ED), t.client.lookup({...LB_CARD_4ED}), t.client.lookup(LB_CARD_4ED)]);
  assert.equal(t.calls.length, 1); assert.deepEqual([a.status, b.status, c.status], ['ok', 'ok', 'ok']);
});

test('results are cached, survive a restart, and expire', async () => {
  const t = make(() => pageOf([LB_4E]));
  await t.client.lookup(LB_CARD_4ED); await t.client.lookup(LB_CARD_4ED);
  assert.equal(t.calls.length, 1);
  const again = createMcClient({fetchImpl: t.fetchImpl, now: t.now, sleep: t.sleep, storage: t.storage}); // new session, same storage
  const r = await again.lookup(LB_CARD_4ED);
  assert.equal(t.calls.length, 1); assert.equal(r.status, 'ok'); assert.equal(r.cached, true);
  t.advance(7 * 3600 * 1000);                                                                              // beyond the 6 h lifetime
  await again.lookup(LB_CARD_4ED);
  assert.equal(t.calls.length, 2);
  await again.lookup(LB_CARD_4ED, {force: true});
  assert.equal(t.calls.length, 3);
});

test('a corrupt or full storage never breaks lookups', async () => {
  const broken = {getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }};
  const t = make(() => pageOf([LB_4E]), {storage: broken});
  assert.equal((await t.client.lookup(LB_CARD_4ED)).status, 'ok');
  const garbage = memStorage(); garbage.d['mtg-mc-cache-2'] = '{oops';
  assert.equal((await make(() => pageOf([LB_4E]), {storage: garbage}).client.lookup(LB_CARD_4ED)).status, 'ok');
});

test('queue: requests are spaced out and never exceed 40 per rolling minute', async () => {
  const t = make((url) => pageOf([raw({name: url.searchParams.get('q'), number: '1', edition: {id: 10, name: 'x', code: '4E'}})]));
  const starts = [];
  const original = t.fetchImpl;
  const measuring = createMcClient({fetchImpl: async (u, i) => { starts.push(t.now()); return original(u, i); }, now: t.now, sleep: t.sleep, storage: memStorage()});
  const lookups = Array.from({length: 50}, (_, i) => measuring.lookup(card(`Card ${i}`, '4ed', '1')));
  await Promise.all(lookups);
  assert.equal(starts.length, 50);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 1300, `gap ${i}: ${starts[i] - starts[i - 1]}`);
  for (let i = 40; i < starts.length; i++) assert.ok(starts[i] - starts[i - 40] >= 60000, `window ${i}`);
});

test('unknown set: pages are followed until the printing is found, and the edition is learned for next time', async () => {
  const filler = (n) => Array.from({length: 3}, (_, i) => raw({id: n * 10 + i, name: 'Lightning Bolt', number: String(900 + n * 10 + i), edition: {id: 4000 + n, name: 'Autre', code: 'ZZ' + n}}));
  const wanted = raw({id: 1, number: '12', edition: {id: 424242, name: 'Nouvelle édition', code: 'NEW'}});
  const t = make((url) => { const p = Number(url.searchParams.get('page')); return pageOf(p === 3 ? [...filler(3), wanted] : filler(p), p, 3); });
  const r = await t.client.lookup(card('Lightning Bolt', 'new', '12'));
  assert.equal(r.status, 'ok'); assert.equal(t.calls.length, 3);
  assert.equal(new URL(t.calls[0].url).searchParams.has('edition_id'), false);
  const next = await t.client.lookup(card('Lightning Bolt', 'new', '12'), {force: true});                    // same printing again: now searched by edition id
  assert.equal(next.status, 'ok'); assert.equal(new URL(t.calls[3].url).searchParams.get('edition_id'), '424242');
});

test('pagination stops after a few pages: too many results means "correspondance à vérifier"', async () => {
  const t = make((url) => { const p = Number(url.searchParams.get('page')); return pageOf([raw({id: p, name: 'Forêt', number: String(p), edition: {id: 5000 + p, name: 'x', code: 'X' + p}})], p, 11); });
  const r = await t.client.lookup(card('Forêt', 'zzz', '999'));
  assert.equal(r.status, 'verify'); assert.equal(r.reason, 'too-many'); assert.equal(t.calls.length, 4);
});

test('a printing MagicCorporation does not list is "absent", not another printing', async () => {
  const t = make(() => pageOf([LB_M10]));
  const r = await t.client.lookup(card('Lightning Bolt', 'plst', 'CLB-187'));
  assert.equal(r.status, 'absent');
});

test('429: the queue waits, retries, and succeeds; nothing is sent during the cooldown', async () => {
  let n = 0;
  const t = make(() => (n++ === 0 ? {status: 429, headers: {'Retry-After': '30'}} : pageOf([LB_4E])));
  const states = []; t.client.onStatus((s) => states.push(s));
  const r = await t.client.lookup(LB_CARD_4ED);
  assert.equal(r.status, 'ok'); assert.equal(t.calls.length, 2);
  assert.ok(states.some((s) => s.rateLimited));
  assert.ok(states.some((s) => s.waiting && s.waitMs >= 29000));
});

test('429 without a Retry-After header (the browser cannot read it) backs off 30 s, then longer', async () => {
  const stamps = [];
  const c = clock(); const s = server(() => ({status: 429}));
  const client = createMcClient({fetchImpl: async (u, i) => { stamps.push(c.now()); return s.fetchImpl(u, i); }, now: c.now, sleep: c.sleep, storage: memStorage(), maxRetries: 2});
  await assert.rejects(client.lookup(LB_CARD_4ED), (e) => e instanceof McError && e.code === 'rate-limited');
  assert.equal(stamps.length, 3);
  assert.ok(stamps[1] - stamps[0] >= 30000); assert.ok(stamps[2] - stamps[1] >= 60000);
});

test('an outage rejects cleanly, retries once, and opens a breaker so the queue does not pile up', async () => {
  const t = make(() => new Error('network down'));
  await assert.rejects(t.client.lookup(LB_CARD_4ED), (e) => e.code === 'unavailable');
  assert.equal(t.calls.length, 2);                                                                          // one retry
  await assert.rejects(t.client.lookup(card('Gala Greeters', 'snc', '148')), (e) => e.code === 'unavailable');
  const before = t.calls.length;
  await assert.rejects(t.client.lookup(card('Counterspell', '4ed', '1')), (e) => e.code === 'unavailable'); // breaker: fails fast, no request
  assert.equal(t.calls.length, before);
  t.advance(61000);                                                                                         // the site comes back
  const ok = make(() => pageOf([LB_4E]));
  assert.equal((await ok.client.lookup(LB_CARD_4ED)).status, 'ok');
});

test('HTTP 500 and unreadable answers are errors too, and one failure does not poison the next lookup', async () => {
  let mode = 'down';
  const t = make(() => (mode === 'down' ? {status: 500} : mode === 'junk' ? {status: 200, body: null} : pageOf([LB_4E])), {breakerAfter: 99});
  await assert.rejects(t.client.lookup(LB_CARD_4ED), (e) => e.code === 'unavailable');
  mode = 'junk';
  assert.equal((await t.client.lookup(LB_CARD_4ED)).status, 'absent');                                      // 200 with no list: nothing found, no crash
  mode = 'up';
  assert.equal((await t.client.lookup(LB_CARD_4ED, {force: true})).status, 'ok');
});

test('an incomplete card is refused before any request', async () => {
  const t = make(() => pageOf([]));
  await assert.rejects(t.client.lookup({name: 'x'}), (e) => e.code === 'bad-request');
  assert.equal(t.calls.length, 0);
});

// ── what the sheet shows ──
test('sheet: both shops side by side, best offer marked per finish, honest text when there is no price', () => {
  const ok = {status: 'ok', card: normalizeCard(STM)};
  const p = mcPanel(ok, {language: 'Fr', playin: {normal: 0.4, foil: 2}});
  assert.equal(p.finishes.normal.price, 0.6); assert.equal(p.finishes.normal.best, 'mc');
  assert.equal(p.finishes.foil.price, null); assert.equal(p.finishes.foil.text, 'Foil non racheté'); assert.equal(p.finishes.foil.best, 'playin'); assert.equal(p.finishes.foil.only, true);
  assert.match(p.note, /n°42/);
  const en = mcPanel({status: 'ok', card: normalizeCard(GALA)}, {language: 'En', playin: {normal: 0.1}});
  assert.equal(en.finishes.normal.text, 'Anglais non racheté'); assert.match(en.note, /FR : 0,30 €/); assert.equal(en.finishes.normal.best, 'playin');
});

test('sheet: verify, absent, error and unchecked never show a price and never claim a best offer', () => {
  for (const [result, text] of [[{status: 'verify', reason: 'edition'}, 'Correspondance à vérifier'], [{status: 'absent'}, 'Impression non listée'], [{status: 'error', message: 'down'}, 'Indisponible'], [null, 'Non vérifiée']]) {
    const p = mcPanel(result, {playin: {normal: 3, foil: 5}});
    assert.equal(p.finishes.normal.price, null); assert.equal(p.finishes.normal.text, text); assert.equal(p.finishes.normal.best, 'playin'); assert.equal(p.finishes.normal.only, true);
  }
  assert.match(mcPanel({status: 'verify', reason: 'numbering'}).note, /vérifie sur MagicCorporation/);
  assert.equal(mcPanel({status: 'error'}).canRetry, true); assert.equal(mcPanel({status: 'ok', card: normalizeCard(LB_4E)}).canRetry, false);
  assert.equal(mcPanel(null, {playin: {}}).finishes.normal.best, null); // nothing known at either shop: no winner
});

test('foil-star collector numbers (273★) match the plain number MagicCorporation lists', () => {
  const thorn = raw({id: 9, name: 'Thorn Elemental', number: '273', edition: {id: 41, name: '7ème Édition', code: '7E'}, buyback_price_vf: 0.3, buyback_price_vo: 0.3});
  assert.equal(numberKey('273★'), '273');
  const m = matchPrinting(cards(thorn), card('Thorn Elemental', '7ed', '273★'));
  assert.equal(m.status, 'ok'); assert.equal(m.card.vf, 0.3);
});
