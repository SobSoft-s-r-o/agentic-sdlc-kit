import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { setConfigMode } from '../../src/config/write.js';
import { loadConfigFromString } from '../../src/config/schema.js';

const FIXTURE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config/valid.yaml'), 'utf8');

/** A config with the things a round trip tends to lose: comments, blank lines, key order, flow maps. */
const COMMENTED = `# Project config, edited by hand.
version: 1
harnesses: [claude, codex]

# owner notes: flip to enforce once the team is used to the gaps
mode: observe  # observe warns, enforce blocks

github:
  repo: acme/shop
  default_branch: main
  project: { owner: acme, owner_type: org, number: 7 }
owners: [shop-owner]   # the humans who approve
task_types: { enabled: [tooling] }

quality_gate: ["npm test"]
# trailing comment
`;

/** The smallest valid config as a plain object (JSON is YAML flow style). */
function loadable(): object {
  return {
    version: 1,
    harnesses: ['claude'],
    mode: 'observe',
    github: { repo: 'acme/shop', default_branch: 'main', project: { owner: 'acme', owner_type: 'org' } },
    owners: ['shop-owner'],
    task_types: { enabled: ['tooling'] },
  };
}

describe('setConfigMode', () => {
  it('changes the mode and keeps comments, blank lines and key order', () => {
    const result = setConfigMode(COMMENTED, 'enforce');

    expect(result.previous).toBe('observe');
    expect(result.text).toBe(COMMENTED.replace('mode: observe  #', 'mode: enforce  #'));
    expect(loadConfigFromString(result.text).mode).toBe('enforce');
  });

  it('is a plain one-line change on a fixture without comments', () => {
    const result = setConfigMode(FIXTURE, 'enforce');

    expect(result.text).toBe(FIXTURE.replace('mode: observe', 'mode: enforce'));
  });

  it('returns the text unchanged when the mode already matches', () => {
    const result = setConfigMode(COMMENTED, 'observe');

    expect(result.previous).toBe('observe');
    expect(result.text).toBe(COMMENTED);
  });

  it('adds mode when it is missing, after the existing keys', () => {
    const withoutMode = COMMENTED.replace(/# owner notes[^\n]*\nmode:[^\n]*\n\n/, '');
    expect(withoutMode).not.toContain('mode:');

    const result = setConfigMode(withoutMode, 'enforce');

    expect(result.previous).toBeUndefined();
    expect(result.text).toContain('\nmode: enforce\n');
    expect(result.text.startsWith('# Project config, edited by hand.\nversion: 1\n')).toBe(true);
    expect(result.text).toContain('# trailing comment');
    expect(loadConfigFromString(result.text).mode).toBe('enforce');
  });

  it('keeps a quoted value quoted and a CRLF file CRLF', () => {
    const quoted = setConfigMode(COMMENTED.replace('mode: observe', 'mode: "observe"'), 'enforce');
    expect(quoted.text).toContain('mode: "enforce"');

    const crlf = setConfigMode(COMMENTED.replace(/\n/g, '\r\n'), 'enforce');
    expect(crlf.text).toBe(COMMENTED.replace('mode: observe  #', 'mode: enforce  #').replace(/\n/g, '\r\n'));
  });

  it('keeps a single-quoted value single-quoted', () => {
    const result = setConfigMode(COMMENTED.replace('mode: observe', "mode: 'observe'"), 'enforce');

    expect(result.text).toBe(COMMENTED.replace('mode: observe  #', "mode: 'enforce'  #"));
  });

  it('appends to a file that does not end in a newline', () => {
    const withoutMode = COMMENTED.replace(/# owner notes[^\n]*\nmode:[^\n]*\n\n/, '').trimEnd();

    const result = setConfigMode(withoutMode, 'observe');

    expect(result.text).toBe(`${withoutMode}\nmode: observe\n`);
  });

  it.each([
    ['a flow-style document', JSON.stringify(loadable())],
    ['an anchored value', COMMENTED.replace('mode: observe', 'mode: &m observe')],
    ['an empty value', COMMENTED.replace('mode: observe', 'mode:')],
  ])('still sets the mode in %s', (_name, text) => {
    const result = setConfigMode(text, 'enforce');

    expect(loadConfigFromString(result.text).mode).toBe('enforce');
  });

  it('refuses an unknown mode', () => {
    expect(() => setConfigMode(COMMENTED, 'strict' as 'enforce')).toThrow(
      'mode must be observe or enforce, got "strict"',
    );
  });

  it('throws when the result is not a valid config, and when the YAML does not parse', () => {
    expect(() => setConfigMode('mode: observe\n', 'enforce')).toThrow(/Invalid config/);
    expect(() => setConfigMode('mode: [observe\n', 'enforce')).toThrow(/YAML|Invalid config/);
  });
});
