import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-ignore node builtin; this config is not part of the DOM-typechecked app project
import { resolve } from 'node:path';

declare const __dirname: string;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // The Sites Worker injects _qoder/storage.mjs at deployment; locally it is
      // replaced by an in-memory fake so tests and previews stay credential-free.
      { find: /\/_qoder\/storage\.mjs$/, replacement: resolve(__dirname, 'dev/storage-fake.mjs') },
    ],
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: { '/functions/v1/app': 'http://127.0.0.1:8000' },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as any);
