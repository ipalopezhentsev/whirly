import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs so the build works under the GitHub Pages sub-path (/whirly/).
  base: './',
  server: { port: 5173 },
});
