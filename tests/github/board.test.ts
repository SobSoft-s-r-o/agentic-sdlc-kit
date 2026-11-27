import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, parseConfig, type Config } from '../../src/config/schema.js';
import {
  BoardError,
  desiredFields,
  ensureBoard,
  OPTION_UPDATE_PRESERVES_VALUES,
  planBoardChanges,
  resolveFieldIds,
  type ExistingField,
} from '../../src/github/board.js';
import { fakeGh, type FakeGh, type FakeGhStep } from '../support/fakeGh.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config/valid.yaml');
/** valid.yaml: org `acme`, project #7, all built-in types plus the custom `infra-change`. */
const cfg = loadConfig(FIXTURE);

function configWith(project: string, enabled = '[analysis, spike]'): Config {
  return parseConfig(`
version: 1
harnesses: [claude]
mode: observe
github:
  repo: acme/shop
  default_branch: main
  project: ${project}
owners: [shop-owner]
task_types:
  enabled: ${enabled}
`);
}

const ALL_FIELD_NAMES = [
  'Status',
  'Phase',
  'Task type',
  'Waiting on',
  'Summary',
  'Current step',
  'Next step',
  'Pending targets',
  'Agent',
  'Last update',
  'Start',
  'Target date',
];

/** The fields GitHub creates on a brand-new project (GraphQL view), with the default Status. */
function builtinFields(): ExistingField[] {
  const plain = (name: string, dataType: string, i: number): ExistingField => ({
    id: `F_${i}`,
    name,
    dataType,
  });
  return [
    plain('Title', 'TITLE', 1),
    plain('Assignees', 'ASSIGNEES', 2),
    {
      id: 'F_status',
      name: 'Status',
      dataType: 'SINGLE_SELECT',
      options: [
        { id: 'o_todo', name: 'Todo', color: 'GREEN', description: "This item hasn't been started" },
        { id: 'o_prog', name: 'In Progress', color: 'YELLOW', description: 'This is actively being worked on' },
        { id: 'o_done', name: 'Done', color: 'PURPLE', description: 'This has been completed' },
      ],
    } as ExistingField,
    plain('Labels', 'LABELS', 4),
    plain('Linked pull requests', 'LINKED_PULL_REQUESTS', 5),
    plain('Milestone', 'MILESTONE', 6),
    plain('Repository', 'REPOSITORY', 7),
    plain('Reviewers', 'REVIEWERS', 8),
    plain('Parent issue', 'PARENT_ISSUE', 9),
    plain('Sub-issues progress', 'SUB_ISSUES_PROGRESS', 10),
    plain('Created', 'CREATED', 11),
    plain('Updated', 'UPDATED', 12),
    plain('Closed', 'CLOSED', 13),
  ];
}

/** A board that already has every desired field and option (Status uses the sdlc option names). */
function provisionedFields(config: Config): ExistingField[] {
  return [
    ...builtinFields().filter(f => f.name !== 'Status'),
    ...desiredFields(config).map((f, i) => ({
      id: `PF_${i}`,
      name: f.name,
      dataType: f.dataType,
      ...(f.options && {
        options: f.options.map((name, j) => ({ id: `PF_${i}_${j}`, name, color: 'GRAY', description: '' })),
      }),
    })),
  ];
}

const gql = (data: unknown): FakeGhStep => ({ match: ['graphql'], stdout: JSON.stringify({ data }) });

function projectStep(
  fields: ExistingField[],
  views: string[] = [],
  ids: { id?: string; number?: number } = {},
): FakeGhStep {
  return gql({
    owner: {
      projectV2: {
        id: ids.id ?? 'PVT_1',
        number: ids.number ?? 7,
        title: 'Board',
        fields: { nodes: fields },
        views: { nodes: views.map(name => ({ name })) },
      },
    },
  });
}

const createFieldStep = (name: string): FakeGhStep =>
  gql({ createProjectV2Field: { projectV2Field: { id: `NEW_${name}`, name } } });

/** Echoes back the options it was sent, as GitHub does, giving new options ids. */
function updateFieldStep(fieldId: string, options: { id?: string; name: string }[]): FakeGhStep {
  return gql({
    updateProjectV2Field: {
      projectV2Field: {
        id: fieldId,
        options: options.map((o, i) => ({ id: o.id ?? `new_${i}`, name: o.name })),
      },
    },
  });
}

