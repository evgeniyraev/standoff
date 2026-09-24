// Persists the kiosk configuration (settings, theme, questions) as JSON in the
// user-data folder. Writes are atomic (tmp file + rename) so a power cut in
// the middle of a save never leaves a corrupt file behind.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { deepMerge, normalizeConfig } from '../shared/defaults.js';

export class ConfigStore extends EventEmitter {
  constructor(dir) {
    super();
    this.file = path.join(dir, 'config.json');
    this.config = normalizeConfig(this.read());
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[config] unreadable, falling back to defaults:', err.message);
        try {
          fs.copyFileSync(this.file, `${this.file}.broken-${Date.now()}`);
        } catch {}
      }
      return {};
    }
  }

  get() {
    return this.config;
  }

  /** Deep-merges a partial patch (arrays replace), normalizes and saves. */
  update(patch) {
    this.config = normalizeConfig(deepMerge(this.config, patch ?? {}));
    this.write();
    this.emit('change', this.config);
    return this.config;
  }

  write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
