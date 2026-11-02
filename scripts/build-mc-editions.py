#!/usr/bin/env python3
"""Builds src/mc-editions.js: MagicCorporation edition id -> Scryfall set code.

MagicCorporation's own edition codes do not always match Scryfall's (4E/4ed, R/3ed, ARC/e01...). Their search page lists
every edition with an id, a code and an ENGLISH name; Scryfall lists its sets the same way. We map by normalised English
name (ordinals folded: "4th" = "Fourth"), fall back to the code only when the names are close, and use a short manual
list for the few editions whose names differ. Anything uncertain stays `null`: the app then asks for a manual check
instead of guessing. Run `python scripts/verify-mc-editions.py` afterwards to check the result against real cards.

Usage: python scripts/build-mc-editions.py   (reads the page's edition list and Scryfall's /sets, writes src/mc-editions.js)
"""
import json
import re
import unicodedata
import urllib.request
import datetime
import pathlib

UA = {'User-Agent': 'mtg-playin-scanner-build/1.0', 'Accept': 'application/json'}
ORDINALS = {'first': '1', 'second': '2', 'third': '3', 'fourth': '4', 'fifth': '5', 'sixth': '6', 'seventh': '7', 'eighth': '8', 'ninth': '9', 'tenth': '10'}
STOP = {'edition', 'the', 'of', 'set', 'and', 'a', 'cards', 'deck'}

# Editions whose English names differ between the two sites, keyed by MagicCorporation edition ID (NOT by code: two
# MagicCorporation editions can share a code). Each one was confirmed against real cards by verify-mc-editions.py.
MANUAL = {
    1: 'lea',     # Alpha                          <-> Limited Edition Alpha
    2: 'leb',     # Beta                           <-> Limited Edition Beta
    3: '2ed',     # Unlimited                      <-> Unlimited Edition
    5: '3ed',     # Revised                        <-> Revised Edition
    31: '6ed',    # 6th Edition                    <-> Classic Sixth Edition
    64: 'btd',    # Beatdown                       <-> Beatdown Box Set
    66: 'ath',    # Anthologies                    <-> Anthologies
    194: 'e01',   # Archenemy Nicol Bolas Deck     <-> Archenemy: Nicol Bolas
    220: 'gk1',   # Guilds of Ravnica Guild Kits   <-> Guilds of Ravnica Guild Kit
    287: 'bot',   # The Brothers' War Transformers <-> Transformers
    308: 'pip',   # Universes Beyond : Fallout     <-> Fallout
    314: 'otp',   # Outlaws of Thunder Junction : Breaking News <-> Breaking News
    315: 'big',   # Outlaws of Thunder Junction : The Big Score <-> The Big Score
    322: 'fdn',   # "Magic the gathering Foundations" <-> Foundations
    349: 'j25',   # Jumpstart 2025                 <-> Foundations Jumpstart
}

# The edition is the right one but collector numbers differ from Scryfall's (offset, variants "1a/1b", missing names...),
# found by verify-mc-editions.py (agreement below 90 %). For these the app never confirms a price from a number that does
# not match: it shows "correspondance à vérifier".
NUMBERING_UNRELIABLE = {9, 16, 18, 19, 35, 49, 57, 65, 66, 73, 78, 79, 111, 145, 159, 171, 176, 287}


def words(name):
    name = unicodedata.normalize('NFD', name or '').encode('ascii', 'ignore').decode().lower().replace('&', ' and ')
    name = re.sub(r'[^a-z0-9]+', ' ', name)
    out = []
    for w in name.split():
        w = ORDINALS.get(w, re.sub(r'^(\d+)(st|nd|rd|th)$', r'\1', w))
        if w and w not in STOP:
            out.append(w)
    return out


def fetch_json(url):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40))


def unescape_js(raw):
    # The page embeds the list as a JavaScript string literal: quotes use a unicode escape, slashes an escaped slash, and
    # apostrophes are escaped twice (JavaScript level, then JSON level). Decode ONE level of JavaScript escapes in a
    # single pass: a backslash followed by "u" and 4 hex digits, or by any other single character. json.loads does the rest.
    backslash = chr(92)
    pattern = re.escape(backslash) + '(u[0-9a-fA-F]{4}|.)'

    def one(m):
        code = m.group(1)
        return chr(int(code[1:], 16)) if len(code) == 5 and code[0] == 'u' else code
    return re.sub(pattern, one, raw)


def mc_editions():
    html = urllib.request.urlopen(urllib.request.Request('https://rachat.magiccorporation.com/recherche', headers=UA), timeout=40).read().decode('utf-8', 'ignore')
    m = re.search(r"editionsListe: JSON\.parse\('(.*?)'\)", html, re.S)
    return json.loads(unescape_js(m.group(1)))


def main():
    editions = mc_editions()
    sets = fetch_json('https://api.scryfall.com/sets')['data']
    by_code = {s['code']: s for s in sets}
    by_words = {}
    for s in sets:
        by_words.setdefault(tuple(words(s['name'])), []).append(s)
    out, report = {}, {'name': 0, 'manual': 0, 'code+close': 0, 'null': 0}
    for e in sorted(editions, key=lambda e: e['id']):
        code, name = e['code'], e['nom']
        mapped, how = None, 'null'
        if e['id'] in MANUAL and MANUAL[e['id']] in by_code:
            mapped, how = MANUAL[e['id']], 'manual'
        else:
            cands = by_words.get(tuple(words(name)), [])
            same_code = [s for s in cands if s['code'] == code.lower()]
            if len(cands) == 1:
                mapped, how = cands[0]['code'], 'name'
            elif same_code:
                mapped, how = same_code[0]['code'], 'name'
            elif not cands and code.lower() in by_code:
                a, b = set(words(name)), set(words(by_code[code.lower()]['name']))
                if a and b and len(a & b) / len(a | b) >= 0.5:
                    mapped, how = code.lower(), 'code+close'
        report[how] += 1
        out[e['id']] = [code, mapped, name, e['id'] in NUMBERING_UNRELIABLE]
    stamp = datetime.date.today().isoformat()
    lines = [
        '// Generated by scripts/build-mc-editions.py on %s. Do not edit by hand.' % stamp,
        '// MagicCorporation edition id -> [MagicCorporation code, Scryfall set code or null, English name, numbers differ (optional)].',
        '// `null` means "no safe equivalent": the app then asks for a manual check instead of guessing.',
        'export const MC_EDITIONS_SNAPSHOT = %s;' % json.dumps(stamp),
        'export const MC_EDITIONS = {',
    ]
    for i, (code, mapped, name, flaky) in out.items():
        tail = ', true' if flaky else ''
        lines.append('  %d: [%s, %s, %s%s],' % (i, json.dumps(code), json.dumps(mapped), json.dumps(name, ensure_ascii=False), tail))
    lines.append('};')
    pathlib.Path('src/mc-editions.js').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print('éditions:', len(out), report)
    print('non mappées:', [(c, n) for c, m, n, f in out.values() if m is None])


main()
