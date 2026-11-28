/**
 * What `sdlc init`, `upgrade` and `uninstall` share: the context they run in, the step report
 * (printed as it goes, or as one JSON document), and the helpers that plan, apply and report the
 * managed files.
 */

import type { Config } from '../config/schema.js';
import type { GhRunner } from '../github/gh.js';
import {
  OBSOLETE_MODIFIED,
  applyPlan,
  formatPlan,
  planApply,
  type ApplyPlan,
  type ApplyResult,
  type Notice,
  type PlanError,
} from '../install/apply.js';
import { MANIFEST_PATH, entryDiskHash, readManifest, type ManifestEntry } from '../install/manifest.js';
import { HOOKS_PATH, findLegacyHooks, setHooksPath, type GitRunner, type HookProbe } from '../install/provision.js';
import type { RepoFs } from '../install/repoFs.js';
import { renderAll } from '../render/plan.js';
import { packageVersion } from '../version.js';
import { errorAsJson, formatCliError } from './errors.js';

/** What `init`, `upgrade` and `uninstall` need. Only `init` uses `gh`; only `uninstall` can do without the config. */
export interface InstallContext {
  /** The repository the files are written to. */
  fs: RepoFs;
  git: GitRunner;
  gh: GhRunner;
  /** Looks at the repository's own hook files (`.git/hooks/<name>`); defaults to the real file system. */
  hookProbe?: HookProbe;
  /** Reads and validates the config; throws when it cannot. Called by `init` and `upgrade`, as their first step. */
  loadConfig: () => Config;
  /** Where the report goes (stdout). */
  out: (text: string) => void;
  /** Where an error that stopped the command before any step went goes (stderr). */
  err: (text: string) => void;
}

export type InstallContextFactory = () => InstallContext | Promise<InstallContext>;

/** `skipped`: nothing to do or not done on purpose (`--skip-github`, a dry run that would have changed something). */
export type StepStatus = 'ok' | 'skipped' | 'failed';

export interface InstallStep {
  name: string;
  status: StepStatus;
  details: string[];
}

export interface WriteSummary {
  path: string;
  action: 'create' | 'update' | 'remove';
}

/** The report of the three commands, and what `--json` prints. */
export interface InstallReport {
  steps: InstallStep[];
  plan: { writes: WriteSummary[]; notices: Notice[]; errors: PlanError[] };
}

export const lines = (text: string): string[] => text.split('\n');
const byPath = (a: WriteSummary, b: WriteSummary): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Collects the steps. A person sees each one as soon as it is done; `--json` prints one document at the end. */
export class Reporter {
  readonly steps: InstallStep[] = [];
  plan: InstallReport['plan'] = { writes: [], notices: [], errors: [] };

  constructor(
    private readonly ctx: InstallContext,
    private readonly json: boolean,
  ) {}

  step(name: string, status: StepStatus, details: string[] = []): void {
    this.steps.push({ name, status, details });
    if (!this.json) this.ctx.out([`[${status}] ${name}`, ...details.map(line => `  ${line}`)].join('\n'));
  }

  /** Runs one step: `run` adds its details and returns its status; a throw is a failed step. */
  async guarded(name: string, run: (details: string[]) => Promise<StepStatus> | StepStatus): Promise<void> {
    const details: string[] = [];
    try {
      this.step(name, await run(details), details);
    } catch (error) {
      this.step(name, 'failed', [...details, ...lines(formatCliError(error))]);
    }
  }

  /** Prints the JSON document, and makes the exit code 1 when a step failed. */
  finish(): InstallReport {
    const report: InstallReport = { steps: this.steps, plan: this.plan };
    if (this.steps.some(step => step.status === 'failed')) process.exitCode = 1;
    if (this.json) this.ctx.out(JSON.stringify(report, null, 2));
    return report;
  }
}

/** Step 1: the config must load, with its MCP server ids; nothing else runs without it. */
export function validateConfig(ctx: InstallContext, report: Reporter): Config | undefined {
  try {
    const cfg = ctx.loadConfig();
    report.step('config', 'ok', [`${cfg.github.repo}: harnesses ${cfg.harnesses.join(', ')}, mode ${cfg.mode}`]);
    return cfg;
  } catch (error) {
    report.step('config', 'failed', lines(formatCliError(error)));
    return undefined;
  }
}

