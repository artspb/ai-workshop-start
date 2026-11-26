// `skill-atlas serve --port 0` for the visual tests: the same server, with GitHub answering from RATE_LIMITED,
// never the network, and no GITHUB_TOKEN. The store is SKILL_ATLAS_CACHE, seeded first with the stored scans
// in the JSON file named by the argument, each at its own fixed time. Prints the page's URL.
import { readFileSync } from 'node:fs';
import { openGitHub, parseGitHubUrl } from '../../src/core/github.ts';
import { replay } from '../../src/core/replay.ts';
import { openDirectory } from '../../src/local.ts';
import { cacheDirectory, openStore } from '../../src/store.ts';
import { createWebServer, listen } from '../../src/web/server.ts';
import { NOW, RATE_LIMITED, type Seed } from './data.ts';

const directory = cacheDirectory(process.env);
for (const { key, refs, scannedAt, result } of JSON.parse(readFileSync(process.argv[2], 'utf8')) as Seed[]) {
  const seeding = openStore(directory, () => new Date(scannedAt));
  await seeding.set(key, { ref: refs[0], result });
  for (const ref of refs.slice(1)) await seeding.addRef(key, ref);
}

const github = replay(RATE_LIMITED);
const open = (input: string) => (parseGitHubUrl(input) ? openGitHub(input, { fetch: github }) : openDirectory(input));
// A scan the page stores is stored at NOW, as the page's clock says.
const store = openStore(directory, () => NOW);
console.log(await listen(createWebServer({ open, store }), 0));
