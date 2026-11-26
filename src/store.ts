// Scan results on disk, one JSON file per key, so a commit already scanned is not scanned again,
// across runs and between the CLI and the web view. The store never fails a scan: a file it
// cannot read is a scan to run, a file it cannot write is a result not kept.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ScanResult, Store, StoredScan } from './core/scan.ts';

/** Bump when the scan finds or words anything differently: older results are then not used. */
const VERSION = 4;

/** `SKILL_ATLAS_CACHE`, else `$XDG_CACHE_HOME/skill-atlas`, else `~/.cache/skill-atlas`. */
export function cacheDirectory(env: Record<string, string | undefined>): string {
  if (env.SKILL_ATLAS_CACHE) return env.SKILL_ATLAS_CACHE;
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'skill-atlas');
}

type Entry = { version: number; key: string; refs: string[]; scannedAt: string; result: ScanResult };

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

  /** Whether it was written. Written aside, then renamed: a scan at the same time never reads half a file. */
  async function write(entry: Entry): Promise<boolean> {
    const temporary = `${file(id(entry.key))}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, JSON.stringify(entry));
      await rename(temporary, file(id(entry.key)));
      return true;
    } catch {
      await rm(temporary, { force: true });
      return false;
    }
  }

  /**
   * Changes to one stored scan, one at a time: each reads the entry the last one wrote, so scans
   * at the same time in one process lose no ref. Separate processes can still race.
   */
  const queues = new Map<string, Promise<unknown>>();
  function serially<T>(scanId: string, change: () => Promise<T>): Promise<T> {
    const next = (queues.get(scanId) ?? Promise.resolve()).then(change);
    const settled = next.catch(() => {});
    queues.set(scanId, settled);
    void settled.then(() => queues.get(scanId) === settled && queues.delete(scanId));
    return next;
  }

  /** Adds the ref to the key's entry; whether the entry is stored. */
  async function addTo(entry: Entry, ref: string): Promise<boolean> {
    // Not recorded if it cannot be written: the scan is still stored.
    if (!entry.refs.includes(ref)) await write({ ...entry, refs: [...entry.refs, ref] });
    return true;
  }

  /** The key's entry; another key under the same id is not it. */
  async function entryOf(key: string): Promise<Entry | undefined> {
    const entry = await read(id(key));
    return entry?.key === key ? entry : undefined;
  }

  return {
    id,
    async get(key) {
      return (await entryOf(key))?.result;
    },
    set(key, { ref, result }) {
      return serially(id(key), async () => {
        // Another scan of the commit, at the same time, stored it first: its result, and this ref too.
        const stored = await entryOf(key);
        if (stored) return addTo(stored, ref);
        return write({ version: VERSION, key, refs: [ref], scannedAt: now().toISOString(), result });
      });
    },
    addRef(key, ref) {
      return serially(id(key), async () => {
        const stored = await entryOf(key);
        return stored ? addTo(stored, ref) : false;
      });
    },
    async list() {
      const names = await readdir(directory).catch(() => [] as string[]);
      const ids = names.map((name) => name.replace(/\.json$/, '')).filter((name) => ID.test(name));
      const scans: StoredScan[] = [];
      for (const scanId of ids) {
        const entry = await read(scanId);
        if (!entry) continue;
        const { repository, skills, warnings } = entry.result;
        scans.push({ id: scanId, repository, refs: entry.refs, skills: skills.length, warnings: warnings.length, scannedAt: entry.scannedAt });
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
