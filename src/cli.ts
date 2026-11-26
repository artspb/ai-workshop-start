#!/usr/bin/env node
// The Node client: a GitHub repository or organization through the GitHub API, or a local directory;
// stdout and stderr, or the web view. A GitHub scan is kept on disk, by commit: see spec/analysis.md.
import { run } from './commands.ts';
import { openGitHub, openGitHubOwner, parseGitHubOwner, parseGitHubUrl } from './core/github.ts';
import { openDirectory } from './local.ts';
import { cacheDirectory, openStore } from './store.ts';
import { createWebServer, listen } from './web/server.ts';

const token = process.env.GITHUB_TOKEN || undefined;
const store = openStore(cacheDirectory(process.env));
const open = (input: string) => (parseGitHubUrl(input) ? openGitHub(input, { fetch, token }) : openDirectory(input));

const openOrganization = (input: string) => (parseGitHubOwner(input) ? openGitHubOwner(input, { fetch, token }) : undefined);

process.exitCode = await run(process.argv.slice(2), {
  open,
  openOrganization,
  store,
  print: (text) => console.log(text),
  error: (text) => console.error(text),
  serve: (port) => listen(createWebServer({ open, store }), port),
});