/** REST `GET .../fields`: the custom fields with numeric ids 100.. (Status is 100). */
function restFieldsStep(path: string): FakeGhStep {
  const body = [
    { id: 1, name: 'Title', data_type: 'title' },
    { id: 2, name: 'Type', data_type: 'issue_type' },
    ...ALL_FIELD_NAMES.map((name, i) => ({ id: 100 + i, name, data_type: 'text' })),
  ];
  return { match: ['api', path], stdout: JSON.stringify(body) };
}

const inputAt = (run: FakeGh, index: number) => JSON.parse(run.inputs[index] ?? 'null') as Record<string, any>;

describe('desiredFields', () => {
  it('lists the twelve board fields in order with their data types', () => {
    const fields = desiredFields(cfg);
    expect(fields.map(f => [f.name, f.dataType])).toEqual([
      ['Status', 'SINGLE_SELECT'],
      ['Phase', 'SINGLE_SELECT'],
      ['Task type', 'SINGLE_SELECT'],
      ['Waiting on', 'SINGLE_SELECT'],
      ['Summary', 'TEXT'],
      ['Current step', 'TEXT'],
      ['Next step', 'TEXT'],
      ['Pending targets', 'TEXT'],
      ['Agent', 'TEXT'],
      ['Last update', 'TEXT'],
      ['Start', 'DATE'],
      ['Target date', 'DATE'],
    ]);
  });

  it('uses the fixed Status and Waiting on option names', () => {
    const byName = Object.fromEntries(desiredFields(cfg).map(f => [f.name, f.options]));
    expect(byName.Status).toEqual([
      'Ready',
      'In progress',
      'Blocked',
      'Paused',
      'In review',
      'Awaiting deployment',
      'Done',
    ]);
    expect(byName['Waiting on']).toEqual(['Owner', 'Agent', 'External', '—']);
  });

  it('offers every phase in canonical order when all types are enabled', () => {
    const phase = desiredFields(cfg).find(f => f.name === 'Phase');
    expect(phase?.options).toEqual([
      'Intake',
      'Debugging',
      'Brainstorming',
      'Analysis',
      'Exploration',
      'Creation',
      'Planning',
      'Implementation',
      'Verification',
      'Review',
      'Delivery',
    ]);
  });

  it('limits phases to those used by enabled types, in canonical order', () => {
    const phase = desiredFields(configWith('{ owner: acme, owner_type: org }', '[spike, analysis]')).find(
      f => f.name === 'Phase',
    );
    expect(phase?.options).toEqual(['Intake', 'Analysis', 'Exploration', 'Delivery']);
  });

  it('lists enabled type labels, custom types included, as Task type options', () => {
    const type = desiredFields(cfg).find(f => f.name === 'Task type');
    expect(type?.options).toEqual([
      'Feature',
      'Bug fix',
      'Tooling',
      'Analysis',
      'Production data',
      'Artifact',
      'Spike',
      'Infra change',
    ]);
  });
});

