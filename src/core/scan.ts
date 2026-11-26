import { findSkills } from './find.ts';
import { sortSkills, type Repository, type Skill } from './model.ts';
import { parseSkill } from './parse.ts';

/** A repository to scan: its files, and how to read them. */
export type Source = {
  repository: Repository;
  /**
   * Every file path, relative to the repository root, and what listing them had to leave out.
   * Listed only when the scan runs: a stored result needs no listing.
   */
  list(): Promise<{ paths: string[]; warnings: string[] }>;
  /** The file's bytes, or undefined if it is not there. */
  read(path: string): Promise<Uint8Array | undefined>;
  /**
   * Everything the result depends on, when it cannot change: a commit and how it was listed.
   * A source with a key is scanned once per store; without one, every time.
   */
  key?: string;
};

export type ScanResult = { repository: Repository; skills: Skill[]; warnings: string[] };

/** Where results are kept between scans, by the source's key. */
export type Store = {
  get(key: string): Promise<ScanResult | undefined>;
  set(key: string, result: ScanResult): Promise<void>;
};

/**
 * fetch → find → parse. With a store, a source with a key is scanned once: the next time, the
 * stored result. A failed scan is not stored.
 */
export async function scan(source: Source, store?: Store): Promise<ScanResult> {
  if (!store || !source.key) return scanFiles(source);
  const stored = await store.get(source.key);
  if (stored) return stored;
  const result = await scanFiles(source);
  await store.set(source.key, result);
  return result;
}

async function scanFiles(source: Source): Promise<ScanResult> {
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
  return { repository: source.repository, skills: sortSkills([...skills.values()]), warnings };
}
