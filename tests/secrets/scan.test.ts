import { beforeAll, describe, expect, it } from 'vitest';
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
import { githubToken, sampleFor, SAMPLES, VARIANTS, word, type Sample } from '../support/secrets.js';

const one = (text: string, allow: string[] = []) => scanAddedLines('src/a.ts', [{ line: 7, text }], allow);

describe('the content rules', () => {
  it('has the rules of the brief, in an order that reports a span once', () => {
    expect(SECRET_RULES.map(rule => rule.id)).toEqual([
      'github-token',
      'github-pat',
      'gitlab-token',
      'aws-access-key',
      'aws-bedrock-api-key',
      'gcp-api-key',
      'gcp-oauth-client-secret',
      'gcp-oauth-token',
      'gcp-refresh-token',
      'fcm-server-key',
      'gcp-service-account-key',
      'azure-storage-key',
      'azure-shared-access-key',
      'azure-sas-signature',
      'azure-ad-client-secret',
      'azure-acr-password',
      'private-key',
      'private-key-base64',
      'putty-private-key',
      'age-secret-key',
      'slack-token',
      'slack-app-token',
      'slack-webhook',
      'stripe-live-key',
      'stripe-webhook-secret',
      'anthropic-key',
      'openai-key',
      'groq-key',
      'replicate-key',
      'perplexity-key',
      'xai-key',
      'huggingface-token',
      'npm-token',
      'pypi-token',
      'rubygems-token',
      'nuget-key',
      'docker-pat',
      'twilio-api-key',
      'sendgrid-key',
      'mailgun-key',
      'mailchimp-key',
      'shopify-token',
      'databricks-token',
      'digitalocean-token',
      'vault-token',
      'terraform-cloud-token',
      'doppler-token',
      'postman-key',
      'grafana-token',
      'newrelic-key',
      'sentry-token',
      'linear-key',
      'notion-token',
      'atlassian-token',
      'supabase-key',
      'planetscale-token',
      'flyio-token',
      'telegram-bot-token',
      'discord-bot-token',
      'discord-webhook',
      'square-token',
      'braintree-token',
      'heroku-api-key',
      'dynatrace-token',
      'pulumi-token',
      'brevo-key',
      'sourcegraph-token',
      'alibaba-access-key-id',
      'aws-secret-access-key',
      'aws-session-token',
      'twilio-auth-token',
      'npmrc-auth',
      'nuget-config-password',
      'url-credentials',
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

    it('ignores a value that is a whole environment variable reference, in a JSON config as the kit renders it', () => {
      expect(one('        "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_PERSONAL_ACCESS_TOKEN"')).toEqual([]);
      expect(one('"GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"')).toEqual([]);
      for (const value of ['$DATABASE_PASSWORD_VALUE', '${DATABASE_PASSWORD}', '%DATABASE_PASSWORD%', '%DatabasePassword%']) {
        expect(found(value), value).toEqual([]);
      }
    });

    it('flags a real value that starts with a dollar sign or a percent escape', () => {
      for (const value of ['$Up3rS3cretXk9abc', '$5ecretValue1234', '%21Xk9mQ2pL7vRtZ', '%2FXk9mQ2pL7vRtZ']) {
        expect(found(value), value).toEqual(['generic-assignment']);
      }
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

describe('the broadened rule set', () => {
  const rules = (text: string): string[] => one(text).map(finding => finding.rule);

  it('has a unique id and a description for every rule, and the generic rule last', () => {
    const ids = SECRET_RULES.map(rule => rule.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of SECRET_RULES) expect(rule.description.length).toBeGreaterThan(10);
    expect(ids.at(-1)).toBe('generic-assignment');
    expect(ids.at(-2)).toBe('jwt');
    // `openai-key` also matches an Anthropic key, so the specific rule must come first.
    expect(ids.indexOf('anthropic-key')).toBeLessThan(ids.indexOf('openai-key'));
  });

  it.each(VARIANTS)('$rule: finds $name, once', variant => {
    expect(rules(variant.text)).toEqual([variant.rule]);
  });

  it.each([
    'groq-key',
    'replicate-key',
    'perplexity-key',
    'xai-key',
    'huggingface-token',
    'npm-token',
    'rubygems-token',
    'docker-pat',
    'shopify-token',
    'databricks-token',
    'digitalocean-token',
    'doppler-token',
    'postman-key',
    'linear-key',
    'supabase-key',
    'pulumi-token',
    'brevo-key',
    'sourcegraph-token',
    'heroku-api-key',
    'atlassian-token',
    'gcp-api-key',
  ])('%s: a token that is longer than the usual one is found too (the prefix makes it a token)', rule => {
    expect(rules(`${sampleFor(rule).text}0`)).toEqual([rule]);
  });

  describe('Firebase and Google Cloud API keys (AIza)', () => {
    const key = sampleFor('gcp-api-key').secret;

    it.each([
      ['google-services.json', `        "current_key": "${key}"`],
      ['GoogleService-Info.plist', `\t<string>${key}</string>`],
      ['a Firebase web config in JS', `  apiKey: "${key}",`],
      ['a Firebase web config, single quotes, one line', `const firebaseConfig = { apiKey: '${key}', authDomain: 'a.firebaseapp.com' };`],
      ['a firebase_options.dart', `    apiKey: '${key}',`],
      ['a Vite or Next env file', `NEXT_PUBLIC_FIREBASE_API_KEY=${key}`],
      ['an Android resource', `    <string name="google_api_key" translatable="false">${key}</string>`],
      ['a Maps URL', `<script src="https://maps.googleapis.com/maps/api/js?key=${key}&callback=init"></script>`],
      ['a Gemini call', `curl "https://generativelanguage.googleapis.com/v1/models?key=${key}"`],
    ])('%s: one finding, by gcp-api-key', (_name, line) => {
      const found = one(line);

      expect(found.map(finding => finding.rule)).toEqual(['gcp-api-key']);
      expect(found[0]?.masked).toBe('AIza…(39 chars)');
    });

    it('finds a key that ends with a dash (the character class includes it)', () => {
      const dashed = `${'AI' + 'za'}${word(34)}-`;

      expect(one(`"current_key": "${dashed}"`).map(finding => ({ rule: finding.rule, masked: finding.masked }))).toEqual([
        { rule: 'gcp-api-key', masked: 'AIza…(39 chars)' },
      ]);
    });

    it('does not block google-services.json or GoogleService-Info.plist by name: they hold client keys, the content rule decides', () => {
      expect(scanFileName('app/google-services.json')).toBeUndefined();
      expect(scanFileName('ios/Runner/GoogleService-Info.plist')).toBeUndefined();
    });

    it('allowing one key by fingerprint lets the file through, and only that key', () => {
      const [finding] = one(`"current_key": "${key}"`);
      const other = `${'AI' + 'za'}${word(35).split('').reverse().join('')}`;

      expect(one(`"current_key": "${key}"`, [finding?.fingerprint ?? ''])).toEqual([]);
      expect(one(`"current_key": "${other}"`, [finding?.fingerprint ?? '']).map(item => item.rule)).toEqual(['gcp-api-key']);
    });
  });

  describe('spans are reported once, by the most specific rule', () => {
    it('a GitHub token in the user part of a URL is a github-token, not a url-credentials', () => {
      expect(rules(`git clone https://${githubToken()}:x-oauth-basic@github.com/o/r.git`)).toEqual(['github-token']);
    });

    it('a URL whose user is a template and whose password only marks a token is not a secret', () => {
      for (const user of ['${GITHUB_TOKEN}', '$GITHUB_TOKEN', '{token}', '%(token)s']) {
        expect(rules(`git clone https://${user}:x-oauth-basic@github.com/o/r.git`)).toEqual([]);
      }
      expect(rules(`git clone https://${word(20)}:x-oauth-basic@github.com/o/r.git`)).toEqual(['url-credentials']);
    });

    it('an npm token in an .npmrc line is an npm-token, not an npmrc-auth', () => {
      const token = sampleFor('npm-token').secret;

      expect(rules(`//registry.npmjs.org/:_authToken=${token}`)).toEqual(['npm-token']);
    });

    it('a Slack webhook is a slack-webhook and nothing else', () => {
      expect(rules(`SLACK_URL="https://${sampleFor('slack-webhook').secret}"`)).toEqual(['slack-webhook']);
    });

    it('a minified service-account JSON gives the key id and the key block, each once', () => {
      const keyId = sampleFor('gcp-service-account-key').secret;
      const block = sampleFor('private-key').secret;
      const json = `{"type":"service_account",${keyId},"private_key":"${block}\\n${word(20)}\\n"}`;

      expect(rules(json)).toEqual(['gcp-service-account-key', 'private-key']);
    });

    it('a base64 PEM and an Azure storage key on one line are two findings', () => {
      const pem = sampleFor('private-key-base64').secret;
      const storage = sampleFor('azure-storage-key').secret;

      expect(rules(`${pem} ${storage}`)).toEqual(['azure-storage-key', 'private-key-base64']);
    });
  });

  describe('placeholders and documentation examples are not secrets', () => {
    const filler = (length: number): string => 'x'.repeat(length);

    it('a token whose body is one repeated character is a filler', () => {
      for (const line of [
        `GITLAB_TOKEN=${'gl' + 'pat-'}${filler(20)}`,
        `STRIPE_WEBHOOK=${'wh' + 'sec_'}${filler(32)}`,
        `HF_TOKEN=${'hf' + '_'}${filler(34)}`,
        `NPM=${'np' + 'm_'}${filler(36)}`,
        `GROQ=${'gs' + 'k_'}${filler(52)}`,
        `Authorization: Bearer ${'ya' + '29.'}${filler(60)}`,
        `"client_secret": "${'GOC' + 'SPX-'}${filler(28)}"`,
        `DOCKER=${'dckr' + '_pat_'}${filler(27)}`,
      ]) {
        expect(one(line)).toEqual([]);
      }
    });

    it('the Slack webhook of the documentation (zeros and X) is not one', () => {
      expect(one(`url: https://hooks.slack${'.com'}/services/T00000000/B00000000/${filler(24)}`)).toEqual([]);
    });

    it('the AWS documentation access key id (ends in EXAMPLE) is not one', () => {
      expect(one(`AWS_ACCESS_KEY_ID=${'AK' + 'IAIOSFODNN7EXAMPLE'}`)).toEqual([]);
      expect(one(`id: ${'AS' + 'IAIOSFODNN7EXAMPLE'}`)).toEqual([]);
    });

    it('an AWS secret key with EXAMPLE in it (the documentation key) is not one', () => {
      expect(one(`aws_secret${'_access_key'} = ${word(30)}EXAMPLEKEY`)).toEqual([]);
    });

    it('an .npmrc token read from the environment is not one', () => {
      expect(one('//registry.npmjs.org/:_authToken=${NPM_TOKEN}')).toEqual([]);
      expect(one('//registry.npmjs.org/:_authToken=$NPM_TOKEN')).toEqual([]);
    });

    it('a NuGet password from the environment is not one', () => {
      for (const value of ['%NUGET_PASSWORD%', '$(NUGET_PASSWORD)', '${NUGET_PASSWORD}', 'xxxxxxxxxxxx']) {
        expect(one(`<add key="ClearText${'Password'}" value="${value}" />`)).toEqual([]);
      }
    });
  });

  describe('short prefixes inside base64 blobs are not tokens', () => {
    it('EAAA and 60 characters are a Square token only as a whole word', () => {
      const square = sampleFor('square-token').secret;

      expect(rules(`SQUARE=${square}`)).toEqual(['square-token']);
      expect(rules(`data:application/wasm;base64,${word(20)}/${square}`)).toEqual([]);
      expect(rules(`blob = "${word(20)}+${square}"`)).toEqual([]);
      expect(rules(`SQUARE=${square}${word(10)}`)).toEqual([]);
    });

    it('ABSK is a Bedrock key only at the start of a word', () => {
      const bedrock = sampleFor('aws-bedrock-api-key').secret;

      expect(rules(`KEY=${bedrock}`)).toEqual(['aws-bedrock-api-key']);
      expect(rules(`blob = "${word(20)}/${bedrock}"`)).toEqual([]);
    });
  });

  describe('discord-bot-token', () => {
    const sample = sampleFor('discord-bot-token');
    const token = sample.secret;

    it('finds a token as an environment value, quoted, after a header word and before a full stop', () => {
      for (const line of [`DISCORD=${token}`, `"token": "${token}"`, `Authorization: Bot ${token}`, `the token is ${token}.`, `(${token})`, token]) {
        expect(rules(line), line.replace(token, '<token>')).toEqual(['discord-bot-token']);
      }
    });

    it('does not read a dotted identifier as a token, with or without a context', () => {
      const identifier = ['NTLMAuthenticationProvide', 'method', 'thisIsAVeryLongMethodNameForTesting'].join('.');
      for (const line of [
        identifier,
        `${identifier}()`,
        `com.example.${identifier}()`,
        `${identifier}.andThenSomeMore`,
        `${identifier}AndMoreWordsOnTheEnd`,
        `x = ${identifier};`,
      ]) {
        expect(rules(line), line).toEqual([]);
      }
    });

    it('needs a first segment that is the base64 of a decimal user id, as Discord makes it', () => {
      const [, timestamp, hmac] = token.split('.');
      const idOfLetters = 'M' + 'T' + word(22);
      expect(rules(`${idOfLetters}.${timestamp}.${hmac}`)).toEqual([]);
      // 17 to 19 digit ids are 23 to 26 characters of base64.
      for (const id of ['12345678901234567', '123456789012345678', '1234567890123456789']) {
        const first = Buffer.from(id).toString('base64').replace(/=+$/, '');
        expect(rules(`${first}.${timestamp}.${hmac}`), `${id.length} digits`).toEqual(['discord-bot-token']);
      }
    });

    it('does not read a token that is glued to a longer word or a dotted chain', () => {
      // (A third segment of up to 38 characters is a token: a few characters after a short one are part of it.)
      const longTail = 's'.repeat(12);
      for (const line of [`prefix${token}`, `foo.${token}`, `${token}.suffix`, `${token}${longTail}`, `${token}-${longTail}`]) {
        expect(rules(line), line.replace(token, '<token>')).toEqual([]);
      }
    });
  });

  describe('url-credentials', () => {
    const url = (password: string, user = 'app', scheme = 'postgres'): string => `${scheme}://${user}:${password}@db.internal:5432/app`;

    it('flags a password, percent-encoded characters and symbols included', () => {
      for (const password of [word(12), 'p%40ss%3Aw0rd', 'Zq7!Zq7*Zq7', 'a-b_c.d~e', 'hunter2hunter2']) {
        expect(rules(url(password))).toEqual(['url-credentials']);
      }
    });

    it('reports the match as the scheme, user and password only, never the host', () => {
      const password = 'Zq7'.repeat(4);
      const [finding] = one(url(password));

      // `postgres://app:` + the password + `@`: the host and the port are not part of the match.
      expect(finding?.masked).toBe(`post…(${'postgres://app:'.length + password.length + '@'.length} chars)`);
    });

    it('ignores references, templates and the placeholders of documentation', () => {
      for (const password of [
        '${DB_PASSWORD}',
        '$DB_PASSWORD',
        '$(cat /run/secrets/db)',
        '{password}',
        '{{ db_password }}',
        '<password>',
        '[password]',
        '%s',
        '%(password)s',
        'password',
        'PASSWORD',
        'passwd',
        'pass',
        'pwd',
        'secret',
        'changeme',
        'CHANGEME',
        'change-me',
        'example',
        'placeholder',
        'your-password',
        'YOUR_PASSWORD',
        'yourpassword',
        'mypassword',
        'xxx',
        'xxxxxxxxxxxx',
        '********',
        '*****',
        'xyz',
        'foobar',
        'test',
        'somepassword',
      ]) {
        expect(one(url(password))).toEqual([]);
      }
    });

    it('ignores a password that is the user name (a default credential) and the user:password examples', () => {
      for (const [user, password] of [
        ['postgres', 'postgres'],
        ['admin', 'admin'],
        ['root', 'root'],
        ['Guest', 'guest'],
        ['user', 'password'],
        ['username', 'password'],
        ['user', 'pass'],
      ] as const) {
        expect(one(url(password, user))).toEqual([]);
      }
      expect(one('redis://:password@cache:6379')).toEqual([]);
    });

    it('flags a real password that starts with a percent escape or a dollar sign', () => {
      // The short form of the owner's probes, assembled so that no URL with a password is in this file.
      expect(rules(['postgres://app', '%21Xk9mQ2pL7vRt@db'].join(':'))).toEqual(['url-credentials']);
      expect(rules(['postgres://app', '$Up3rS3cretXk9@db'].join(':'))).toEqual(['url-credentials']);
      for (const password of ['%21Xk9mQ2pL7vRt', '%2FXk9mQ2pL7vRt', '%40admin', '%7Ejk3', '$Up3rS3cretXk9', '$5ecret', '$ab12']) {
        expect(rules(url(password)), password).toEqual(['url-credentials']);
      }
    });

    it('ignores a Windows %VAR%, a printf placeholder and an environment variable reference', () => {
      for (const password of ['%DB_PASSWORD%', '%DbPassword%', '%_SECRET%', '%s', '%d', '%(db_password)s', '$DB_PASSWORD', '$_X1', '${db_password}', '${DB_PASSWORD:-x}']) {
        expect(one(url(password)), password).toEqual([]);
      }
    });

    it('does not read a query string or a fragment as a password', () => {
      for (const line of [
        'http://example.com:8080?next=@foo',
        'https://example.com:8080#section@here',
        'http://example.com:8080/?next=@foo',
        'https://example.org:443?redirect=@me',
        'http://host:80?a=b@c.d',
      ]) {
        expect(one(line), line).toEqual([]);
      }
    });

    it('flags a literal password for a docker-compose style user', () => {
      expect(rules(url('s3cr3tValue1', 'postgres'))).toEqual(['url-credentials']);
    });

    it('does not flag a URL without a password, a port, an email address or a path with an @', () => {
      for (const line of [
        'https://example.org:8080/path',
        'http://localhost:3000/api/@me',
        'ssh://git@github.com/org/repo.git',
        'ssh://git@github.com:22/org/repo.git',
        'mailto:someone@example.org',
        'git@github.com:org/repo.git',
        'https://example.org/a@b',
        'see https://example.org:8080 and then user@example.org',
        '"https://" + host + ":" + port + "@"',
      ]) {
        expect(one(line)).toEqual([]);
      }
    });

    it('finds the credentials in a quoted URL, in a JSON value and after a jdbc prefix', () => {
      expect(rules(`"url": "${url(word(12))}",`)).toEqual(['url-credentials']);
      expect(rules(`spring.datasource.url=jdbc:${url(word(12), 'app', 'postgresql')}`)).toEqual(['url-credentials']);
    });
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
    // Nor more than four characters of the secret. (The rule id is left out: `rubygems-token` spells the
    // first characters of a `rubygems_` key itself.)
    expect(line.replace(finding?.rule ?? '', '')).not.toContain(sample.secret.slice(0, 8));
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
    // Added with the broadened rules.
    'AuthKey_ABC123DEF4.p8',
    'certs/apns.P8',
    'putty/work.ppk',
    'release.jks',
    'app/release.keystore',
    'debug.keystore',
    'firebase-adminsdk-abc12-0123456789.json',
    'secrets/my-app-firebase-adminsdk-xyz.json',
    '.aws/credentials',
    'home/.aws/credentials',
    'gcloud/application_default_credentials.json',
    'kubeconfig',
    'deploy/kubeconfig',
    'cluster.kubeconfig',
    '.kube/config',
    'home/.kube/config',
    'terraform.tfvars',
    'infra/prod.auto.tfvars',
    'infra/prod.tfvars.json',
    'terraform.tfstate',
    'infra/terraform.tfstate.backup',
    'infra/prod.tfstate',
    'terraform.tfstate.1700000000.backup',
    '.npmrc',
    'packages/web/.npmrc',
    '.pypirc',
    '.netrc',
    '_netrc',
    '.git-credentials',
    '.pgpass',
    '.htpasswd',
    '.dockercfg',
    'client.ovpn',
    'vpn/work.OVPN',
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
    // Not secret, or not a credential file.
    'google-services.json',
    'app/google-services.json',
    'ios/Runner/GoogleService-Info.plist',
    'terraform.tfvars.example',
    'infra/prod.tfvars.example',
    '.npmrc.example',
    '.pypirc.template',
    'netrc.md',
    'credentials',
    'src/aws/credentials',
    'aws/credentials',
    'kube/config',
    'config',
    'kubeconfig.md',
    'main.tf',
    'variables.tf',
    'tfstate.md',
    'keystore.md',
    'release.jks.md',
    'AuthKey_ABC123DEF4.p8.md',
    'firebase.json',
    'firebase-admin.ts',
    'ovpn.md',
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
    expect(scanFileName('release.jks')?.rule).toBe('keystore-file');
    expect(scanFileName('x/firebase-adminsdk-1.json')?.rule).toBe('credentials-file');
    expect(scanFileName('.aws/credentials')?.rule).toBe('cloud-credentials-file');
    expect(scanFileName('.kube/config')?.rule).toBe('kubeconfig-file');
    expect(scanFileName('terraform.tfvars')?.rule).toBe('terraform-secret-file');
    expect(scanFileName('.npmrc')?.rule).toBe('credential-dotfile');
    expect(scanFileName('a.ovpn')?.rule).toBe('vpn-profile-file');
    expect(FILE_NAME_RULES.map(rule => rule.id)).toEqual([
      'env-file',
      'key-file',
      'keystore-file',
      'ssh-private-key-file',
      'credentials-file',
      'cloud-credentials-file',
      'kubeconfig-file',
      'terraform-secret-file',
      'credential-dotfile',
      'vpn-profile-file',
    ]);
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

  /** How many times slower than plain text a scan of a hostile line may be. Backtracking costs seconds, hundreds of times more. */
  const SLOWDOWN = 25;
  const scanTime = (text: string): number => {
    const started = performance.now();
    scanAddedLines('min.js', [{ line: 1, text }], []);
    return performance.now() - started;
  };
  /** The fastest of up to three scans, stopping at the first that is under `limit`. */
  const fastest = (text: string, limit = Infinity): number => {
    let best = Infinity;
    for (let run = 0; run < 3 && best >= limit; run += 1) best = Math.min(best, scanTime(text));
    return best;
  };
  /**
   * What a scan of 100k characters of plain text takes on this machine: the best of three. The bound for
   * every other line is a multiple of it, so a slow or busy machine moves the bound with it. Never 0, so
   * a timer that reads 0 ms cannot make every bound 0.
   */
  const measureBaseline = (): number => {
    const plain = 'a'.repeat(LONG);
    let best = Infinity;
    for (let run = 0; run < 3; run += 1) best = Math.min(best, scanTime(plain));
    return Math.max(best, 1);
  };
  let baseline = 1;
  beforeAll(() => {
    baseline = measureBaseline();
  });

  /**
   * Whether scanning `text` takes less than `SLOWDOWN` times the baseline. A line that is over is
   * measured again against a fresh baseline: when the machine got busy after the first one was taken, it
   * slows the baseline as well, and a backtracking rule is still hundreds of times over.
   */
  const expectScanFast = (text: string, label: string): void => {
    let limit = SLOWDOWN * baseline;
    let took = fastest(text, limit);
    if (took >= limit) {
      baseline = Math.max(baseline, measureBaseline());
      limit = SLOWDOWN * baseline;
      took = Math.min(took, fastest(text, limit));
    }
    expect(took, `${label} (baseline ${baseline.toFixed(1)} ms)`).toBeLessThan(limit);
  };

  /**
   * What a rule can be made to work hard on: its own sample (or the near miss, or half of it) over and
   * over, and the sample next to a very long run of every character class a pattern repeats over.
   */
  const adversarial = (text: string, nearMiss: string): Array<[string, string]> => [
    ['sample repeated', fill(`${text} `)],
    ['sample repeated, no separator', fill(text)],
    ['near miss repeated', fill(nearMiss)],
    ['near miss repeated, spaced', fill(`${nearMiss} `)],
    ['half of the sample repeated', fill(text.slice(0, Math.ceil(text.length / 2)))],
    ['sample, then letters', text + fill('a')],
    ['sample, then dashes', text + fill('-')],
    ['sample, then slashes', text + fill('/')],
    ['sample, then equals signs', text + fill('=')],
    ['sample, then spaces', text + fill(' ')],
    ['letters, then sample', fill('a') + text],
    ['dashes, then sample', fill('-') + text],
    ['digits, then sample', fill('7') + text],
    ['near miss, then letters', nearMiss + fill('a')],
    ['near miss, then dashes', nearMiss + fill('-')],
  ];

  const expectFast = (text: string, nearMiss: string): void => {
    for (const [name, line] of adversarial(text, nearMiss)) {
      expect(line.length, name).toBeGreaterThanOrEqual(LONG - 500);
      expectScanFast(line, `${name}: ${line.length} characters`);
    }
  };

  it.each(SAMPLES)('$rule: its sample, the near miss and a long run around them are scanned about as fast as plain text', sample => {
    expectFast(sample.text, sample.nearMiss);
  });

  it.each(VARIANTS)('$rule ($name): its variant and a long run around it are scanned about as fast as plain text', variant => {
    expectFast(variant.text, variant.text.slice(0, -1));
  });

  it.each(shapes)('%s: a line of 100k characters is scanned about as fast as plain text', (_name, text) => {
    expect(text.length).toBeGreaterThanOrEqual(LONG - 100);

    expectScanFast(text, 'line of 100k characters');
  });

  it('still finds a secret in the middle of a very long line', () => {
    const text = `${'x '.repeat(50_000)}${githubToken()} ${'y '.repeat(50_000)}`;

    expect(scanAddedLines('min.js', [{ line: 1, text }], []).map(finding => finding.rule)).toEqual(['github-token']);
  });
});
