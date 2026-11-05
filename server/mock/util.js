import http from 'node:http';

export function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address();
      resolve({ server, port: p, url: `http://127.0.0.1:${p}`, close: () => closeServer(server) });
    });
  });
}

export function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shared failure keys: a key containing "bad" is rejected, "ratelimit" is throttled, "quota" is out of credit. */
export function keyProblem(key) {
  if (!key) return 'missing';
  if (/bad/i.test(key)) return 'bad';
  if (/ratelimit/i.test(key)) return 'ratelimit';
  if (/quota/i.test(key)) return 'quota';
  return null;
}

export { http };
