// `npm run dev`: Vite dev server for the renderers + Electron pointed at it.
// Runs windowed (not kiosk); set STANDOFF_KIOSK=1 to test kiosk mode.
import { spawn } from 'node:child_process';
import electronPath from 'electron';
import { createServer } from 'vite';

const server = await createServer({ configFile: 'vite.config.js' });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
console.log(`[dev] renderer at ${url}`);

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
