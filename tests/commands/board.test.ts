import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/schema.js';
import { formatEnsureResult, registerBoardCommand } from '../../src/commands/board.js';
import type { EnsureBoardResult } from '../../src/github/board.js';
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

async function runBoard(args: string[], script: FakeGhStep[]) {
  const run = fakeGh(script);
  const out: string[] = [];
  const program = new Command().exitOverride();
  registerBoardCommand(program, () => ({ run, config: cfg, out: text => out.push(text) }));
  await program.parseAsync(['node', 'sdlc', 'board', 'ensure', ...args]);
  return { run, out };
}

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
  };

  it('tells the user to record a newly created project number and lists manual steps', () => {
    const text = formatEnsureResult(base, false);
    expect(text).toContain('Created project #12; set github.project.number: 12 in sdlc.config.yaml');
    expect(text).toContain('Fields and options are up to date');
    expect(text).toContain('Created views: Board');
    expect(text).toContain('Manual steps:\n  - Create the "In flight" view manually (table layout)');
  });

  it('says a new project would be created in a dry run without a project', () => {
    const text = formatEnsureResult(
      { ...base, created: false, wouldCreateProject: true, projectNumber: 0, viewsCreated: [], viewsManual: [] },
      true,
    );
    expect(text).toContain('No project configured; a new one would be created');
  });
});
