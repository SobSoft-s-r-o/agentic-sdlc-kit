#!/usr/bin/env node
// Pack smoke test: what users get from npm is the tarball, not the working tree.
// It packs the package, installs the tarball into an empty project and runs the installed `sdlc`:
//   - `sdlc --version` must print the version of package.json;
//   - `sdlc config validate` must accept a copy of tests/fixtures/config/valid.yaml.
// It exits 0 and prints one line on success; on any mismatch it exits 1 with a one-line reason.
// Run it from anywhere: `node scripts/pack-smoke.mjs` (CI builds first; `npm pack` runs `prepare`, which builds too).
// It needs the npm registry for the dependencies of the package (`npm install` of the tarball).
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_PREFIX = 'sdlc-pack-smoke-';

class SmokeFailure extends Error {}

/** Fails the smoke with a one-line reason. */
function fail(reason) {
  throw new SmokeFailure(reason.replace(/\s+/g, ' ').trim());
}

/** Runs a command to completion without a terminal; fails the smoke when it cannot start or exits non-zero. */
function run(label, command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    // One line of the output: the first that names an error, else the last; npm's "see the log" line says nothing.
    const lines = `${result.stderr}\n${result.stdout}`.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.includes('A complete log of this run'));
    const detail = lines.find(line => /error/i.test(line)) ?? lines.at(-1) ?? 'no output';
    fail(`${label} exited ${result.status ?? result.signal}: ${detail}`);
  }
  return result.stdout;
}

/**
 * The report of `npm pack --json`. npm prints the lifecycle output of `prepare` (the `tsc` build)
 * before the JSON, so the report starts at the first line that begins with `[`.
 */
function parsePackReport(stdout) {
  const start = stdout.split('\n').findIndex(line => line.startsWith('['));
  if (start < 0) fail('npm pack --json printed no JSON report');
  try {
    const [report] = JSON.parse(stdout.split('\n').slice(start).join('\n'));
    if (typeof report?.filename !== 'string' || !Array.isArray(report.files)) fail('npm pack --json report has no filename and files');
    return report;
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    return fail(`npm pack --json printed unreadable JSON: ${error.message}`);
  }
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  try {
    // The tarball goes into the temporary directory too, so removing the directory removes it.
    const packed = parsePackReport(run('npm pack', 'npm', ['pack', '--json', '--pack-destination', dir], repoRoot));
    const tarball = join(dir, packed.filename);

    const project = join(dir, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'package.json'), `${JSON.stringify({ name: 'smoke', private: true })}\n`);
    run('npm install', 'npm', ['install', '--no-audit', '--no-fund', tarball], project);

    const version = run('sdlc --version', 'npx', ['--no-install', 'sdlc', '--version'], project).trim();
    if (version !== manifest.version) fail(`sdlc --version printed "${version}", package.json says "${manifest.version}"`);

    const config = join(project, 'sdlc.config.yaml');
    copyFileSync(join(repoRoot, 'tests/fixtures/config/valid.yaml'), config);
    run('sdlc config validate', 'npx', ['--no-install', 'sdlc', 'config', 'validate', '--config', config], project);

    console.log(`pack-smoke: ok, ${manifest.name} ${version} (${packed.files.length} files in ${packed.filename})`);
  } finally {
    // Only the directory this run made: a fresh name under the system temp directory, checked before it is removed.
    const home = realpathSync(tmpdir());
    if (dirname(realpathSync(dir)) === home && basename(dir).startsWith(TEMP_PREFIX)) {
      await rm(dir, { recursive: true });
    }
  }
}

main().catch(error => {
  console.error(`pack-smoke: FAILED: ${error instanceof SmokeFailure ? error.message : (error?.message ?? String(error))}`);
  process.exitCode = 1;
});
