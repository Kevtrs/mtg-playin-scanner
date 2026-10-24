// Cardmarket prices come straight from Scryfall's card data (`prices.eur`, `prices.eur_foil`), refreshed daily.
// On a card checked against Manabox, `eur` / `eur_foil` equal Cardmarket's TREND price for the normal / foil version.
export const parseEur = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

// Same shape as the Playin prices (`normal`, `foil`, `edition`) so the rest of the app can treat both alike.
export function cardmarketPrices(card) {
  const prices = card?.prices || {};
  return { normal: parseEur(prices.eur), foil: parseEur(prices.eur_foil), edition: card?.set_name || '', matched: true, source: 'cardmarket' };
}

// Only Cardmarket's own product pages are ever opened from this link.
export function cardmarketUrl(card) {
  const url = card?.purchase_uris?.cardmarket;
  return typeof url === 'string' && /^https:\/\/www\.cardmarket\.com\//.test(url) ? url : null;
}

export const sourceOf = (item) => (item?.source === 'cardmarket' ? 'cardmarket' : 'playin');

// Totals are never mixed: a Playin buy price and a Cardmarket trend price are different things.
export function totalsBySource(items) {
  const totals = { playin: { cards: 0, sum: 0 }, cardmarket: { cards: 0, sum: 0 } };
  for (const item of items) {
    const quantity = item.quantity || 1; const bucket = totals[sourceOf(item)];
    bucket.cards += quantity; bucket.sum += (Number(item.price) || 0) * quantity;
  }
  return totals;
}
