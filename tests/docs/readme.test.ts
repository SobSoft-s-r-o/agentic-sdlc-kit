import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../README.md'), 'utf8');

describe('README', () => {
  it('states the current status: the core CLI is available, the installer is still to come', () => {
    const status = readme.split('\n').find(line => line.startsWith('> Status:'));
    expect(status).toBeDefined();
    expect(status).not.toMatch(/design phase/i);
    expect(status).toMatch(/core CLI/i);
    expect(status).toMatch(/installer/i);
  });
});
