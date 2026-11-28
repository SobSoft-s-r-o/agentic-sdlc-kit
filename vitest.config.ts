import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Builds `dist/` once for `tests/cli.test.ts` and `tests/packaging.test.ts`, which would race if each built it.
    globalSetup: ['tests/support/globalBuild.ts'],
  },
});
