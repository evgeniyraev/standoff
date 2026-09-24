// Values baked into the build by the GitHub Action (scripts/write-build-info.js
// writes build-info.json before packaging). In development the same values can
// be supplied through environment variables.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

let cached = null;

export function getBuildInfo() {
  if (cached) return cached;
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'build-info.json'), 'utf8'));
  } catch {}
  cached = {
    room: process.env.STANDOFF_ROOM || file.room || '',
    pin: process.env.STANDOFF_PIN || file.pin || '',
    commit: file.commit || 'dev',
    builtAt: file.builtAt || null,
  };
  return cached;
}
