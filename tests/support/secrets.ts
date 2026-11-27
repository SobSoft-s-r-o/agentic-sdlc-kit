/**
 * Fake secrets for the secret guard's tests, assembled at run time. No literal in the repository
 * has the shape of a token, so neither the kit's own guard nor GitHub push protection can flag it:
 * a prefix is always a separate, short piece and the body is generated.
 * Each sample is the shortest thing its rule accepts; `nearMiss` is the same with one character less.
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

/** Another shape of something a rule must find (a second prefix, a JSON form, ...): one finding, by that rule. */
export interface Variant {
  rule: string;
  /** What the variant is, for the test name. */
  name: string;
  text: string;
  secret: string;
}

const make = (rule: string, secret: string, nearMiss: string, wrap = (value: string) => value): Sample => ({
  rule,
  secret,
  text: wrap(secret),
  nearMiss: wrap(nearMiss),
});

const cycle = (alphabet: string, length: number): string =>
  alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);

/** Bodies: none is a single repeated character (a filler), none has the shape of another rule's token. */
export const word = (length: number): string => cycle('Ab1', length);
const upper = (length: number): string => cycle('ABC9', length);
const hex = (length: number): string => cycle('0a1b2c3d', length);
const letters = (length: number): string => cycle('AbCd', length);
const lower32 = (length: number): string => cycle('ab23cd45', length);
const url64 = (length: number): string => cycle('Ab1_-', length);
const std64 = (length: number): string => cycle('Ab1+/', length);
const bech32 = (length: number): string => cycle('QPZRY9X8', length);

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
const base64Of = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

