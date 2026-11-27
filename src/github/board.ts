import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PHASES, typeRegistry, type Config } from '../config/schema.js';
import {
  displayPhase,
  STATUS_LABELS,
  WAITING_ON_LABELS,
  type BoardFields,
} from '../core/projection.js';
import { GhError, ghJson, graphql, type GhRunner } from './gh.js';

/**
 * Whether `updateProjectV2Field` keeps the values already set on items when options are added.
 * Spike result (docs/notes/projects-option-update.md, 2026-11-27): it does, but only when every
 * existing option is resent with its `id`; without ids all option ids are regenerated and item
 * values are cleared. The implementation therefore always sends ids.
 */
export const OPTION_UPDATE_PRESERVES_VALUES = true;

/** A project this run created. */
export interface CreatedProject {
  number: number;
  id: string;
  url?: string;
}

/** A board that cannot be provisioned or used as configured. */
export class BoardError extends Error {
  /** Set when this run had already created the project before failing. */
  readonly createdProject?: CreatedProject;

  constructor(message: string, options?: { cause?: unknown; createdProject?: CreatedProject }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BoardError';
    this.createdProject = options?.createdProject;
  }
}

export interface ExistingOption {
  id: string;
  name: string;
  color?: string;
  description?: string;
}

export interface ExistingField {
  id: string;
  name: string;
  dataType: 'SINGLE_SELECT' | 'TEXT' | 'DATE' | string;
  options?: ExistingOption[];
}

export interface DesiredField {
  name: string;
  dataType: 'SINGLE_SELECT' | 'TEXT' | 'DATE';
  options?: string[];
}

export interface BoardPlan {
  createFields: DesiredField[];
  addOptions: { fieldId: string; fieldName: string; missing: string[] }[];
  typeConflicts: string[];
}

export type FieldKey = keyof BoardFields | 'start' | 'targetDate';

/** Board field names, in creation order. `Type` is a reserved built-in name, hence `Task type`. */
const FIELD_NAMES: Record<FieldKey, string> = {
  status: 'Status',
  phase: 'Phase',
  type: 'Task type',
  waitingOn: 'Waiting on',
  summary: 'Summary',
  currentStep: 'Current step',
  nextStep: 'Next step',
  pendingTargets: 'Pending targets',
  agent: 'Agent',
  lastUpdate: 'Last update',
  start: 'Start',
  targetDate: 'Target date',
};
const FIELD_KEYS = Object.keys(FIELD_NAMES) as FieldKey[];

