import { defaultGhRunner, type GhRunner } from '../../src/github/gh.js';

/** What the e2e suite may touch: one repository, the projects of one owner that the suite owns. */
export interface GuardScope {
  /** The sandbox repository, `owner/name`. */
  repo: string;
  /** The login that owns the projects. */
  projectOwner: string;
  /** The project numbers the suite owns: the one given by `SDLC_E2E_PROJECT` and the one it created. The caller adds to it. */
  projects: ReadonlySet<number>;
}

/** The `gh` command groups whose target is a repository, named by `--repo <owner/name>` (or `-R`). */
const REPO_GROUPS: ReadonlySet<string> = new Set(['issue', 'pr', 'label', 'repo', 'release', 'run', 'workflow', 'secret', 'variable']);
/** The `gh project` subcommands the suite needs. Anything else (delete, close, edit, copy, link ...) is refused. */
const PROJECT_READ_OR_CREATE: ReadonlySet<string> = new Set(['create', 'list']);
const PROJECT_OF_NUMBER: ReadonlySet<string> = new Set(['view', 'field-list', 'item-list']);
/** Subcommands that remove or move something; the suite only ever opens and closes issues. */
const DESTRUCTIVE_SUBCOMMANDS: ReadonlySet<string> = new Set(['delete', 'transfer', 'archive', 'unarchive', 'rename', 'lock', 'unlock']);
/** Flags that retarget a call away from the repository; never needed here. */
const REFUSED_FLAGS: ReadonlySet<string> = new Set(['--hostname', '--org', '--user']);
/** Flags that take a value, so the value is not mistaken for a positional argument. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--repo', '-R', '--owner', '--method', '-X', '--header', '-H', '--field', '-F', '--raw-field', '-f', '--input',
  '--jq', '-q', '--template', '-t', '--cache', '--preview', '-p', '--hostname', '--format', '--limit', '-L', '--title',
  '--body', '-b', '--body-file', '--label', '-l', '--state', '-s', '--search', '-S', '--json', '--reason', '-r',
  '--color', '--description', '-d', '--assignee', '-a', '--author', '-A', '--base', '--head', '--milestone', '-m',
  '--app', '--comment', '--name', '-n',
]);
/** Flags that make `gh api` send a request body or a method other than GET. */
const WRITE_FLAGS: ReadonlySet<string> = new Set(['--method', '-X', '--field', '-F', '--raw-field', '-f', '--input']);
/** A GraphQL mutation that removes something; the suite never deletes. */
const DESTRUCTIVE_MUTATION = /\b(?:delete|transfer|archive|unarchive)[A-Za-z0-9]*\s*\(/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

const lower = (text: string | undefined): string => (text ?? '').trim().toLowerCase();
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Flag {
  name: string;
  value?: string;
}

/** The flags (with their values) and the positional arguments of `args`; a flag not in `VALUE_FLAGS` takes no value. */
function parseArgs(args: readonly string[]): { flags: Flag[]; positionals: string[] } {
  const flags: Flag[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq > 0 ? arg.slice(0, eq) : arg;
      if (eq > 0) flags.push({ name, value: arg.slice(eq + 1) });
      else if (VALUE_FLAGS.has(name)) flags.push({ name, value: args[++i] ?? '' });
      else flags.push({ name });
    } else if (arg.startsWith('-') && arg.length > 1) {
      const name = arg.slice(0, 2);
      if (!VALUE_FLAGS.has(name)) flags.push({ name });
      else if (arg.length > 2) flags.push({ name, value: arg.slice(arg.startsWith(`${name}=`) ? 3 : 2) });
      else flags.push({ name, value: args[++i] ?? '' });
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

/** The HTTP method `gh api` would use: `-X`/`--method`, else POST when it sends fields or a body, else GET. */
function methodOf(flags: readonly Flag[]): string {
  const given = flags.find(flag => flag.name === '-X' || flag.name === '--method');
  if (given !== undefined) return (given.value ?? '').trim().toUpperCase();
  return flags.some(flag => WRITE_FLAGS.has(flag.name)) ? 'POST' : 'GET';
}
const isRead = (flags: readonly Flag[]): boolean => ['GET', 'HEAD'].includes(methodOf(flags));

/** The GraphQL variables of the request body `input`; `undefined` when it is not a JSON object with a string query. */
function graphqlRequest(input: string | undefined): { query: string; variables: Record<string, unknown> } | undefined {
  if (input === undefined) return undefined;
  try {
    const body: unknown = JSON.parse(input);
    if (typeof body !== 'object' || body === null) return undefined;
    const { query, variables } = body as { query?: unknown; variables?: unknown };
    if (typeof query !== 'string') return undefined;
    if (variables !== undefined && (typeof variables !== 'object' || variables === null)) return undefined;
    return { query, variables: (variables ?? {}) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/** Why `gh` with `args` and stdin `input` may not run in the suite, or `undefined` when it may. Fails closed: what is not recognised is refused. */
export function checkGhCall(scope: GuardScope, args: readonly string[], input?: string): string | undefined {
  const sandbox = lower(scope.repo);
  const owner = lower(scope.projectOwner);
  const [group, ...rest] = args;
  if (group === undefined || group.startsWith('-')) return 'no command';

  const sandboxUrl = new RegExp(`^https://github\\.com/${escapeRegExp(sandbox)}(?:[/#?]|$)`, 'i');
  const stray = args.find(arg => URL_SCHEME.test(arg) && !sandboxUrl.test(arg));
  if (stray !== undefined) return `the URL ${stray} is not in ${scope.repo}`;

  const { flags, positionals } = parseArgs(rest);
  for (const flag of flags) {
    if (REFUSED_FLAGS.has(flag.name)) return `${flag.name} is not allowed`;
    if ((flag.name === '--repo' || flag.name === '-R') && lower(flag.value) !== sandbox) {
      return `${flag.name} ${flag.value ?? ''} is not ${scope.repo}`;
    }
    if (flag.name === '--owner' && lower(flag.value) !== owner) return `--owner ${flag.value ?? ''} is not ${scope.projectOwner}`;
  }

  if (REPO_GROUPS.has(group)) {
    if (!flags.some(flag => flag.name === '--repo' || flag.name === '-R')) return `gh ${group} needs --repo ${scope.repo}`;
    if (DESTRUCTIVE_SUBCOMMANDS.has(positionals[0] ?? '')) return `gh ${group} ${positionals[0]} is not allowed`;
    if (group === 'repo') {
      if (positionals[0] !== 'view') return 'only gh repo view is allowed';
      const named = positionals.slice(1).find(arg => /^[\w.-]+\/[\w.-]+$/.test(arg));
      if (named !== undefined && lower(named) !== sandbox) return `${named} is not ${scope.repo}`;
    }
    return undefined;
  }
  if (group === 'project') return checkProject(scope, flags, positionals);
  if (group === 'api') return checkApi(scope, flags, positionals, input);
  return `gh ${group} is not a command the suite uses`;
}

function checkProject(scope: GuardScope, flags: readonly Flag[], positionals: readonly string[]): string | undefined {
  const [sub, ...numbers] = positionals;
  if (!flags.some(flag => flag.name === '--owner')) {
    // A bare number resolves against the logged-in user, who need not own the sandbox project.
    return `gh project needs --owner ${scope.projectOwner}`;
  }
  if (sub !== undefined && PROJECT_READ_OR_CREATE.has(sub)) {
    return numbers.length === 0 ? undefined : `gh project ${sub} takes no number`;
  }
  if (sub === undefined || !PROJECT_OF_NUMBER.has(sub)) return `gh project ${sub ?? ''} is not a command the suite uses`;
  const [number, ...more] = numbers;
  if (number === undefined || more.length > 0 || !/^\d+$/.test(number)) return `gh project ${sub} needs one project number`;
  return scope.projects.has(Number(number)) ? undefined : `project #${number} is not one the suite owns`;
}

function checkApi(
  scope: GuardScope,
  flags: readonly Flag[],
  positionals: readonly string[],
  input: string | undefined,
): string | undefined {
  const sandbox = lower(scope.repo);
  const owner = lower(scope.projectOwner);
  if (positionals.length !== 1) return 'cannot tell which endpoint gh api calls';
  const endpoint = (positionals[0] as string).replace(/^\/+/, '');
  if (/(?:^|\/)\.\.(?:\/|\?|$)|%2e|\\/i.test(endpoint)) return `the endpoint ${endpoint} is not a plain path`;
  const path = lower(endpoint);

  const repoRoot = new RegExp(`^repos/${escapeRegExp(sandbox)}(?:[/?]|$)`);
  if (repoRoot.test(path)) {
    const [route = ''] = path.split('?');
    // The repository itself is never changed, moved or deleted; only what is inside it is written.
    if (route === `repos/${sandbox}` && !isRead(flags)) return `${methodOf(flags)} ${endpoint} would change the repository itself`;
    if (/\/(?:transfer|archive)$/.test(route)) return `the endpoint ${endpoint} moves or archives the repository`;
    return undefined;
  }

  if (path === 'graphql') return checkGraphql(scope, input);

  const project = new RegExp(`^(?:users|orgs)/${escapeRegExp(owner)}/projectsv2/(\\d+)(?:[/?]|$)`).exec(path);
  if (project) {
    if (!scope.projects.has(Number(project[1]))) return `project #${project[1]} is not one the suite owns`;
    return methodOf(flags) === 'DELETE' ? 'deleting a project is not allowed' : undefined;
  }

  // Who is logged in, and what kind of account the project owner is: reads only.
  if ((path === 'user' || new RegExp(`^users/${escapeRegExp(owner)}(?:[/?]|$)`).test(path)) && isRead(flags)) return undefined;
  return `the endpoint ${endpoint} is not in ${scope.repo} or on the project owner's projects`;
}

/**
 * A GraphQL call must carry its request on stdin, name no repository, owner or project other than
 * the suite's in its variables, and must not delete anything. Calls by node id (`id`, `ids`,
 * `input`) cannot be read; those ids come from queries that named the owner and number.
 */
function checkGraphql(scope: GuardScope, input: string | undefined): string | undefined {
  const request = graphqlRequest(input);
  if (request === undefined) return 'a GraphQL call must send {"query", "variables"} on stdin (--input -)';
  if (DESTRUCTIVE_MUTATION.test(request.query)) return 'a GraphQL call that deletes, archives or transfers is not allowed';
  const { variables } = request;
  const sandbox = lower(scope.repo);
  const owner = lower(scope.projectOwner);
  const text = (name: string): string | undefined => (typeof variables[name] === 'string' ? (variables[name] as string) : undefined);

  if ('repoOwner' in variables || 'repoName' in variables) {
    const named = `${text('repoOwner') ?? ''}/${text('repoName') ?? ''}`;
    if (lower(named) !== sandbox) return `the GraphQL variables name repository ${named}, not ${scope.repo}`;
  }
  for (const name of ['owner', 'projectOwner']) {
    if (name in variables && lower(text(name)) !== owner) return `the GraphQL variable ${name} is not ${scope.projectOwner}`;
  }
  for (const name of ['number', 'projectNumber']) {
    if (name in variables) {
      const value = variables[name];
      if (typeof value !== 'number' || !scope.projects.has(value)) return `project #${String(value)} is not one the suite owns`;
    }
  }
  return undefined;
}

/**
 * A runner that fails closed: it refuses any `gh` call that is not on the sandbox repository
 * (`--repo`, `repos/<sandbox>/...`, a URL in it), on a project the suite owns (`--owner`, a project
 * number it owns) or on the allowlist (`gh api user`, `users/<owner>`, GraphQL for the suite's
 * owner and projects), so a code path that strays fails the suite instead of writing elsewhere.
 * The runner has no environment to set, so the ambient `GH_REPO` is not overridden.
 */
export function sandboxRunner(scope: GuardScope, inner: GhRunner = defaultGhRunner): GhRunner {
  return (args, input) => {
    const refusal = checkGhCall(scope, args, input);
    if (refusal === undefined) return inner(args, input);
    return Promise.reject(new Error(`e2e guard: refused \`gh ${args.slice(0, 3).join(' ')}\`: ${refusal}`));
  };
}
