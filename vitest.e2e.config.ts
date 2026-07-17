import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    // Live CPU inference; give the smallest model room to finish.
    testTimeout: 600_000,
    hookTimeout: 60_000,
  },
});
