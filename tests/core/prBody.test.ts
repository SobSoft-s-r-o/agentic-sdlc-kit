import { describe, expect, it } from 'vitest';
import { parsePrBody } from '../../src/core/prBody.js';

describe('parsePrBody', () => {
  it('parses issue, scope and targets from the conventions', () => {
    expect(parsePrBody('Related to #12\nScope: partial\nTargets: web, api')).toEqual({
      issues: [12],
      scope: 'partial',
      scopeRecognized: true,
      targets: ['web', 'api'],
    });
  });

  it('defaults scope to final and targets to none when the lines are absent', () => {
    expect(parsePrBody('Related to #12')).toEqual({
      issues: [12],
      scope: 'final',
      scopeRecognized: true,
      targets: [],
    });
  });

  it('accepts an explicit final scope', () => {
    expect(parsePrBody('Related to #12\nScope: final').scope).toBe('final');
  });

  it('never treats closing keywords as task links', () => {
    for (const keyword of ['Fixes', 'Closes', 'Resolves', 'fixed', 'closed', 'resolved']) {
      expect(parsePrBody(`${keyword} #5`).issues, keyword).toEqual([]);
    }
  });

  it('keeps Related to links when closing keywords are also present', () => {
    expect(parsePrBody('Fixes #5\nRelated to #6').issues).toEqual([6]);
  });

  it('lists several issues from one line', () => {
    expect(parsePrBody('Related to #1, #2').issues).toEqual([1, 2]);
    expect(parsePrBody('Related to #1,#2 , #3').issues).toEqual([1, 2, 3]);
  });

  it('collects issues across several lines and de-duplicates them', () => {
    expect(parsePrBody('Related to #3\nSome text\nRelated to #1, #3').issues).toEqual([3, 1]);
  });

  it('matches keys and keywords case-insensitively', () => {
    expect(parsePrBody('related TO #4\nSCOPE: Partial\ntargets: Web').scope).toBe('partial');
    expect(parsePrBody('related TO #4\nSCOPE: Partial\ntargets: Web')).toEqual({
      issues: [4],
      scope: 'partial',
      scopeRecognized: true,
      targets: ['web'],
    });
  });

  it('trims, lowercases and de-duplicates targets', () => {
    expect(parsePrBody('Targets:  Web ,API,, web , api ').targets).toEqual(['web', 'api']);
  });

  it('ignores an empty Targets line', () => {
    expect(parsePrBody('Targets:').targets).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    expect(parsePrBody('Related to #12\r\nScope: partial\r\nTargets: web, api\r\n')).toEqual({
      issues: [12],
      scope: 'partial',
      scopeRecognized: true,
      targets: ['web', 'api'],
    });
  });

  it('only recognises the conventions at the start of a line', () => {
    const body = 'This is related to #8 somehow.\nPlease set Scope: partial in the template.\nTargets: web';
    expect(parsePrBody(body)).toEqual({ issues: [], scope: 'final', scopeRecognized: true, targets: ['web'] });
  });

  it('does not link issues in other repositories', () => {
    expect(parsePrBody('Related to other/repo#9').issues).toEqual([]);
  });

  it('falls back to final for an unrecognised scope value and says so', () => {
    expect(parsePrBody('Scope: banana')).toMatchObject({ scope: 'final', scopeRecognized: false });
    expect(parsePrBody('Scope: partail')).toMatchObject({ scope: 'final', scopeRecognized: false });
    expect(parsePrBody('Scope:')).toMatchObject({ scope: 'final', scopeRecognized: false });
  });

  it('does not treat a longer word as a scope value', () => {
    expect(parsePrBody('Scope: partially')).toMatchObject({ scope: 'final', scopeRecognized: false });
    expect(parsePrBody('Scope: finalize')).toMatchObject({ scope: 'final', scopeRecognized: false });
  });

  it('reports scope as recognised when the line is absent or valid', () => {
    expect(parsePrBody('Related to #1').scopeRecognized).toBe(true);
    expect(parsePrBody('Scope: final').scopeRecognized).toBe(true);
    expect(parsePrBody('Scope: partial').scopeRecognized).toBe(true);
  });

  it('accepts a scope value followed by punctuation or a remark', () => {
    expect(parsePrBody('Scope: partial.')).toMatchObject({ scope: 'partial', scopeRecognized: true });
    expect(parsePrBody('Scope: partial (docs only)')).toMatchObject({ scope: 'partial', scopeRecognized: true });
    expect(parsePrBody('SCOPE: Final, ready to ship')).toMatchObject({ scope: 'final', scopeRecognized: true });
  });

  it('accepts a bullet before the Scope key', () => {
    expect(parsePrBody('- Scope: partial')).toMatchObject({ scope: 'partial', scopeRecognized: true });
    expect(parsePrBody('* scope: partial')).toMatchObject({ scope: 'partial', scopeRecognized: true });
  });

  it('accepts a bullet before the Targets key', () => {
    expect(parsePrBody('- Targets: web, api').targets).toEqual(['web', 'api']);
    expect(parsePrBody('Related to #3\n* targets: web').targets).toEqual(['web']);
    expect(parsePrBody('- the targets: web').targets).toEqual([]);
  });

  it('does not read a value from the next line', () => {
    expect(parsePrBody('Scope:\npartial')).toMatchObject({ scope: 'final', scopeRecognized: false });
  });

  it('uses the first recognised Scope line when there are several', () => {
    expect(parsePrBody('Scope: partial\nScope: final').scope).toBe('partial');
    expect(parsePrBody('Scope: final\nScope: partial').scope).toBe('final');
  });

  it('skips an unrecognised Scope line in favour of a later recognised one', () => {
    expect(parsePrBody('Scope: banana\nScope: partial')).toMatchObject({ scope: 'partial', scopeRecognized: true });
  });

  it('links issues listed as bullets', () => {
    expect(parsePrBody('- Related to #3\n* related to #4, #5').issues).toEqual([3, 4, 5]);
  });

  it('still ignores a Related to mention inside a sentence or a bullet sentence', () => {
    expect(parsePrBody('- This is related to #8').issues).toEqual([]);
    expect(parsePrBody('See notes, related to #8').issues).toEqual([]);
  });

  it('returns empty results for an empty body', () => {
    expect(parsePrBody('')).toEqual({ issues: [], scope: 'final', scopeRecognized: true, targets: [] });
  });
});
