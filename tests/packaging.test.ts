import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

/** Every file under `dir` (a directory of the repository), as a path relative to the repository root. */
function filesUnder(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .map(entry => join(dir, entry))
    .filter(path => statSync(join(root, path)).isFile());
}

let packed: string[];
beforeAll(async () => {
  // `npm pack` takes `dist/` whole. `tests/support/globalBuild.ts` built it once before this file started, so
  // this runs no build of its own (two builds into `dist/` raced), and `--ignore-scripts` skips `prepare`.
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

  it('packs the whole build and every template, so the file count means something', () => {
    // The compiled output of every source file, and nothing from `dist/` that no source file makes.
    const compiled = filesUnder('src')
      .filter(file => file.endsWith('.ts'))
      .map(file => file.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js'))
      .sort();
    expect(compiled.length).toBeGreaterThan(50);
    expect(packed.filter(path => path.startsWith('dist/')).sort()).toEqual(compiled);
    expect(packed.filter(path => path.startsWith('templates/')).sort()).toEqual(filesUnder('templates').sort());
    // `files` whitelist (dist, templates, INSTALL.md, CHANGELOG.md) plus what npm always adds.
    const others = packed.filter(path => !path.startsWith('dist/') && !path.startsWith('templates/')).sort();
    expect(others).toEqual(['CHANGELOG.md', 'INSTALL.md', 'LICENSE', 'README.md', 'package.json']);
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