export const SAMPLES: Sample[] = [
  make('github-token', ghp + word(36), ghp + word(35), value => `GH=${value}`),
  make('github-pat', pat + word(82), pat + word(81), value => `export X=${value}`),
  make('gitlab-token', 'gl' + 'pat-' + url64(20), 'gl' + 'pat-' + url64(19), value => `GITLAB_TOKEN=${value}`),
  make('aws-access-key', akia + upper(16), akia + upper(15), value => `key = ${value}`),
  make('aws-bedrock-api-key', 'AB' + 'SK' + std64(109), 'AB' + 'SK' + std64(108), value => `KEY=${value}`),
  make('gcp-api-key', aiza + word(35), aiza + word(34), value => `key: ${value}`),
  make(
    'gcp-oauth-client-secret',
    'GOC' + 'SPX-' + url64(28),
    'GOC' + 'SPX-' + url64(27),
    // Quoted under a `secret` key, so the generic rule would also match: it must not report it again.
    value => `  "client_secret": "${value}",`,
  ),
  make('gcp-oauth-token', 'ya' + '29.' + url64(40), 'ya' + '29.' + url64(39), value => `Authorization: Bearer ${value}`),
  make('gcp-refresh-token', '1//0' + url64(40), '1//0' + url64(39), value => `"refresh_token": "${value}"`),
  make('fcm-server-key', 'AAAA' + word(7) + ':APA91b' + url64(134), 'AAAA' + word(7) + ':APA91b' + url64(129), value => `key=${value}`),
  make(
    'gcp-service-account-key',
    `"private_key_id": "${hex(40)}"`,
    `"private_key_id": "${hex(39)}"`,
    value => `  ${value},`,
  ),
  make(
    'azure-storage-key',
    'Account' + 'Key=' + std64(86) + '==',
    'Account' + 'Key=' + std64(85) + '==',
    value => `DefaultEndpointsProtocol=https;AccountName=acct;${value};EndpointSuffix=core.windows.net`,
  ),
  make(
    'azure-shared-access-key',
    'Shared' + 'AccessKey=' + std64(43) + '=',
    'Shared' + 'AccessKey=' + std64(42) + '=',
    value => `Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=root;${value}`,
  ),
  make(
    'azure-sas-signature',
    'sig=' + word(43) + '%3D',
    'sig=' + word(42) + '%3D',
    value => `url = "https://acct.blob.core.windows.net/c/b?sv=2022-11-02&se=2030-01-01T00%3A00%3A00Z&${value}"`,
  ),
  make('azure-ad-client-secret', 'Abc' + '8Q~' + word(31), 'Abc' + '8Q~' + word(30), value => `client_secret = ${value}`),
  make('private-key', begin + 'RSA PRIVATE KEY-----', begin + 'RSA PRIVATE KEY----', value => `  ${value}`),
  make(
    'private-key-base64',
    base64Of(begin + 'PRIVATE KEY--'),
    base64Of(begin + 'PRIVATE KEY--').slice(0, -1),
    value => `  tls.key: ${value}`,
  ),
  make('putty-private-key', 'PuTTY' + '-User-Key-File-3:', 'PuTTY' + '-User-Key-File-4:', value => `${value} ssh-ed25519`),
  make('age-secret-key', 'AGE-SECRET' + '-KEY-1' + bech32(58), 'AGE-SECRET' + '-KEY-1' + bech32(57), value => `# ${value}`),
  make('slack-token', xoxb + '1234567890', xoxb + '123456789', value => `SLACK=${value}`),
  make(
    'slack-app-token',
    'xa' + 'pp-1-' + upper(11) + '-1234567890123-' + hex(32),
    'xa' + 'pp-1-' + upper(11) + '-1234567890123-' + hex(31),
    value => `SLACK_APP_TOKEN=${value}`,
  ),
  make(
    'slack-webhook',
    'hooks.slack' + '.com/services/T' + upper(8) + '/B' + upper(8) + '/' + word(24),
    'hooks.slack' + '.com/services/T' + upper(8) + '/B' + upper(8) + '/' + word(22),
    value => `url: https://${value}`,
  ),
  make('stripe-live-key', live + word(24), live + word(23), value => `STRIPE=${value}`),
  make('stripe-webhook-secret', 'wh' + 'sec_' + word(32), 'wh' + 'sec_' + word(31), value => `STRIPE_WEBHOOK=${value}`),
  make('anthropic-key', anthropic + word(32), anthropic + word(31), value => `KEY=${value}`),
  // `(proj-)?` is optional, so only a bare key one character short is a near miss.
  make('openai-key', openai + 'proj-' + word(32), openai + word(31), value => `KEY=${value}`),
  make('groq-key', 'gs' + 'k_' + word(52), 'gs' + 'k_' + word(51), value => `GROQ=${value}`),
  make('replicate-key', 'r8' + '_' + url64(37), 'r8' + '_' + url64(36), value => `REPLICATE=${value}`),
  make('perplexity-key', 'pp' + 'lx-' + word(48), 'pp' + 'lx-' + word(47), value => `PPLX=${value}`),
  make('xai-key', 'xa' + 'i-' + word(80), 'xa' + 'i-' + word(79), value => `XAI=${value}`),
  make('huggingface-token', 'hf' + '_' + word(34), 'hf' + '_' + word(33), value => `HF_TOKEN=${value}`),
  make('npm-token', 'np' + 'm_' + word(36), 'np' + 'm_' + word(35), value => `NPM=${value}`),
  make('pypi-token', 'py' + 'pi-' + 'AgEIcHlwaS5vcmc' + url64(50), 'py' + 'pi-' + 'AgEIcHlwaS5vcmc' + url64(49), value => `TWINE=${value}`),
  make('rubygems-token', 'ruby' + 'gems_' + hex(48), 'ruby' + 'gems_' + hex(47), value => `GEM=${value}`),
  make('nuget-key', 'oy' + '2' + lower32(43), 'oy' + '2' + lower32(42), value => `NUGET=${value}`),
  make('docker-pat', 'dckr' + '_pat_' + url64(27), 'dckr' + '_pat_' + url64(26), value => `DOCKER=${value}`),
  make('twilio-api-key', 'S' + 'K' + hex(32), 'S' + 'K' + hex(31), value => `TWILIO_API_KEY=${value}`),
  make(
    'sendgrid-key',
    'S' + 'G.' + url64(22) + '.' + url64(43),
    'S' + 'G.' + url64(22) + '.' + url64(42),
    value => `SENDGRID=${value}`,
  ),
  make('mailgun-key', 'ke' + 'y-' + hex(32), 'ke' + 'y-' + hex(31), value => `MAILGUN=${value}`),
  make('mailchimp-key', hex(32) + '-us' + '21', hex(31) + '-us' + '21', value => `MC=${value}`),
  make('shopify-token', 'shp' + 'at_' + hex(32), 'shp' + 'at_' + hex(31), value => `SHOPIFY=${value}`),
  make('databricks-token', 'da' + 'pi' + hex(32), 'da' + 'pi' + hex(31), value => `DATABRICKS=${value}`),
  make('digitalocean-token', 'do' + 'p_v1_' + hex(64), 'do' + 'p_v1_' + hex(63), value => `DO=${value}`),
  make('vault-token', 'hv' + 's.' + url64(90), 'hv' + 's.' + url64(89), value => `VAULT=${value}`),
  make(
    'terraform-cloud-token',
    word(14) + '.at' + 'lasv1.' + url64(60),
    word(14) + '.at' + 'lasv1.' + url64(59),
    value => `token "app.terraform.io" ${value}`,
  ),
  make('doppler-token', 'dp' + '.pt.' + word(43), 'dp' + '.pt.' + word(42), value => `DOPPLER=${value}`),
  make('postman-key', 'PM' + 'AK-' + hex(24) + '-' + hex(34), 'PM' + 'AK-' + hex(24) + '-' + hex(33), value => `POSTMAN=${value}`),
  make('grafana-token', 'gl' + 'sa_' + word(32) + '_' + hex(8), 'gl' + 'sa_' + word(32) + '_' + hex(7), value => `GRAFANA=${value}`),
  make('newrelic-key', 'NR' + 'AK-' + upper(27), 'NR' + 'AK-' + upper(26), value => `NEW_RELIC=${value}`),
  make('sentry-token', 'sntr' + 'yu_' + hex(64), 'sntr' + 'yu_' + hex(63), value => `SENTRY=${value}`),
  make('linear-key', 'lin' + '_api_' + word(40), 'lin' + '_api_' + word(39), value => `LINEAR=${value}`),
  make('notion-token', 'nt' + 'n_' + '12345678901' + word(35), 'nt' + 'n_' + '12345678901' + word(34), value => `NOTION=${value}`),
  make('atlassian-token', 'ATATT' + '3' + url64(186), 'ATATT' + '3' + url64(185), value => `JIRA=${value}`),
  make('supabase-key', 'sb' + 'p_' + lower32(40), 'sb' + 'p_' + lower32(39), value => `SUPABASE=${value}`),
  make('planetscale-token', 'pscale' + '_tkn_' + url64(32), 'pscale' + '_tkn_' + url64(31), value => `PS=${value}`),
  make('flyio-token', 'fo' + '1_' + url64(43), 'fo' + '1_' + url64(42), value => `FLY=${value}`),
  make('telegram-bot-token', '123456789' + ':AA' + url64(33), '123456789' + ':AA' + url64(32), value => `BOT=${value}`),
  make(
    'discord-bot-token',
    'M' + 'T' + word(22) + '.' + word(6) + '.' + url64(27),
    'M' + 'T' + word(22) + '.' + word(6) + '.' + url64(26),
    value => `DISCORD=${value}`,
  ),
  make(
    'discord-webhook',
    'discord' + '.com/api/webhooks/123456789012345678/' + url64(64),
    'discord' + '.com/api/webhooks/123456789012345678/' + url64(59),
    value => `url: https://${value}`,
  ),
  make('square-token', 'EA' + 'AA' + url64(60), 'EA' + 'AA' + url64(59), value => `SQUARE=${value}`),
  make(
    'braintree-token',
    'access' + '_token$production$' + lower32(16) + '$' + hex(32),
    'access' + '_token$production$' + lower32(16) + '$' + hex(31),
    value => `BT=${value}`,
  ),
  make('heroku-api-key', 'HR' + 'KU-AA' + url64(58), 'HR' + 'KU-AA' + url64(57), value => `HEROKU=${value}`),
  make('dynatrace-token', 'dt0c' + '01.' + word(24) + '.' + word(64), 'dt0c' + '01.' + word(24) + '.' + word(63), value => `DT=${value}`),
  make('pulumi-token', 'pu' + 'l-' + hex(40), 'pu' + 'l-' + hex(39), value => `PULUMI=${value}`),
  make('brevo-key', 'xkeys' + 'ib-' + hex(64) + '-' + word(16), 'xkeys' + 'ib-' + hex(64) + '-' + word(15), value => `BREVO=${value}`),
  make('sourcegraph-token', 'sg' + 'p_' + hex(40), 'sg' + 'p_' + hex(39), value => `SRC=${value}`),
  make('alibaba-access-key-id', 'LT' + 'AI' + word(20), 'LT' + 'AI' + word(19), value => `ALI=${value}`),
  make('azure-acr-password', std64(42) + '+AC' + 'R' + word(6), std64(42) + '+AC' + 'R' + word(5), value => `docker login -p ${value}`),
  make(
    'aws-secret-access-key',
    'aws_secret' + '_access_key = ' + std64(40),
    'aws_secret' + '_access_key = ' + std64(39),
  ),
  make('aws-session-token', 'aws_session' + '_token=' + std64(100), 'aws_session' + '_token=' + std64(99), value => `export ${value}`),
  make('twilio-auth-token', 'TWILIO' + '_AUTH_TOKEN=' + hex(32), 'TWILIO' + '_AUTH_TOKEN=' + hex(31)),
  make(
    'npmrc-auth',
    '/:_auth' + 'Token=' + word(16),
    '/:_auth' + 'Token=' + word(15),
    value => `//registry.example.org${value}`,
  ),
  make(
    'nuget-config-password',
    '<add key="ClearText' + 'Password" value="' + word(12) + '"',
    '<add key="ClearText' + 'Password" value="' + word(7) + '"',
    value => `    ${value} />`,
  ),
  make(
    'url-credentials',
    'postgres://app:' + word(12) + '@',
    'postgres://app:' + 'ab' + '@',
    value => `DATABASE_URL=${value}db.internal:5432/app`,
  ),
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

/** Other shapes of what the rules must find: one finding each, by the named rule. */
export const VARIANTS: Variant[] = (() => {
  const variants: Variant[] = [];
  const add = (rule: string, name: string, secret: string, wrap = (value: string) => value): void => {
    variants.push({ rule, name, secret, text: wrap(secret) });
  };
  const assign = (value: string): string => `TOKEN_VALUE=${value}`;

  for (const [name, body] of [
    ['project token', 'glptt-' + hex(40)],
    ['deploy token', 'gldt-' + url64(20)],
    ['runner token', 'glrt-' + url64(20)],
    ['routable runner token', 'glrt-t1_' + url64(30)],
    ['feed token', 'glft-' + url64(20)],
  ] as const) {
    add('gitlab-token', name, body, assign);
  }

  for (const prefix of ['ASIA', 'ABIA', 'ACCA', 'A3T' + 'A']) {
    add('aws-access-key', `${prefix}...`, prefix + upper(16), value => `id=${value}`);
  }

  for (const kind of ['RSA ', 'EC ', 'DSA ', 'OPENSSH ', 'ENCRYPTED ', 'SSH2 ENCRYPTED ', '']) {
    add('private-key', `${kind.trim() || 'plain'} PRIVATE KEY`, begin + kind + 'PRIVATE KEY-----');
  }
  add('private-key', 'PGP private key block', begin + 'PGP PRIVATE KEY BLOCK-----');
  add('private-key', 'inside a JSON string', `"private_key": "${begin}PRIVATE KEY-----\\nMIIEv...\\n"`.replace('MIIEv...', word(12)));

  for (const kind of ['', 'RSA ', 'EC ', 'DSA ', 'OPENSSH ', 'ENCRYPTED ']) {
    // The whole PEM header in base64, as a kubeconfig or a Kubernetes TLS secret holds it.
    add('private-key-base64', `${kind.trim() || 'plain'} PRIVATE KEY`, base64Of(begin + kind + 'PRIVATE KEY-----'), value => `  client-key-data: ${value}`);
  }

  for (const letter of ['a', 'p', 'r', 's', 'o']) add('slack-token', `xox${letter}`, 'xo' + `x${letter}-` + '1234567890-abcdefghij');
  add('slack-token', 'config token', 'xo' + 'xe.xo' + 'xp-1-' + word(30));
  add('slack-token', 'refresh token', 'xo' + 'xe-1-' + word(30));
  add('slack-webhook', 'workflow webhook', 'hooks.slack' + '.com/workflows/' + word(43));
  add('slack-webhook', 'trigger webhook', 'hooks.slack' + '.com/triggers/' + word(43));

  add('anthropic-key', 'admin key', anthropic + 'admin01-' + url64(93) + 'AA');
  add('anthropic-key', 'api key', anthropic + 'api03-' + url64(93) + 'AA');
  add('openai-key', 'service account key', openai + 'svcacct-' + url64(60));
  add('openai-key', 'admin key', openai + 'admin-' + url64(60));

  add('gcp-oauth-token', 'a long access token', 'ya' + '29.a0' + url64(160));
  add('huggingface-token', 'organization token', 'api' + '_org_' + word(34));
  add('digitalocean-token', 'oauth token', 'do' + 'o_v1_' + hex(64));
  add('digitalocean-token', 'refresh token', 'do' + 'r_v1_' + hex(64));
  for (const kind of ['ca', 'pa', 'ss']) add('shopify-token', `shp${kind}`, `shp${kind}_` + hex(32));
  add('planetscale-token', 'password', 'pscale' + '_pw_' + url64(32));
  add('planetscale-token', 'oauth token', 'pscale' + '_oauth_' + url64(32));
  add('pypi-token', 'test.pypi.org token', 'py' + 'pi-' + 'AgENdGVzdC5weXBpLm9yZw' + url64(50));
  add('newrelic-key', 'insert key', 'NR' + 'II-' + word(32));
  add('notion-token', 'integration secret', 'sec' + 'ret_' + word(43));
  add('supabase-key', 'secret api key', 'sb' + '_secret_' + url64(30));
  add('sentry-token', 'organization token', 'sntr' + 'ys_' + 'eyJpYXQiO' + std64(60) + '_' + std64(43));
  add('vault-token', 'batch token', 'hv' + 'b.' + url64(140));
  add('flyio-token', 'macaroon (fm1r)', 'fm' + '1r_' + std64(120));
  add('flyio-token', 'macaroon (fm2)', 'fm' + '2_' + std64(120));
  add('grafana-token', 'cloud token', 'gl' + 'c_' + std64(40));
  add('grafana-token', 'legacy api key', 'eyJr' + 'Ijoi' + word(80));
  add('square-token', 'access token (sq0atp)', 'sq0' + 'atp-' + url64(22));
  add('square-token', 'oauth secret (sq0csp)', 'sq0' + 'csp-' + url64(43));
  add('discord-webhook', 'discordapp.com host', 'discordapp' + '.com/api/webhooks/123456789012345678/' + url64(68));
  add('sourcegraph-token', 'with an instance prefix', 'sg' + 'p_' + hex(16) + '_' + hex(40));
  add('sourcegraph-token', 'local', 'sg' + 'p_local_' + hex(40));
  add('azure-sas-signature', 'unencoded padding', 'sig=' + word(43) + '=', value => `https://a.blob.core.windows.net/c?sp=r&${value}&sv=2022-11-02`);
  add('azure-sas-signature', 'encoded plus and slash', 'sig=' + word(40) + '%2B%2F' + 'b' + '%3d', value => `https://a.blob.core.windows.net/c?sv=2022-11-02&${value}`);
  add('aws-secret-access-key', 'a JSON credential', 'SecretAccessKey": "' + std64(40), value => `  "${value}",`);
  add('aws-secret-access-key', 'a JS client option', "secretAccessKey: '" + std64(40));
  add('aws-secret-access-key', 'AWS_SECRET_ACCESS_KEY', 'AWS_SECRET' + '_ACCESS_KEY=' + std64(40));
  add('aws-secret-access-key', 'an AWS_SECRET_KEY alias', 'aws-secret' + '-key: ' + std64(40));
  add('aws-session-token', 'a JSON credential', 'SessionToken": "' + std64(120), value => `  "${value}",`);
  add('twilio-auth-token', 'quoted, any case', 'twilio_auth' + '_token = "' + hex(32));
  add('npmrc-auth', 'a basic auth line', '/:_auth' + '=' + std64(24), value => `//registry.example.org${value}`);
  add('npmrc-auth', 'a password line', '/:_pass' + 'word=' + std64(24), value => `//registry.example.org${value}`);
  add('nuget-config-password', 'plain Password', '<add key="Pass' + 'word" value="' + word(12) + '"', value => `<packageSourceCredentials>${value} />`);

  for (const scheme of ['mysql', 'mongodb+srv', 'redis', 'amqps', 'https', 'ftp', 'git+https', 'jdbc:postgresql']) {
    add('url-credentials', scheme, `${scheme}://deploy:${word(14)}@`, value => `url = ${value}example.org/path`);
  }
  add('url-credentials', 'no user (redis style)', 'redis://:' + word(14) + '@', value => `${value}cache.internal:6379`);
  add('url-credentials', 'the token as user and a literal password', 'https://' + word(20) + ':x-oauth-basic@', value => `${value}github.com/org/repo.git`);
  return variants;
})();

/** The secret part of a sample, the thing that must never be printed whole. */
export const secretOf = (sample: Sample): string => sample.secret;

export const sampleFor = (rule: string): Sample => {
  const sample = SAMPLES.find(candidate => candidate.rule === rule);
  if (sample === undefined) throw new Error(`no sample for ${rule}`);
  return sample;
};

/** A GitHub token for tests that need one secret and nothing else. */
export const githubToken = (): string => sampleFor('github-token').secret;
