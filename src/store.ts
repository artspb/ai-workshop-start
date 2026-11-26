// Scan results on disk, one JSON file per key, so a commit already scanned is not scanned again,
// across runs and between the CLI and the web view. The store never fails a scan: a file it
// cannot read is a scan to run, a file it cannot write is a result not kept.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ScanResult, Store } from './core/scan.ts';

/** Bump when the scan finds or words anything differently: older results are then not used. */
const VERSION = 1;

/** `SKILL_ATLAS_CACHE`, else `$XDG_CACHE_HOME/skill-atlas`, else `~/.cache/skill-atlas`. */
export function cacheDirectory(env: Record<string, string | undefined>): string {
  if (env.SKILL_ATLAS_CACHE) return env.SKILL_ATLAS_CACHE;
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'skill-atlas');
}

type Entry = { version: number; key: string; result: ScanResult };

export function openStore(directory: string): Store {
  const file = (key: string) => join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  return {
    async get(key) {
      try {
        const entry = JSON.parse(await readFile(file(key), 'utf8')) as Entry;
        return entry.version === VERSION && entry.key === key ? entry.result : undefined;
      } catch {
        return undefined;
      }
    },
    async set(key, result) {
      const entry: Entry = { version: VERSION, key, result };
      // Written aside, then renamed: a scan at the same time never reads half a file.
      const temporary = `${file(key)}.${randomUUID()}.tmp`;
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporary, JSON.stringify(entry));
        await rename(temporary, file(key));
      } catch {
        await rm(temporary, { force: true });
      }
    },
  };
}
