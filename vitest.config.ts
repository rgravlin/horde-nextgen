import { defineConfig } from 'vitest/config';

// Unit tests are plain Node: no DOM, no renderer, no audio context (ARCHITECTURE.md).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    globals: false,
    reporters: ['default'],
  },
});