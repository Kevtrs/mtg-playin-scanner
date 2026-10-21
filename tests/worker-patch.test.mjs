import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const SNIPPET = readFileSync(new URL('../ci/worker-memory-cap.js', import.meta.url), 'utf8');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/18.7 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36';
const SHARED = { initial: 256, maximum: 65536, shared: true };

// Runs the real snippet against a fake WebAssembly namespace so nothing global is touched.
function run({ userAgent, platform = 'iPhone', url = 'https://x.test/cv/scanner.worker.mjs?v=abc', Memory = WebAssembly.Memory, self }) {
  const wasm = { Memory };
  const code = SNIPPET.replaceAll('import.meta.url', '__metaUrl') + '\nreturn { __cvSessionTuning };';
  const out = new Function('WebAssembly', 'navigator', '__metaUrl', 'self', code)(wasm, { userAgent, platform, maxTouchPoints: 5 }, url, self);
  return { wasm, ...out };
}
const GIB = 1024 ** 3;
const PAGES_PER_GIB = GIB / 65536;
// Records the maximum the patched code actually asks the browser for (a shared memory's own buffer does not report it).
function recording() {
  const asked = [];
  const Recorder = function (descriptor) { asked.push(descriptor.maximum); return { descriptor }; };
  Recorder.prototype = {};
  return { asked, Recorder };
}
function askedMaximum(options) {
  const { asked, Recorder } = recording();
  const { wasm, __cvSessionTuning } = run({ ...options, Memory: Recorder });
  new wasm.Memory(SHARED);
  return { asked, __cvSessionTuning };
}

test('iPhone: the shared WebAssembly heap is capped to 1 GiB instead of 4 GiB, and sessions stop pre-inflating the heap', () => {
  const { asked, __cvSessionTuning } = askedMaximum({ userAgent: IPHONE });
  assert.deepEqual(asked, [PAGES_PER_GIB]);
  assert.deepEqual(__cvSessionTuning, { enableCpuMemArena: false, enableMemPattern: false });
});

test('other platforms keep the original 4 GiB maximum and default session options', () => {
  const { asked, __cvSessionTuning } = askedMaximum({ userAgent: ANDROID, platform: 'Linux armv8l' });
  assert.deepEqual(asked, [65536]);
  assert.deepEqual(__cvSessionTuning, {});
});

test('iPadOS reporting itself as a Mac is treated as iOS', () => {
  const { asked } = askedMaximum({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', platform: 'MacIntel' });
  assert.deepEqual(asked, [PAGES_PER_GIB]);
});

test('?nocap=1 switches the whole patch off', () => {
  const { asked, __cvSessionTuning } = askedMaximum({ userAgent: IPHONE, url: 'https://x.test/cv/scanner.worker.mjs?v=abc&nocap=1' });
  assert.deepEqual(asked, [65536]);
  assert.deepEqual(__cvSessionTuning, {});
});

test('when the browser still refuses, the maximum is halved until it is accepted', () => {
  const asked = [];
  const Stingy = function (descriptor) { asked.push(descriptor.maximum); if (descriptor.maximum > 8192) throw new RangeError('Out of memory'); return { descriptor }; };
  Stingy.prototype = {};
  const { wasm } = run({ userAgent: IPHONE, Memory: Stingy });
  const memory = new wasm.Memory(SHARED);
  assert.deepEqual(asked, [16384, 8192]);
  assert.equal(memory.descriptor.maximum, 8192);
  assert.equal(memory.descriptor.initial, 256);
});

test('a refusal that is not a RangeError, or a floor of 4096 pages, is reported instead of hidden', () => {
  const Broken = function () { throw new TypeError('nope'); }; Broken.prototype = {};
  assert.throws(() => new (run({ userAgent: IPHONE, Memory: Broken }).wasm.Memory)(SHARED), TypeError);
  const Never = function () { throw new RangeError('no'); }; Never.prototype = {};
  assert.throws(() => new (run({ userAgent: IPHONE, Memory: Never }).wasm.Memory)(SHARED), RangeError);
});

test('non-shared memories and unusual descriptors pass through untouched', () => {
  const { wasm } = run({ userAgent: IPHONE });
  assert.equal(new wasm.Memory({ initial: 1, maximum: 2 }).buffer.byteLength, 65536);
  assert.equal(new wasm.Memory({ initial: 1 }).buffer.byteLength, 65536);
});

test('every result sent to the page carries the current WebAssembly heap size, other messages are untouched', () => {
  const sent = [];
  const fakeSelf = { postMessage(message, transfer) { sent.push({ message, transfer }); } };
  const Real = function (descriptor) { return { buffer: { byteLength: descriptor.initial * 65536 } }; }; Real.prototype = {};
  const { wasm } = run({ userAgent: IPHONE, Memory: Real, self: fakeSelf });
  new wasm.Memory({ initial: 256, maximum: 65536, shared: true });   // 16 MiB
  new wasm.Memory({ initial: 1024, maximum: 65536, shared: true });  // 64 MiB
  fakeSelf.postMessage({ type: 'result', cardPresent: true }, [1]);
  fakeSelf.postMessage({ type: 'progress' });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].message.wasmMB, 80);
  assert.deepEqual(sent[0].transfer, [1]);
  assert.equal('wasmMB' in sent[1].message, false);
});

test('with ?nocap=1 the heap is still measured, but never capped', () => {
  const sent = [];
  const fakeSelf = { postMessage(message) { sent.push(message); } };
  const asked = [];
  const Real = function (descriptor) { asked.push(descriptor.maximum); return { buffer: { byteLength: 65536 * 256 } }; }; Real.prototype = {};
  const { wasm } = run({ userAgent: IPHONE, url: 'https://x.test/w.mjs?nocap=1', Memory: Real, self: fakeSelf });
  new wasm.Memory({ initial: 256, maximum: 65536, shared: true });
  fakeSelf.postMessage({ type: 'result' });
  assert.deepEqual(asked, [65536]);
  assert.equal(sent[0].wasmMB, 16);
});
