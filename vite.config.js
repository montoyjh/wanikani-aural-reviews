import { defineConfig } from 'vite';

export default defineConfig({
  base: '/wanikani-aural-reviews/',
  build: {
    outDir: 'dist',
  },
  resolve: {
    alias: {
      path: 'path-browserify',
    },
  },
});
