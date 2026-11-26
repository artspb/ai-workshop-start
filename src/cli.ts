#!/usr/bin/env node
// The Node client: a GitHub repository or organization through the GitHub API, or a local directory;
// stdout and stderr, or the web view. A GitHub scan is kept on disk, by commit: see spec/analysis.md.
import { run } from './commands.ts';
import { openGitHub, openGitHubOwner, parseGitHubOwner, parseGitHubUrl } from './core/github.ts';
import type { Meter } from './core/requests.ts';
import { openDirectory } from './local.ts';
import { cacheDirectory, openStore } from './store.ts';
import { createWebServer, listen } from './web/server.ts';

const token = process.env.GITHUB_TOKEN || undefined;
const store = openStore(cacheDirectory(process.env));
// The web view counts each scan's requests with a meter; the CLI does not.
const open = (input: string, meter?: Meter) => (parseGitHubUrl(input) ? openGitHub(input, { fetch, token, meter }) : openDirectory(input));

const openOrganization = (input: string, meter?: Meter) => (parseGitHubOwner(input) ? openGitHubOwner(input, { fetch, token, meter }) : undefined);

process.exitCode = await run(process.argv.slice(2), {
  open,
  openOrganization,
  store,
  print: (text) => console.log(text),
  error: (text) => console.error(text),
  serve: (port) => listen(createWebServer({ open, openOrganization, store }), port),
});
