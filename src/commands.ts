// The skill-atlas commands. Everything that differs between the CLI and the tests comes in
// through the context.
import { AtlasError } from './core/errors.ts';
import { skillLink, type Repository, type Skill } from './core/model.ts';
import { scan, type Source, type Store } from './core/scan.ts';

export type Context = {
  /** Opens what the user asked to scan. */
  open(input: string): Promise<Source>;
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

/** `<owner>/<repo> · N skills`, then each skill's name, first sentence and link. */
function printRepository(repository: Repository, skills: Skill[], { print }: Context) {
  print(`${repository.id} · ${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}`);
  for (const skill of skills) {
    print(skill.description ? `${skill.name} — ${firstSentence(skill.description)}` : skill.name);
    print(`  ${skillLink(repository, skill)}`);
    if (skill.copies.length > 0) print(`  also in ${skill.copies.join(', ')}`);
  }
}

function firstSentence(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;
}