/**
 * What removing the plan's obsolete entries does right now: the entries still unmodified on disk
 * (they go) and a notice for each modified one (it is kept, as `applyPlan` does). An entry that is
 * already gone from disk is neither. Entries that cannot be read are left in `removable`: applying
 * the plan reports the error.
 */
function previewObsolete(plan: ApplyPlan, fs: RepoFs): { removable: ManifestEntry[]; kept: Notice[] } {
  const removable: ManifestEntry[] = [];
  const kept: Notice[] = [];
  for (const entry of plan.obsolete) {
    let current: string | undefined;
    try {
      current = entryDiskHash(entry, fs.read(entry.path));
    } catch {
      current = entry.hash;
    }
    if (current === undefined) continue;
    if (current === entry.hash) removable.push(entry);
    else kept.push({ path: entry.path, message: entry.key === undefined ? OBSOLETE_MODIFIED : `${entry.key}: ${OBSOLETE_MODIFIED}` });
  }
  return { removable, kept };
}

/** The writes of a plan as a person sees them; the removable obsolete files and keys are included when asked. */
function plannedWrites(plan: ApplyPlan, obsolete: ManifestEntry[]): WriteSummary[] {
  const writes: WriteSummary[] = plan.writes.filter(w => w.path !== MANIFEST_PATH).map(w => ({ path: w.path, action: w.action }));
  for (const entry of obsolete) {
    const action = entry.kind === 'file' ? 'remove' : 'update';
    if (!writes.some(w => w.path === entry.path && w.action === action)) writes.push({ path: entry.path, action });
  }
  return writes.sort(byPath);
}

/** What an applied plan did: the files written (created or changed) and removed, without the manifest. */
function appliedWrites(plan: ApplyPlan, result: ApplyResult): WriteSummary[] {
  const planned = new Map(plan.writes.map(write => [write.path, write.action]));
  const writes: WriteSummary[] = [
    ...result.written.map((path): WriteSummary => ({ path, action: planned.get(path) === 'create' ? 'create' : 'update' })),
    ...result.removed.map((path): WriteSummary => ({ path, action: 'remove' })),
  ];
  return writes.filter((w, i) => writes.findIndex(other => other.path === w.path) === i).sort(byPath);
}

/**
 * Prints a plan, applies it unless `dryRun`, and files the outcome with the report; returns the
 * step's status: `failed` for any error, `skipped` for a dry run that would have written something,
 * else `ok`. `leading` lines go first in the step's details. With `removeObsolete`, entries the kit
 * no longer generates are listed as removals while they are unmodified; a modified one is listed as
 * kept, in a dry run and a real run alike. The same `removeObsolete` goes to `applyPlan` and to the
 * text.
 */
export function reportPlan(
  report: Reporter,
  name: string,
  plan: ApplyPlan,
  fs: RepoFs,
  options: { dryRun: boolean; removeObsolete: boolean; leading?: string[] },
): StepStatus {
  const { dryRun, removeObsolete } = options;
  const preview = removeObsolete ? previewObsolete(plan, fs) : undefined;
  // Applying adds the notices and errors found on the way (obsolete entries, failed writes) to the plan's own.
  const result = dryRun ? undefined : applyPlan(plan, fs, { removeObsolete });
  const notices = result?.notices ?? [...plan.notices, ...(preview?.kept ?? [])];
  const errors = result?.errors ?? plan.errors;
  const removable = preview?.removable ?? [];
  const writes = result ? appliedWrites(plan, result) : plannedWrites(plan, removable);
  report.plan = { writes, notices, errors };
  const status: StepStatus = errors.length > 0 ? 'failed' : dryRun && writes.length > 0 ? 'skipped' : 'ok';
  const shown: ApplyPlan = { ...plan, notices, errors, obsolete: preview ? removable : plan.obsolete };
  report.step(name, status, [...(options.leading ?? []), ...lines(formatPlan(shown, dryRun, { removeObsolete }))]);
  return status;
}

/**
 * Step 2 of `init` and `upgrade`: render everything for `cfg`, plan it against the manifest, print
 * the plan and apply it unless `dryRun`. Returns what the owner still has to do and the step's status. A failure to render
 * or to read the manifest is a failed step, not an exception.
 */
