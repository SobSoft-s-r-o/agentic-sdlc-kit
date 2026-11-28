import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTemplate, templatesDir } from '../../src/render/templates.js';

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

describe('templatesDir', () => {
  it('is the absolute templates/ directory at the package root', () => {
    const dir = templatesDir();
    expect(isAbsolute(dir)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(relative(dir, join(dir, '..', 'package.json'))).toBe(join('..', 'package.json'));
    expect(existsSync(join(dir, '..', 'package.json'))).toBe(true);
    expect(dir.endsWith(`${sep}templates`)).toBe(true);
  });
});

describe('loadTemplate', () => {
  it('returns the text of every file under templates/, addressed by its relative path', () => {
    for (const file of filesUnder(templatesDir())) {
      const rel = relative(templatesDir(), file).split(sep).join('/');
      expect(loadTemplate(rel)).toBe(readFileSync(file, 'utf8'));
    }
  });

  it('names the template in the error when it does not exist', () => {
    expect(() => loadTemplate('nope/missing.md')).toThrow('template not found: nope/missing.md');
  });

  it('refuses a path that leaves the templates directory', () => {
    expect(() => loadTemplate('../package.json')).toThrow('outside the templates directory');
    expect(() => loadTemplate('a/../../package.json')).toThrow('outside the templates directory');
    expect(() => loadTemplate(join(templatesDir(), '..', 'package.json'))).toThrow('outside the templates directory');
  });
});
