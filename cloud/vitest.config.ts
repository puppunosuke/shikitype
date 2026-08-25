import { cloudflarePool, cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const options = {
  wrangler: { configPath: './wrangler.test.jsonc' },
};

export default defineConfig({
  plugins: [cloudflareTest(options)],
  test: {
    include: ['test/**/*.test.ts'],
    pool: cloudflarePool(options),
  },
});
