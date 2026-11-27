import { describe, expect, it } from 'vitest';
import { parseOwnerCommand, type OwnerCommand } from '../../src/core/ownerCommand.js';

const cases: Array<[string, string, OwnerCommand | null]> = [
  ['approve', '/approve', { action: 'approve' }],
  ['accept', '/accept', { action: 'accept' }],
  ['ran', '/ran', { action: 'ran' }],
  ['merge', '/merge', { action: 'merge' }],
  ['cancel with a reason', '/cancel scope dropped', { action: 'cancel', reason: 'scope dropped' }],
  ['upper case', '/APPROVE', { action: 'approve' }],
  ['mixed case cancel', '/Cancel Not needed', { action: 'cancel', reason: 'Not needed' }],
  ['text after the command', '/approve thanks, looks good', { action: 'approve' }],
  ['tab after the command', '/accept\tthanks', { action: 'accept' }],
  ['surrounding whitespace', '   /approve   ', { action: 'approve' }],
  ['leading blank lines', '\n\n  \n/approve', { action: 'approve' }],
  ['CRLF line endings', '/approve\r\nthanks', { action: 'approve' }],
  ['cancel reason is trimmed to its line', '/cancel   too late  \nmore text', { action: 'cancel', reason: 'too late' }],
  ['more text on later lines', '/ran\n\nran it just now', { action: 'ran' }],
  ['cancel without a reason', '/cancel', null],
  ['cancel with a blank reason', '/cancel    \nbecause', null],
  ['a longer word', '/approved', null],
  ['a longer word with a reason', '/cancelled by me', null],
  ['a different command', '/deploy', null],
  ['no slash', 'approve', null],
  ['a slash before whitespace', '/ approve', null],
  ['not on the first line', 'Looks good.\n/approve', null],
  ['quoted', '> /approve', null],
  ['quoted with a reply', '> /approve\nno, wait', null],
  ['inside a sentence', 'please /approve this', null],
  ['inline code', '`/approve`', null],
  ['empty', '', null],
  ['only whitespace', ' \n \t\n', null],
];

describe('parseOwnerCommand', () => {
  it.each(cases)('%s', (_name, body, expected) => {
    expect(parseOwnerCommand(body)).toEqual(expected);
  });

  it('reads the type of a type-change approval, /approve type <id>, in any letter case', () => {
    expect(parseOwnerCommand('/approve type artifact')).toEqual({ action: 'approve', typeId: 'artifact' });
    expect(parseOwnerCommand('/Approve TYPE Production-Data  ok\nthanks')).toEqual({
      action: 'approve',
      typeId: 'production-data',
    });
    expect(parseOwnerCommand('/approve type')).toEqual({ action: 'approve', typeId: '' });
    expect(parseOwnerCommand('/approve typescript')).toEqual({ action: 'approve' });
    expect(parseOwnerCommand('/approve the type change')).toEqual({ action: 'approve' });
  });

  it('gives no reason for commands that take none', () => {
    expect(parseOwnerCommand('/approve because')).not.toHaveProperty('reason');
  });
});
