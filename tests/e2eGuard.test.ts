import { describe, expect, it, vi } from 'vitest';
import { checkGhCall, sandboxRunner, type GuardScope } from './e2e/guard.js';

const REPO = 'Acme/Sandbox';
const OWNER = 'acme';
const scope = (projects: number[] = [7]): GuardScope => ({ repo: REPO, projectOwner: OWNER, projects: new Set(projects) });
const refusal = (args: string[], input?: string, projects?: number[]): string | undefined =>
  checkGhCall(scope(projects), args, input);
const graphql = (variables: Record<string, unknown>, query = 'query { viewer { login } }'): string =>
  JSON.stringify({ query, variables });

describe('e2e guard: what the suite sends is allowed', () => {
  const allowed: [string, string[], string?][] = [
    ['who is logged in', ['api', 'user', '-q', '.login']],
    ['the kind of the project owner', ['api', 'users/acme', '-q', '.type']],
    ['project create', ['project', 'create', '--owner', 'acme', '--title', 'sdlc-e2e-ab12', '--format', 'json']],
    ['project item-list', ['project', 'item-list', '7', '--owner', 'acme', '--limit', '500', '--format', 'json']],
    ['label create', ['label', 'create', 'e2e', '--repo', REPO, '--color', 'ededed', '--description', 'Opened by the suite']],
    ['label list by REST', ['api', 'repos/Acme/Sandbox/labels?per_page=100', '--paginate', '--jq', '.[].name']],
    ['issue view', ['issue', 'view', '3', '--repo', REPO, '--json', 'state,stateReason,title,labels']],
    ['issue view, repo in another case', ['issue', 'view', '3', '--repo', 'acme/sandbox', '--json', 'number,title,url,state']],
    ['issue list', ['issue', 'list', '--repo', REPO, '--label', 'e2e', '--state', 'open', '--json', 'number,title', '--limit', '100']],
    ['issue close', ['issue', 'close', '3', '--repo', REPO, '--reason', 'not planned']],
    ['issue comment', ['issue', 'comment', '3', '--repo', REPO, '--body', '/approve']],
    ['issue comment, repo given with -R', ['issue', 'comment', '3', '-R', REPO, '--body', 'see the docs']],
    ['pr list with a search', ['pr', 'list', '--repo', REPO, '--state', 'all', '--search', '"Related to #3" in:body', '--json', 'number', '--limit', '30']],
    ['--repo=value', ['issue', 'view', '3', '--repo=acme/sandbox', '--json', 'state']],
    ['an issue URL of the sandbox', ['issue', 'view', 'https://github.com/Acme/Sandbox/issues/3', '--repo', REPO]],
    ['comments, paginated', ['api', '--paginate', 'repos/Acme/Sandbox/issues/3/comments?per_page=100']],
    ['issue create by REST', ['api', '-X', 'POST', 'repos/Acme/Sandbox/issues', '--input', '-']],
    ['issue patch by REST, leading slash', ['api', '-X', 'PATCH', '/repos/acme/sandbox/issues/3', '--input', '-']],
    ['comment edit by REST', ['api', '-X', 'PATCH', 'repos/Acme/Sandbox/issues/comments/9', '--input', '-']],
    ['repository read by REST', ['api', 'repos/Acme/Sandbox/branches/main']],
    ['repo view', ['repo', 'view', '--repo', REPO, '--json', 'name']],
    ['project REST read', ['api', '/users/acme/projectsV2/7/fields?per_page=100']],
    ['project view create by REST', ['api', '-X', 'POST', '/users/acme/projectsV2/7/views', '--input', '-']],
    ['GraphQL: the project of the owner', ['api', 'graphql', '--input', '-'], graphql({ owner: 'Acme', number: 7 })],
    [
      'GraphQL: the issue and the board',
      ['api', 'graphql', '--input', '-'],
      graphql({ repoOwner: 'acme', repoName: 'sandbox', issue: 3, projectOwner: 'acme', projectNumber: 7 }),
    ],
    ['GraphQL: by node id', ['api', 'graphql', '--input', '-'], graphql({ id: 'PVT_x', after: null })],
    [
      'GraphQL: a mutation by input',
      ['api', 'graphql', '--input', '-'],
      graphql({ input: { projectId: 'PVT_x', contentId: 'I_x' } }, 'mutation($input: X!) { addProjectV2ItemById(input: $input) { item { id } } }'),
    ],
  ];
  it.each(allowed)('%s', (_name, args, input) => {
    expect(refusal(args, input)).toBeUndefined();
  });
});

