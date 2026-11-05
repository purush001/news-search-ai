import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createApi } from './server/app.js';

// One API handler, mounted as Vite dev/preview middleware. `npm start` mounts the same handler.
function apiPlugin() {
  const api = createApi();
  const mount = (server) => {
    server.middlewares.use((req, res, next) => {
      api.handle(req, res).then(
        (handled) => {
          if (!handled) next();
        },
        (err) => next(err),
      );
    });
  };
  return {
    name: 'news-search-ai-api',
    configureServer: mount,
    configurePreviewServer: mount,
  };
}

export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: { host: '127.0.0.1', port: 5173, strictPort: false },
  preview: { host: '127.0.0.1', port: 4173 },
  build: { outDir: 'dist', sourcemap: false },
});
