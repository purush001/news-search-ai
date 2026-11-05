// Offline demo: starts the mock OpenAI and SerpAPI servers, then Vite wired to them.
// Any key works except those containing "bad" (401), "ratelimit" (429) or "quota" (429 out of credit).
import { spawn } from 'node:child_process';
import { startMockOpenAI } from '../server/mock/openai.js';
import { startMockSerpApi } from '../server/mock/serpapi.js';

const openai = await startMockOpenAI({ port: Number(process.env.MOCK_OPENAI_PORT) || 4101 });
const serp = await startMockSerpApi({ port: Number(process.env.MOCK_SERPAPI_PORT) || 4102 });
console.log(`Mock OpenAI  : ${openai.url}/v1`);
console.log(`Mock SerpAPI : ${serp.url}`);
console.log('Use any keys, e.g. sk-mock-openai-key-000000 and mock-serpapi-key. Keys containing "bad", "ratelimit" or "quota" simulate failures.');

const child = spawn(process.execPath, ['./node_modules/vite/bin/vite.js'], {
  stdio: 'inherit',
  env: { ...process.env, OPENAI_BASE_URL: `${openai.url}/v1`, SERPAPI_BASE_URL: serp.url, OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-6.1-sol' },
});
const stop = () => {
  child.kill();
  openai.close();
  serp.close();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
