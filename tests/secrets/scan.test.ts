import { describe, expect, it } from 'vitest';
import { FILE_NAME_RULES, SECRET_RULES } from '../../src/secrets/rules.js';
import {
  ALLOW_MARKER,
  fingerprintOf,
  formatFinding,
  maskOf,
  scanAddedLines,
  scanChanges,
  scanFileName,
} from '../../src/secrets/scan.js';
import { githubToken, sampleFor, SAMPLES } from '../support/secrets.js';

const one = (text: string, allow: string[] = []) => scanAddedLines('src/a.ts', [{ line: 7, text }], allow);

describe('the content rules', () => {
  it('has the rules of the brief, in an order that reports a span once', () => {
    expect(SECRET_RULES.map(rule => rule.id)).toEqual([
      'github-token',
      'github-pat',
      'aws-access-key',
      'gcp-api-key',
      'private-key',
      'slack-token',
      'stripe-live-key',
      'anthropic-key',
      'openai-key',
      'jwt',
      'generic-assignment',
    ]);
    expect(SAMPLES.map(sample => sample.rule).sort()).toEqual(SECRET_RULES.map(rule => rule.id).sort());
  });

  it.each(SAMPLES)('$rule: matches its sample and reports it once', sample => {
    const found = one(sample.text);

    // `openai-key` also matches what `anthropic-key` matches; the sample of openai is not an anthropic one.
    expect(found.map(finding => finding.rule)).toEqual([sample.rule]);
    expect(found[0]?.path).toBe('src/a.ts');
    expect(found[0]?.line).toBe(7);
  });

  it.each(SAMPLES)('$rule: does not match a near miss (one character short)', sample => {
    expect(one(sample.nearMiss).filter(finding => finding.rule === sample.rule)).toEqual([]);
  });

  it('finds several secrets on one line, and the same secret twice', () => {
    const github = sampleFor('github-token').secret;
    const aws = sampleFor('aws-access-key').secret;

    const found = one(`${github} ${aws} ${github}`);

    expect(found.map(finding => finding.rule)).toEqual(['github-token', 'github-token', 'aws-access-key']);
    expect(found[0]?.fingerprint).toBe(found[1]?.fingerprint);
  });

  it('reports an Anthropic key once, as anthropic-key (openai-key also matches its text)', () => {
    const key = sampleFor('anthropic-key').secret;

    expect(SECRET_RULES.find(rule => rule.id === 'openai-key')?.pattern.test(key)).toBe(true);
    expect(one(`ANTHROPIC_API_KEY=${key}`).map(finding => finding.rule)).toEqual(['anthropic-key']);
  });

  it('a quoted token is reported by the specific rule, not twice by the generic one', () => {
    const key = sampleFor('anthropic-key').secret;

    expect(one(`token = "${key}"`).map(finding => finding.rule)).toEqual(['anthropic-key']);
  });

  it('allowing the specific finding also silences the generic rule on the same span', () => {
    const key = sampleFor('github-token').secret;
    const [specific] = one(`token = "${key}"`);

    expect(one(`token = "${key}"`, [specific?.fingerprint ?? ''])).toEqual([]);
  });

  describe('generic-assignment', () => {
    const rule = SECRET_RULES.find(candidate => candidate.id === 'generic-assignment');
    const key = 'pass' + 'word';
    const found = (value: string, name = key) => one(`${name} = "${value}"`).map(finding => finding.rule);

    it('flags a long quoted value for each key name, any case, with : or = and single quotes', () => {
      for (const name of ['password', 'passwd', 'secret', 'token', 'api_key', 'api-key', 'apikey', 'API_KEY', 'DB_PASSWORD']) {
        expect(found('Zq7Zq7Zq7Zq7Zq7', name)).toEqual(['generic-assignment']);
      }
      expect(one(`"${key}": 'Zq7Zq7Zq7Zq7Zq7'`).map(finding => finding.rule)).toEqual(['generic-assignment']);
    });

    it('ignores references, templates and placeholders', () => {
      for (const value of [
        '${DATABASE_PASSWORD}',
        '$(cat /run/secrets/pw)',
        '<your-password-here>',
        'xxxxxxxxxxxx',
        '************',
        'CHANGEME',
        'Example',
      ]) {
        expect(found(value)).toEqual([]);
      }
      expect(rule?.ignore).toBeTypeOf('function');
    });

    it('ignores the placeholder of the MCP config and values that are too short', () => {
      expect(one('token: "${GITHUB_PERSONAL_ACCESS_TOKEN}"')).toEqual([]);
      expect(one('"Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"')).toEqual([]);
      expect(one(`${key}: "changeme"`)).toEqual([]);
      expect(found('short')).toEqual([]);
    });

    it('does not flag an unquoted value or a plain mention', () => {
      expect(one(`${key}: Zq7Zq7Zq7Zq7Zq7`)).toEqual([]);
      expect(one('the token is stored in the keystore')).toEqual([]);
    });

    it('flags a value that merely starts like a placeholder', () => {
      expect(found('changeme-Zq7Zq7Zq7')).toEqual(['generic-assignment']);
    });
  });

  it('finds a large JWT (a 5 KB payload and a 4096-bit RSA signature)', () => {
    const jwt = ['ey' + 'J' + 'a'.repeat(40), 'ey' + 'J' + 'b'.repeat(5000), 'c'.repeat(683)].join('.');

    expect(one(`Authorization: Bearer ${jwt}`).map(finding => finding.rule)).toEqual(['jwt']);
  });

  it('does not match its own pattern sources', () => {
    for (const rule of SECRET_RULES) expect(one(rule.pattern.source)).toEqual([]);
  });
});

