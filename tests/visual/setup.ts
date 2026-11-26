// Before the visual tests: `./fixture` copied to WORKDIR, a path the same on every machine, so its local links,
// `file:///tmp/skill-atlas-visual/fixture/…`, look the same in every screenshot. Its symbolic links stay links.
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKDIR } from './data.ts';

export default function setup() {
  rmSync(WORKDIR, { recursive: true, force: true });
  cpSync(fileURLToPath(new URL('../../fixture', import.meta.url)), join(WORKDIR, 'fixture'), { recursive: true, verbatimSymlinks: true });
}
