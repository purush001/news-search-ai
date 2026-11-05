import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './app.js';
import { createStaticHandler } from './static.js';
import { redact } from './redact.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Standalone server: API plus the built `dist/` bundle. */
export function createAppServer({ distDir = path.join(here, '..', 'dist'), api = createApi() } = {}) {
  const serveStatic = createStaticHandler(distDir);
  const server = http.createServer(async (req, res) => {
    try {
      if (await api.handle(req, res)) return;
      await serveStatic(req, res);
    } catch (err) {
      api.config.logger(`handler error: ${redact(err?.message)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Internal error');
      } else {
        res.destroy();
      }
    }
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 4173;
  const distDir = process.env.DIST_DIR ? path.resolve(process.env.DIST_DIR) : path.join(here, '..', 'dist');
  if (!existsSync(path.join(distDir, 'index.html'))) {
    console.warn(`Warning: ${distDir}/index.html not found. Run "npm run build" first.`);
  }
  const server = createAppServer({ distDir });
  process.on('unhandledRejection', (reason) => console.error('unhandled rejection:', redact(reason?.message ?? reason)));
  server.listen(port, '127.0.0.1', () => {
    const { address, port: p } = server.address();
    console.log(`News Search AI listening on http://${address}:${p}`);
  });
}
