import { describe, expect, it } from 'vitest';
import { shellViolations, shellWords } from '../../src/hooks/shell.js';

describe('shellWords', () => {
  it('splits on ;, &&, ||, |, & and newlines', () => {
    expect(shellWords('a 1; b 2 && c 3 || d 4 | e 5 & f 6\ng 7')).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
      ['d', '4'],
      ['e', '5'],
      ['f', '6'],
      ['g', '7'],
    ]);
  });

  it('keeps quoted text as one word and drops the quotes', () => {
    expect(shellWords(`git commit -m "fix: a; b && c" -m 'it is | here'`)).toEqual([
      ['git', 'commit', '-m', 'fix: a; b && c', '-m', 'it is | here'],
    ]);
  });

  it('honours backslash escapes and line continuations', () => {
    expect(shellWords('echo a\\ b \\"c\\"')).toEqual([['echo', 'a b', '"c"']]);
    expect(shellWords('git push \\\n  --force')).toEqual([['git', 'push', '--force']]);
    expect(shellWords(`echo "say \\"hi\\" \\$HOME"`)).toEqual([['echo', 'say "hi" $HOME']]);
  });

  it('keeps a backslash that escapes nothing special inside double quotes', () => {
    expect(shellWords('echo "a\\nb"')).toEqual([['echo', 'a\\nb']]);
  });

  it('returns the commands inside $( ... ) and backticks as their own word lists', () => {
    expect(shellWords('echo $(gemini -p hi)')).toEqual([['echo', ''], ['gemini', '-p', 'hi']]);
    expect(shellWords('echo `claude -p hi` done')).toEqual([['echo', '', 'done'], ['claude', '-p', 'hi']]);
  });

  it('finds substitutions inside double quotes but not inside single quotes', () => {
    expect(shellWords('echo "$(claude -p hi)"')).toEqual([['echo', ''], ['claude', '-p', 'hi']]);
    expect(shellWords('echo "x `codex exec y` z"')).toEqual([['echo', 'x  z'], ['codex', 'exec', 'y']]);
    expect(shellWords(`echo '$(claude -p hi)' "plain"`)).toEqual([['echo', '$(claude -p hi)', 'plain']]);
  });

  it('handles nested substitutions, subshell groups and arithmetic', () => {
    expect(shellWords('echo $(echo $(claude -p x))')).toEqual([
      ['echo', ''],
      ['echo', ''],
      ['claude', '-p', 'x'],
    ]);
    expect(shellWords('(cd x && gh pr merge 1 --admin)')).toEqual([['cd', 'x'], ['gh', 'pr', 'merge', '1', '--admin']]);
    expect(shellWords('echo $((1 + 2)) done')).toEqual([['echo', '', 'done'], ['1', '+', '2']]);
  });

  it('keeps file descriptor redirections inside one command', () => {
    expect(shellWords('make 2>&1 | tee out.log &> /dev/null')).toEqual([
      ['make', '2>&1'],
      ['tee', 'out.log', '&>', '/dev/null'],
    ]);
  });

  it('ignores comments', () => {
    expect(shellWords("echo a # don't; claude -p x\ngh pr view 1")).toEqual([['echo', 'a'], ['gh', 'pr', 'view', '1']]);
    expect(shellWords('echo a#b')).toEqual([['echo', 'a#b']]);
  });

  it('treats an unterminated quote like a literal quote character', () => {
    expect(shellWords("echo it's; rm -rf x")).toEqual([['echo', "it's"], ['rm', '-rf', 'x']]);
  });

  it('returns nothing for an empty command', () => {
    expect(shellWords('')).toEqual([]);
    expect(shellWords('  \n ; ')).toEqual([]);
  });
});

