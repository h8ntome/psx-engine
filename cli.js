#!/usr/bin/env node
// CLI entry point — checks if server is already running, then starts or opens.
import http from 'http';
import { execFile } from 'child_process';

const PORT = process.env.PORT || 3000;
const URL  = `http://localhost:${PORT}`;

function openBrowser(url) {
  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', url]);
  } else if (process.platform === 'darwin') {
    execFile('open', [url]);
  } else {
    execFile('xdg-open', [url]);
  }
}

function serverAlreadyRunning() {
  return new Promise((resolve) => {
    const req = http.get(URL, () => resolve(true));
    req.setTimeout(500, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

const running = await serverAlreadyRunning();

if (running) {
  console.log(`[PSX] Already running — opening ${URL}`);
  openBrowser(URL);
} else {
  await import('./index.js');
}
