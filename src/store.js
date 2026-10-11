// Tiny JSON-file store shared by the website process and the MCP process,
// so a trade Claude makes over MCP shows up on the website and vice versa.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });

export function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${name}.json`), 'utf8'));
  } catch {
    return fallback;
  }
}

export function write(name, value) {
  const file = path.join(DATA_DIR, `${name}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function logActivity(source, action, details = {}) {
  const log = read('activity', []);
  const entry = { time: new Date().toISOString(), source, action, ...details };
  log.unshift(entry);
  write('activity', log.slice(0, 500));
  import('./notify.js').then((m) => m.notifyActivity(entry)).catch(() => {});
  return entry;
}

export function getActivity(limit = 50) {
  return read('activity', []).slice(0, limit);
}