/** Option colors, cycled for options this tool creates. */
const COLORS = ['BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'RED', 'PINK', 'PURPLE', 'GRAY'];

const normalize = (name: string): string => name.trim().toLowerCase();

function unique(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter(name => {
    const key = normalize(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function desiredFieldEntries(cfg: Config): { key: FieldKey; field: DesiredField }[] {
  const types = [...typeRegistry(cfg).values()];
  const usedPhases = new Set(types.flatMap(t => t.phases));
  const options: Partial<Record<FieldKey, string[]>> = {
    status: Object.values(STATUS_LABELS),
    phase: PHASES.filter(p => usedPhases.has(p)).map(displayPhase),
    type: unique(types.map(t => t.label)),
    waitingOn: Object.values(WAITING_ON_LABELS),
  };
  const dataType = (key: FieldKey): DesiredField['dataType'] =>
    options[key] ? 'SINGLE_SELECT' : key === 'start' || key === 'targetDate' ? 'DATE' : 'TEXT';
  return FIELD_KEYS.map(key => {
    const keyOptions = options[key];
    return {
      key,
      field: {
        name: FIELD_NAMES[key],
        dataType: dataType(key),
        ...(keyOptions && { options: keyOptions }),
      },
    };
  });
}

/** The fields the board needs; Phase and Task type options follow the enabled task types. */
export function desiredFields(cfg: Config): DesiredField[] {
  return desiredFieldEntries(cfg).map(e => e.field);
}

/**
 * Compares the board with the desired fields. Names match case-insensitively (surrounding
 * whitespace ignored); fields that are not desired (built-ins such as Title, or the issue type
 * field named `Type`) are never touched, and existing extra options are left alone.
 */
export function planBoardChanges(existing: ExistingField[], desired: DesiredField[]): BoardPlan {
  const byName = new Map<string, ExistingField>();
  for (const field of existing) {
    if (!byName.has(normalize(field.name))) byName.set(normalize(field.name), field);
  }
  const plan: BoardPlan = { createFields: [], addOptions: [], typeConflicts: [] };
  for (const want of desired) {
    const have = byName.get(normalize(want.name));
    if (!have) {
      plan.createFields.push(want);
    } else if (have.dataType !== want.dataType) {
      plan.typeConflicts.push(want.name);
    } else if (want.options) {
      const present = new Set((have.options ?? []).map(o => normalize(o.name)));
      const missing = want.options.filter(name => !present.has(normalize(name)));
      if (missing.length > 0) {
        plan.addOptions.push({ fieldId: have.id, fieldName: have.name, missing });
      }
    }
  }
  return plan;
}

// --- GitHub access ---------------------------------------------------------------------------

interface ProjectSnapshot {
  id: string;
  number: number;
  fields: ExistingField[];
  viewNames: string[];
}

interface RawProject {
  id: string;
  number: number;
  fields: { nodes: Partial<ExistingField>[] };
  views: { nodes: { name?: string }[] };
}

const PROJECT_SELECTION = `
  id
  number
  fields(first: 100) {
    nodes {
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField { options { id name color description } }
    }
  }
  views(first: 100) { nodes { name } }`;

function snapshotOf(raw: RawProject): ProjectSnapshot {
  const fields = raw.fields.nodes.filter(
    (f): f is ExistingField =>
      typeof f.id === 'string' && typeof f.name === 'string' && typeof f.dataType === 'string',
  );
  const viewNames = raw.views.nodes.flatMap(v => (typeof v.name === 'string' ? [v.name] : []));
  return { id: raw.id, number: raw.number, fields, viewNames };
}

async function fetchProject(run: GhRunner, cfg: Config): Promise<ProjectSnapshot> {
  const { owner, ownerType, number } = cfg.github.project;
  const root = ownerType === 'org' ? 'organization' : 'user';
  const data = await graphql<{ owner: { projectV2: RawProject | null } | null }>(
    run,
    `query($owner: String!, $number: Int!) {
      owner: ${root}(login: $owner) { projectV2(number: $number) { ${PROJECT_SELECTION} } }
    }`,
    { owner, number },
  );
  const raw = data.owner?.projectV2;
  if (!raw) throw new BoardError(`Project #${number} not found for ${ownerType} "${owner}"`);
  return snapshotOf(raw);
}

async function fetchProjectById(run: GhRunner, id: string): Promise<ProjectSnapshot> {
  const data = await graphql<{ node: RawProject | null }>(
    run,
    `query($id: ID!) { node(id: $id) { ... on ProjectV2 { ${PROJECT_SELECTION} } } }`,
    { id },
  );
  if (!data.node) throw new BoardError(`Project ${id} not found right after creating it`);
  return snapshotOf(data.node);
}

/** Creates the project, linked to the configured repository. */
async function createProject(
  run: GhRunner,
  cfg: Config,
): Promise<{ project: ProjectSnapshot; url?: string }> {
  const { owner, ownerType } = cfg.github.project;
  const [repoOwner, repoName] = cfg.github.repo.split('/') as [string, string];
  const root = ownerType === 'org' ? 'organization' : 'user';
  const ids = await graphql<{ owner: { id: string } | null; repo: { id: string } | null }>(
    run,
    `query($owner: String!, $repoOwner: String!, $repoName: String!) {
      owner: ${root}(login: $owner) { id }
      repo: repository(owner: $repoOwner, name: $repoName) { id }
    }`,
    { owner, repoOwner, repoName },
  );
  if (!ids.owner) throw new BoardError(`Project owner ${ownerType} "${owner}" not found`);
  if (!ids.repo) throw new BoardError(`Repository ${cfg.github.repo} not found`);
  const created = await graphql<{
    createProjectV2: { projectV2: { id: string; number: number; url?: string } };
  }>(
    run,
    `mutation($input: CreateProjectV2Input!) {
      createProjectV2(input: $input) { projectV2 { id number url } }
    }`,
    { input: { ownerId: ids.owner.id, repositoryId: ids.repo.id, title: `${repoName} SDLC tasks` } },
  );
  const { id, url } = created.createProjectV2.projectV2;
  return { project: await fetchProjectById(run, id), url };
}

/** Ids of the given fields that have a value on at least one item of the project. */
async function populatedFieldIds(
  run: GhRunner,
  projectId: string,
  fieldIds: string[],
): Promise<Set<string>> {
  interface Page {
    node: {
      items: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { fieldValues: { nodes: { field?: { id?: string } }[] } }[];
      };
    };
  }
  const wanted = new Set(fieldIds);
  const populated = new Set<string>();
  let after: string | null = null;
  do {
    const page: Page = await graphql<Page>(
      run,
      `query($id: ID!, $after: String) {
        node(id: $id) { ... on ProjectV2 {
          items(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { fieldValues(first: 50) { nodes {
              ... on ProjectV2ItemFieldSingleSelectValue { field { ... on ProjectV2FieldCommon { id } } }
            } } }
          }
        } }
      }`,
      { id: projectId, after },
    );
    for (const item of page.node.items.nodes) {
      for (const value of item.fieldValues.nodes) {
        const id = value.field?.id;
        if (id !== undefined && wanted.has(id)) populated.add(id);
      }
    }
    after = page.node.items.pageInfo.hasNextPage ? page.node.items.pageInfo.endCursor : null;
  } while (after !== null && populated.size < wanted.size);
  return populated;
}

async function createField(run: GhRunner, projectId: string, field: DesiredField): Promise<void> {
  await graphql(
    run,
    `mutation($input: CreateProjectV2FieldInput!) {
      createProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2FieldCommon { id name } } }
    }`,
    {
      input: {
        projectId,
        dataType: field.dataType,
        name: field.name,
        ...(field.options && {
          singleSelectOptions: field.options.map((name, i) => ({
            name,
            color: COLORS[i % COLORS.length],
            description: '',
          })),
        }),
      },
    },
  );
}

/** Resends every existing option with its id (so item values survive) and appends the new ones. */
async function appendOptions(
  run: GhRunner,
  existing: ExistingField,
  missing: string[],
): Promise<void> {
  const current = existing.options ?? [];
  const kept = current.map(o => ({
    id: o.id,
    name: o.name,
    color: o.color ?? 'GRAY',
    description: o.description ?? '',
  }));
  const added = missing.map((name, i) => ({
    name,
    color: COLORS[(current.length + i) % COLORS.length],
    description: '',
  }));
  const data = await graphql<{
    updateProjectV2Field: { projectV2Field: { options?: { id: string }[] } | null };
  }>(
    run,
    `mutation($input: UpdateProjectV2FieldInput!) {
      updateProjectV2Field(input: $input) {
        projectV2Field { ... on ProjectV2SingleSelectField { id options { id name } } }
      }
    }`,
    { input: { fieldId: existing.id, singleSelectOptions: [...kept, ...added] } },
  );
  const returned = new Set((data.updateProjectV2Field.projectV2Field?.options ?? []).map(o => o.id));
  if (kept.some(o => !returned.has(o.id))) {
    throw new BoardError(
      `Updating the options of "${existing.name}" changed existing option ids; ` +
        'values already set on items may have been cleared',
    );
  }
}

// --- Views -----------------------------------------------------------------------------------

interface ViewSpec {
  name: string;
  layout: 'table' | 'board';
  filter?: string;
  /** Table grouping. */
  groupBy?: FieldKey;
  /** Board columns. */
  columnsBy?: FieldKey;
  sortBy?: { field: FieldKey; direction: 'asc' | 'desc' };
}

const VIEWS: readonly ViewSpec[] = [
  { name: 'Board', layout: 'board', columnsBy: 'status' },
  {
    name: 'In flight',
    layout: 'table',
    filter: '-status:Done',
    sortBy: { field: 'lastUpdate', direction: 'desc' },
  },
  {
    name: 'Awaiting deployment',
    layout: 'table',
    filter: 'status:"Awaiting deployment"',
    groupBy: 'pendingTargets',
  },
  { name: 'Waiting on owner', layout: 'table', filter: 'waiting-on:Owner' },
];

function describeView(view: ViewSpec): string {
  const parts = [`${view.layout} layout`];
  if (view.columnsBy) parts.push(`columns by ${FIELD_NAMES[view.columnsBy]}`);
  if (view.filter) parts.push(`filter "${view.filter}"`);
  if (view.groupBy) parts.push(`grouped by ${FIELD_NAMES[view.groupBy]}`);
  if (view.sortBy) {
    const direction = view.sortBy.direction === 'desc' ? 'descending' : 'ascending';
    parts.push(`sorted by ${FIELD_NAMES[view.sortBy.field]} (${direction})`);
  }
  return parts.join(', ');
}

const manualView = (view: ViewSpec, reason: string): string =>
  `Create the "${view.name}" view manually (${describeView(view)}); the API could not: ${reason}`;

function reasonOf(error: GhError): string {
  const text = error.stderr.trim() || error.message;
  return text.split('\n')[0] ?? text;
}

/** HTTP 404/410: the endpoint does not exist for this owner or plan; anything else is a failure. */
const isUnsupported = (error: GhError): boolean => /\bHTTP (404|410)\b/.test(error.stderr);

export interface ViewFailure {
  name: string;
  error: string;
}

interface ViewOutcome {
  viewsCreated: string[];
  viewsManual: string[];
  viewsFailed: ViewFailure[];
}

/** REST base path of the project; views and field ids for grouping/sorting live there. */
function restBase(cfg: Config, number: number): string {
  const { owner, ownerType } = cfg.github.project;
  return `/${ownerType === 'org' ? 'orgs' : 'users'}/${owner}/projectsV2/${number}`;
}

function missingViews(project: ProjectSnapshot): ViewSpec[] {
  const existing = new Set(project.viewNames.map(normalize));
  return VIEWS.filter(view => !existing.has(normalize(view.name)));
}

/**
 * Creates the given views through the REST Projects API. An endpoint that answers 404/410 is
 * unsupported and yields manual steps; any other failure, or a needed field missing from the
 * REST field list, is a failure.
 */
async function createViews(
  run: GhRunner,
  cfg: Config,
  project: ProjectSnapshot,
  views: ViewSpec[],
): Promise<ViewOutcome> {
  const base = restBase(cfg, project.number);
  const outcome: ViewOutcome = { viewsCreated: [], viewsManual: [], viewsFailed: [] };

  let fieldIds: Map<string, number>;
  try {
    const fields =
      (await ghJson<{ id: number; name: string }[] | undefined>(run, [
        'api',
        `${base}/fields?per_page=100`,
      ])) ?? [];
    fieldIds = new Map(fields.map(f => [normalize(f.name), f.id]));
  } catch (error) {
    if (!(error instanceof GhError)) throw error;
    if (isUnsupported(error)) {
      outcome.viewsManual.push(...views.map(v => manualView(v, reasonOf(error))));
    } else {
      outcome.viewsFailed.push(...views.map(v => ({ name: v.name, error: reasonOf(error) })));
    }
    return outcome;
  }

  const idOf = (key: FieldKey): number => fieldIds.get(normalize(FIELD_NAMES[key])) as number;

  for (const view of views) {
    const needed = [view.columnsBy, view.groupBy, view.sortBy?.field].filter(
      (key): key is FieldKey => key !== undefined,
    );
    const absent = needed.find(key => !fieldIds.has(normalize(FIELD_NAMES[key])));
    if (absent !== undefined) {
      outcome.viewsFailed.push({
        name: view.name,
        error: `field "${FIELD_NAMES[absent]}" is missing from the project's field list`,
      });
      continue;
    }
    const body = {
      name: view.name,
      layout: view.layout,
      ...(view.filter && { filter: view.filter }),
      ...(view.columnsBy && { vertical_group_by: [idOf(view.columnsBy)] }),
      ...(view.groupBy && { group_by: [idOf(view.groupBy)] }),
      ...(view.sortBy && { sort_by: [[idOf(view.sortBy.field), view.sortBy.direction]] }),
    };
    try {
      await ghJson(run, ['api', '-X', 'POST', `${base}/views`, '--input', '-'], body);
      outcome.viewsCreated.push(view.name);
    } catch (error) {
      if (!(error instanceof GhError)) throw error;
      if (isUnsupported(error)) outcome.viewsManual.push(manualView(view, reasonOf(error)));
      else outcome.viewsFailed.push({ name: view.name, error: reasonOf(error) });
    }
  }
  return outcome;
}

// --- ensureBoard -----------------------------------------------------------------------------

export interface EnsureBoardOptions {
  /** Only query; report what would change. */
  dryRun: boolean;
  /** Overrides {@link OPTION_UPDATE_PRESERVES_VALUES}; for tests. */
  optionUpdatesPreserveValues?: boolean;
  /** Called as soon as this run has created the project, before anything else is written to it. */
  onProjectCreated?: (project: CreatedProject) => void;
}

export interface EnsureBoardResult {
  /** 0 when a dry run found no configured project. */
  projectNumber: number;
  /** Empty when a dry run found no configured project. */
  projectId: string;
  /** True when this run created the project. */
  created: boolean;
  /** True when a dry run found no configured project and a real run would create one. */
  wouldCreateProject: boolean;
  plan: BoardPlan;
  /** Views that did not exist yet when the run started. */
  viewsPlanned: string[];
  viewsCreated: string[];
  /** Manual instructions for views the API does not support (HTTP 404/410). */
  viewsManual: string[];
  /** Views whose creation failed; a failed GitHub write, so the command exits non-zero. */
  viewsFailed: ViewFailure[];
}

/** The fields a brand-new project starts with that matter here. */
const NEW_PROJECT_FIELDS: ExistingField[] = [
  {
    id: '',
    name: 'Status',
    dataType: 'SINGLE_SELECT',
    options: ['Todo', 'In Progress', 'Done'].map(name => ({ id: '', name })),
  },
];

/**
 * Creates the project when none is configured, then adds the missing fields, the missing options
 * of existing single-selects and the missing views. Add-only: nothing is renamed, deleted or
 * reordered, and only the configured (or just created) project is written to. Throws BoardError
 * before any write (dry run included) when a field exists with another data type, or when option
 * updates are unsafe and the field already has values. A view the API refuses (other than with
 * HTTP 404/410, which means unsupported) is reported in `viewsFailed`; the caller must exit
 * non-zero. A failure after this run created the project throws a BoardError that carries the new
 * project's number and URL (`createdProject`) and tells the user to configure it before retrying.
 */
export async function ensureBoard(
  run: GhRunner,
  cfg: Config,
  opts: EnsureBoardOptions,
): Promise<EnsureBoardResult> {
  const preservesValues = opts.optionUpdatesPreserveValues ?? OPTION_UPDATE_PRESERVES_VALUES;
  const desired = desiredFields(cfg);

  let project: ProjectSnapshot;
  let createdProject: CreatedProject | undefined;
  let wouldCreateProject = false;
  if (cfg.github.project.number !== undefined) {
    project = await fetchProject(run, cfg);
  } else if (opts.dryRun) {
    wouldCreateProject = true;
    project = { id: '', number: 0, fields: NEW_PROJECT_FIELDS, viewNames: [] };
  } else {
    const made = await createProject(run, cfg);
    project = made.project;
    createdProject = { number: project.number, id: project.id, url: made.url };
    opts.onProjectCreated?.(createdProject);
  }
  const created = createdProject !== undefined;

  const provision = async (): Promise<EnsureBoardResult> => {
    const plan = planBoardChanges(project.fields, desired);
    if (plan.typeConflicts.length > 0) {
      throw new BoardError(
        `Board fields exist with another data type: ${plan.typeConflicts.join(', ')}. ` +
          'Rename or delete them on the board, or point github.project.number at another board.',
      );
    }

    if (!preservesValues && plan.addOptions.length > 0 && !created && !wouldCreateProject) {
      const populated = await populatedFieldIds(
        run,
        project.id,
        plan.addOptions.map(a => a.fieldId),
      );
      const names = plan.addOptions.filter(a => populated.has(a.fieldId)).map(a => a.fieldName);
      if (names.length > 0) {
        throw new BoardError(
          `Adding options to ${names.join(', ')} would clear values already set on items. ` +
            'Refusing to change a populated field; create a new board and point github.project.number at it.',
        );
      }
    }

    const views = missingViews(project);
    const base = {
      projectNumber: project.number,
      projectId: project.id,
      created,
      wouldCreateProject,
      plan,
      viewsPlanned: views.map(v => v.name),
    };
    const noViews: ViewOutcome = { viewsCreated: [], viewsManual: [], viewsFailed: [] };
    if (opts.dryRun) return { ...base, ...noViews };

    for (const field of plan.createFields) await createField(run, project.id, field);
    for (const change of plan.addOptions) {
      const field = project.fields.find(f => f.id === change.fieldId) as ExistingField;
      await appendOptions(run, field, change.missing);
    }
    return { ...base, ...(views.length > 0 ? await createViews(run, cfg, project, views) : noViews) };
  };

  if (!createdProject) return provision();
  try {
    return await provision();
  } catch (error) {
    // The project exists now; without its number in the config a rerun would create another one.
    const where = `#${createdProject.number}${createdProject.url ? ` (${createdProject.url})` : ''}`;
    throw new BoardError(
      `Project ${where} was created but provisioning failed: ${(error as Error).message}. ` +
        `Set github.project.number: ${createdProject.number} in sdlc.config.yaml before running ` +
        '"sdlc board ensure" again, or a second project will be created.',
      { cause: error, createdProject },
    );
  }
}

// --- resolveFieldIds -------------------------------------------------------------------------

export type FieldMap = Record<FieldKey, { id: string; options?: Record<string, string> }>;

interface CacheEntry {
  /** Which configured project the entry belongs to, so a cache hit needs no API call. */
  ref: string;
  fields: FieldMap;
}

/** The nearest ancestor of `cwd` holding a `.git` entry (directory or worktree file), else `cwd`. */
export function findRepoRoot(cwd: string = process.cwd()): string {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

function readCache(path: string): Record<string, CacheEntry> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, CacheEntry>) : {};
  } catch {
    return {};
  }
}

/** Whether a cached map still has every field and option the config needs. */
function coversDesired(map: FieldMap | undefined, entries: ReturnType<typeof desiredFieldEntries>): boolean {
  if (typeof map !== 'object' || map === null) return false;
  return entries.every(({ key, field }) => {
    const cached = map[key];
    if (typeof cached?.id !== 'string') return false;
    return (field.options ?? []).every(name => typeof cached.options?.[name] === 'string');
  });
}

function buildFieldMap(
  existing: ExistingField[],
  entries: ReturnType<typeof desiredFieldEntries>,
): FieldMap {
  const byName = new Map(existing.map(f => [normalize(f.name), f]));
  const map: Partial<FieldMap> = {};
  const missingFields: string[] = [];
  const missingOptions: string[] = [];
  for (const { key, field } of entries) {
    const have = byName.get(normalize(field.name));
    if (!have || have.dataType !== field.dataType) {
      missingFields.push(field.name);
      continue;
    }
    if (!field.options) {
      map[key] = { id: have.id };
      continue;
    }
    const ids = new Map((have.options ?? []).map(o => [normalize(o.name), o.id]));
    const options: Record<string, string> = {};
    const absent: string[] = [];
    for (const name of field.options) {
      const id = ids.get(normalize(name));
      if (id === undefined) absent.push(name);
      else options[name] = id;
    }
    if (absent.length > 0) missingOptions.push(`${field.name}: ${absent.join(', ')}`);
    map[key] = { id: have.id, options };
  }
  if (missingFields.length > 0 || missingOptions.length > 0) {
    const problems = [
      ...(missingFields.length > 0 ? [`missing fields: ${missingFields.join(', ')}`] : []),
      ...(missingOptions.length > 0 ? [`missing options: ${missingOptions.join('; ')}`] : []),
    ];
    throw new BoardError(`The board is not set up (${problems.join(' | ')}); run "sdlc board ensure"`);
  }
  return map as FieldMap;
}

export interface ResolveFieldIdsOptions {
  /** Directory holding `.sdlc/cache/`; defaults to the git root of the working directory. */
  repoRoot?: string;
  /** Ignore the cache and read the board again. */
  refresh?: boolean;
}

/**
 * Field and option ids of the configured board, from `.sdlc/cache/fields.json` (keyed by project
 * id) when it still covers every needed field and option, else from GitHub. Throws BoardError
 * when the board lacks a needed field or option.
 */
export async function resolveFieldIds(
  run: GhRunner,
  cfg: Config,
  opts: ResolveFieldIdsOptions = {},
): Promise<FieldMap> {
  const { owner, ownerType, number } = cfg.github.project;
  if (number === undefined) {
    throw new BoardError('github.project.number is not set; run "sdlc board ensure" first');
  }
  const ref = `${ownerType}:${owner}/${number}`;
  const entries = desiredFieldEntries(cfg);
  const cachePath = join(opts.repoRoot ?? findRepoRoot(), '.sdlc', 'cache', 'fields.json');
  const cache = readCache(cachePath);

  if (!opts.refresh) {
    const hit = Object.values(cache).find(entry => entry?.ref === ref);
    if (hit && coversDesired(hit.fields, entries)) return hit.fields;
  }

  const project = await fetchProject(run, cfg);
  const map = buildFieldMap(project.fields, entries);

  const next = Object.fromEntries(Object.entries(cache).filter(([, entry]) => entry?.ref !== ref));
  next[project.id] = { ref, fields: map };
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // The cache is an optimisation only; a read-only checkout must still work.
  }
  return map;
}
