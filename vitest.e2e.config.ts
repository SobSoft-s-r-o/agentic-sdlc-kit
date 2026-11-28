import { defineConfig } from 'vitest/config';

// The opt-in suite against a real sandbox repository (`npm run test:e2e`). `vitest.config.ts` only
// includes `tests/**/*.test.ts`, so `npm test` never sees these files. Every call is a real `gh`
// round trip, so a test (and its setup hook) gets minutes, not the default five seconds.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    // One sandbox, one run at a time: the files would otherwise race for the same repository.
    fileParallelism: false,
  },
});
