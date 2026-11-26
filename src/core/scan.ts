import { findSkills } from './find.ts';
import { sortSkills, type Repository, type Skill } from './model.ts';
import { parseSkill } from './parse.ts';

/** A repository to scan: its files, and how to read them. */
export type Source = {
  repository: Repository;
  /**
   * Every file path, relative to the repository root, and what listing them had to leave out.
   * Listed only when the scan runs: a stored result needs no listing. `key`: the one of `keys`
   * the result is stored under; none when the listing does not follow from the commit alone
   * (code search).
   */
  list(): Promise<{ paths: string[]; warnings: string[]; key?: string }>;
  /** The file's bytes, or undefined if it is not there. */
  read(path: string): Promise<Uint8Array | undefined>;
  /**
   * Where a stored result for this source may be, in order: each key is everything a result
   * depends on, when it cannot change, a commit and how it was listed. How it is listed is only
   * known once listed, so the listing says which one it is. Without keys, scanned every time.
   */
  keys?: string[];
  /**
   * Whether a result stored under one of `keys` is this source's; without it, any is. A key an
   * earlier version stored under may hold either listing: one answer for every input, or roots.
   */
  serves?(key: string, result: ScanResult): boolean;
  /** What was asked for, for people: `main (default branch)`, or the ref of `/tree/<ref>`. */
  ref?: string;
};

export type ScanResult = { repository: Repository; skills: Skill[]; warnings: string[] };

/** A stored scan, as the list of earlier scans shows it. */
export type StoredScan = {
  /** Opens the stored result with `Store.open`. */
  id: string;
  repository: Repository;
  /**
   * Every ref asked for, in order: `main (default branch)`, the ref of `/tree/<ref>`. Refs at the
   * same commit share the stored scan.
   */
  refs: string[];
  skills: number;
  warnings: number;
  /** When it was scanned, an ISO 8601 time. */
  scannedAt: string;
};

/** Where results are kept between scans, by the source's key. */
export type Store = {
  get(key: string): Promise<ScanResult | undefined>;
  /** Stores a new scan; whether it was stored. */
  set(key: string, scan: { ref: string; result: ScanResult }): Promise<boolean>;
  /** Records one more ref asked for of a stored scan; whether the scan is stored. */
  addRef(key: string, ref: string): Promise<boolean>;
  /** The id a key's scan is stored under, as `list` and `open` know it. */
  id(key: string): string;
  /** Every stored scan, the latest first. */
  list(): Promise<StoredScan[]>;
  /** A stored scan's result by its id, or undefined. */
  open(id: string): Promise<ScanResult | undefined>;
};

/** A scan's result, and the id of the stored scan it is, or null when it is not stored. */
export type Scanned = { result: ScanResult; stored: string | null };

/**
 * fetch → find → parse. With a store, a source with a key is scanned once: the next time, the
 * stored result. A failed scan is not stored.
 */
export async function scan(source: Source, store?: Store): Promise<Scanned> {
  if (!store || !source.keys?.length) return { result: (await scanFiles(source)).result, stored: null };
  const ref = source.ref ?? '';
  for (const key of source.keys) {
    const hit = await store.get(key);
    if (hit && (source.serves?.(key, hit) ?? true)) return { result: hit, stored: (await store.addRef(key, ref)) ? store.id(key) : null };
  }
  const { result, key } = await scanFiles(source);
  if (!key) return { result, stored: null };
  return { result, stored: (await store.set(key, { ref, result })) ? store.id(key) : null };
}

async function scanFiles(source: Source): Promise<{ result: ScanResult; key?: string }> {
  const listed = await source.list();
  const files = findSkills(listed.paths);
  // The files are read at the same time: on GitHub, each one is a request.
  const read = await Promise.all(files.map(async (file) => ({ file, bytes: await source.read(file.path) })));
  const warnings = [...listed.warnings];
  // Copies: the same name and the same bytes. Files are in path order, so the first is the skill.
  const skills = new Map<string, Skill>();
  for (const { file, bytes } of read) {
    if (!bytes) {
      warnings.push(`${file.path}: listed, but not found at the scanned commit; skipped`);
      continue;
    }
    const text = new TextDecoder().decode(bytes);
    const key = JSON.stringify([file.name, text]);
    const original = skills.get(key);
    if (original) {
      original.copies.push(file.path);
      continue;
    }
    const parsed = parseSkill(text);
    if (parsed.warning) warnings.push(`${file.path}: ${parsed.warning}`);
    skills.set(key, {
      id: `${source.repository.id}:${file.path}`,
      repository: source.repository.id,
      path: file.path,
      name: parsed.name ?? file.name,
      description: parsed.description,
      commit: source.repository.commit,
      copies: [],
    });
  }
  const result = { repository: source.repository, skills: sortSkills([...skills.values()]), warnings };
  return { result, key: listed.key };
}
