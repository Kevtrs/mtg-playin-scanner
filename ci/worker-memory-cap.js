// ── MTG Playin Scanner patch, inserted into scanner.worker.mjs at deploy time (see ci/patch-engine.py) ──
// Why: onnxruntime-web creates its WebAssembly heap as a *shared* memory whose maximum is 4 GiB
// (65536 pages), even when single-threaded. iOS WebKit reserves a shared memory's whole maximum up
// front, which can get the page killed ("A problem repeatedly occurred") or throw "Out of memory".
// What: on iOS the maximum is capped to 1 GiB and halved again if the browser still refuses; on iOS the
// ONNX sessions also stop pre-inflating the heap (enableCpuMemArena / enableMemPattern off).
// Add ?nocap=1 to the worker URL to switch all of this off.
// Sources: zenn.dev/kaz_sakai/articles/ios-safari-onnx-memory, github.com/ben-milanko/dart-pdf/pull/1097
const __cvCapEnabled = !new URL(import.meta.url).searchParams.has('nocap');
const __cvIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (__cvCapEnabled) {
  const NativeMemory = WebAssembly.Memory;
  const capPages = __cvIOS ? 16384 : Infinity; // 16384 pages = 1 GiB
  WebAssembly.Memory = function Memory(descriptor) {
    if (!descriptor || !descriptor.shared || !(descriptor.maximum > 0)) return new NativeMemory(descriptor);
    let maximum = Math.min(descriptor.maximum, capPages);
    for (;;) {
      try { return new NativeMemory({ ...descriptor, maximum }); }
      catch (error) { if (!(error instanceof RangeError) || maximum <= 4096) throw error; maximum = Math.floor(maximum / 2); }
    }
  };
  WebAssembly.Memory.prototype = NativeMemory.prototype;
}
const __cvSessionTuning = (__cvIOS && __cvCapEnabled) ? { enableCpuMemArena: false, enableMemPattern: false } : {};
