export function normalizedWords(value) {
  const stop = new Set(['the', 'of', 'at', 'and', 'a', 'le', 'la', 'les', 'de', 'des', 'du', 'au', 'aux', 'et', 'edition', 'ed']);
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((word) => word && !stop.has(word));
}

// Double-faced cards are listed by their front face ("A // B" -> "A").
export function searchName(card) { return card.name.split(' // ')[0].trim(); }

export function printingScore(row, card) {
  const wanted = new Set(normalizedWords(card.set_name));
  const found = normalizedWords(row.edition);
  let score = found.reduce((sum, word) => sum + (wanted.has(word) ? Math.max(2, word.length) : 0), 0);
  const setNorm = normalizedWords(card.set_name).join(' ');
  const editionNorm = found.join(' ');
  if (setNorm === editionNorm) score += 50;
  if (row.nameEn.toLowerCase() === searchName(card).toLowerCase() || row.nameEn.toLowerCase() === card.name.toLowerCase()) score += 8;
  // Scryfall omits frame_effects when empty: coerce so "plain" compares equal to "plain".
  const special = Boolean(card.promo || card.full_art || card.frame_effects?.some((effect) => ['extendedart', 'showcase', 'inverted', 'etched'].includes(effect)));
  const extras = /extra|promo|showcase|special|borderless|etendue|extended/i.test(row.edition + ' ' + row.nameEn);
  if (special === extras) score += 5;
  return score;
}

export function priceData(card, rows, language) {
  const bestRow = [...rows].sort((a, b) => printingScore(b, card) - printingScore(a, card))[0];
  const variants = bestRow?.variants.filter((v) => v.label.startsWith(language + ' ') && /Mint\/Nmint/i.test(v.label)) || [];
  return { normal: variants.find((v) => !v.foil)?.price ?? null, foil: variants.find((v) => v.foil)?.price ?? null, edition: bestRow?.edition || '' };
}
