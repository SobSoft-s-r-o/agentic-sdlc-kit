import { rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseUnifiedDiff, pushedChanges, stagedChanges, type ChangeSet } from '../../src/secrets/gitDiff.js';
import { scanChanges } from '../../src/secrets/scan.js';
import { createGitRunner, type GitRunner } from '../../src/install/provision.js';
import { githubToken } from '../support/secrets.js';
import { createTestRepo, type TestRepo } from '../support/gitRepo.js';

const ZEROS = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const diff = (...lines: string[]): string => `${lines.join('\n')}\n`;

describe('parseUnifiedDiff', () => {
  it('gives the line numbers of added lines across two hunks of one file', () => {
    const text = diff(
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -2,0 +3,2 @@ function f() {',
      '+added three',
      '+added four',
      '@@ -10 +12,2 @@',
      '-old ten',
      '+new twelve',
      '+new thirteen',
    );

    expect(parseUnifiedDiff(text)).toEqual([
      {
        path: 'src/a.ts',
        lines: [
          { line: 3, text: 'added three' },
          { line: 4, text: 'added four' },
          { line: 12, text: 'new twelve' },
          { line: 13, text: 'new thirteen' },
        ],
      },
    ]);
  });

  it('a hunk header without a count means one line', () => {
    const text = diff('diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -4 +7 @@', '-old', '+new');

    expect(parseUnifiedDiff(text)).toEqual([{ path: 'x', lines: [{ line: 7, text: 'new' }] }]);
  });

  it('reads a new file, and skips a deleted file and a binary file', () => {
    const text = diff(
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      'index 4444444..0000000',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-secret one',
      '-secret two',
      'diff --git a/logo.png b/logo.png',
      'new file mode 100644',
      'index 0000000..5555555',
      'Binary files /dev/null and b/logo.png differ',
      'diff --git a/after.txt b/after.txt',
      '--- a/after.txt',
      '+++ b/after.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    );

    expect(parseUnifiedDiff(text)).toEqual([
      {
        path: 'new.txt',
        lines: [
          { line: 1, text: 'one' },
          { line: 2, text: 'two' },
        ],
      },
      { path: 'after.txt', lines: [{ line: 1, text: 'b' }] },
    ]);
  });

  it('a file with only removed lines has nothing to scan and is left out', () => {
    const text = diff('diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -3,2 +2,0 @@ ctx', '-a', '-b');

    expect(parseUnifiedDiff(text)).toEqual([]);
  });

  it('counts context lines, ignores "\\ No newline", and keeps the text exactly (CR, tabs, leading spaces)', () => {
    const text = diff(
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,3 +1,4 @@',
      ' context',
      '+  indented\ttab\r',
      '\\ No newline at end of file',
      ' context two',
      '+last',
    );

    expect(parseUnifiedDiff(text)).toEqual([
      {
        path: 'x',
        lines: [
          { line: 2, text: '  indented\ttab\r' },
          { line: 4, text: 'last' },
        ],
      },
    ]);
  });

  it('an added line that looks like a file header is content, not a header (a secret cannot hide behind "++")', () => {
    const secret = githubToken();
    const text = diff(
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -0,0 +1,4 @@',
      '++ b/elsewhere.ts',
      `++ ${secret}`,
      '++ /dev/null',
      '+-- a/other',
    );

    const [file, ...rest] = parseUnifiedDiff(text);

    expect(rest).toEqual([]);
    expect(file?.path).toBe('src/a.ts');
    expect(file?.lines).toEqual([
      { line: 1, text: '+ b/elsewhere.ts' },
      { line: 2, text: `+ ${secret}` },
      { line: 3, text: '+ /dev/null' },
      { line: 4, text: '-- a/other' },
    ]);
    expect(scanChanges({ files: parseUnifiedDiff(text), names: [] }, []).map(finding => finding.rule)).toEqual([
      'github-token',
    ]);
  });

  it('an added line that looks like a diff header or a hunk header is content too', () => {
    const text = diff(
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -0,0 +1,3 @@',
      '+diff --git a/y b/y',
      '+@@ -1 +9 @@',
      '+Binary files a and b differ',
    );

    expect(parseUnifiedDiff(text)).toEqual([
      {
        path: 'x',
        lines: [
          { line: 1, text: 'diff --git a/y b/y' },
          { line: 2, text: '@@ -1 +9 @@' },
          { line: 3, text: 'Binary files a and b differ' },
        ],
      },
    ]);
  });

  it('a file that is deleted, then one that is added, do not mix up their lines', () => {
    const text = diff(
      'diff --git a/gone b/gone',
      '--- a/gone',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-+++ b/trick',
      '-+not added',
      'diff --git a/new b/new',
      '--- /dev/null',
      '+++ b/new',
      '@@ -0,0 +1 @@',
      '+x',
    );

    expect(parseUnifiedDiff(text)).toEqual([{ path: 'new', lines: [{ line: 1, text: 'x' }] }]);
  });

  it('reads the path of a rename with edits, a path with spaces and a quoted path', () => {
    const text = diff(
      'diff --git a/old name.txt b/new name.txt',
      'similarity index 80%',
      'rename from old name.txt',
      'rename to new name.txt',
      '--- a/old name.txt',
      '+++ b/new name.txt\t',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git "a/caf\\303\\251.key" "b/caf\\303\\251.key"',
      '--- /dev/null',
      '+++ "b/caf\\303\\251 \\"q\\".key"',
      '@@ -0,0 +1 @@',
      '+c',
      // A quoted path with a space gets git's trailing tab after the closing quote.
      'diff --git "a/caf\\303\\251 y.md" "b/caf\\303\\251 y.md"',
      '--- /dev/null',
      '+++ "b/caf\\303\\251 y.md"\t',
      '@@ -0,0 +1 @@',
      '+d',
    );

    expect(parseUnifiedDiff(text).map(file => file.path)).toEqual(['new name.txt', 'café "q".key', 'café y.md']);
  });

  it('decodes git octal escapes and keeps non-ASCII characters outside the BMP whole', () => {
    const text = diff(
      'diff --git "a/\\360\\237\\224\\221.txt" "b/\\360\\237\\224\\221.txt"',
      '--- /dev/null',
      '+++ "b/\\360\\237\\224\\221.txt"',
      '@@ -0,0 +1 @@',
      '+a',
      'diff --git a/\u{1F511}2.txt b/\u{1F511}2.txt',
      '--- /dev/null',
      '+++ "b/\u{1F511}2 \\t.txt"\t',
      '@@ -0,0 +1 @@',
      '+b',
    );

    expect(parseUnifiedDiff(text).map(file => file.path)).toEqual(['\u{1F511}.txt', '\u{1F511}2 \t.txt']);
  });

  it('reads a combined diff of a merge: only a line that is new to every parent is added', () => {
    const text = diff(
      'diff --cc f.txt',
      'index 74e8ad8,2b1936b..b878a33',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@@ -4,1 -4,1 +4,3 @@@',
      '- main',
      ' -side',
      '++resolved by hand',
      ' +from the first parent',
      '+ from the second parent',
      '++another new line',
    );

    expect(parseUnifiedDiff(text)).toEqual([
      {
        path: 'f.txt',
        lines: [
          { line: 4, text: 'resolved by hand' },
          { line: 7, text: 'another new line' },
        ],
      },
    ]);
  });

  it('gives nothing for empty text, and stops on a hunk header it cannot read (the guard fails closed)', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('\n\n')).toEqual([]);
    expect(() => parseUnifiedDiff(diff('diff --git a/x b/x', '+++ b/x', '@@ nonsense @@', '+x'))).toThrow(
      'unreadable hunk header',
    );
  });

  it('the error for a hunk header it cannot read names the file and the line, and holds no diff text', () => {
    const token = githubToken();
    const text = diff('diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -0,0 +1 @@', '+ok', 'diff --git a/y.ts b/y.ts', '+++ b/y.ts', `@@ ${token} @@`, '+x');

    expect(() => parseUnifiedDiff(text)).toThrow('unreadable hunk header in y.ts (line 8 of the diff)');
    let message = '';
    try {
      parseUnifiedDiff(text);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(token);
    expect(message).not.toContain(token.slice(0, 6));
    expect(() => parseUnifiedDiff(diff('@@ nonsense @@'))).toThrow('unreadable hunk header (line 1 of the diff)');
  });

  it('skips blank lines between files (git log prints one after a commit)', () => {
    const text = diff(
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -0,0 +1 @@',
      '+one',
      '',
      'diff --git a/y b/y',
      '--- a/y',
      '+++ b/y',
      '@@ -0,0 +1 @@',
      '+two',
      '',
    );

    expect(parseUnifiedDiff(text).map(file => file.path)).toEqual(['x', 'y']);
  });
});

// -- with a fake git ---------------------------------------------------------------------------------

interface Call {
  args: string[];
}

function fakeGit(answers: Array<{ code?: number; stdout?: string; stderr?: string } | Error>): {
  git: GitRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const git: GitRunner = async args => {
    calls.push({ args });
    const answer = answers[calls.length - 1];
    if (answer === undefined) throw new Error(`unexpected git call: ${args.join(' ')}`);
    if (answer instanceof Error) throw answer;
    return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
  };
  return { git, calls };
}

const ADDED = diff('diff --git a/a.txt b/a.txt', '--- /dev/null', '+++ b/a.txt', '@@ -0,0 +1 @@', '+hello');

describe('stagedChanges', () => {
  it('runs the two git commands of the brief and gives the added lines and the staged names', async () => {
    const { git, calls } = fakeGit([{ stdout: ADDED }, { stdout: 'a.txt\0.env\0' }]);

    const changes = await stagedChanges(git);

    expect(calls.map(call => call.args)).toEqual([
      [
        'diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-textconv',
        '--src-prefix=a/', '--dst-prefix=b/', '--diff-filter=ACMRT',
      ],
      ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACRT'],
    ]);
    expect(changes).toEqual({ files: [{ path: 'a.txt', lines: [{ line: 1, text: 'hello' }] }], names: ['a.txt', '.env'] });
  });

  it('a failing git command throws (the guard blocks), naming the command and the reason', async () => {
    await expect(stagedChanges(fakeGit([{ code: 128, stderr: 'fatal: not a git repository\nmore' }]).git)).rejects.toThrow(
      'git diff failed: fatal: not a git repository',
    );
    await expect(
      stagedChanges(fakeGit([{ stdout: '' }, { code: 1, stderr: '' }]).git),
    ).rejects.toThrow('git diff failed: exit code 1');
  });

  it('a git that cannot run at all throws too', async () => {
    await expect(stagedChanges(fakeGit([new Error('git not found; install https://git-scm.com')]).git)).rejects.toThrow(
      'git not found',
    );
  });
});

describe('pushedChanges', () => {
  const LOG = [
    'log', '-p', '-U0', '--no-color', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/', '--root', '--cc', '--format=',
  ];
  const NAMES = ['log', '--name-only', '-z', '--no-color', '--root', '--diff-filter=ACRT', '--format='];

  it('scans <remote sha>..<local sha> of each pushed ref, patch and names', async () => {
    const { git, calls } = fakeGit([{ stdout: ADDED }, { stdout: 'a.txt\0' }]);

    const changes = await pushedChanges(git, [{ localSha: B, remoteSha: A, deleting: false }]);

    expect(calls.map(call => call.args)).toEqual([[...LOG, `${A}..${B}`], [...NAMES, `${A}..${B}`]]);
    expect(changes.files.map(file => file.path)).toEqual(['a.txt']);
    expect(changes.names).toEqual(['a.txt']);
  });

  it('a new branch (remote sha all zeros) uses <local sha> --not --remotes', async () => {
    const { git, calls } = fakeGit([{ stdout: '' }, { stdout: '' }]);

    await pushedChanges(git, [{ localSha: B, remoteSha: ZEROS, deleting: false }]);

    expect(calls.map(call => call.args)).toEqual([
      [...LOG, B, '--not', '--remotes'],
      [...NAMES, B, '--not', '--remotes'],
    ]);
  });

  it('a deletion is skipped, and with nothing else no git command runs', async () => {
    const { git, calls } = fakeGit([]);

    expect(await pushedChanges(git, [{ localSha: ZEROS, remoteSha: A, deleting: true }])).toEqual({ files: [], names: [] });
    expect(calls).toEqual([]);
  });

  it('when the remote sha is not known locally it falls back to <local sha> --not --remotes', async () => {
    const { git, calls } = fakeGit([
      { code: 128, stderr: 'fatal: bad revision' },
      { stdout: ADDED },
      { stdout: 'a.txt\0' },
    ]);

    const changes = await pushedChanges(git, [{ localSha: B, remoteSha: A, deleting: false }]);

    expect(calls.map(call => call.args)).toEqual([
      [...LOG, `${A}..${B}`],
      [...LOG, B, '--not', '--remotes'],
      [...NAMES, B, '--not', '--remotes'],
    ]);
    expect(changes.files).toHaveLength(1);
  });

  it('a log that fails both ways throws; so does a names command that fails', async () => {
    const update = [{ localSha: B, remoteSha: A, deleting: false }];

    await expect(
      pushedChanges(fakeGit([{ code: 128, stderr: 'fatal: bad object' }, { code: 128, stderr: 'fatal: bad object' }]).git, update),
    ).rejects.toThrow('git log failed: fatal: bad object');
    await expect(
      pushedChanges(fakeGit([{ stdout: '' }, { code: 128, stderr: 'boom' }]).git, update),
    ).rejects.toThrow('git log failed: boom');
  });

  it('combines several refs, each once', async () => {
    const { git } = fakeGit([{ stdout: ADDED }, { stdout: 'a.txt\0' }, { stdout: ADDED }, { stdout: 'a.txt\0b.pem\0' }]);

    const changes = await pushedChanges(git, [
      { localSha: B, remoteSha: A, deleting: false },
      { localSha: A, remoteSha: ZEROS, deleting: false },
    ]);

    expect(changes.names).toEqual(['a.txt', 'b.pem']);
    expect(changes.files).toHaveLength(2);
  });

  it('refuses a sha that is not an object name, so it can never be taken for an option', async () => {
    const { git, calls } = fakeGit([]);

    await expect(pushedChanges(git, [{ localSha: '--output=/tmp/x', remoteSha: A, deleting: false }])).rejects.toThrow(
      'unexpected object name',
    );
    await expect(pushedChanges(git, [{ localSha: B, remoteSha: 'not-a-sha', deleting: false }])).rejects.toThrow(
      'unexpected object name',
    );
    expect(calls).toEqual([]);
  });
});

// -- with real git -------------------------------------------------------------------------------------

describe('with real git', () => {
  let repo: TestRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
    repo = undefined;
    vi.unstubAllEnvs();
  });

  const setup = (): TestRepo => {
    repo = createTestRepo();
    return repo;
  };
  const scanned = (changes: ChangeSet) =>
    scanChanges(changes, []).map(finding => `${finding.path}:${finding.line ?? '-'}:${finding.rule}`);

  it('stagedChanges: a staged token and a staged .env are found, an unstaged one is not', async () => {
    const r = setup();
    r.write('README.md', 'hello\n');
    r.commit('init');
    r.write('src/config.ts', `export const a = 1;\nexport const token = "${githubToken()}";\n`);
    r.write('.env', 'FOO=bar\n');
    r.write('unstaged.ts', `const t = "${githubToken()}";\n`);
    r.git('add', 'src/config.ts', '.env');

    const changes = await stagedChanges(createGitRunner(r.root));

    expect(scanned(changes)).toEqual(['src/config.ts:2:github-token', '.env:-:env-file']);
  });

  it('stagedChanges: works before the first commit, and sees a rename to a secret file name', async () => {
    const r = setup();
    r.write('plain.txt', 'one\ntwo\n');
    r.git('add', '-A');
    expect(scanned(await stagedChanges(createGitRunner(r.root)))).toEqual([]);
    r.commit('first');
    r.git('mv', 'plain.txt', 'server.pem');

    expect(scanned(await stagedChanges(createGitRunner(r.root)))).toEqual(['server.pem:-:key-file']);
  });

  it('stagedChanges: a removed .env is not a finding, a file name with unusual characters is still checked', async () => {
    const r = setup();
    r.write('.env', 'A=1\n');
    r.commit('oops');
    r.git('rm', '-q', '--cached', '.env');
    r.write('café.key', 'x\n');
    r.write('with space/id_rsa', 'x\n');
    r.git('add', 'café.key', 'with space/id_rsa');

    const changes = await stagedChanges(createGitRunner(r.root));

    expect([...changes.names].sort()).toEqual(['café.key', 'with space/id_rsa']);
    expect(scanned(changes).sort()).toEqual(['café.key:-:key-file', 'with space/id_rsa:-:ssh-private-key-file']);
  });

  it('stagedChanges: a "++" line cannot hide a token', async () => {
    const r = setup();
    r.write('seed.txt', 'x\n');
    r.commit('init');
    r.write('trick.txt', `+ b/dev/null\n+ ${githubToken()}\n`);
    r.git('add', 'trick.txt');

    expect(scanned(await stagedChanges(createGitRunner(r.root)))).toEqual(['trick.txt:2:github-token']);
  });

  it('stagedChanges: git config that changes the diff output does not matter', async () => {
    const r = setup();
    r.write('seed.txt', 'x\n');
    r.commit('init');
    r.git('config', 'diff.noprefix', 'true');
    r.git('config', 'diff.mnemonicPrefix', 'true');
    r.git('config', 'diff.external', 'false');
    r.write('app.ts', `const t = "${githubToken()}";\n`);
    r.git('add', 'app.ts');

    expect(scanned(await stagedChanges(createGitRunner(r.root)))).toEqual(['app.ts:1:github-token']);
  });

  it('pushedChanges: a token in an earlier commit of the range is found even if a later commit removed it', async () => {
    const r = setup();
    r.write('seed.txt', 'x\n');
    r.commit('init');
    const base = r.git('rev-parse', 'HEAD').trim();
    r.write('leak.ts', `const t = "${githubToken()}";\n`);
    r.write('.env.local', 'A=1\n');
    r.commit('leak');
    r.write('leak.ts', 'const t = process.env.T;\n');
    r.git('rm', '-q', '.env.local');
    r.commit('fix');
    const head = r.git('rev-parse', 'HEAD').trim();

    const changes = await pushedChanges(createGitRunner(r.root), [{ localSha: head, remoteSha: base, deleting: false }]);

    expect(scanned(changes).sort()).toEqual(['.env.local:-:env-file', 'leak.ts:1:github-token']);
  });

  it('pushedChanges: a new branch is scanned against the remotes only', async () => {
    const r = setup();
    r.write('old.ts', `const t = "${githubToken()}";\n`);
    r.commit('already on the remote');
    r.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    r.git('checkout', '-q', '-b', 'topic');
    r.write('new.ts', `const t = "${githubToken()}";\n`);
    r.commit('new work');
    const head = r.git('rev-parse', 'HEAD').trim();

    const changes = await pushedChanges(createGitRunner(r.root), [{ localSha: head, remoteSha: ZEROS, deleting: false }]);

    expect(scanned(changes)).toEqual(['new.ts:1:github-token']);
  });

  it('pushedChanges: a remote sha this repository does not have still scans the push', async () => {
    const r = setup();
    r.write('seed.txt', 'x\n');
    r.commit('init');
    r.write('leak.ts', `const t = "${githubToken()}";\n`);
    r.commit('leak');
    const head = r.git('rev-parse', 'HEAD').trim();

    const changes = await pushedChanges(createGitRunner(r.root), [
      { localSha: head, remoteSha: 'c'.repeat(40), deleting: false },
    ]);

    expect(scanned(changes)).toEqual(['leak.ts:1:github-token']);
  });

  it('pushedChanges: a secret that only a merge commit adds (a conflict resolved by hand) is found', async () => {
    const r = setup();
    r.write('f.txt', 'a\nb\nc\n');
    r.commit('init');
    r.git('checkout', '-q', '-b', 'side');
    r.write('f.txt', 'a\nb\nc\nside\n');
    r.commit('side');
    r.git('checkout', '-q', 'main');
    r.write('f.txt', 'a\nb\nc\nmain\n');
    r.commit('main');
    const base = r.git('rev-parse', 'HEAD').trim();
    try {
      r.git('merge', 'side');
    } catch {
      // The conflict is the point.
    }
    r.write('f.txt', `a\nb\nc\ntoken = "${githubToken()}"\n`);
    r.commit('merge');
    const head = r.git('rev-parse', 'HEAD').trim();

    const changes = await pushedChanges(createGitRunner(r.root), [{ localSha: head, remoteSha: base, deleting: false }]);

    expect(scanned(changes)).toEqual(['f.txt:4:github-token']);
  });

  it('pushedChanges: a clean merge adds no finding of its own, and an old secret of the other side is not re-reported', async () => {
    const r = setup();
    r.write('f.txt', 'a\n');
    r.commit('init');
    r.git('checkout', '-q', '-b', 'side');
    r.write('side.txt', 'side\n');
    r.commit('side');
    r.git('checkout', '-q', 'main');
    r.write('main.txt', `const t = "${githubToken()}";\n`);
    r.commit('main with a token, already pushed');
    r.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    r.git('merge', '-q', '--no-edit', 'side');
    const head = r.git('rev-parse', 'HEAD').trim();
    const remote = r.git('rev-parse', 'origin/main').trim();

    const changes = await pushedChanges(createGitRunner(r.root), [{ localSha: head, remoteSha: remote, deleting: false }]);

    expect(scanned(changes)).toEqual([]);
  });

  describe('what git config and attributes must not be able to hide', () => {
    it('pushedChanges: the root commit is scanned although log.showRoot is false (a new branch, patch and names)', async () => {
      const r = setup();
      r.git('config', 'log.showRoot', 'false');
      r.write('app.ts', `const t = "${githubToken()}";\n`);
      r.write('.env', 'A=1\n');
      r.commit('root, made with --no-verify');
      const head = r.git('rev-parse', 'HEAD').trim();

      const changes = await pushedChanges(createGitRunner(r.root), [{ localSha: head, remoteSha: ZEROS, deleting: false }]);

      expect(scanned(changes).sort()).toEqual(['.env:-:env-file', 'app.ts:1:github-token']);
    });

    it('pushedChanges: the root commit of a history the remote knows nothing of is scanned too (remote sha given)', async () => {
      const r = setup();
      r.git('config', 'log.showRoot', 'false');
      r.write('seed.txt', 'x\n');
      r.commit('what the remote has');
      const remote = r.git('rev-parse', 'HEAD').trim();
      r.git('checkout', '-q', '--orphan', 'unrelated');
      r.git('rm', '-rfq', '.');
      r.write('leak.ts', `const t = "${githubToken()}";\n`);
      r.commit('an unrelated root');
      const head = r.git('rev-parse', 'HEAD').trim();

      const changes = await pushedChanges(createGitRunner(r.root), [{ localSha: head, remoteSha: remote, deleting: false }]);

      expect(scanned(changes)).toEqual(['leak.ts:1:github-token']);
    });

    it('stagedChanges: a textconv driver cannot replace what a staged file holds', async () => {
      const r = setup();
      r.write('.gitattributes', '*.txt diff=hide\n');
      r.git('config', 'diff.hide.textconv', 'echo hidden');
      r.write('seed.md', 'x\n');
      r.commit('init');
      r.write('notes.txt', `token = "${githubToken()}"\n`);
      r.git('add', 'notes.txt');

      expect(scanned(await stagedChanges(createGitRunner(r.root)))).toEqual(['notes.txt:1:github-token']);
    });

    it('pushedChanges: a textconv driver cannot replace what a pushed commit holds', async () => {
      const r = setup();
      r.write('.gitattributes', '*.txt diff=hide\n');
      r.git('config', 'diff.hide.textconv', 'echo hidden');
      r.write('seed.md', 'x\n');
      r.commit('init');
      const base = r.git('rev-parse', 'HEAD').trim();
      r.write('notes.txt', `token = "${githubToken()}"\n`);
      r.commit('leak');
      const head = r.git('rev-parse', 'HEAD').trim();

      const changes = await pushedChanges(createGitRunner(r.root), [{ localSha: head, remoteSha: base, deleting: false }]);

      expect(scanned(changes)).toEqual(['notes.txt:1:github-token']);
    });

    it('stagedChanges: a type change (a symlink that becomes a file) is scanned, by content and by name', async () => {
      const r = setup();
      symlinkSync('target', join(r.root, 'link'));
      symlinkSync('target', join(r.root, '.env'));
      r.commit('two symlinks');
      for (const name of ['link', '.env']) rmSync(join(r.root, name));
      r.write('link', `const t = "${githubToken()}";\n`);
      r.write('.env', 'A=1\n');
      r.git('add', 'link', '.env');
      expect(r.git('diff', '--cached', '--name-status').trim().split('\n').map(line => line.split('\t')[0])).toEqual(['T', 'T']);

      expect(scanned(await stagedChanges(createGitRunner(r.root))).sort()).toEqual(['.env:-:env-file', 'link:1:github-token']);
    });

    it('stagedChanges: diff.mnemonicPrefix and diff.noprefix change no path; a path with a space and non-ASCII is read right', async () => {
      const r = setup();
      r.write('seed.md', 'x\n');
      r.commit('init');
      r.git('config', 'diff.mnemonicPrefix', 'true');
      r.write('café y.md', `token = "${githubToken()}"\n`);
      r.write('b/inner.ts', `token = "${githubToken()}"\n`);
      r.git('add', 'café y.md', 'b/inner.ts');
      const runner = createGitRunner(r.root);

      expect(scanned(await stagedChanges(runner)).sort()).toEqual(['b/inner.ts:1:github-token', 'café y.md:1:github-token']);
      r.git('config', 'diff.noprefix', 'true');
      expect(scanned(await stagedChanges(runner)).sort()).toEqual(['b/inner.ts:1:github-token', 'café y.md:1:github-token']);
    });

    it('pushedChanges: the same for diff.mnemonicPrefix and diff.noprefix', async () => {
      const r = setup();
      r.write('seed.md', 'x\n');
      r.commit('init');
      const base = r.git('rev-parse', 'HEAD').trim();
      r.git('config', 'diff.noprefix', 'true');
      r.write('café y.md', `token = "${githubToken()}"\n`);
      r.write('b/inner.ts', `token = "${githubToken()}"\n`);
      r.commit('leak');
      const head = r.git('rev-parse', 'HEAD').trim();

      const changes = await pushedChanges(createGitRunner(r.root), [{ localSha: head, remoteSha: base, deleting: false }]);

      expect(scanned(changes).sort()).toEqual(['b/inner.ts:1:github-token', 'café y.md:1:github-token']);
    });
  });
});
