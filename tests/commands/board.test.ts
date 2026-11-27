import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, parseConfig, type Config } from '../../src/config/schema.js';
import { formatEnsureResult, registerBoardCommand } from '../../src/commands/board.js';
import { desiredFields, type EnsureBoardResult } from '../../src/github/board.js';
import { fakeGh, type FakeGhStep } from '../support/fakeGh.js';

const cfg = loadConfig(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config/valid.yaml'));

const emptyProject: FakeGhStep = {
  match: ['graphql'],
  stdout: JSON.stringify({
    data: {
      owner: {
        projectV2: {
          id: 'PVT_1',
          number: 7,
          fields: {
            nodes: [
              {
                id: 'F_status',
                name: 'Status',
                dataType: 'SINGLE_SELECT',
                options: [{ id: 'o1', name: 'Todo', color: 'GREEN', description: '' }],
              },
            ],
          },
          views: { nodes: [{ name: 'Board' }] },
        },
      },
    },
  }),
};

async function runBoard(args: string[], script: FakeGhStep[], config: Config = cfg) {
  const run = fakeGh(script);
  const out: string[] = [];
  const err: string[] = [];
  const program = new Command().exitOverride();
  registerBoardCommand(program, () => ({
    run,
    config,
    out: text => out.push(text),
    err: text => err.push(text),
  }));
  await program.parseAsync(['node', 'sdlc', 'board', 'ensure', ...args]);
  return { run, out, err };
}

/** A project that already has every field and option, with the given views. */
function provisionedProject(views: string[]): FakeGhStep {
  const nodes = [
    { id: 'F_title', name: 'Title', dataType: 'TITLE' },
    ...desiredFields(cfg).map((f, i) => ({
      id: `PF_${i}`,
      name: f.name,
      dataType: f.dataType,
      ...(f.options && { options: f.options.map((name, j) => ({ id: `PF_${i}_${j}`, name })) }),
    })),
  ];
  return {
    match: ['graphql'],
    stdout: JSON.stringify({
      data: {
        owner: {
          projectV2: {
            id: 'PVT_1',
            number: 7,
            fields: { nodes },
            views: { nodes: views.map(name => ({ name })) },
          },
        },
      },
    }),
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('sdlc board ensure', () => {
  it('prints machine-readable JSON with --json and issues only queries with --dry-run', async () => {
    const { run, out } = await runBoard(['--dry-run', '--json'], [emptyProject]);
    expect(run.calls).toHaveLength(1);
    const printed = JSON.parse(out.join('\n'));
    expect(printed).toMatchObject({
      dryRun: true,
      projectNumber: 7,
      created: false,
      viewsCreated: [],
      viewsManual: [],
      viewsPlanned: ['In flight', 'Awaiting deployment', 'Waiting on owner'],
    });
    expect(printed.plan.createFields).toHaveLength(11);
    expect(printed.plan.addOptions[0].fieldName).toBe('Status');
  });

  it('summarises a dry run in plain text', async () => {
    const { out } = await runBoard(['--dry-run'], [emptyProject]);
    const text = out.join('\n');
    expect(text).toContain('Project #7');
    expect(text).toContain('Would create fields: Phase, Task type');
    expect(text).toContain('Would add options to Status: Ready, In progress');
    expect(text).toContain('Would create views: In flight, Awaiting deployment, Waiting on owner');
  });
});

describe('sdlc board ensure exit code', () => {
  const threeViews = ['Board', 'In flight', 'Awaiting deployment'];

  it('exits non-zero and reports the view when its creation fails', async () => {
    const { out } = await runBoard(
      ['--json'],
      [
        provisionedProject(threeViews),
        { match: ['api'], stdout: '[]' },
        { match: ['POST'], code: 1, stderr: 'gh: Server Error (HTTP 500)' },
      ],
    );
    expect(process.exitCode).toBe(1);
    const printed = JSON.parse(out.join('\n'));
    expect(printed.viewsFailed).toEqual([{ name: 'Waiting on owner', error: 'gh: Server Error (HTTP 500)' }]);
    expect(printed.viewsManual).toEqual([]);
  });

  it('lists failed views in the plain text summary', async () => {
    const { out } = await runBoard(
      [],
      [
        provisionedProject(threeViews),
        { match: ['api'], stdout: '[]' },
        { match: ['POST'], code: 1, stderr: 'gh: Validation Failed (HTTP 422)' },
      ],
    );
    expect(process.exitCode).toBe(1);
    expect(out.join('\n')).toContain('Failed views:\n  - Waiting on owner: gh: Validation Failed (HTTP 422)');
  });

  it('exits zero when the views endpoint is unsupported and prints the manual steps', async () => {
    const { out } = await runBoard(
      [],
      [
        provisionedProject(threeViews),
        { match: ['api'], stdout: '[]' },
        { match: ['POST'], code: 1, stderr: 'gh: Not Found (HTTP 404)' },
      ],
    );
    expect(process.exitCode).toBeUndefined();
    expect(out.join('\n')).toContain('Manual steps:');
    expect(out.join('\n')).toContain('waiting-on:Owner');
  });

  it('exits zero when everything was created', async () => {
    await runBoard([], [provisionedProject(['Board', 'In flight', 'Awaiting deployment', 'Waiting on owner'])]);
    expect(process.exitCode).toBeUndefined();
  });
});

describe('sdlc board ensure with no configured project', () => {
  const newCfg = parseConfig(`
version: 1
harnesses: [claude]
mode: observe
github:
  repo: acme/shop
  default_branch: main
  project: { owner: acme, owner_type: org }
owners: [shop-owner]
task_types:
  enabled: [analysis, spike]
`);

  it('prints the new project number at once and fails with it when a later write fails', async () => {
    const script: FakeGhStep[] = [
      {
        match: ['graphql'],
        stdout: JSON.stringify({ data: { owner: { id: 'O_acme' }, repo: { id: 'R_shop' } } }),
      },
      {
        match: ['graphql'],
        stdout: JSON.stringify({
          data: {
            createProjectV2: {
              projectV2: { id: 'PVT_new', number: 12, url: 'https://github.com/orgs/acme/projects/12' },
            },
          },
        }),
      },
      {
        match: ['graphql'],
        stdout: JSON.stringify({
          data: {
            node: {
              id: 'PVT_new',
              number: 12,
              fields: { nodes: [{ id: 'F_title', name: 'Title', dataType: 'TITLE' }] },
              views: { nodes: [] },
            },
          },
        }),
      },
      { match: ['graphql'], code: 1, stderr: 'gh: Server Error (HTTP 500)' },
    ];
    const err: string[] = [];
    const out: string[] = [];
    const program = new Command().exitOverride();
    registerBoardCommand(program, () => ({
      run: fakeGh(script),
      config: newCfg,
      out: text => out.push(text),
      err: text => err.push(text),
    }));

    const failure = await program.parseAsync(['node', 'sdlc', 'board', 'ensure']).catch((e: unknown) => e);

    expect(err).toEqual([
      'Created project #12 (https://github.com/orgs/acme/projects/12); ' +
        'set github.project.number: 12 in sdlc.config.yaml before running this again',
    ]);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('github.project.number: 12');
    expect(out).toEqual([]);
  });
});

describe('formatEnsureResult', () => {
  const base: EnsureBoardResult = {
    projectNumber: 12,
    projectId: 'PVT_new',
    created: true,
    wouldCreateProject: false,
    plan: { createFields: [], addOptions: [], typeConflicts: [] },
    viewsPlanned: [],
    viewsCreated: ['Board'],
    viewsManual: ['Create the "In flight" view manually (table layout)'],
    viewsFailed: [{ name: 'Waiting on owner', error: 'gh: Server Error (HTTP 500)' }],
  };

  it('tells the user to record a newly created project number and lists manual steps', () => {
    const text = formatEnsureResult(base, false);
    expect(text).toContain('Created project #12; set github.project.number: 12 in sdlc.config.yaml');
    expect(text).toContain('Fields and options are up to date');
    expect(text).toContain('Created views: Board');
    expect(text).toContain('Manual steps:\n  - Create the "In flight" view manually (table layout)');
    expect(text).toContain('Failed views:\n  - Waiting on owner: gh: Server Error (HTTP 500)');
  });

  it('says a new project would be created in a dry run without a project', () => {
    const text = formatEnsureResult(
      { ...base, created: false, wouldCreateProject: true, projectNumber: 0, viewsCreated: [], viewsManual: [], viewsFailed: [] },
      true,
    );
    expect(text).toContain('No project configured; a new one would be created');
  });
});
