// ── MTG Playin Scanner patch, inserted into scanner.worker.mjs at deploy time (see ci/patch-engine.py) ──
// Why: onnxruntime-web creates its WebAssembly heap as a *shared* memory whose maximum is 4 GiB
// (65536 pages), even when single-threaded. iOS WebKit reserves a shared memory's whole maximum up
// front, which can get the page killed ("A problem repeatedly occurred") or throw "Out of memory".
// What: on iOS the maximum is capped to 1 GiB and halved again if the browser still refuses; on iOS the
// ONNX sessions also stop pre-inflating the heap (enableCpuMemArena / enableMemPattern off).
// Every result sent to the page also carries `wasmMB` (current WebAssembly heap size) so a crash
// report can show how the engine's memory evolved just before the page was killed.
// Add ?nocap=1 to the worker URL to switch the cap and the session tuning off.
// Sources: zenn.dev/kaz_sakai/articles/ios-safari-onnx-memory, github.com/ben-milanko/dart-pdf/pull/1097
const __cvCapEnabled = !new URL(import.meta.url).searchParams.has('nocap');
const __cvIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const __cvMemories = [];
{
  const NativeMemory = WebAssembly.Memory;
  const capPages = (__cvIOS && __cvCapEnabled) ? 16384 : Infinity; // 16384 pages = 1 GiB
  WebAssembly.Memory = function Memory(descriptor) {
    let memory;
    if (!__cvCapEnabled || !descriptor || !descriptor.shared || !(descriptor.maximum > 0)) memory = new NativeMemory(descriptor);
    else {
      let maximum = Math.min(descriptor.maximum, capPages);
      for (;;) {
        try { memory = new NativeMemory({ ...descriptor, maximum }); break; }
        catch (error) { if (!(error instanceof RangeError) || maximum <= 4096) throw error; maximum = Math.floor(maximum / 2); }
      }
    }
    __cvMemories.push(memory);
    return memory;
  };
  WebAssembly.Memory.prototype = NativeMemory.prototype;
}
const __cvSessionTuning = (__cvIOS && __cvCapEnabled) ? { enableCpuMemArena: false, enableMemPattern: false } : {};
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  const nativePost = self.postMessage.bind(self);
  self.postMessage = (message, transfer) => {
    try {
      if (message && message.type === 'result') message.wasmMB = Math.round(__cvMemories.reduce((sum, memory) => sum + (memory.buffer ? memory.buffer.byteLength : 0), 0) / 1048576);
    } catch { /* never let the measurement disturb the scan */ }
    return nativePost(message, transfer);
  };
}