describe('e2e guard: gh calls on a repository need --repo', () => {
  it.each(['issue', 'pr', 'label', 'repo', 'release', 'run', 'workflow', 'secret', 'variable'])('gh %s without --repo is refused', group => {
    expect(refusal([group, 'list'])).toMatch(/needs --repo/);
    expect(refusal([group, 'view', '3', '--json', 'state'])).toMatch(/needs --repo/);
  });

  it.each(['issue', 'pr', 'label', 'repo', 'release', 'run', 'workflow', 'secret', 'variable'])('gh %s on another repository is refused', group => {
    expect(refusal([group, 'view', '--repo', 'other/place'])).toMatch(/is not Acme\/Sandbox/);
    expect(refusal([group, 'view', '-R', 'other/place'])).toMatch(/is not Acme\/Sandbox/);
    expect(refusal([group, 'view', '--repo=other/place'])).toMatch(/is not Acme\/Sandbox/);
  });

  it('refuses a repository that only starts with the sandbox name', () => {
    expect(refusal(['issue', 'list', '--repo', 'Acme/Sandbox-two'])).toMatch(/is not/);
    expect(refusal(['issue', 'list', '--repo', 'Acme/Sandbo'])).toMatch(/is not/);
  });

  it('refuses a second --repo that names another repository', () => {
    expect(refusal(['issue', 'list', '--repo', REPO, '--repo', 'other/place'])).toMatch(/is not/);
  });

  it('refuses a repository named by a positional argument', () => {
    expect(refusal(['repo', 'view', 'other/place', '--repo', REPO])).toMatch(/other\/place is not/);
  });

  it('refuses what removes or moves something, and any repo subcommand but view', () => {
    for (const sub of ['delete', 'transfer', 'archive', 'unarchive', 'rename', 'lock']) {
      expect(refusal(['issue', sub, '3', '--repo', REPO]), sub).toMatch(/not allowed/);
    }
    expect(refusal(['repo', 'delete', '--repo', REPO, '--yes'])).toMatch(/not allowed/);
    expect(refusal(['repo', 'edit', '--repo', REPO])).toMatch(/only gh repo view/);
    expect(refusal(['repo', 'create', 'x', '--repo', REPO])).toMatch(/only gh repo view/);
  });

  it('refuses a URL that is not in the sandbox, wherever it stands', () => {
    expect(refusal(['issue', 'view', 'https://github.com/other/place/issues/1', '--repo', REPO])).toMatch(/URL/);
    expect(refusal(['issue', 'view', 'https://github.com/Acme/Sandbox-two/issues/1', '--repo', REPO])).toMatch(/URL/);
    expect(refusal(['issue', 'view', 'https://example.com/Acme/Sandbox/issues/1', '--repo', REPO])).toMatch(/URL/);
    expect(refusal(['api', 'https://api.github.com/repos/other/place/issues'])).toMatch(/URL/);
    expect(refusal(['browse', 'https://github.com/other/place'])).toMatch(/URL/);
  });
});

