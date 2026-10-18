const ORDINALS = { first: '1', second: '2', third: '3', fourth: '4', fifth: '5', sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10' };
const STOP = new Set(['the', 'of', 'at', 'and', 'a', 'le', 'la', 'les', 'de', 'des', 'du', 'au', 'aux', 'et', 'edition', 'ed', 'magic', 'gathering', 'set']);

// Playin names its editions in French ("4ème Edition"), Scryfall in English ("Fourth Edition"):
// ordinals are reduced to digits so both sides compare equal.
export function normalizedWords(value) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .filter((word) => word && !STOP.has(word))
    .map((word) => ORDINALS[word] ?? word.replace(/^(\d+)(?:st|nd|rd|th|eme|er|ere|e)$/, '$1'));
}

// Weight of a word shared by both names. Close English/French cognates ("legends"/"legendes") count too.
function wordWeight(a, b) {
  if (a === b) return Math.max(2, a.length);
  if (a.length < 5 || b.length < 5) return 0;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  return prefix >= 5 && prefix >= 0.7 * Math.min(a.length, b.length) ? prefix : 0;
}

// How much of the Playin edition name is explained by the Scryfall set name (0 = unrelated).
export function editionOverlap(row, card) {
  const wanted = normalizedWords(card.set_name);
  return normalizedWords(row.edition).reduce((sum, word) => sum + Math.max(0, ...wanted.map((w) => wordWeight(word, w))), 0);
}

// Double-faced cards are listed by their front face ("A // B" -> "A").
export function searchName(card) { return card.name.split(' // ')[0].trim(); }

export function printingScore(row, card) {
  const found = normalizedWords(row.edition);
  let score = editionOverlap(row, card);
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

const MIN_OVERLAP = 2;

// Best Playin row for a printing, or no price at all: a wrong edition's price is worse than none.
export function priceData(card, rows, language) {
  const ranked = rows
    .filter((row) => editionOverlap(row, card) >= MIN_OVERLAP)
    .map((row) => ({ row, score: printingScore(row, card) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const ambiguous = Boolean(best && ranked[1] && ranked[1].score === best.score && ranked[1].row.edition !== best.row.edition);
  const bestRow = ambiguous ? null : best?.row;
  const variants = bestRow?.variants.filter((v) => v.label.startsWith(language + ' ') && /Mint\/Nmint/i.test(v.label)) || [];
  return { normal: variants.find((v) => !v.foil)?.price ?? null, foil: variants.find((v) => v.foil)?.price ?? null, edition: bestRow?.edition || '', matched: Boolean(bestRow), ambiguous };
}

// Keep only what priceData() reads (Mint/Nmint variants): ~5x smaller to store and re-parse.
export function compactRows(rows) {
  return rows
    .map((row) => ({ nameFr: row.nameFr, nameEn: row.nameEn, edition: row.edition, variants: row.variants.filter((v) => /Mint\/Nmint/i.test(v.label)) }))
    .filter((row) => row.variants.length);
}