describe('planBoardChanges', () => {
  const desired = desiredFields(cfg);

  it('creates all fields on an empty board', () => {
    const plan = planBoardChanges(builtinFields(), desired);
    expect(plan.createFields.map(f => f.name)).toEqual(ALL_FIELD_NAMES.filter(n => n !== 'Status'));
    expect(plan.createFields).toHaveLength(11);
    expect(plan.typeConflicts).toEqual([]);
    expect(plan.addOptions.map(a => a.fieldName)).toEqual(['Status']);
  });

  it('reuses built-in status options case-insensitively', () => {
    const plan = planBoardChanges(builtinFields(), desired);
    expect(plan.addOptions).toEqual([
      {
        fieldId: 'F_status',
        fieldName: 'Status',
        missing: ['Ready', 'Blocked', 'Paused', 'In review', 'Awaiting deployment'],
      },
    ]);
    expect(plan.addOptions[0]?.missing).not.toContain('In progress');
    expect(plan.addOptions[0]?.missing).not.toContain('Done');
  });

  it('reports a type conflict when a field exists with another data type', () => {
    const existing = [...builtinFields(), { id: 'F_sum', name: 'Summary', dataType: 'SINGLE_SELECT' }];
    const plan = planBoardChanges(existing, desired);
    expect(plan.typeConflicts).toEqual(['Summary']);
    expect(plan.createFields.map(f => f.name)).not.toContain('Summary');
  });

  it('matches field names ignoring case and surrounding whitespace', () => {
    const existing = provisionedFields(cfg).map(f =>
      f.name === 'Current step' ? { ...f, name: '  current STEP ' } : f,
    );
    const plan = planBoardChanges(existing, desired);
    expect(plan.createFields).toEqual([]);
    expect(plan.typeConflicts).toEqual([]);
  });

  it('ignores built-in non-custom fields, including the issue type field named Type', () => {
    const existing = [...builtinFields(), { id: 'F_type', name: 'Type', dataType: 'ISSUE_TYPE' }];
    const plan = planBoardChanges(existing, desired);
    expect(plan.createFields.map(f => f.name)).toContain('Task type');
    expect(plan.typeConflicts).toEqual([]);
    expect(plan.addOptions.map(a => a.fieldName)).toEqual(['Status']);
  });

  it('keeps existing extra options and only reports the missing ones', () => {
    const existing = provisionedFields(cfg).map(f =>
      f.name === 'Phase'
        ? { ...f, options: [...(f.options ?? []).filter(o => o.name !== 'Review'), { id: 'x', name: 'Triage' }] }
        : f,
    );
    const plan = planBoardChanges(existing, desired);
    expect(plan.addOptions).toEqual([
      { fieldId: expect.any(String), fieldName: 'Phase', missing: ['Review'] },
    ]);
  });

  it('plans nothing for a fully provisioned board', () => {
    expect(planBoardChanges(provisionedFields(cfg), desired)).toEqual({
      createFields: [],
      addOptions: [],
      typeConflicts: [],
    });
  });
});

