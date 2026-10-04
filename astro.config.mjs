// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  // No sessions (so no KV namespace) and no image service: the app has neither.
  session: false,
  adapter: cloudflare({ imageService: 'passthrough' }),
});