describe('scanAddedLines', () => {
  it('skips a line with the allow marker, only that line', () => {
    const token = githubToken();
    const lines = [
      { line: 1, text: `const a = "${token}"; // ${ALLOW_MARKER}` },
      { line: 2, text: `const b = "${token}";` },
    ];

    expect(scanAddedLines('x.ts', lines, []).map(finding => finding.line)).toEqual([2]);
    expect(ALLOW_MARKER).toBe('sdlc:allow-secret');
  });

  it('drops a finding whose fingerprint is allowed, and keeps the others', () => {
    const github = sampleFor('github-token').secret;
    const aws = sampleFor('aws-access-key').secret;
    const [first] = one(github);

    const found = one(`${github} ${aws}`, [first?.fingerprint ?? '']);

    expect(found.map(finding => finding.rule)).toEqual(['aws-access-key']);
  });

  it('a fingerprint is the first 16 hex characters of sha256 of "<rule>:<match>"', () => {
    const secret = sampleFor('github-token').secret;
    const [finding] = one(secret);

    expect(finding?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(finding?.fingerprint).toBe(fingerprintOf('github-token', secret));
    // Known value, so a change of the formula is noticed: sha256("a:b") starts with this.
    expect(fingerprintOf('a', 'b')).toBe('6783a31eabf68ccc');
  });

  it('the fingerprint depends on the rule and on the secret', () => {
    expect(fingerprintOf('github-token', 'x')).not.toBe(fingerprintOf('jwt', 'x'));
    expect(fingerprintOf('github-token', 'x')).not.toBe(fingerprintOf('github-token', 'y'));
  });

  it('is not stateful: the same input gives the same findings, call after call', () => {
    const text = `${githubToken()} ${githubToken()}`;

    expect(one(text)).toEqual(one(text));
    expect(one(text)).toHaveLength(2);
  });

  it('empty input and lines without secrets give nothing', () => {
    expect(scanAddedLines('x', [], [])).toEqual([]);
    expect(one('')).toEqual([]);
    expect(one('const answer = 42;')).toEqual([]);
  });
});

describe('masking', () => {
  it('shows the first 4 characters, an ellipsis and the length', () => {
    expect(maskOf('abcdefghij')).toBe('abcd…(10 chars)');
    expect(maskOf('abc')).toBe('abc…(3 chars)');
    expect(maskOf('😀😀😀😀😀')).toBe('😀😀😀😀…(10 chars)');
  });

  it.each(SAMPLES)('$rule: the masked text has at most 4 characters of the match and no line shows the secret', sample => {
    const [finding] = one(sample.text);

    expect(finding).toBeDefined();
    const shown = (finding?.masked ?? '').split('…')[0] ?? '';
    expect([...shown].length).toBeLessThanOrEqual(4);
    expect(finding?.masked).toMatch(/…\(\d+ chars\)$/);
    const line = formatFinding(finding!);
    expect(line).not.toContain(sample.secret);
    expect(JSON.stringify(finding)).not.toContain(sample.secret);
    // Nor more than four characters of the secret beyond what the pattern itself spells.
    expect(line).not.toContain(sample.secret.slice(0, 8));
  });
});

describe('formatFinding', () => {
  it('is "<path>:<line> <rule> <masked> (fingerprint <fp>)"', () => {
    const [finding] = one(githubToken());

    expect(formatFinding(finding!)).toBe(
      `src/a.ts:7 github-token ghp_…(40 chars) (fingerprint ${fingerprintOf('github-token', githubToken())})`,
    );
  });

  it('has no line number for a file-name finding', () => {
    const finding = scanFileName('config/.env.local');

    expect(formatFinding(finding!)).toMatch(/^config\/\.env\.local env-file \.env\.local \(fingerprint [0-9a-f]{16}\)$/);
  });

  it('prints control characters of a path as ?', () => {
    const [finding] = scanAddedLines('a\u001b[31m\nb.ts', [{ line: 1, text: githubToken() }], []);

    expect(formatFinding(finding!).startsWith('a?[31m?b.ts:1 ')).toBe(true);
  });
});

describe('file-name rules', () => {
  const blocked = [
    '.env',
    '.env.local',
    '.env.production',
    'apps/web/.env',
    'apps/web/.env.local',
    '.ENV',
    'server.pem',
    'certs/tls.key',
    'store.p12',
    'store.pfx',
    'id_rsa',
    'id_rsa_backup',
    '.ssh/id_ed25519',
    'id_ed25519_work',
    'id_ecdsa',
    'home/.ssh/id_ecdsa_sk',
    'id_dsa',
    'id_dsa.bak',
    'credentials.json',
    'config/credentials.prod.json',
    'service-account.json',
    'infra/service-account-prod.json',
  ];
  const allowed = [
    '.env.example',
    '.env.sample',
    '.env.template',
    'apps/web/.env.example',
    'id_ed25519.pub',
    'id_rsa.pub',
    'id_ecdsa.pub',
    'id_dsa.pub',
    'id_dsa_notes.pub',
    'id_ecdsa_sk.pub',
    'envelope.txt',
    'environment.ts',
    'src/env.ts',
    'credentials.md',
    'keys.json',
    'monkey.keyboard',
    'README.md',
    'src/credentials/index.ts',
  ];

  it.each(blocked)('blocks %s', path => {
    const finding = scanFileName(path);

    expect(finding).toBeDefined();
    expect(finding?.line).toBeUndefined();
    expect(finding?.path).toBe(path);
    expect(finding?.masked).toBe(path.split('/').pop());
    expect(finding?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it.each(allowed)('allows %s', path => {
    expect(scanFileName(path)).toBeUndefined();
  });

  it('names the rule, and the fingerprint is that of the path', () => {
    expect(scanFileName('.env.local')?.rule).toBe('env-file');
    expect(scanFileName('a/tls.pem')?.rule).toBe('key-file');
    expect(scanFileName('id_rsa')?.rule).toBe('ssh-private-key-file');
    expect(scanFileName('credentials.json')?.rule).toBe('credentials-file');
    expect(scanFileName('a/tls.pem')?.fingerprint).toBe(fingerprintOf('key-file', 'a/tls.pem'));
    expect(scanFileName('a/tls.pem')?.fingerprint).not.toBe(scanFileName('b/tls.pem')?.fingerprint);
    expect(FILE_NAME_RULES.map(rule => rule.id)).toEqual(['env-file', 'key-file', 'ssh-private-key-file', 'credentials-file']);
  });
});

describe('scanChanges', () => {
  it('scans added lines and file names, honours the allow list for both, and reports a finding once', () => {
    const token = githubToken();
    const changes = {
      files: [
        { path: 'a.ts', lines: [{ line: 1, text: token }] },
        { path: 'a.ts', lines: [{ line: 1, text: token }] },
        { path: 'b.ts', lines: [{ line: 3, text: 'fine' }] },
      ],
      names: ['.env', '.env', 'ok.txt', 'tls.pem'],
    };

    const found = scanChanges(changes, []);

    expect(found.map(finding => `${finding.path}:${finding.line ?? '-'}:${finding.rule}`)).toEqual([
      'a.ts:1:github-token',
      '.env:-:env-file',
      'tls.pem:-:key-file',
    ]);
    const allow = found.filter(finding => finding.rule !== 'github-token').map(finding => finding.fingerprint);
    expect(scanChanges(changes, allow).map(finding => finding.rule)).toEqual(['github-token']);
  });
});

describe('long lines', () => {
  const LONG = 100_000;
  const SEED = 'ab1';
  /** `unit` repeated to at least 100k characters. */
  const fill = (unit: string): string => unit.repeat(Math.ceil(LONG / unit.length));
  const shapes: Array<[string, string]> = [
    ['plain text', fill('a')],
    ['spaces', fill(' ')],
    ['dashes', fill('-')],
    ['underscores and dashes', fill('-_')],
    ['dots', fill('.')],
    ['quotes', fill('"')],
    ['jwt starts joined by dashes', fill('ey' + 'J-')],
    ['jwt starts joined by dashes (words)', fill('ey' + 'J' + SEED.repeat(4) + '-')],
    ['jwt starts joined by dots', fill('ey' + 'J' + SEED.repeat(4) + '.')],
    ['jwt with no end', 'ey' + 'J' + SEED.repeat(10) + '.ey' + 'J' + fill('-')],
    ['jwt with a long first segment', 'ey' + 'J' + fill(SEED) + '.ey' + 'J' + SEED.repeat(10) + '.'],
    ['jwt almost whole', fill('ey' + 'J' + SEED.repeat(4) + '.ey' + 'J' + SEED.repeat(4) + '.ab-')],
    ['jwt dashes in every segment', fill('ey' + 'J' + '-'.repeat(12) + '.ey' + 'J' + '-'.repeat(12) + '.' + '-'.repeat(12))],
    ['sk- joined by dashes', fill('sk-')],
    ['sk- then dashes', 'sk-' + fill('-')],
    ['sk-ant- then dashes', 'sk-ant-' + fill('-')],
    ['xox starts', fill('xo' + 'xb-')],
    ['xox then dashes', 'xo' + 'xb-' + fill('-')],
    ['live key starts', fill('sk' + '_live_')],
    ['github starts', fill('gh' + 'p_')],
    ['github_pat start', 'github' + '_pat_' + fill('_')],
    ['aws starts', fill('AK' + 'IA')],
    ['aiza starts', fill('AI' + 'za')],
    ['private key starts', fill('-----' + 'BEGIN ')],
    ['password keyword repeated', fill('pass' + 'word=')],
    ['password with spaces', 'pass' + 'word' + fill(' ')],
    ['password, equals, spaces', 'pass' + 'word' + ' = ' + fill(' ')],
    ['password and an open quote', 'pass' + 'word' + '="' + fill('a')],
    ['password keyword and quote repeated', fill('pass' + 'word' + "='" + 'a'.repeat(15) + ' ')],
    ['password with spaces repeated', fill('pass' + 'word' + ' '.repeat(20) + '= ' + ' '.repeat(20))],
    ['password and closing quotes repeated', fill('pass' + 'word' + '"'.repeat(20))],
    ['mixed', fill('token = "' + 'x'.repeat(11) + ' eyJ-sk--xoxb-')],
  ];

  /** The fastest of three scans: a slow machine slows every run, a backtracking rule slows every run by seconds. */
  const bestOfThree = (text: string): number => {
    let best = Infinity;
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      scanAddedLines('min.js', [{ line: 1, text }], []);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };

  it.each(shapes)('%s: a line of 100k characters is scanned in well under a second', (_name, text) => {
    expect(text.length).toBeGreaterThanOrEqual(LONG - 100);

    expect(bestOfThree(text)).toBeLessThan(1_000);
  });

  it('still finds a secret in the middle of a very long line', () => {
    const text = `${'x '.repeat(50_000)}${githubToken()} ${'y '.repeat(50_000)}`;

    expect(scanAddedLines('min.js', [{ line: 1, text }], []).map(finding => finding.rule)).toEqual(['github-token']);
  });
});