describe('ensureBoard', () => {
  const STATUS_OPTION_INPUTS = [
    { id: 'o_todo', name: 'Todo', color: 'GREEN', description: "This item hasn't been started" },
    { id: 'o_prog', name: 'In Progress', color: 'YELLOW', description: 'This is actively being worked on' },
    { id: 'o_done', name: 'Done', color: 'PURPLE', description: 'This has been completed' },
  ];

  /** The full add-only run against an empty org board: queries, mutations, then views. */
  function emptyBoardScript(views: string[] = []): FakeGhStep[] {
    const statusSent = [
      ...STATUS_OPTION_INPUTS,
      ...['Ready', 'Blocked', 'Paused', 'In review', 'Awaiting deployment'].map(name => ({ name })),
    ];
    const missingViews = ['Board', 'In flight', 'Awaiting deployment', 'Waiting on owner'].filter(
      v => !views.map(x => x.toLowerCase()).includes(v.toLowerCase()),
    );
    return [
      projectStep(builtinFields(), views),
      ...ALL_FIELD_NAMES.filter(n => n !== 'Status').map(createFieldStep),
      updateFieldStep('F_status', statusSent),
      ...(missingViews.length > 0 ? [restFieldsStep('/orgs/acme/projectsV2/7/fields?per_page=100')] : []),
      ...missingViews.map(name => ({ match: ['POST'], stdout: JSON.stringify({ number: 9, name }) })),
    ];
  }

  it('records that option updates keep item values (spike result)', () => {
    expect(OPTION_UPDATE_PRESERVES_VALUES).toBe(true);
  });

  it('dry run issues no mutations', async () => {
    const run = fakeGh([projectStep(builtinFields())]);
    const result = await ensureBoard(run, cfg, { dryRun: true });
    expect(run.calls).toHaveLength(1);
    expect(run.calls.flat()).not.toContain('POST');
    expect(run.inputs.every(input => !(input ?? '').includes('mutation'))).toBe(true);
    expect(result).toMatchObject({
      projectNumber: 7,
      projectId: 'PVT_1',
      created: false,
      viewsCreated: [],
      viewsManual: [],
      viewsFailed: [],
      viewsPlanned: ['Board', 'In flight', 'Awaiting deployment', 'Waiting on owner'],
    });
    expect(result.plan.createFields).toHaveLength(11);
    expect(result.plan.addOptions).toHaveLength(1);
  });

  it('dry run without a configured project plans a new board and makes no calls', async () => {
    const run = fakeGh([]);
    const result = await ensureBoard(run, configWith('{ owner: acme, owner_type: org }'), { dryRun: true });
    expect(run.calls).toEqual([]);
    expect(result).toMatchObject({ created: false, wouldCreateProject: true, projectNumber: 0, projectId: '' });
    expect(result.plan.createFields).toHaveLength(11);
    expect(result.viewsPlanned).toHaveLength(4);
  });

  it('refuses option changes on a populated field when updates are unsafe', async () => {
    const run = fakeGh([
      projectStep(builtinFields()),
      gql({
        node: {
          items: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                fieldValues: {
                  nodes: [{}, { optionId: 'o_prog', field: { id: 'F_status' } }],
                },
              },
            ],
          },
        },
      }),
    ]);
    const error = await ensureBoard(run, cfg, { dryRun: false, optionUpdatesPreserveValues: false }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BoardError);
    expect((error as BoardError).message).toContain('create a new board');
    expect((error as BoardError).message).toContain('Status');
    expect(run.calls).toHaveLength(2);
    expect(run.inputs.every(input => !(input ?? '').includes('mutation'))).toBe(true);
  });

  it('allows option changes on unpopulated fields even when updates are unsafe', async () => {
    const run = fakeGh([
      projectStep(builtinFields(), ['Board', 'In flight', 'Awaiting deployment', 'Waiting on owner']),
      gql({ node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }),
      ...ALL_FIELD_NAMES.filter(n => n !== 'Status').map(createFieldStep),
      updateFieldStep('F_status', [...STATUS_OPTION_INPUTS, ...Array(5).fill({ name: 'x' })]),
    ]);
    await ensureBoard(run, cfg, { dryRun: false, optionUpdatesPreserveValues: false });
    expect(run.calls).toHaveLength(14);
  });

  it('refuses before any mutation when a field exists with another data type', async () => {
    const fields = [...builtinFields(), { id: 'F_sum', name: 'Summary', dataType: 'SINGLE_SELECT' }];
    const run = fakeGh([projectStep(fields)]);
    await expect(ensureBoard(run, cfg, { dryRun: false })).rejects.toThrow(/Summary/);
    expect(run.calls).toHaveLength(1);
  });

  it('creates fields and adds options, resending existing options with ids, colors and descriptions', async () => {
    const run = fakeGh(emptyBoardScript());
    const result = await ensureBoard(run, cfg, { dryRun: false });

    const created = run.inputs.slice(1, 12).map((_, i) => inputAt(run, i + 1).variables.input);
    expect(created.map(i => i.name)).toEqual(ALL_FIELD_NAMES.filter(n => n !== 'Status'));
    expect(created.every(i => i.projectId === 'PVT_1')).toBe(true);
    expect(created[0]).toMatchObject({
      dataType: 'SINGLE_SELECT',
      name: 'Phase',
      singleSelectOptions: expect.arrayContaining([{ name: 'Intake', color: expect.any(String), description: '' }]),
    });
    expect(created.find(i => i.name === 'Summary')).toEqual({ projectId: 'PVT_1', dataType: 'TEXT', name: 'Summary' });
    expect(created.find(i => i.name === 'Start')).toEqual({ projectId: 'PVT_1', dataType: 'DATE', name: 'Start' });

    const update = inputAt(run, 12).variables.input;
    expect(update.fieldId).toBe('F_status');
    expect(update.singleSelectOptions.slice(0, 3)).toEqual(STATUS_OPTION_INPUTS);
    expect(update.singleSelectOptions.slice(3).map((o: { name: string }) => o.name)).toEqual([
      'Ready',
      'Blocked',
      'Paused',
      'In review',
      'Awaiting deployment',
    ]);
    for (const option of update.singleSelectOptions.slice(3)) {
      expect(option).not.toHaveProperty('id');
      expect(option.description).toBe('');
    }
    expect(result.created).toBe(false);
  });

  it('throws when an option update would change existing option ids', async () => {
    const script = emptyBoardScript();
    const updateIndex = 12;
    script[updateIndex] = gql({
      updateProjectV2Field: { projectV2Field: { id: 'F_status', options: [{ id: 'fresh', name: 'Todo' }] } },
    });
    const run = fakeGh(script);
    await expect(ensureBoard(run, cfg, { dryRun: false })).rejects.toThrow(/option ids/);
  });

  it('creates the four views through the REST views API', async () => {
    const run = fakeGh(emptyBoardScript());
    const result = await ensureBoard(run, cfg, { dryRun: false });

    expect(run.calls[13]).toEqual(['api', '/orgs/acme/projectsV2/7/fields?per_page=100']);
    const posts = run.calls.slice(14);
    expect(posts).toHaveLength(4);
    for (const call of posts) {
      expect(call).toEqual(['api', '-X', 'POST', '/orgs/acme/projectsV2/7/views', '--input', '-']);
    }
    const bodies = [14, 15, 16, 17].map(i => inputAt(run, i));
    // Field ids come from the REST field list: Status 100, Pending targets 107, Last update 109.
    expect(bodies).toEqual([
      { name: 'Board', layout: 'board', vertical_group_by: [100] },
      { name: 'In flight', layout: 'table', filter: '-status:Done', sort_by: [[109, 'desc']] },
      { name: 'Awaiting deployment', layout: 'table', filter: 'status:"Awaiting deployment"', group_by: [107] },
      { name: 'Waiting on owner', layout: 'table', filter: 'waiting-on:Owner' },
    ]);
    expect(result.viewsCreated).toEqual(['Board', 'In flight', 'Awaiting deployment', 'Waiting on owner']);
    expect(result.viewsManual).toEqual([]);
  });

  it('uses user-scoped endpoints for a user-owned project', async () => {
    const userCfg = configWith('{ owner: lubo, owner_type: user, number: 3 }');
    const run = fakeGh([
      projectStep(provisionedFields(userCfg), ['Board'], { number: 3 }),
      restFieldsStep('/users/lubo/projectsV2/3/fields?per_page=100'),
      { match: ['POST'], stdout: '{}' },
      { match: ['POST'], stdout: '{}' },
      { match: ['POST'], stdout: '{}' },
    ]);
    await ensureBoard(run, userCfg, { dryRun: false });
    expect(inputAt(run, 0).query).toContain('user(login');
    expect(run.calls[2]).toContain('/users/lubo/projectsV2/3/views');
  });

  it('skips views whose name already exists, ignoring case', async () => {
    const run = fakeGh(emptyBoardScript(['board', 'In Flight']));
    const result = await ensureBoard(run, cfg, { dryRun: false });
    expect(result.viewsCreated).toEqual(['Awaiting deployment', 'Waiting on owner']);
    expect(run.calls.filter(c => c.includes('POST'))).toHaveLength(2);
    expect(result.viewsManual).toEqual([]);
  });

  it('makes no calls beyond the query for a fully provisioned board with all views', async () => {
    const run = fakeGh([
      projectStep(provisionedFields(cfg), ['Board', 'In flight', 'Awaiting deployment', 'Waiting on owner']),
    ]);
    const result = await ensureBoard(run, cfg, { dryRun: false });
    expect(run.calls).toHaveLength(1);
    expect(result.viewsCreated).toEqual([]);
    expect(result.viewsManual).toEqual([]);
    expect(result.viewsFailed).toEqual([]);
    expect(result.viewsPlanned).toEqual([]);
  });

  it('returns manual instructions for views whose endpoint answers 404 or 410 (unsupported)', async () => {
    const script = emptyBoardScript();
    // Board succeeds; the rest are unsupported.
    script[14] = { match: ['POST'], stdout: '{"number":2}' };
    script[15] = { match: ['POST'], code: 1, stderr: 'gh: Not Found (HTTP 404)' };
    script[16] = { match: ['POST'], code: 1, stderr: 'gh: Gone (HTTP 410)' };
    script[17] = { match: ['POST'], code: 1, stderr: 'HTTP 404: Not Found' };
    const run = fakeGh(script);
    const result = await ensureBoard(run, cfg, { dryRun: false });

    expect(result.viewsCreated).toEqual(['Board']);
    expect(result.viewsFailed).toEqual([]);
    expect(result.viewsManual).toHaveLength(3);
    expect(result.viewsManual[0]).toContain('In flight');
    expect(result.viewsManual[0]).toContain('-status:Done');
    expect(result.viewsManual[0]).toContain('Last update');
    expect(result.viewsManual[1]).toContain('Awaiting deployment');
    expect(result.viewsManual[1]).toContain('Pending targets');
    expect(result.viewsManual[2]).toContain('waiting-on:Owner');
  });

  it.each([
    ['422', 'gh: Validation Failed (HTTP 422)'],
    ['500', 'gh: Server Error (HTTP 500)'],
    ['no HTTP status', 'connection reset by peer'],
  ])('reports a view that fails with %s as failed, not manual, and still tries the others', async (_, stderr) => {
    const script = emptyBoardScript();
    script[15] = { match: ['POST'], code: 1, stderr };
    const run = fakeGh(script);
    const result = await ensureBoard(run, cfg, { dryRun: false });

    expect(result.viewsCreated).toEqual(['Board', 'Awaiting deployment', 'Waiting on owner']);
    expect(result.viewsManual).toEqual([]);
    expect(result.viewsFailed).toEqual([{ name: 'In flight', error: stderr }]);
  });

  it('returns manual instructions for every view when the field list endpoint answers 404', async () => {
    const script = emptyBoardScript().slice(0, 13);
    script.push({ match: ['api'], code: 1, stderr: 'HTTP 404: Not Found' });
    const run = fakeGh(script);
    const result = await ensureBoard(run, cfg, { dryRun: false });
    expect(result.viewsCreated).toEqual([]);
    expect(result.viewsManual).toHaveLength(4);
    expect(result.viewsFailed).toEqual([]);
  });

  it('reports every view as failed when the field list cannot be read for another reason', async () => {
    const script = emptyBoardScript().slice(0, 13);
    script.push({ match: ['api'], code: 1, stderr: 'gh: Server Error (HTTP 502)' });
    const run = fakeGh(script);
    const result = await ensureBoard(run, cfg, { dryRun: false });
    expect(result.viewsCreated).toEqual([]);
    expect(result.viewsManual).toEqual([]);
    expect(result.viewsFailed.map(f => f.name)).toEqual([
      'Board',
      'In flight',
      'Awaiting deployment',
      'Waiting on owner',
    ]);
    expect(result.viewsFailed[0]?.error).toContain('HTTP 502');
  });

  it('reports views that need a field missing from the REST field list as failed', async () => {
    const script = emptyBoardScript();
    script[13] = {
      match: ['api'],
      stdout: JSON.stringify([{ id: 100, name: 'Status', data_type: 'single_select' }]),
    };
    // Only Board and Waiting on owner can be created; the other two need fields the list lacks.
    const run = fakeGh([...script.slice(0, 15), script[17] as FakeGhStep]);
    const result = await ensureBoard(run, cfg, { dryRun: false });
    expect(result.viewsCreated).toEqual(['Board', 'Waiting on owner']);
    expect(result.viewsManual).toEqual([]);
    expect(result.viewsFailed).toEqual([
      { name: 'In flight', error: 'field "Last update" is missing from the project\'s field list' },
      { name: 'Awaiting deployment', error: 'field "Pending targets" is missing from the project\'s field list' },
    ]);
  });

  describe('when no project is configured', () => {
    const newCfg = configWith('{ owner: acme, owner_type: org }');
    const createdUrl = 'https://github.com/orgs/acme/projects/12';
    const createSteps = (): FakeGhStep[] => [
      gql({ owner: { id: 'O_acme' }, repo: { id: 'R_shop' } }),
      gql({ createProjectV2: { projectV2: { id: 'PVT_new', number: 12, url: createdUrl } } }),
      gql({
        node: {
          id: 'PVT_new',
          number: 12,
          title: 'shop SDLC tasks',
          fields: { nodes: builtinFields() },
          views: { nodes: [{ name: 'View 1' }] },
        },
      }),
    ];

    it('creates a project linked to the repository, announces it, then provisions it', async () => {
      const run = fakeGh([
        ...createSteps(),
        ...ALL_FIELD_NAMES.filter(n => n !== 'Status').map(createFieldStep),
        updateFieldStep('F_status', [...STATUS_OPTION_INPUTS, ...Array(5).fill({ name: 'x' })]),
        restFieldsStep('/orgs/acme/projectsV2/12/fields?per_page=100'),
        ...[1, 2, 3, 4].map(() => ({ match: ['POST'], stdout: '{}' })),
      ]);
      const announced: { number: number; id: string; url?: string }[] = [];
      const callsWhenAnnounced: number[] = [];
      const result = await ensureBoard(run, newCfg, {
        dryRun: false,
        onProjectCreated: project => {
          announced.push(project);
          callsWhenAnnounced.push(run.calls.length);
        },
      });

      expect(inputAt(run, 0).variables).toEqual({ owner: 'acme', repoOwner: 'acme', repoName: 'shop' });
      expect(inputAt(run, 0).query).toContain('organization(login');
      expect(inputAt(run, 1).variables.input).toEqual({
        ownerId: 'O_acme',
        repositoryId: 'R_shop',
        title: 'shop SDLC tasks',
      });
      expect(announced).toEqual([{ number: 12, id: 'PVT_new', url: createdUrl }]);
      // Announced right after the project exists, before any field is written.
      expect(callsWhenAnnounced).toEqual([3]);
      expect(result).toMatchObject({ created: true, projectNumber: 12, projectId: 'PVT_new' });
      expect(result.viewsCreated).toHaveLength(4);
      // Every later write targets the project that was just created.
      expect(inputAt(run, 3).variables.input.projectId).toBe('PVT_new');
      expect(
        run.calls.filter(c => c.includes('POST')).every(c => c.includes('/orgs/acme/projectsV2/12/views')),
      ).toBe(true);
    });

    it('names the created project and the config key to set when a later write fails', async () => {
      const run = fakeGh([
        ...createSteps(),
        { match: ['graphql'], code: 1, stderr: 'gh: Server Error (HTTP 500)' },
      ]);
      const announced: number[] = [];
      const error = await ensureBoard(run, newCfg, {
        dryRun: false,
        onProjectCreated: project => announced.push(project.number),
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BoardError);
      const boardError = error as BoardError;
      expect(boardError.message).toContain('Project #12');
      expect(boardError.message).toContain(createdUrl);
      expect(boardError.message).toContain('created but provisioning failed');
      expect(boardError.message).toContain('HTTP 500');
      expect(boardError.message).toContain('github.project.number: 12');
      expect(boardError.createdProject).toEqual({ number: 12, id: 'PVT_new', url: createdUrl });
      expect(boardError.cause).toBeInstanceOf(Error);
      expect(announced).toEqual([12]);
      expect(run.calls).toHaveLength(4);
    });

    it('does not announce a project in a dry run, and a failure before creation has no created project', async () => {
      const announced: number[] = [];
      const dry = fakeGh([]);
      await ensureBoard(dry, newCfg, { dryRun: true, onProjectCreated: p => announced.push(p.number) });
      expect(announced).toEqual([]);

      const failing = fakeGh([{ match: ['graphql'], code: 1, stderr: 'gh: Server Error (HTTP 500)' }]);
      const error = await ensureBoard(failing, newCfg, { dryRun: false }).catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(BoardError);
    });
  });

  it('fails clearly when the configured project does not exist', async () => {
    const run = fakeGh([gql({ owner: { projectV2: null } })]);
    await expect(ensureBoard(run, cfg, { dryRun: false })).rejects.toThrow(/project #7/i);
  });
});

