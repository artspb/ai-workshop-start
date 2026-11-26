// Scan results on disk, one JSON file per key, so a commit already scanned is not scanned again,
// across runs and between the CLI and the web view. The store never fails a scan: a file it
// cannot read is a scan to run, a file it cannot write is a result not kept.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ScanResult, Store, StoredScan } from './core/scan.ts';

/** Bump when the scan finds or words anything differently: older results are then not used. */
const VERSION = 2;

/** `SKILL_ATLAS_CACHE`, else `$XDG_CACHE_HOME/skill-atlas`, else `~/.cache/skill-atlas`. */
export function cacheDirectory(env: Record<string, string | undefined>): string {
  if (env.SKILL_ATLAS_CACHE) return env.SKILL_ATLAS_CACHE;
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'skill-atlas');
}

type Entry = { version: number; key: string; listing: string; scannedAt: string; result: ScanResult };

/** A stored scan's id: its file name, a hash of its key. Nothing else names a file. */
const ID = /^[0-9a-f]{64}$/;

export function openStore(directory: string, now: () => Date = () => new Date()): Store {
  const id = (key: string) => createHash('sha256').update(key).digest('hex');
  const file = (id: string) => join(directory, `${id}.json`);

  /** The entry in the file, or undefined if it is missing, corrupt or of another version. */
  async function read(id: string): Promise<Entry | undefined> {
    try {
      const entry = JSON.parse(await readFile(file(id), 'utf8')) as Entry;
      return entry.version === VERSION ? entry : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    async get(key) {
      const entry = await read(id(key));
      return entry?.key === key ? entry.result : undefined;
    },
    async set(key, { listing, result }) {
      const entry: Entry = { version: VERSION, key, listing, scannedAt: now().toISOString(), result };
      // Written aside, then renamed: a scan at the same time never reads half a file.
      const temporary = `${file(id(key))}.${randomUUID()}.tmp`;
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporary, JSON.stringify(entry));
        await rename(temporary, file(id(key)));
      } catch {
        await rm(temporary, { force: true });
      }
    },
    async list() {
      const names = await readdir(directory).catch(() => [] as string[]);
      const ids = names.map((name) => name.replace(/\.json$/, '')).filter((name) => ID.test(name));
      const scans: StoredScan[] = [];
      for (const scanId of ids) {
        const entry = await read(scanId);
        if (!entry) continue;
        const { repository, skills, warnings } = entry.result;
        scans.push({ id: scanId, repository, listing: entry.listing, skills: skills.length, warnings: warnings.length, scannedAt: entry.scannedAt });
      }
      // The latest first; the same time, by repository then commit.
      const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      return scans.sort(
        (a, b) => compare(b.scannedAt, a.scannedAt) || compare(a.repository.id, b.repository.id) || compare(a.repository.commit, b.repository.commit),
      );
    },
    async open(scanId) {
      return ID.test(scanId) ? (await read(scanId))?.result : undefined;
    },
  };
}
