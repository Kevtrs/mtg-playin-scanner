#!/usr/bin/env python3
"""Checks src/mc-editions.js against real data (development tool, not part of the app).

For each MagicCorporation edition whose code differs from the mapped Scryfall set (plus a sample of the others), it
downloads the first page of that edition's cards from MagicCorporation (name + number) and compares them with the cards of
the mapped Scryfall set: the share of MagicCorporation cards that also exist in the Scryfall set with the same name AND the
same collector number is the agreement. It stays under MagicCorporation's limit (60 requests per minute) and waits for the
window to reset when the remaining quota gets low.

Usage: python scripts/verify-mc-editions.py [--all] [--ids 10,5,...]
"""
import json
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request

UA = {'User-Agent': 'mtg-playin-scanner-build/1.0', 'Accept': 'application/json'}
MC = 'https://rachat.magiccorporation.com/api/search/cards'


def parse_table():
    text = open('src/mc-editions.js', encoding='utf-8').read()
    table = {}
    for m in re.finditer(r'^\s*(\d+): \[(.*)\],$', text, re.M):
        table[int(m.group(1))] = json.loads('[' + m.group(2) + ']')
    return table


def norm(name):
    name = unicodedata.normalize('NFD', name or '').encode('ascii', 'ignore').decode().lower()
    front = re.split(r'\s*/+\s*', name)[0]
    return re.sub(r'[^a-z0-9]+', ' ', front).strip()


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40)


def mc_page(edition_id):
    r = get(MC + '?' + urllib.parse.urlencode({'edition_id': edition_id, 'page': 1}) + '&non_rachetees=1')
    remaining = int(r.headers.get('X-RateLimit-Remaining') or 0)
    return json.load(r), remaining


def scryfall_set(code):
    cards, url = {}, 'https://api.scryfall.com/cards/search?' + urllib.parse.urlencode({'q': 'set:' + code, 'unique': 'prints', 'include_extras': 'true', 'include_variations': 'true'})
    while url:
        d = json.load(get(url))
        for c in d['data']:
            cards[(c['collector_number'].lower().lstrip('0') or '0', norm(c['name']))] = True
        url = d.get('next_page')
        time.sleep(0.12)
    return cards


def main():
    table = parse_table()
    ids = None
    for a in sys.argv[1:]:
        if a.startswith('--ids='):
            ids = [int(x) for x in a[6:].split(',')]
    todo = []
    for i, (code, sc, name, *_flags) in sorted(table.items()):
        if sc is None:
            continue
        if ids is not None:
            if i in ids:
                todo.append(i)
        elif code.lower() != sc or '--all' in sys.argv:
            todo.append(i)
    print('éditions à vérifier:', len(todo), flush=True)
    bad = []
    for n, i in enumerate(todo, 1):
        code, sc, name = table[i][:3]
        try:
            page, remaining = mc_page(i)
            if remaining <= 4:
                print('   (quota bas, attente de la fin de la fenêtre)', flush=True)
                time.sleep(62)
            cards = page['data']
            sset = scryfall_set(sc)
            ok = sum(1 for c in cards if ((c['number'] or '').lower().lstrip('0') or '0', norm(c['name'])) in sset)
            ratio = ok / len(cards) if cards else None
            flag = '' if ratio is not None and ratio >= 0.9 else '   <-- A EXAMINER'
            if flag:
                bad.append(i)
            print('%3d/%d id=%-4d %-5s -> %-5s %-34s %s/%s cartes concordantes%s' % (n, len(todo), i, code, sc, name[:34], ok, len(cards), flag), flush=True)
        except Exception as e:  # noqa: BLE001 - a dev tool: report and keep going
            print('id=%d erreur: %s' % (i, e), flush=True)
        time.sleep(1.3)
    print('A examiner:', bad, flush=True)


main()
