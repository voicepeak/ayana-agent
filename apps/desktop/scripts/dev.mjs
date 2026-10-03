import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
await import('./build-electron.mjs');
const server = await createServer({ server: { port: 5173 } });
await server.listen();
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, AYANA_RENDERER_URL: 'http://127.0.0.1:5173' },
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  child.kill();
  await server.close();
}
child.on('exit', async (code) => { await close(); process.exit(code ?? 0); });
process.on('SIGINT', close);
process.on('SIGTERM', close);