describe('resolveFieldIds', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
  });
  async function tmpRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'sdlc-fields-'));
    dirs.push(dir);
    return dir;
  }
  const cachePath = (root: string) => join(root, '.sdlc', 'cache', 'fields.json');

  it('maps every board field to its id and each option name to its option id', async () => {
    const root = await tmpRoot();
    const fields = provisionedFields(cfg).map(f =>
      f.name === 'Status'
        ? { ...f, options: f.options?.map(o => (o.name === 'In progress' ? { ...o, name: 'IN PROGRESS ' } : o)) }
        : f,
    );
    const run = fakeGh([projectStep(fields)]);
    const map = await resolveFieldIds(run, cfg, { repoRoot: root });

    expect(Object.keys(map).sort()).toEqual(
      ['agent', 'currentStep', 'lastUpdate', 'nextStep', 'pendingTargets', 'phase', 'start', 'status', 'summary', 'targetDate', 'type', 'waitingOn'].sort(),
    );
    expect(map.summary).toEqual({ id: 'PF_4' });
    expect(map.type.id).toBe('PF_2');
    expect(map.status.options?.['In progress']).toBe('PF_0_1');
    expect(map.status.options?.Done).toBe('PF_0_6');
    expect(map.waitingOn.options?.['—']).toBe('PF_3_3');
  });

  it('caches by project id and serves later calls without gh', async () => {
    const root = await tmpRoot();
    const first = await resolveFieldIds(fakeGh([projectStep(provisionedFields(cfg))]), cfg, { repoRoot: root });
    const cached = JSON.parse(await readFile(cachePath(root), 'utf8'));
    expect(Object.keys(cached)).toEqual(['PVT_1']);

    const idle = fakeGh([]);
    const second = await resolveFieldIds(idle, cfg, { repoRoot: root });
    expect(idle.calls).toEqual([]);
    expect(second).toEqual(first);
  });

  it('refetches when a needed option is missing from the cache', async () => {
    const root = await tmpRoot();
    const stale = await resolveFieldIds(fakeGh([projectStep(provisionedFields(cfg))]), cfg, { repoRoot: root });
    const cached = JSON.parse(await readFile(cachePath(root), 'utf8'));
    delete cached.PVT_1.fields.status.options.Done;
    await writeFile(cachePath(root), JSON.stringify(cached));

    const run = fakeGh([projectStep(provisionedFields(cfg))]);
    const fresh = await resolveFieldIds(run, cfg, { repoRoot: root });
    expect(run.calls).toHaveLength(1);
    expect(fresh.status.options?.Done).toBe(stale.status.options?.Done);
    expect(JSON.parse(await readFile(cachePath(root), 'utf8')).PVT_1.fields.status.options.Done).toBeDefined();
  });

  it('refetches when a needed field is missing from the cache', async () => {
    const root = await tmpRoot();
    await resolveFieldIds(fakeGh([projectStep(provisionedFields(cfg))]), cfg, { repoRoot: root });
    const cached = JSON.parse(await readFile(cachePath(root), 'utf8'));
    delete cached.PVT_1.fields.targetDate;
    await writeFile(cachePath(root), JSON.stringify(cached));

    const run = fakeGh([projectStep(provisionedFields(cfg))]);
    const map = await resolveFieldIds(run, cfg, { repoRoot: root });
    expect(run.calls).toHaveLength(1);
    expect(map.targetDate.id).toBeDefined();
  });

  it('refetches when asked to refresh and when the cache file is corrupt', async () => {
    const root = await tmpRoot();
    await resolveFieldIds(fakeGh([projectStep(provisionedFields(cfg))]), cfg, { repoRoot: root });

    const forced = fakeGh([projectStep(provisionedFields(cfg))]);
    await resolveFieldIds(forced, cfg, { repoRoot: root, refresh: true });
    expect(forced.calls).toHaveLength(1);

    await writeFile(cachePath(root), '{not json');
    const repaired = fakeGh([projectStep(provisionedFields(cfg))]);
    await resolveFieldIds(repaired, cfg, { repoRoot: root });
    expect(repaired.calls).toHaveLength(1);
    expect(JSON.parse(await readFile(cachePath(root), 'utf8'))).toHaveProperty('PVT_1');
  });

  it('keeps one cache entry per project id, replacing a stale entry for the same project', async () => {
    const root = await tmpRoot();
    await mkdir(dirname(cachePath(root)), { recursive: true });
    await resolveFieldIds(fakeGh([projectStep(provisionedFields(cfg))]), cfg, { repoRoot: root });
    await resolveFieldIds(fakeGh([projectStep(provisionedFields(cfg), [], { id: 'PVT_2' })]), cfg, {
      repoRoot: root,
      refresh: true,
    });
    expect(Object.keys(JSON.parse(await readFile(cachePath(root), 'utf8')))).toEqual(['PVT_2']);
  });

  it('tells the user to run board ensure when the board lacks a needed field or option', async () => {
    const root = await tmpRoot();
    const run = fakeGh([projectStep(builtinFields())]);
    const error = await resolveFieldIds(run, cfg, { repoRoot: root }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BoardError);
    expect((error as BoardError).message).toContain('sdlc board ensure');
    expect((error as BoardError).message).toContain('Phase');
    expect((error as BoardError).message).toContain('Status: Ready');
    await expect(readFile(cachePath(root), 'utf8')).rejects.toThrow();
  });

  it('requires a configured project number', async () => {
    const root = await tmpRoot();
    const run = fakeGh([]);
    await expect(
      resolveFieldIds(run, configWith('{ owner: acme, owner_type: org }'), { repoRoot: root }),
    ).rejects.toThrow(/github\.project\.number/);
    expect(run.calls).toEqual([]);
  });
});
