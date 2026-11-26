// Runs the commands the way the CLI does, with GitHub answering from EXAMPLE below.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { run } from '../src/commands.ts';
import { openGitHub, parseGitHubUrl, type Fetch } from '../src/core/github.ts';
import { replay, type Recording } from '../src/core/replay.ts';
import type { Meter } from '../src/core/requests.ts';
import { openDirectory } from '../src/local.ts';
import { createWebServer, listen } from '../src/web/server.ts';

export const FIXTURE = fileURLToPath(new URL('../fixture', import.meta.url));
export const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/** The commit GitHub answers for JetBrains/example. */
export const EXAMPLE_COMMIT = '5ab6270ab772d113e8ad52ebfcaa0109c522ae00';

/** What GitHub answers for a small repository, JetBrains/example, with one skill. */
const EXAMPLE: Recording = {
  'https://api.github.com/repos/JetBrains/example': { status: 200, body: { full_name: 'JetBrains/example', default_branch: 'main' } },
  'https://api.github.com/repos/JetBrains/example/commits/main': { status: 200, body: { sha: EXAMPLE_COMMIT } },
  // A branch that does not exist: GitHub answers 422, not 404.
  'https://api.github.com/repos/JetBrains/example/commits/no-such-branch': {
    status: 422,
    body: { message: 'No commit found for SHA: no-such-branch', status: '422' },
  },
  [`https://api.github.com/repos/JetBrains/example/git/trees/${EXAMPLE_COMMIT}?recursive=1`]: {
    status: 200,
    body: { truncated: false, tree: [{ path: '.claude/skills/commits/SKILL.md', mode: '100644', type: 'blob', sha: '0' }] },
  },
  [`https://raw.githubusercontent.com/JetBrains/example/${EXAMPLE_COMMIT}/.claude/skills/commits/SKILL.md`]: {
    status: 200,
    body: '---\nname: commits\ndescription: Write commit messages the way this repository does. Use for every commit.\n---\n# Commits\n',
  },
};

const github = replay(EXAMPLE);

/** Opens a scan as the CLI does, with a token, as EXAMPLE answers it: its tree fits in one answer. */
export const open = (input: string, meter?: Meter) =>
  parseGitHubUrl(input) ? openGitHub(input, { fetch: github, token: 'test', meter }) : openDirectory(input);

/** `skill-atlas <args>`, as the CLI runs it, with GitHub answering from EXAMPLE. */
export async function atlas(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(args, {
    open,
    print: (text) => stdout.push(text),
    error: (text) => stderr.push(text),
    serve: (port) => listen(createWebServer({ open }), port),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

/**
 * A fetch that answers from a recording, GraphQL too: a query for the default branches' commits is
 * answered as GitHub would, from the recording's answers for each repository (`/repos/<id>` and its
 * default branch's `/commits/<branch>`); a repository not recorded, or whose commit is not `200`, has
 * no `defaultBranchRef`, as an empty one. A recording of `/graphql` itself answers every query instead.
 */
export function replayGraphQL(recording: Recording): Fetch {
  const rest = replay(recording);
  return async (url, init) => {
    if (url !== 'https://api.github.com/graphql' || Object.hasOwn(recording, url)) return rest(url, init);
    assert.equal(init?.method, 'POST');
    if (!init.headers?.Authorization) return Response.json({ message: 'This endpoint requires you to be authenticated.' }, { status: 401 });
    const { query } = JSON.parse(init.body ?? '{}') as { query: string };
    const data: Record<string, unknown> = {};
    for (const [, alias, owner, name] of query.matchAll(/(\w+): repository\(owner: "([^"]*)", name: "([^"]*)"\)/g)) {
      const info = recording[`https://api.github.com/repos/${owner}/${name}`];
      if (info?.status !== 200) {
        data[alias] = null;
        continue;
      }
      const branch = (info.body as { default_branch: string }).default_branch;
      const commit = recording[`https://api.github.com/repos/${owner}/${name}/commits/${encodeURIComponent(branch)}`];
      const oid = commit?.status === 200 ? (commit.body as { sha: string }).sha : undefined;
      data[alias] = { defaultBranchRef: oid ? { name: branch, target: { oid } } : null };
    }
    return Response.json({ data });
  };
}
