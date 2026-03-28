#!/usr/bin/env node

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import http from 'http';
import { exec } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, 'index.js');

// 🔥 CRITICAL: force module resolution from global install
const require = createRequire(entry);
global.require = require;

const PORT = process.env.PORT || 3000;
const URL = `http://localhost:${PORT}`;

function isRunning() {
  return new Promise((resolve) => {
    const req = http.get(URL, () => resolve(true));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function openBrowser(url) {
  if (process.platform === 'darwin') {
    exec(`open ${url}`);
  } else if (process.platform === 'win32') {
    exec(`start ${url}`);
  } else {
    exec(`xdg-open ${url}`);
  }
}

async function waitForServer() {
  for (let i = 0; i < 20; i++) {
    if (await isRunning()) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

(async () => {
  const running = await isRunning();

  if (running) {
    console.log(`[PSX] Already running → ${URL}`);
    openBrowser(URL);
    return;
  }

  console.log('[PSX] Starting server...');

  await import(entry);

  const ready = await waitForServer();

  if (ready) {
    console.log(`[PSX] Ready → ${URL}`);
    openBrowser(URL);
  } else {
    console.error('[PSX] Failed to start');
  }
})();