describe('e2e guard: gh api', () => {
  it('refuses a path outside the sandbox and the allowlist', () => {
    for (const path of [
      'repos/other/place/issues',
      'repos/Acme/Sandbox-two/issues',
      'repos/Acme/Sandbo/issues',
      'repos/Acme',
      'repos',
      'orgs/acme/repos',
      'users/other',
      'users/other/projectsV2/7',
      'orgs/other/projectsV2/7',
      'rate_limit',
      'user/repos',
      'user/emails',
      'notifications',
      'search/issues?q=x',
      'gists',
    ]) {
      expect(refusal(['api', path]), path).toMatch(/is not in Acme\/Sandbox|is not one the suite owns/);
    }
  });

  it('refuses a path that climbs out of the sandbox', () => {
    expect(refusal(['api', 'repos/Acme/Sandbox/../other/place/issues'])).toMatch(/plain path/);
    expect(refusal(['api', 'repos/Acme/Sandbox/%2e%2e/other/place'])).toMatch(/plain path/);
    expect(refusal(['api', 'repos/Acme/Sandbox/..'])).toMatch(/plain path/);
  });

  it('refuses a call whose endpoint cannot be told', () => {
    expect(refusal(['api'])).toMatch(/cannot tell/);
    expect(refusal(['api', 'repos/Acme/Sandbox/issues', 'repos/other/place/issues'])).toMatch(/cannot tell/);
  });

  it('refuses a request sent to another host', () => {
    expect(refusal(['api', 'repos/Acme/Sandbox/issues', '--hostname', 'ghe.example.com'])).toMatch(/not allowed/);
  });

  it('only reads who is logged in and the project owner', () => {
    expect(refusal(['api', 'user', '-X', 'PATCH', '--input', '-'])).toMatch(/not in/);
    expect(refusal(['api', 'user', '-f', 'name=x'])).toMatch(/not in/);
    expect(refusal(['api', 'users/acme', '-X', 'DELETE'])).toMatch(/not in/);
    expect(refusal(['api', 'users/acme', '--method', 'GET'])).toBeUndefined();
  });

  it('never changes the repository itself', () => {
    expect(refusal(['api', '-X', 'DELETE', 'repos/Acme/Sandbox'])).toMatch(/repository itself/);
    expect(refusal(['api', '--method', 'delete', '/repos/acme/sandbox'])).toMatch(/repository itself/);
    expect(refusal(['api', '-X', 'PATCH', 'repos/Acme/Sandbox', '--input', '-'])).toMatch(/repository itself/);
    expect(refusal(['api', 'repos/Acme/Sandbox', '-f', 'archived=true'])).toMatch(/repository itself/);
    expect(refusal(['api', '-X', 'POST', 'repos/Acme/Sandbox/transfer', '--input', '-'])).toMatch(/moves or archives/);
    expect(refusal(['api', 'repos/Acme/Sandbox'])).toBeUndefined();
  });

  it('only touches the projects the suite owns', () => {
    expect(refusal(['api', '/users/acme/projectsV2/8/fields'])).toMatch(/project #8 is not one the suite owns/);
    expect(refusal(['api', '/users/acme/projectsV2/8/fields'], undefined, [8])).toBeUndefined();
    expect(refusal(['api', '-X', 'DELETE', '/users/acme/projectsV2/7'])).toMatch(/deleting a project/);
  });
});

describe('e2e guard: GraphQL', () => {
  const call = ['api', 'graphql', '--input', '-'];

  it('needs its request on stdin', () => {
    expect(refusal(call)).toMatch(/stdin/);
    expect(refusal(['api', 'graphql', '-f', 'query={viewer{login}}'])).toMatch(/stdin/);
    expect(refusal(call, 'not json')).toMatch(/stdin/);
    expect(refusal(call, '[]')).toMatch(/stdin/);
    expect(refusal(call, JSON.stringify({ variables: {} }))).toMatch(/stdin/);
    expect(refusal(call, JSON.stringify({ query: 'query { a }', variables: 'x' }))).toMatch(/stdin/);
  });

  it('refuses another repository, owner or project in the variables', () => {
    expect(refusal(call, graphql({ repoOwner: 'other', repoName: 'sandbox' }))).toMatch(/name repository other\/sandbox/);
    expect(refusal(call, graphql({ repoOwner: 'acme', repoName: 'place' }))).toMatch(/name repository acme\/place/);
    expect(refusal(call, graphql({ repoOwner: 'acme' }))).toMatch(/name repository/);
    expect(refusal(call, graphql({ owner: 'other', number: 7 }))).toMatch(/variable owner is not acme/);
    expect(refusal(call, graphql({ projectOwner: 'other', projectNumber: 7 }))).toMatch(/variable projectOwner is not acme/);
    expect(refusal(call, graphql({ owner: 'acme', number: 8 }))).toMatch(/project #8 is not one the suite owns/);
    expect(refusal(call, graphql({ owner: 'acme', number: '7' }))).toMatch(/project #7 is not one the suite owns/);
    expect(refusal(call, graphql({ projectOwner: 'acme', projectNumber: 9 }))).toMatch(/project #9/);
    expect(refusal(call, graphql({ owner: 'acme', number: 8 }), [8])).toBeUndefined();
  });

  it('refuses a mutation that deletes, archives or transfers', () => {
    for (const mutation of [
      'mutation($input: X!) { deleteProjectV2(input: $input) { clientMutationId } }',
      'mutation($input: X!) { deleteProjectV2Item(input: $input) { deletedItemId } }',
      'mutation($input: X!) { archiveProjectV2Item (input: $input) { item { id } } }',
      'mutation($input: X!) { transferRepository(input: $input) { repository { id } } }',
      'mutation($input: X!) { deleteIssue(input: $input) { clientMutationId } }',
    ]) {
      expect(refusal(call, graphql({ input: {} }, mutation)), mutation).toMatch(/deletes, archives or transfers/);
    }
    // Clearing a field value and adding an item are what the suite does.
    expect(refusal(call, graphql({ input: {} }, 'mutation($input: X!) { clearProjectV2ItemFieldValue(input: $input) { projectV2Item { id } } }'))).toBeUndefined();
    expect(refusal(call, graphql({ input: {} }, 'query { node(id: "x") { ... on Issue { isArchived } } }'))).toBeUndefined();
  });
});

describe('e2e guard: gh project', () => {
  it('needs --owner, and the owner of the suite', () => {
    expect(refusal(['project', 'create', '--title', 'x'])).toMatch(/needs --owner acme/);
    expect(refusal(['project', 'item-list', '7'])).toMatch(/needs --owner acme/);
    expect(refusal(['project', 'list'])).toMatch(/needs --owner acme/);
    expect(refusal(['project', 'create', '--owner', 'other', '--title', 'x'])).toMatch(/--owner other is not acme/);
    expect(refusal(['project', 'item-list', '7', '--owner=other'])).toMatch(/--owner other is not acme/);
    expect(refusal(['project', 'create', '--owner', 'ACME', '--title', 'x'])).toBeUndefined();
  });

  it('only reads a project number the suite owns', () => {
    expect(refusal(['project', 'item-list', '8', '--owner', 'acme'])).toMatch(/project #8 is not one the suite owns/);
    expect(refusal(['project', 'view', '8', '--owner', 'acme'])).toMatch(/project #8/);
    expect(refusal(['project', 'field-list', '8', '--owner', 'acme'])).toMatch(/project #8/);
    expect(refusal(['project', 'item-list', '8', '--owner', 'acme'], undefined, [7, 8])).toBeUndefined();
    expect(refusal(['project', 'item-list', '--owner', 'acme'])).toMatch(/needs one project number/);
    expect(refusal(['project', 'item-list', 'seven', '--owner', 'acme'])).toMatch(/needs one project number/);
    expect(refusal(['project', 'item-list', '7', '8', '--owner', 'acme'])).toMatch(/needs one project number/);
    expect(refusal(['project', 'create', '7', '--owner', 'acme'])).toMatch(/takes no number/);
  });

  it('refuses every other subcommand', () => {
    for (const sub of ['delete', 'close', 'edit', 'copy', 'link', 'unlink', 'mark-template', 'item-delete', 'item-archive', 'field-delete', 'item-add']) {
      expect(refusal(['project', sub, '7', '--owner', 'acme']), sub).toMatch(/not a command the suite uses/);
    }
    expect(refusal(['project', '--owner', 'acme'])).toMatch(/not a command the suite uses/);
  });
});

describe('e2e guard: anything else is refused', () => {
  it('refuses a command the suite does not use', () => {
    for (const args of [['auth', 'status'], ['auth', 'logout'], ['extension', 'install', 'x'], ['alias', 'set', 'a', 'b'], ['gist', 'create'], ['ssh-key', 'add'], ['config', 'set', 'a', 'b'], ['codespace', 'delete'], ['org', 'list']]) {
      expect(refusal([...args, '--repo', REPO]), args.join(' ')).toMatch(/is not a command the suite uses/);
    }
  });

  it('refuses a call with no command', () => {
    expect(refusal([])).toBe('no command');
    expect(refusal(['--repo', REPO])).toBe('no command');
  });
});

describe('e2e guard: the runner', () => {
  const answer = { stdout: '{}', stderr: '', code: 0 };

  it('passes an allowed call to the inner runner, with its stdin', async () => {
    const inner = vi.fn().mockResolvedValue(answer);
    const run = sandboxRunner(scope(), inner);
    await expect(run(['api', 'repos/Acme/Sandbox/issues', '--paginate'])).resolves.toBe(answer);
    await expect(run(['api', 'graphql', '--input', '-'], graphql({ owner: 'acme', number: 7 }))).resolves.toBe(answer);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(inner).toHaveBeenLastCalledWith(['api', 'graphql', '--input', '-'], graphql({ owner: 'acme', number: 7 }));
  });

  it('rejects a refused call without running it, and says why', async () => {
    const inner = vi.fn().mockResolvedValue(answer);
    const run = sandboxRunner(scope(), inner);
    await expect(run(['issue', 'list'])).rejects.toThrow(/e2e guard: refused `gh issue list`: gh issue needs --repo Acme\/Sandbox/);
    await expect(run(['api', 'repos/other/place/issues'])).rejects.toThrow(/e2e guard: refused/);
    await expect(run(['repo', 'delete', '--repo', REPO])).rejects.toThrow(/e2e guard: refused/);
    expect(inner).not.toHaveBeenCalled();
  });

  it('follows the set of projects the suite owns, which grows when it creates one', async () => {
    const inner = vi.fn().mockResolvedValue(answer);
    const projects = new Set<number>();
    const run = sandboxRunner({ repo: REPO, projectOwner: OWNER, projects }, inner);
    const list = ['project', 'item-list', '12', '--owner', OWNER];
    await expect(run(list)).rejects.toThrow(/project #12 is not one the suite owns/);
    projects.add(12);
    await expect(run(list)).resolves.toBe(answer);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
