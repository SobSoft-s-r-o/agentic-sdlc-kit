import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Manifest {
  repository: { type: string; url: string };
  homepage: string;
  bugs: { url: string };
  keywords: string[];
  author: string;
  publishConfig: { access: string; provenance: boolean };
  files: string[];
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;

let packed: string[];
beforeAll(async () => {
  // `npm pack` takes `dist/` whole, so pack a fresh build instead of trusting a stale one.
  await run('npm', ['run', 'build'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  const [report] = JSON.parse(stdout) as [{ files: { path: string }[] }];
  packed = report.files.map((file) => file.path);
}, 120_000);

describe('npm tarball', () => {
  it('packs only the whitelist', () => {
    const unwanted = packed.filter(
      (path) =>
        ['tests/', 'src/', 'docs/', '.superpowers/'].some((prefix) => path.startsWith(prefix)) ||
        path.endsWith('.d.ts') ||
        path === 'tsconfig.json' ||
        path === 'vitest.config.ts',
    );
    expect(unwanted).toEqual([]);
    for (const wanted of [
      'dist/cli.js',
      'templates/hooks/run.sh',
      'templates/githooks/hook.sh',
      'INSTALL.md',
      'CHANGELOG.md',
      'README.md',
      'LICENSE',
      'package.json',
    ]) {
      expect(packed, `${wanted} must be packed`).toContain(wanted);
    }
  });

  it('manifest names the repository', () => {
    expect(pkg.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/SobSoft-s-r-o/agentic-sdlc-kit.git',
    });
    expect(pkg.homepage).toBe('https://github.com/SobSoft-s-r-o/agentic-sdlc-kit#readme');
    expect(pkg.bugs).toEqual({ url: 'https://github.com/SobSoft-s-r-o/agentic-sdlc-kit/issues' });
    expect(pkg.publishConfig.provenance).toBe(true);
    expect(pkg.publishConfig.access).toBe('public');
  });
});