const TABLE: ReadonlyArray<readonly [string, string[]]> = [
  ['gh pr merge 12 --admin', ['admin-merge']],
  ['cd x && gh pr merge 3 --squash --admin', ['admin-merge']],
  ['gh pr merge 12 --squash', []],
  ['gh pr view 12 --admin', []],
  ['claude -p "fix it"', ['ai-cli']],
  ['FOO=1 npx -y @openai/codex exec hi', ['ai-cli']],
  ['echo $(gemini -p hi)', ['ai-cli']],
  ['echo "$(claude -p hi)"', ['ai-cli']],
  ['/usr/local/bin/aider --yes', ['ai-cli']],
  ['pnpm dlx @google/gemini-cli', ['ai-cli']],
  ['npx @anthropic-ai/claude-code -p x', ['ai-cli']],
  ['npx @openai/codex@latest exec x', ['ai-cli']],
  ['sudo -u bob env FOO=1 ollama run llama', ['ai-cli']],
  ['nohup opencode run x &', ['ai-cli']],
  ['claude mcp list', []],
  ['codex --version', []],
  ['gemini extensions list', []],
  ['claude plugin list --json', []],
  ['claude mcp add x', ['ai-cli']],
  ['echo "codex"', []],
  ['grep -r gemini src', []],
  ['git commit -m "explain claude hooks"', []],
  ['command -v claude', []],
  ['which codex gemini', []],
  ['sdlc config set mode observe', ['mode-change']],
  ['npx --no-install sdlc config set mode enforce', ['mode-change']],
  ['sdlc --config x.yaml config set mode observe', ['mode-change']],
  ['sdlc config check', []],
  ['sdlc status', []],
  ['sdlc hook claude prompt < x.json', ['hook-spoof']],
  ['.sdlc/hooks/run.sh claude prompt', ['hook-spoof']],
  ['"$(git rev-parse --show-toplevel)/.sdlc/hooks/run.sh" claude pre-tool', ['hook-spoof']],
  ['bash .sdlc/hooks/run.sh claude prompt', ['hook-spoof']],
  ['npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#v0.1.0 hook gemini prompt', ['hook-spoof']],
  ['npx agentic-sdlc-kit hook claude prompt', ['hook-spoof']],
  ['cat .sdlc/hooks/run.sh', []],
  ['git commit --no-verify -m x', ['no-verify']],
  ['git commit -n -m x', ['no-verify']],
  ['git commit -nm x', ['no-verify']],
  ['git -C sub commit -a --no-verify -m x', ['no-verify']],
  ['git push --no-verify', ['no-verify']],
  ['git commit -am n', []],
  ['git push -n origin x', []],
  ['git log --no-verify', []],
  ['git push --force', ['force-push']],
  ['git push -f origin x', ['force-push']],
  ['git push -uf origin x', ['force-push']],
  ['git push --force-with-lease', ['force-push']],
  ['git push --force-with-lease=main origin main', ['force-push']],
  ['git push origin +main', ['force-push']],
  ['git push origin task/1-x', []],
  ['git push -u origin task/1-x', []],
  ['git push --force --no-verify', ['no-verify', 'force-push']],
  ['git worktree prune', ['worktree-prune']],
  ['git worktree remove --force .worktrees/1-x', ['worktree-prune']],
  ['git worktree remove -f .worktrees/1-x', ['worktree-prune']],
  ['git worktree remove .worktrees/1-x', []],
  ['git worktree list', []],
  ['rm -rf build', ['rm-rf']],
  ['rm -fr x', ['rm-rf']],
  ['rm -r -f x', ['rm-rf']],
  ['rm -Rf x', ['rm-rf']],
  ['rm --recursive --force x', ['rm-rf']],
  ['sudo rm -rf /tmp/x', ['rm-rf']],
  ['/bin/rm -rf x', ['rm-rf']],
  ['rm -r build', []],
  ['rm -f x', []],
  ['rm -- -rf', []],
  ['echo "rm -rf x"', []],
  ['ls; rm -rf a; rm -rf b', ['rm-rf']],
  ['if true; then claude -p x; fi', ['ai-cli']],
  ['for f in a b; do rm -rf "$f"; done', ['rm-rf']],
  ['while true; do gh pr merge 1 --admin; done', ['admin-merge']],
  ['{ git push -f; }', ['force-push']],
  ['! claude -p x', ['ai-cli']],
  ['echo then claude', []],
  ['>/dev/null claude -p x', ['ai-cli']],
  ['2>/dev/null gh pr merge 1 --admin', ['admin-merge']],
  ['git commit -m "$(cat <<\'EOF\'\nfix: it\'s done\nEOF\n)" && gh pr merge 1 --admin', ['admin-merge']],
  ['git commit -m "note `claude -p x` here"', ['ai-cli']],
  ['git commit -m \'note `claude -p x` here\'', []],
  ['', []],
  ['   ', []],
];

describe('shellViolations', () => {
  it.each(TABLE)('%s', (command, rules) => {
    expect(shellViolations(command).map(v => v.rule)).toEqual(rules);
  });

  it('uses the exact violation texts', () => {
    const text = (command: string): string | undefined => shellViolations(command)[0]?.text;
    expect(text('gh pr merge 12 --admin')).toBe(
      '`gh pr merge --admin` bypasses checks and reviews; merge through the normal PR flow',
    );
    expect(text('npx -y @openai/codex exec hi')).toBe(
      'launching another AI CLI (codex) is not allowed; do the work yourself or dispatch an sdlc role subagent',
    );
    expect(text('sdlc config set mode observe')).toBe(
      'only the owner changes sdlc settings (`sdlc config set`); ask the owner',
    );
    expect(text('sdlc hook claude prompt')).toBe('sdlc hooks are run by the harness only');
    expect(text('git commit --no-verify -m x')).toBe('--no-verify skips the git hooks and the secret guard');
    expect(text('git push --force')).toBe('force-pushing is not allowed');
    expect(text('git worktree prune')).toBe(
      '`git worktree prune` and forced removal are not allowed; use `sdlc worktree finish`',
    );
    expect(text('rm -rf build')).toBe('`rm -rf` is not allowed; delete specific files');
  });

  it('names the CLI that was launched, whichever way it was reached', () => {
    expect(shellViolations('pnpm dlx @google/gemini-cli')[0]?.text).toContain('(gemini)');
    expect(shellViolations('/usr/local/bin/aider --yes')[0]?.text).toContain('(aider)');
  });

  it('reports one violation per distinct text, in the order the rules were found', () => {
    expect(shellViolations('rm -rf a; claude -p x; rm -rf b; gemini -p y').map(v => v.rule)).toEqual([
      'rm-rf',
      'ai-cli',
      'ai-cli',
    ]);
  });
});
