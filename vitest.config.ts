import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 120000,
    // One Electron shell at a time: the seam test owns a real window.
    fileParallelism: false,
  },
})
