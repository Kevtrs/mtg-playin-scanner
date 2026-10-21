#!/usr/bin/env python3
"""Patches the CollectorVision files copied into dist/cv at deploy time.

Usage: python3 ci/patch-engine.py dist/cv /path/to/onnxruntime-web/dist

Every patch asserts that its anchor exists, so a change upstream makes the deployment FAIL loudly
instead of shipping a silently missing fix.
"""
import pathlib
import shutil
import sys

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'dist/cv')
here = pathlib.Path(__file__).resolve().parent
ort_dist = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None


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

# 2) The engine ships onnxruntime-web's WebGPU/JSEP "asyncify" build even though it only uses the CPU. On Safari 26.2+
#    WebKit's WebAssembly JIT runs away compiling it (WebKit bug 304810, onnxruntime issue 26827) and iOS kills the page.
#    The plain WebAssembly build of the SAME onnxruntime-web version is stable there, so it becomes the default.
#    ?ort=webgpu on the worker URL brings the old build back (diagnostic switch).
PLAIN_FILES = ('ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm')
assert ort_dist is not None and all((ort_dist / f).is_file() for f in PLAIN_FILES), 'build WebAssembly simple d\'onnxruntime-web introuvable'
for f in PLAIN_FILES:
    shutil.copy(ort_dist / f, root / 'vendor' / 'onnxruntime-web' / f)

# 3) iOS memory: cap the shared WebAssembly heap and stop the ONNX sessions pre-inflating it.
worker = root / 'scanner.worker.mjs'
snippet = (here / 'worker-memory-cap.js').read_text(encoding='utf-8')
import_line = 'import * as ort from "./vendor/onnxruntime-web/ort.webgpu.min.mjs?v=__BUILD_ID__";'
session = '      executionProviders: [ep],'
original = worker.read_text(encoding='utf-8')
# The old (WebGPU/asyncify) build stays available in a second worker file, for comparison and as a diagnostic switch.
# NOTE: no top-level await here: a module worker that awaits at the top loses the messages posted before it finishes loading.
patch(worker, [
    (import_line, 'import * as ort from "./vendor/onnxruntime-web/ort.wasm.min.mjs?v=__BUILD_ID__";' + chr(10) + chr(10) + snippet, 1),
    (session, session + ' ...__cvSessionTuning,', 2),
])
old_worker = root / 'scanner.worker.old.mjs'
old_worker.write_text(worker.read_text(encoding='utf-8').replace('ort.wasm.min.mjs?v=__BUILD_ID__', 'ort.webgpu.min.mjs?v=__BUILD_ID__', 1), encoding='utf-8')

for path, marker in ((applet, 'catalogMode: this.config.catalogMode'), (worker, '__cvSessionTuning'), (worker, 'ort.wasm.min.mjs')):
    assert marker in path.read_text(encoding='utf-8'), f'{path.name}: correctif absent après application'
def ort_import(path):
    return next(line for line in path.read_text(encoding='utf-8').splitlines() if line.startswith('import * as ort'))
assert 'ort.wasm.min.mjs' in ort_import(worker) and 'ort.webgpu.min.mjs' in ort_import(old_worker), 'workers mal formés'
print('Moteur corrigé :', applet.name, worker.name, old_worker.name)
