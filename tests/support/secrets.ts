/**
 * Fake secrets for the secret guard's tests, assembled at run time. No literal in the repository
 * has the shape of a token, so neither the kit's own guard nor GitHub push protection can flag it.
 * Each sample is the shortest thing its rule accepts; `short` is the same with one character less.
 */
export interface Sample {
  rule: string;
  /** A line (or fragment) the rule must match, and that contains the whole fake secret. */
  text: string;
  /** What the rule must report as the match (the secret itself). */
  secret: string;
  /** Almost the same thing, one character short: the rule must not match it. */
  nearMiss: string;
}

const make = (rule: string, secret: string, nearMiss: string, wrap = (value: string) => value): Sample => ({
  rule,
  secret,
  text: wrap(secret),
  nearMiss: wrap(nearMiss),
});

const word = (length: number): string => 'Ab1'.repeat(Math.ceil(length / 3)).slice(0, length);
const upper = (length: number): string => 'ABC9'.repeat(Math.ceil(length / 4)).slice(0, length);

const ghp = 'gh' + 'p_';
const pat = 'github' + '_pat_';
const akia = 'AK' + 'IA';
const aiza = 'AI' + 'za';
const xoxb = 'xo' + 'xb-';
const live = 'sk' + '_live_';
const anthropic = 'sk' + '-ant-';
const openai = 'sk' + '-';
const jwtHead = 'ey' + 'J';
const begin = '-----' + 'BEGIN ';
const passwordKey = 'pass' + 'word';

export const SAMPLES: Sample[] = [
  make('github-token', ghp + word(36), ghp + word(35), value => `GH=${value}`),
  make('github-pat', pat + word(82), pat + word(81), value => `export X=${value}`),
  make('aws-access-key', akia + upper(16), akia + upper(15), value => `key = ${value}`),
  make('gcp-api-key', aiza + word(35), aiza + word(34), value => `key: ${value}`),
  make('private-key', begin + 'RSA PRIVATE KEY-----', begin + 'RSA PRIVATE KEY----', value => `  ${value}`),
  make('slack-token', xoxb + '1234567890', xoxb + '123456789', value => `SLACK=${value}`),
  make('stripe-live-key', live + word(24), live + word(23), value => `STRIPE=${value}`),
  make('anthropic-key', anthropic + word(32), anthropic + word(31), value => `KEY=${value}`),
  // `(proj-)?` is optional, so only a bare key one character short is a near miss.
  make('openai-key', openai + 'proj-' + word(32), openai + word(31), value => `KEY=${value}`),
  make(
    'jwt',
    [jwtHead + word(10), jwtHead + word(10), word(10)].join('.'),
    [jwtHead + word(10), jwtHead + word(10), word(9)].join('.'),
    value => `Authorization: ${value}`,
  ),
  make(
    'generic-assignment',
    `${passwordKey}: "${word(12)}"`,
    `${passwordKey}: "${word(11)}"`,
  ),
];

/** The secret part of a sample, the thing that must never be printed whole. */
export const secretOf = (sample: Sample): string => sample.secret;

export const sampleFor = (rule: string): Sample => {
  const sample = SAMPLES.find(candidate => candidate.rule === rule);
  if (sample === undefined) throw new Error(`no sample for ${rule}`);
  return sample;
};

/** A GitHub token for tests that need one secret and nothing else. */
export const githubToken = (): string => sampleFor('github-token').secret;
