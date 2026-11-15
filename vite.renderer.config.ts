import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  // App version for Settings → About, read from package.json at build time.
  define: {
    __APP_VERSION__: JSON.stringify(require('./package.json').version),
  },
  css: {
    postcss: {
      plugins: [require('@tailwindcss/postcss')],
    },
  },
  resolve: {
    alias: {
      '@domain': path.resolve(__dirname, 'src/domain'),
      '@infra': path.resolve(__dirname, 'src/infrastructure'),
      '@app': path.resolve(__dirname, 'src/application'),
    },
  },
});
