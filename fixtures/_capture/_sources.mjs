// Machine-local capture sources. The capture scripts mirror line counts, byte sizes and key
// names from a few real project directories; their names must never ship in git, so they live
// in `fixtures/_capture/sources.local.json` (gitignored, see sources.example.json) or in the
// MOLDIG_CAPTURE_SOURCES env var (path to such a file). Without either, every mirror falls back
// to the documented shape and the script says so in its "sources live" line.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadSources() {
  const file = process.env.MOLDIG_CAPTURE_SOURCES ?? join(HERE, 'sources.local.json');
  try {
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** Absolute path of a source entry (values are relative to the home directory), or '' when unset. */
export function sourcePath(rel) {
  if (typeof rel !== 'string' || rel === '') return '';
  return isAbsolute(rel) ? rel : join(homedir(), rel);
}

/** Case-insensitive needles the leak check must not find: every declared source directory name. */
export function sourceNeedles(sources) {
  const names = new Set(Array.isArray(sources.leakNeedles) ? sources.leakNeedles : []);
  for (const group of Object.values(sources)) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
    for (const v of Object.values(group)) if (typeof v === 'string' && v) names.add(v.split('/').filter(Boolean).pop());
  }
  return [...names].filter((n) => n && n.length > 2).map((n) => new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
}
