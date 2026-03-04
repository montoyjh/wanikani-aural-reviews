import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  base: '/wanikani-aural-reviews/',
  build: {
    outDir: 'dist',
  },
  resolve: {
    alias: {
      path: path.resolve(__dirname, 'path-shim.js'),
    },
  },
});