export function installFiles(
  ctx: InstallContext,
  cfg: Config,
  report: Reporter,
  options: { dryRun: boolean; overwriteModified: boolean; removeObsolete: boolean; showKit: boolean },
): { userCommands: string[]; notes: string[]; status: StepStatus } {
  try {
    const manifest = readManifest(ctx.fs);
    const { changes, userCommands, notes } = renderAll(cfg, ctx.fs);
    const plan = planApply(changes, ctx.fs, manifest, { overwriteModified: options.overwriteModified });
    const status = reportPlan(report, 'files', plan, ctx.fs, {
      dryRun: options.dryRun,
      removeObsolete: options.removeObsolete,
      ...(options.showKit ? { leading: [`kit ${manifest?.kit ?? 'none'} → ${packageVersion()}`] } : {}),
    });
    return { userCommands, notes, status };
  } catch (error) {
    report.step('files', 'failed', lines(formatCliError(error)));
    return { userCommands: [], notes: [], status: 'failed' };
  }
}

/**
 * The details that say which of the repository's own hooks (`.git/hooks/<name>`) the kit's scripts
 * run after the sdlc step, and which they skip because they are not executable. A repository whose
 * hooks directory cannot be found has none to report.
 */
async function legacyHookDetails(ctx: InstallContext, dryRun: boolean): Promise<string[]> {
  let found: Awaited<ReturnType<typeof findLegacyHooks>>;
  try {
    found = await findLegacyHooks(ctx.git, ctx.fs.root, ctx.hookProbe);
  } catch {
    return [];
  }
  const details: string[] = [];
  if (found.chained.length > 0) {
    details.push(
      `${dryRun ? 'dry run: the sdlc hooks would chain' : 'the sdlc hooks chain'} your existing hooks in ${found.dir}: ` +
        `${found.chained.join(', ')} (each runs after the sdlc step, with the same arguments, and its exit code counts)`,
    );
  }
  if (found.notExecutable.length > 0) {
    details.push(
      `not executable, so not run: ${found.notExecutable.map(name => `${found.dir}/${name}`).join(', ')} ` +
        '(chmod +x to run it after the sdlc step)',
    );
  }
  return details;
}

/**
 * Step 3: point `core.hooksPath` at the kit's hooks, unless the owner has set it to something else,
 * and say which existing hooks the kit's scripts chain. Not when the files step failed: the hook
 * scripts may be missing, and git would then run no hook at all.
 */
export function installHooksPath(ctx: InstallContext, report: Reporter, dryRun: boolean, filesStatus: StepStatus): Promise<void> {
  return report.guarded('git hooks path', async details => {
    if (filesStatus === 'failed') {
      details.push(`core.hooksPath not changed: writing the files failed, so the hooks in ${HOOKS_PATH} may be missing; fix the errors above and run again`);
      return 'skipped';
    }
    const notices: string[] = [];
    const result = await setHooksPath(ctx.git, { dryRun, notice: message => notices.push(message) });
    details.push(...notices);
    switch (result) {
      case 'set':
        details.push(dryRun ? `dry run: would set core.hooksPath to ${HOOKS_PATH}` : `core.hooksPath set to ${HOOKS_PATH}`);
        details.push(...(await legacyHookDetails(ctx, dryRun)));
        return dryRun ? 'skipped' : 'ok';
      case 'already':
        details.push(`core.hooksPath is already ${HOOKS_PATH}`);
        details.push(...(await legacyHookDetails(ctx, false)));
        return 'ok';
      case 'conflict':
        return 'skipped';
    }
  });
}

/**
 * Runs one install command: builds the context, runs `run`, and reports a failure that stopped it
 * before any step (no git repository, ...) the way the other commands do: on stderr, or as
 * `{"error": ...}` with `--json`, and exit code 1. It never rejects.
 */
export async function runInstallAction(
  makeContext: InstallContextFactory,
  options: { json?: boolean },
  run: (ctx: InstallContext) => Promise<unknown>,
): Promise<void> {
  let ctx: InstallContext | undefined;
  try {
    ctx = await makeContext();
    await run(ctx);
  } catch (error) {
    process.exitCode = 1;
    if (options.json) (ctx?.out ?? (text => void process.stdout.write(`${text}\n`)))(JSON.stringify(errorAsJson(error), null, 2));
    else (ctx?.err ?? (text => void process.stderr.write(`${text}\n`)))(formatCliError(error));
  }
}
