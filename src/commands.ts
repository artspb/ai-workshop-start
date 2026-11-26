// The skill-atlas commands. Everything that differs between the CLI and the tests comes in
// through the context.
import { AtlasError } from './core/errors.ts';
import { firstSentence, skillLink, type Repository, type Skill } from './core/model.ts';
import { scanOrganization, type Organization } from './core/organization.ts';
import { scan, type Source, type Store } from './core/scan.ts';

export type Context = {
  /** Opens what the user asked to scan. */
  open(input: string): Promise<Source>;
  /** Opens the organization or user the user asked to scan; undefined when the input is not one. */
  openOrganization?(input: string): Promise<Organization> | undefined;
  /** Earlier scans; without one, every scan runs. */
  store?: Store;
  print(text: string): void;
  /** Errors and warnings. */
  error(text: string): void;
  /** Starts the web view on the port; resolves to its URL once it listens. */
  serve(port: number): Promise<string>;
};

/** The web view's port without `--port`. */
export const DEFAULT_PORT = 4173;

const usage = `Usage: skill-atlas <command>

  scan <GitHub URL | directory>   find every SKILL.md in a repository and print it
  scan <GitHub organization URL>  the same, in every repository of an organization or a user
  serve [--port <port>]           the same, in a browser, on http://localhost:${DEFAULT_PORT}
  help                            show this help`;

/** Runs one command; returns its exit code. */
export async function run(args: string[], context: Context): Promise<number> {
  const [command = 'help', ...rest] = args;
  try {
    if (command === 'scan') await scanCommand(rest, context);
    else if (command === 'serve') await serveCommand(rest, context);
    else if (command === 'help') context.print(usage);
    else throw new AtlasError(`Unknown command: ${command}\n\n${usage}`);
    return 0;
  } catch (error) {
    if (!(error instanceof AtlasError)) throw error;
    context.error(error.message);
    return 1;
  }
}

async function scanCommand(args: string[], context: Context) {
  if (args.length !== 1) throw new AtlasError('Usage: skill-atlas scan <GitHub URL | directory>');
  const organization = context.openOrganization?.(args[0]);
  if (organization) return printOrganization(await organization, context);
  const { result } = await scan(await context.open(args[0]), context.store);
  printRepository(result.repository, result.skills, context);
  for (const warning of result.warnings) context.error(`warning: ${warning}`);
}

async function serveCommand(args: string[], context: Context) {
  const usage = 'Usage: skill-atlas serve [--port <port>]';
  let port = DEFAULT_PORT;
  if (args.length === 2 && args[0] === '--port') {
    if (!/^\d+$/.test(args[1]) || Number(args[1]) > 65535) throw new AtlasError(`Not a port: ${args[1]}\n${usage}`);
    port = Number(args[1]);
  } else if (args.length !== 0) throw new AtlasError(usage);
  const url = await context.serve(port);
  context.print(`Skill Atlas at ${url} · Ctrl+C stops it`);
}

/**
 * `<owner> · N repositories · M skills`, then each repository with skills as `scan` prints it, an
 * empty line before it; the warnings after, each with its repository.
 */
async function printOrganization(organization: Organization, context: Context) {
  const scans = await scanOrganization(organization, context.open, context.store);
  const skills = scans.reduce((total, { result }) => total + (result?.skills.length ?? 0), 0);
  context.print(`${organization.id} · ${count(scans.length, 'repository', 'repositories')} · ${count(skills, 'skill', 'skills')}`);
  for (const { result } of scans) {
    if (!result?.skills.length) continue;
    context.print('');
    printRepository(result.repository, result.skills, context);
  }
  for (const { id, result, error } of scans) {
    for (const warning of result ? result.warnings : [error]) context.error(`warning: ${id}: ${warning}`);
  }
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `<owner>/<repo> · N skills`, then each skill's name, first sentence and link. */
function printRepository(repository: Repository, skills: Skill[], { print }: Context) {
  print(`${repository.id} · ${count(skills.length, 'skill', 'skills')}`);
  for (const skill of skills) {
    print(skill.description ? `${skill.name} — ${firstSentence(skill.description)}` : skill.name);
    print(`  ${skillLink(repository, skill)}`);
    if (skill.copies.length > 0) print(`  also in ${skill.copies.join(', ')}`);
  }
}
