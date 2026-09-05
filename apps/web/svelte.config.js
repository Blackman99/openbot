import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Serve complete JS assets; the build runtime can emit empty Brotli sidecars.
    adapter: adapter({ precompress: false }),
  },
};

export default config;
