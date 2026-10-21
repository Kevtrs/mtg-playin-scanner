import { defineConfig } from 'vite';

export default defineConfig({
  // Relative URLs work both at / and at /<repository>/ on GitHub Pages.
  base: './',
  build: { target: 'es2020' },
  // Changes with every commit: appended to the engine's URLs so a patched engine file is never served from an old cache.
  define: { __BUILD_ID__: JSON.stringify(process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 8) : 'dev') }
});
