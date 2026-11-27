/**
 * What the secret guard looks for: content rules (applied to one added line at a time) and file-name
 * rules. The patterns are plain, non-global regular expressions; `scan.ts` makes its own global
 * copies, so nothing here carries state between lines. No pattern may backtrack without bound on a
 * very long line: every open-ended repeat either sits in a class that the next token cannot be part
 * of, or has an upper limit (see the long-line tests).
 */

export interface SecretRule {
  id: string;
  description: string;
  pattern: RegExp;
  /** True for a match that is not a secret after all (a placeholder); the match is then not reported. */
  ignore?: (match: RegExpMatchArray) => boolean;
}

/** Values of `generic-assignment` that are placeholders, whatever their case. */
const PLACEHOLDER_VALUES = new Set(['changeme', 'example', 'placeholder']);

/** A value that is a reference to a secret, a template or a filler, not a secret. */
function isPlaceholderValue(value: string): boolean {
  if (value.includes('${') || value.includes('$(') || value.includes('<')) return true;
  if (PLACEHOLDER_VALUES.has(value.toLowerCase())) return true;
  const [first] = value;
  return first !== undefined && [...value].every(char => char === first);
}

/**
 * The order matters: a span of a line is reported once, by the first rule that matches it, so the
 * specific rules come before `openai-key` (which also matches an Anthropic key) and
 * `generic-assignment` (which also matches a quoted specific token).
 */
export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'github-token',
    description: 'GitHub token (ghp_, gho_, ghu_, ghs_, ghr_)',
    pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/,
  },
  {
    id: 'github-pat',
    description: 'GitHub fine-grained personal access token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/,
  },
  {
    id: 'aws-access-key',
    description: 'AWS access key id',
    pattern: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    id: 'gcp-api-key',
    description: 'Google Cloud API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: 'private-key',
    description: 'private key block (also a service-account JSON key)',
    pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    id: 'slack-token',
    description: 'Slack token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    id: 'stripe-live-key',
    description: 'Stripe live secret or restricted key',
    pattern: /\b(sk|rk)_live_[A-Za-z0-9]{24,}\b/,
  },
  {
    id: 'anthropic-key',
    description: 'Anthropic API key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/,
  },
  {
    id: 'openai-key',
    description: 'OpenAI API key',
    pattern: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/,
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    // The segments are bounded: `-` is both in a segment and between starts, so a line of `eyJ-eyJ-…`
    // would otherwise be scanned to its end from every start (quadratic). Real tokens fit the bounds.
    pattern: /\beyJ[A-Za-z0-9_-]{10,1024}\.eyJ[A-Za-z0-9_-]{10,16384}\.[A-Za-z0-9_-]{10,4096}\b/,
  },
  {
    id: 'generic-assignment',
    description: 'a quoted value assigned to password, secret, token or api key',
    // Group 2 is the value; `ignore` drops placeholders.
    // The optional quote after the key name makes it match JSON, YAML and dict keys ("api_key": "...").
    pattern: /(password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i,
    ignore: match => isPlaceholderValue(match[2] ?? ''),
  },
];

/** File names that hold secrets (matched on the lower-cased name, whatever the directory). */
export interface FileNameRule {
  id: string;
  description: string;
  matches(name: string): boolean;
}

const ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);

export const FILE_NAME_RULES: readonly FileNameRule[] = [
  {
    id: 'env-file',
    description: 'environment file (.env, .env.*)',
    matches: name => (name === '.env' || name.startsWith('.env.')) && !ENV_EXAMPLES.has(name),
  },
  {
    id: 'key-file',
    description: 'key or certificate store (*.pem, *.key, *.p12, *.pfx)',
    matches: name => ['.pem', '.key', '.p12', '.pfx'].some(extension => name.endsWith(extension)),
  },
  {
    id: 'ssh-private-key-file',
    description: 'SSH private key (id_rsa*, id_ed25519*)',
    matches: name => (name.startsWith('id_rsa') || name.startsWith('id_ed25519')) && !name.endsWith('.pub'),
  },
  {
    id: 'credentials-file',
    description: 'credentials or service-account JSON',
    matches: name =>
      name.endsWith('.json') && (name.startsWith('credentials') || name.startsWith('service-account')),
  },
];
