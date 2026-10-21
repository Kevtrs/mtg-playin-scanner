#!/usr/bin/env python3
"""Patches the CollectorVision files copied into dist/cv at deploy time.

Usage: python3 ci/patch-engine.py dist/cv

Every patch asserts that its anchor exists, so a change upstream makes the deployment FAIL loudly
instead of shipping a silently missing fix.
"""
import pathlib
import sys

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'dist/cv')
here = pathlib.Path(__file__).resolve().parent


def patch(path, edits):
    text = path.read_text(encoding='utf-8')
    assert 'catalogMode: this.config.catalogMode' not in text and '__cvSessionTuning' not in text, f'{path.name}: déjà corrigé'
    for anchor, replacement, expected in edits:
        found = text.count(anchor)
        assert found == expected, f'{path.name}: cible introuvable ou ambiguë ({found} trouvée(s), {expected} attendue(s)) : {anchor[:70]!r}'
        text = text.replace(anchor, replacement)
    path.write_text(text, encoding='utf-8')


# 1) The applet never tells the worker which catalogue to use (so it always ran the frozen v1 one), nor whether
#    to match cards upside-down too (a second embedding + catalogue search per frame, which the page can switch off).
applet = root / 'lib' / 'collectorvision-scanner-applet.mjs'
anchor = '        enableWebGpu: this.config.enableWebGpu === true,'
patch(applet, [(anchor, anchor + chr(10) + '        catalogMode: this.config.catalogMode === "v2" ? "v2" : "v1",' + chr(10) + '        rotationInvariant: this.config.rotationInvariant !== false,', 1)])

# 2) iOS memory: cap the shared WebAssembly heap and stop the ONNX sessions pre-inflating it.
worker = root / 'scanner.worker.mjs'
snippet = (here / 'worker-memory-cap.js').read_text(encoding='utf-8')
import_line = 'import * as ort from "./vendor/onnxruntime-web/ort.webgpu.min.mjs?v=__BUILD_ID__";'
session = '      executionProviders: [ep],'
patch(worker, [
    (import_line, import_line + chr(10) + chr(10) + snippet, 1),
    (session, session + ' ...__cvSessionTuning,', 2),
])

for path, marker in ((applet, 'catalogMode: this.config.catalogMode'), (worker, '__cvSessionTuning')):
    assert marker in path.read_text(encoding='utf-8'), f'{path.name}: correctif absent après application'
print('Moteur corrigé :', applet.name, worker.name)
