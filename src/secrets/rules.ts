/**
 * What the secret guard looks for: content rules (applied to one added line at a time) and file-name
 * rules. The patterns are plain, non-global regular expressions; `scan.ts` makes its own global
 * copies, so nothing here carries state between lines. No pattern may backtrack without bound on a
 * very long line: every open-ended repeat either sits in a class that the next token cannot be part
 * of, or has an upper limit (see the long-line tests).
 *
 * Every rule but the last two is a distinctive prefix with a fixed shape: low false positives is the
 * point, so there is deliberately no entropy rule. A comment names where each format comes from:
 * gitleaks (`config/gitleaks.toml`, rule id given), TruffleHog (`pkg/detectors/<name>`), or the
 * vendor's own documentation.
 */

export interface SecretRule {
  id: string;
  description: string;
  pattern: RegExp;
  /** True for a match that is not a secret after all (a placeholder); the match is then not reported. */
  ignore?: (match: RegExpMatchArray) => boolean;
}

/** A value of one repeated character (`xxxxxxxx`, `00000000`, `********`) is a filler, not a secret. */
function isFiller(value: string): boolean {
  const [first] = value;
  return first !== undefined && [...value].every(char => char === first);
}

/**
 * A value that is a reference to a secret, a template or a filler, not a secret. (The placeholder
 * words `changeme`, `example` and `placeholder` need no check of their own: each is shorter than the
 * 12 characters that `generic-assignment` asks of a value, so none is ever matched.)
 */
function isPlaceholderValue(value: string): boolean {
  if (value.includes('${') || value.includes('$(') || value.includes('<')) return true;
  return isFiller(value);
}

/** For a rule whose group 1 is the body of a prefixed token: a prefix and a filler body is a documentation example. */
const fillerBody = (match: RegExpMatchArray): boolean => isFiller(match[1] ?? '');

/**
 * The base64 of the start of a PEM header (`-----BEGIN [KIND ]PRIVATE KEY-----`) as a Kubernetes TLS
 * secret, a kubeconfig or a CI variable holds it. Only whole 3-byte groups are used (at least one
 * byte of the header is left out), so the stem is the same whatever follows the header; the base64
 * of the whole file starts with it because the header is the first thing in a PEM file.
 */
function pemBase64Stem(kind: string): string {
  const header = Buffer.from(`-----BEGIN ${kind}PRIVATE KEY${kind === 'PGP ' ? ' BLOCK' : ''}-----`, 'utf8');
  const whole = Math.floor(header.length / 3) * 3;
  return header.subarray(0, whole === header.length ? whole - 3 : whole).toString('base64');
}

const PEM_KINDS = ['', 'RSA ', 'EC ', 'DSA ', 'OPENSSH ', 'ENCRYPTED ', 'SSH2 ENCRYPTED ', 'PGP '];

/**
 * The stems as one pattern: their common start, then the alternatives. (Factoring the start out also
 * keeps the pattern's own source from being a stem, so the guard does not flag `rules.ts`.)
 */
function pemBase64Pattern(): RegExp {
  const stems = PEM_KINDS.map(pemBase64Stem);
  let common = stems[0] ?? '';
  for (const stem of stems) while (!stem.startsWith(common)) common = common.slice(0, -1);
  return new RegExp(`\\b${common}(?:${stems.map(stem => stem.slice(common.length)).join('|')})`);
}

/** Words that stand for a password in documentation (compared in lower case, without `-`, `_` and `.`). */
const PLACEHOLDER_PASSWORDS = new Set([
  'password',
  'passwd',
  'pass',
  'pwd',
  'secret',
  'changeme',
  'example',
  'placeholder',
  'yourpassword',
  'mypassword',
  'yoursecret',
  'mysecret',
  'redacted',
  // The stock passwords of documentation examples (`new URL('http://abc:xyz@example.com')`).
  'xyz',
  'abc',
  'foo',
  'bar',
  'foobar',
  'test',
  'demo',
  'somepassword',
]);

/**
 * A whole value that names a variable or a template slot: `$DB_PASSWORD`, `${DB_PASSWORD}`, the Windows
 * `%DB_PASSWORD%`, the format placeholders `%s`, `%d` and `%(password)s`, and `{password}`, `[password]`.
 * It is deliberately narrow: the dollar form is a variable name in its usual shape (upper case, so
 * `$Up3rS3cretXk9` is a password) and the percent form needs a letter after the percent sign and a closing
 * one (so `%21Xk9mQ2pL7vRt` and `%2F…`, a password that starts with a percent escape, is a password).
 */
const REFERENCE_VALUE = /^(?:\$[A-Z_][A-Z0-9_]*|\$\{[^}]*\}|\[[^\]]*\]|\{[^}]*\}|%\(\w+\)s|%[sd]|%[A-Za-z_]\w*%)$/;

/** The literal password of a URL that carries its token in the user part (`https://<token>:x-oauth-basic@github.com`). */
const TOKEN_MARKER_PASSWORDS = new Set(['x-oauth-basic', 'x-access-token', 'x-token-auth']);

const isReference = (value: string): boolean => isPlaceholderValue(value) || REFERENCE_VALUE.test(value);

/**
 * `scheme://user:password@host` where the password is a template, a documentation word or the user
 * name, or where the user is a template and the password only marks it as a token.
 */
function isPlaceholderCredential(match: RegExpMatchArray): boolean {
  const user = match[1] ?? '';
  const password = match[2] ?? '';
  return (
    isReference(password) ||
    PLACEHOLDER_PASSWORDS.has(password.toLowerCase().replace(/[-_.]/g, '')) ||
    password.toLowerCase() === user.toLowerCase() ||
    (TOKEN_MARKER_PASSWORDS.has(password.toLowerCase()) && isReference(user))
  );
}

/**
 * The order matters: a span of a line is reported once, by the first rule that matches it, so the
 * specific rules come before `openai-key` (which also matches an Anthropic key), `url-credentials`
 * (which also matches a token in the user part of a URL) and `generic-assignment` (which also
 * matches a quoted specific token).
 */
export const SECRET_RULES: readonly SecretRule[] = [
  // --- Source hosting ---
  {
    id: 'github-token',
    description: 'GitHub token (ghp_, gho_, ghu_, ghs_, ghr_)',
    // GitHub docs "About authentication to GitHub" (token formats); gitleaks github-pat, github-oauth, github-app-token.
    pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/,
  },
  {
    id: 'github-pat',
    description: 'GitHub fine-grained personal access token',
    // gitleaks github-fine-grained-pat: github_pat_ and 82 characters.
    pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/,
  },
  {
    id: 'gitlab-token',
    description: 'GitLab token (glpat-, glptt-, gldt-, glrt-, glft-, ...)',
    // GitLab docs "Token overview" (prefixes); gitleaks gitlab-pat, gitlab-ptt, gitlab-deploy-token, gitlab-rrt, ...
    pattern: /\bgl(?:pat|ptt|dt|rt|ft|ffct|soat|cbt|imt|agent|oas)-([A-Za-z0-9_-]{20,300})/,
    ignore: fillerBody,
  },

  // --- AWS ---
  {
    id: 'aws-access-key',
    description: 'AWS access key id (AKIA, ASIA, ABIA, ACCA, A3T)',
    // AWS IAM docs "Unique identifiers" (prefixes); gitleaks aws-access-token. The documentation key ends in EXAMPLE.
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}\b/,
    ignore: match => match[0].endsWith('EXAMPLE'),
  },
  {
    id: 'aws-bedrock-api-key',
    description: 'AWS Amazon Bedrock long-lived API key',
    // gitleaks aws-amazon-bedrock-api-key-long-lived: ABSK and base64. Not inside a longer base64 blob (ABSK occurs there).
    pattern: /(?<![A-Za-z0-9+/_-])ABSK[A-Za-z0-9+/]{109,269}={0,2}/,
  },

  // --- Google ---
  {
    id: 'gcp-api-key',
    description: 'Google Cloud / Firebase API key (AIza)',
    // gitleaks gcp-api-key; TruffleHog googleapikey. No trailing boundary: the class includes `-`, a key may end with it.
    // This is also the key of `google-services.json` and `GoogleService-Info.plist` (see FILE_NAME_RULES).
    pattern: /\bAIza[0-9A-Za-z_-]{35}/,
  },
  {
    id: 'gcp-oauth-client-secret',
    description: 'Google OAuth client secret (GOCSPX-)',
    // Google OAuth client secrets since 2021: GOCSPX- and 28 characters (TruffleHog googleoauth2 / gcp oauth client).
    pattern: /\bGOCSPX-([A-Za-z0-9_-]{28})/,
    ignore: fillerBody,
  },
  {
    id: 'gcp-oauth-token',
    description: 'Google OAuth access token (ya29.)',
    // Google OAuth 2.0 access tokens start with ya29. (Google Identity docs; gitleaks gcp-oauth-access-token style).
    pattern: /\bya29\.([A-Za-z0-9_-]{40,2048})/,
    ignore: fillerBody,
  },
  {
    id: 'gcp-refresh-token',
    description: 'Google OAuth refresh token (1//0)',
    // Google OAuth refresh tokens start with 1//0 (Google Identity docs). The lookbehind skips a path like a/1//0...
    pattern: /(?<![A-Za-z0-9_/-])1\/\/0([A-Za-z0-9_-]{40,512})/,
    ignore: fillerBody,
  },
  {
    id: 'fcm-server-key',
    description: 'Firebase Cloud Messaging legacy server key',
    // Legacy FCM server keys: AAAA, 7 characters, :APA91b and about 134 more (TruffleHog firebasecloudmessaging).
    pattern: /\bAAAA[A-Za-z0-9_-]{7}:APA91b[A-Za-z0-9_-]{130,140}/,
  },
  {
    id: 'gcp-service-account-key',
    description: 'Google service-account key file (private_key_id)',
    // The JSON key file of a service account has a 40-hex "private_key_id" next to its "private_key" block
    // (Google Cloud docs "Create service account keys"). Also matched inside a JSON string (escaped quotes).
    pattern: /\\?["']private_key_id\\?["']\s*:\s*\\?["'][0-9a-f]{40}(?![0-9A-Za-z])/,
  },

  // --- Azure ---
  {
    id: 'azure-storage-key',
    description: 'Azure Storage account key in a connection string',
    // Microsoft docs "Configure Azure Storage connection strings": AccountKey= and an 88-character base64 key.
    pattern: /\bAccountKey=[A-Za-z0-9+/]{86}==/i,
  },
  {
    id: 'azure-shared-access-key',
    description: 'Azure Service Bus / Event Hubs / IoT Hub shared access key',
    // SharedAccessKey= and a 44-character base64 key (Microsoft docs, Service Bus connection strings).
    pattern: /\bSharedAccessKey=[A-Za-z0-9+/]{43}=/i,
  },
  {
    id: 'azure-sas-signature',
    description: 'Azure shared access signature (sig= in a SAS URL)',
    // A SAS token's signature is 44 base64 characters (Microsoft docs "Create a service SAS"), plain or URL-encoded.
    pattern: /(?<=[?&;])sig=(?:[A-Za-z0-9+/]|%2[BbFf]){43}(?:%3[Dd]|=)/,
  },
  {
    id: 'azure-ad-client-secret',
    description: 'Azure AD / Entra application client secret',
    // gitleaks azure-ad-client-secret: three characters, a digit, Q~ and 31 to 34 more.
    pattern: /(?<![A-Za-z0-9_~.-])[A-Za-z0-9_~.]{3}\dQ~[A-Za-z0-9_~.-]{31,34}(?![A-Za-z0-9_~.-])/,
  },
  {
    id: 'azure-acr-password',
    description: 'Azure Container Registry password (+ACR)',
    // TruffleHog azurecontainerregistry: 42 base64 characters, +ACR and 6 more.
    pattern: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{42}\+ACR[A-Za-z0-9]{6}\b/,
  },

  // --- Keys and key blocks ---
  {
    id: 'private-key',
    description: 'private key block (PEM, OpenSSH, PGP; also a service-account JSON key)',
    // RFC 7468 labels (RSA, EC, DSA, OPENSSH, ENCRYPTED, SSH2 ENCRYPTED and plain PRIVATE KEY) and the PGP armor
    // header (RFC 4880: PRIVATE KEY BLOCK); gitleaks private-key.
    pattern: /-----BEGIN (?:[A-Z0-9]{2,12} ){0,3}PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    id: 'private-key-base64',
    description: 'base64 of a PEM private key header (a kubeconfig, a Kubernetes TLS secret)',
    // `-----BEGIN [KIND ]PRIVATE KEY-----` in base64, as `client-key-data:` and `tls.key:` hold it (kubectl, cert-manager).
    pattern: pemBase64Pattern(),
  },
  {
    id: 'putty-private-key',
    description: 'PuTTY private key file (PuTTY-User-Key-File-2 or 3)',
    // The first line of a .ppk file (PuTTY docs, "PPK file format").
    pattern: /\bPuTTY-User-Key-File-[23]:/,
  },
  {
    id: 'age-secret-key',
    description: 'age secret key (AGE-SECRET-KEY-1)',
    // age specification: Bech32 of the secret key, AGE-SECRET-KEY-1 and 58 characters; gitleaks age-secret-key.
    pattern: /\bAGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}/,
  },

  // --- Slack ---
  {
    id: 'slack-token',
    description: 'Slack token (xoxa, xoxb, xoxp, xoxo, xoxr, xoxs, xoxe)',
    // Slack docs "Token types"; gitleaks slack-bot-token, slack-user-token, slack-config-access-token, ...
    pattern: /\bxox(?:[abposr]|e(?:\.xox[bp])?)-[A-Za-z0-9-]{10,}\b/,
  },
  {
    id: 'slack-app-token',
    description: 'Slack app-level token (xapp-)',
    // gitleaks slack-app-token: xapp-, a digit, an app id, a number and 32 or more characters.
    pattern: /\bxapp-\d-[A-Za-z0-9]{8,16}-\d{8,16}-[A-Za-z0-9]{32,100}/,
  },
  {
    id: 'slack-webhook',
    description: 'Slack incoming webhook URL',
    // gitleaks slack-webhook-url: hooks.slack.com/(services|workflows|triggers)/ and the secret path.
    // The documentation's T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX has a filler last segment.
    pattern: /\bhooks\.slack\.com\/(?:services|workflows|triggers)\/([A-Za-z0-9+/]{43,56})/,
    ignore: match => isFiller((match[1] ?? '').split('/').pop() ?? ''),
  },

  // --- Payments ---
  {
    id: 'stripe-live-key',
    description: 'Stripe live secret or restricted key',
    // Stripe docs "API keys": sk_live_ and rk_live_; gitleaks stripe-access-token.
    pattern: /\b(sk|rk)_live_[A-Za-z0-9]{24,}\b/,
  },
  {
    id: 'stripe-webhook-secret',
    description: 'Stripe webhook signing secret (whsec_)',
    // Stripe docs "Webhook signatures": whsec_ and the signing secret.
    pattern: /\bwhsec_([A-Za-z0-9]{32,128})/,
    ignore: fillerBody,
  },

  // --- AI providers ---
  {
    id: 'anthropic-key',
    description: 'Anthropic API or admin key',
    // Anthropic API keys (sk-ant-api03-, sk-ant-admin01-); gitleaks anthropic-api-key, anthropic-admin-api-key.
    pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/,
  },
  {
    id: 'openai-key',
    description: 'OpenAI API key (sk-, sk-proj-, sk-svcacct-, sk-admin-)',
    // OpenAI docs (key prefixes); gitleaks openai-api-key; TruffleHog openai.
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\b/,
  },
  {
    id: 'groq-key',
    description: 'Groq API key (gsk_)',
    // gitleaks / TruffleHog groq: gsk_ and 52 characters.
    pattern: /\bgsk_([A-Za-z0-9]{52})/,
    ignore: fillerBody,
  },
  {
    id: 'replicate-key',
    description: 'Replicate API token (r8_)',
    // TruffleHog replicate: r8_ and 37 characters.
    pattern: /\br8_([0-9A-Za-z_-]{37})/,
    ignore: fillerBody,
  },
  {
    id: 'perplexity-key',
    description: 'Perplexity API key (pplx-)',
    // gitleaks perplexity-api-key: pplx- and 48 characters.
    pattern: /\bpplx-([A-Za-z0-9]{48})/,
    ignore: fillerBody,
  },
  {
    id: 'xai-key',
    description: 'xAI API key (xai-)',
    // gitleaks / TruffleHog xai: xai- and 80 characters.
    pattern: /\bxai-([A-Za-z0-9_]{80})/,
    ignore: fillerBody,
  },
  {
    id: 'huggingface-token',
    description: 'Hugging Face access token (hf_, api_org_)',
    // gitleaks huggingface-access-token, huggingface-organization-api-token: 34 characters.
    pattern: /\b(?:hf|api_org)_([A-Za-z0-9]{34})/,
    ignore: fillerBody,
  },

  // --- Package registries ---
  {
    id: 'npm-token',
    description: 'npm access token (npm_)',
    // npm docs "About access tokens" (granular tokens); gitleaks npm-access-token: npm_ and 36 characters.
    pattern: /\bnpm_([A-Za-z0-9]{36})/,
    ignore: fillerBody,
  },
  {
    id: 'pypi-token',
    description: 'PyPI upload token (pypi-)',
    // gitleaks pypi-upload-token: pypi- and the base64 of the macaroon header ("pypi.org", or "test.pypi.org").
    pattern: /\bpypi-(?:AgEIcHlwaS5vcmc|AgENdGVzdC5weXBpLm9yZw)[A-Za-z0-9_-]{50,1000}/,
  },
  {
    id: 'rubygems-token',
    description: 'RubyGems API key (rubygems_)',
    // gitleaks rubygems-api-token: rubygems_ and 48 hex characters.
    pattern: /\brubygems_([a-f0-9]{48})/,
    ignore: fillerBody,
  },
  {
    id: 'nuget-key',
    description: 'NuGet API key (oy2...)',
    // TruffleHog nugetapikey: oy2 and 43 characters. The short prefix is why the length must be exact.
    pattern: /\boy2[a-z0-9]{43}(?![a-z0-9])/,
  },
  {
    id: 'docker-pat',
    description: 'Docker Hub personal access token (dckr_pat_)',
    // Docker docs "Create and manage access tokens": dckr_pat_ and 27 characters.
    pattern: /\bdckr_pat_([A-Za-z0-9_-]{27,64})/,
    ignore: fillerBody,
  },

  // --- SaaS ---
  {
    id: 'twilio-api-key',
    description: 'Twilio API key SID (SK and 32 hex)',
    // gitleaks twilio-api-key: SK and 32 hex characters. (The account SID, AC and 32 hex, is not a secret by itself.)
    pattern: /\bSK[0-9a-f]{32}(?![0-9A-Za-z])/,
  },
  {
    id: 'sendgrid-key',
    description: 'SendGrid API key (SG.)',
    // SendGrid docs "API keys": SG., 22 characters, a dot and 43 characters; gitleaks sendgrid-api-token.
    pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/,
  },
  {
    id: 'mailgun-key',
    description: 'Mailgun private API key (key- and 32 hex)',
    // gitleaks mailgun-private-api-token; TruffleHog mailgun: key- and 32 hex characters.
    pattern: /(?<![\w-])key-[0-9a-f]{32}(?![\w-])/,
  },
  {
    id: 'mailchimp-key',
    description: 'Mailchimp API key (32 hex and -usNN)',
    // gitleaks mailchimp-api-key; TruffleHog mailchimp: 32 hex characters and the data center.
    pattern: /\b[0-9a-f]{32}-us\d{1,2}(?![\w-])/,
  },
  {
    id: 'shopify-token',
    description: 'Shopify access token (shpat_, shpca_, shppa_, shpss_)',
    // gitleaks shopify-access-token, shopify-custom-access-token, shopify-private-app-access-token, shopify-shared-secret.
    pattern: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}/,
  },
  {
    id: 'databricks-token',
    description: 'Databricks personal access token (dapi)',
    // gitleaks databricks-api-token: dapi and 32 hex characters, and an optional -N.
    pattern: /\bdapi[a-f0-9]{32}(?:-\d)?/,
  },
  {
    id: 'digitalocean-token',
    description: 'DigitalOcean token (dop_v1_, doo_v1_, dor_v1_)',
    // gitleaks digitalocean-pat, digitalocean-access-token, digitalocean-refresh-token: 64 hex characters.
    pattern: /\bdo[opr]_v1_[a-f0-9]{64}/,
  },
  {
    id: 'vault-token',
    description: 'HashiCorp Vault token (hvs., hvb.)',
    // Vault 1.10+ service (hvs.) and batch (hvb.) tokens; gitleaks vault-service-token, vault-batch-token.
    pattern: /\b(?:hvs\.[A-Za-z0-9_-]{90,120}|hvb\.[A-Za-z0-9_-]{138,300})/,
  },
  {
    id: 'terraform-cloud-token',
    description: 'Terraform Cloud / HCP API token (.atlasv1.)',
    // gitleaks hashicorp-tf-api-token: 14 characters, .atlasv1. and 60 to 70 more.
    pattern: /\b[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9_=-]{60,70}/,
  },
  {
    id: 'doppler-token',
    description: 'Doppler token (dp.pt.)',
    // gitleaks doppler-api-token: dp.pt. and 43 characters.
    pattern: /\bdp\.pt\.[A-Za-z0-9]{43}/,
  },
  {
    id: 'postman-key',
    description: 'Postman API key (PMAK-)',
    // gitleaks postman-api-token: PMAK-, 24 hex, a dash and 34 hex.
    pattern: /\bPMAK-[A-Fa-f0-9]{24}-[A-Fa-f0-9]{34}/,
  },
  {
    id: 'grafana-token',
    description: 'Grafana token (glc_, glsa_, legacy API key)',
    // gitleaks grafana-cloud-api-token (glc_), grafana-service-account-token (glsa_), grafana-api-key (eyJrIjoi).
    pattern: /\b(?:glc_[A-Za-z0-9+/]{32,400}={0,3}|glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}|eyJrIjoi[A-Za-z0-9]{70,400}={0,3})/,
  },
  {
    id: 'newrelic-key',
    description: 'New Relic key (NRAK-, NRII-)',
    // gitleaks new-relic-user-api-key (NRAK-), new-relic-insert-key (NRII-).
    pattern: /\bNR(?:AK-[A-Z0-9]{27}|II-[A-Za-z0-9-]{32})/,
  },
  {
    id: 'sentry-token',
    description: 'Sentry auth token (sntryu_, sntrys_)',
    // gitleaks sentry-user-token (sntryu_), sentry-org-token (sntrys_ and the base64 of {"iat":).
    pattern: /\b(?:sntryu_[a-f0-9]{64}|sntrys_eyJpYXQiO[A-Za-z0-9+/=]{20,500}_[A-Za-z0-9+/]{43})/,
  },
  {
    id: 'linear-key',
    description: 'Linear API key (lin_api_)',
    // gitleaks linear-api-key: lin_api_ and 40 characters.
    pattern: /\blin_api_([A-Za-z0-9]{40})/,
    ignore: fillerBody,
  },
  {
    id: 'notion-token',
    description: 'Notion integration token (ntn_, secret_)',
    // Notion changelog (2024: ntn_) and the older secret_ and 43 characters; TruffleHog notion, gitleaks notion-api-token.
    pattern: /\b(?:ntn_[0-9]{11}[A-Za-z0-9]{35}|secret_([A-Za-z0-9]{43}))/,
    ignore: fillerBody,
  },
  {
    id: 'atlassian-token',
    description: 'Atlassian API token (ATATT3)',
    // gitleaks atlassian-api-token: ATATT3 and 186 characters.
    pattern: /\bATATT3[A-Za-z0-9_=-]{186}/,
  },
  {
    id: 'supabase-key',
    description: 'Supabase access token or secret key (sbp_, sb_secret_)',
    // TruffleHog supabasetoken (sbp_ and 40 hex); Supabase docs "API keys" (sb_secret_).
    pattern: /\b(?:sbp_[a-f0-9]{40}|sb_secret_([A-Za-z0-9_-]{20,100}))/,
    ignore: fillerBody,
  },
  {
    id: 'planetscale-token',
    description: 'PlanetScale token or password (pscale_tkn_, pscale_pw_, pscale_oauth_)',
    // gitleaks planetscale-api-token, planetscale-password, planetscale-oauth-token: 32 to 64 characters.
    pattern: /\bpscale_(?:tkn|pw|oauth)_[A-Za-z0-9_=.-]{32,64}/,
  },
  {
    id: 'flyio-token',
    description: 'Fly.io access token (fo1_, fm1r_, fm1a_, fm2_)',
    // gitleaks flyio-access-token; TruffleHog flyio. The macaroon forms are bounded here (2000 characters).
    pattern: /\b(?:fo1_[A-Za-z0-9_-]{43}|fm1[ar]_[A-Za-z0-9+/]{100,2000}={0,3}|fm2_[A-Za-z0-9+/]{100,2000}={0,3})/,
  },
  {
    id: 'telegram-bot-token',
    description: 'Telegram bot token',
    // Telegram Bot API docs: <bot id>:<35 characters>, always starting AA; gitleaks telegram-bot-api-token.
    pattern: /(?<!\d)\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/,
  },
  {
    id: 'discord-bot-token',
    description: 'Discord bot token',
    // TruffleHog discordbottoken: base64 of the bot's user id, a timestamp and an HMAC. The first segment is the
    // base64 of a decimal id, so it is groups of four characters from a small alphabet ([MNO] for the first digit,
    // [DTjz] for the next, ...): a dotted identifier (`NTLMAuthenticationProvide.method.longMethodName`) is not
    // one. The token is not inside a longer word or a dotted chain, before or after.
    pattern:
      /(?<![A-Za-z0-9_-])(?<![A-Za-z0-9_-]\.)(?:[MNO][DTjz][AEIMQUYcgk][wxyz0-5]){4,6}(?:[MNO][DTjz][AEIMQUYcgk]|[MNO][AQgw])?\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,38}(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])/,
  },
  {
    id: 'discord-webhook',
    description: 'Discord webhook URL',
    // TruffleHog discordwebhook: /api/webhooks/<snowflake>/<token>.
    pattern: /\bdiscord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d{17,20}\/[A-Za-z0-9_-]{60,80}/,
  },
  {
    id: 'square-token',
    description: 'Square access token or OAuth secret (EAAA, sq0atp-, sq0csp-)',
    // gitleaks square-access-token (EAAA, sq0atp-); TruffleHog square, squareapp (sq0csp-). EAAA is also a common
    // start of base64 (wasm, images), so it counts only as a whole 64-character word, not inside a longer blob.
    pattern: /(?<![A-Za-z0-9+/_-])(?:sq0atp-[A-Za-z0-9_-]{22,60}|sq0c[a-z]{2}-[A-Za-z0-9_-]{40,50}|EAAA[A-Za-z0-9_-]{60}(?![A-Za-z0-9+/=_-]))/,
  },
  {
    id: 'braintree-token',
    description: 'PayPal / Braintree production access token',
    // Braintree docs "Access tokens": access_token$production$<16>$<32 hex>; TruffleHog braintreepayments.
    pattern: /\baccess_token\$production\$[0-9a-z]{16}\$[0-9a-f]{32}/,
  },
  {
    id: 'heroku-api-key',
    description: 'Heroku API key (HRKU-AA)',
    // gitleaks heroku-api-key-v2: HRKU-AA and 58 characters.
    pattern: /\bHRKU-AA([A-Za-z0-9_-]{58})/,
    ignore: fillerBody,
  },
  {
    id: 'dynatrace-token',
    description: 'Dynatrace API token (dt0c01.)',
    // gitleaks dynatrace-api-token: dt0c01., 24 characters, a dot and 64 characters.
    pattern: /\bdt0c01\.[A-Za-z0-9]{24}\.[A-Za-z0-9]{64}/,
  },
  {
    id: 'pulumi-token',
    description: 'Pulumi access token (pul-)',
    // gitleaks pulumi-api-token: pul- and 40 hex characters.
    pattern: /\bpul-([a-f0-9]{40})/,
    ignore: fillerBody,
  },
  {
    id: 'brevo-key',
    description: 'Brevo (Sendinblue) API key (xkeysib-)',
    // gitleaks sendinblue-api-token: xkeysib-, 64 hex, a dash and 16 characters.
    pattern: /\bxkeysib-[a-f0-9]{64}-[A-Za-z0-9]{16}/,
  },
  {
    id: 'sourcegraph-token',
    description: 'Sourcegraph access token (sgp_)',
    // gitleaks sourcegraph-access-token: sgp_, an optional instance id or local, and 40 hex characters.
    pattern: /\bsgp_(?:(?:[a-fA-F0-9]{16}|local)_)?[a-fA-F0-9]{40}/,
  },
  {
    id: 'alibaba-access-key-id',
    description: 'Alibaba Cloud AccessKey ID (LTAI)',
    // gitleaks alibaba-access-key-id: LTAI and 20 characters.
    pattern: /\bLTAI[A-Za-z0-9]{20}(?![A-Za-z0-9])/,
  },

  // --- Credentials by their name: the key word makes the value a secret ---
  {
    id: 'aws-secret-access-key',
    description: 'AWS secret access key assigned to aws_secret_access_key / SecretAccessKey',
    // AWS docs "Access keys": 40 characters of base64 alphabet. Only in assignment context (the value alone has no
    // prefix). The key of the AWS documentation (it contains EXAMPLE) and a filler are not secrets.
    pattern: /(?<![A-Za-z0-9])(?:aws[_-]?secret[_-]?(?:access[_-]?)?key|SecretAccessKey)["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i,
    ignore: match => /example/i.test(match[1] ?? '') || isFiller(match[1] ?? ''),
  },
  {
    id: 'aws-session-token',
    description: 'AWS session token assigned to aws_session_token / SessionToken',
    // AWS STS docs "GetSessionToken": a long base64 value (hundreds of characters) in assignment context.
    pattern: /(?<![A-Za-z0-9])(?:aws[_-]?session[_-]?token|SessionToken)["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{100,2000})/i,
    ignore: fillerBody,
  },
  {
    id: 'twilio-auth-token',
    description: 'Twilio auth token assigned to TWILIO_AUTH_TOKEN',
    // Twilio docs "Auth Tokens": 32 hex characters, no prefix, so only in assignment context.
    pattern: /(?<![A-Za-z0-9])twilio[_-]?auth[_-]?token["']?\s*[:=]\s*["']?([0-9a-f]{32})(?![0-9A-Za-z])/i,
    ignore: fillerBody,
  },
  {
    id: 'npmrc-auth',
    description: 'credential in an .npmrc line (_authToken, _auth, _password)',
    // npm docs ".npmrc": //registry/:_authToken=, :_auth= and :_password=. A ${VAR} reference is not matched.
    pattern: /\/:_(?:authToken|auth|password)\s*=\s*["']?([A-Za-z0-9+/=_.-]{16,1024})/,
    ignore: fillerBody,
  },
  {
    id: 'nuget-config-password',
    description: 'password in a NuGet.config (<add key="ClearTextPassword" value="...">)',
    // gitleaks nuget-config-password. A %VAR%, $(VAR) or ${VAR} reference is not a password.
    pattern: /<add\s+key="(?:ClearText)?Password"\s+value="([^"]{8,})"/i,
    ignore: match => {
      const value = match[1] ?? '';
      return isPlaceholderValue(value) || (value.startsWith('%') && value.endsWith('%'));
    },
  },
  {
    id: 'url-credentials',
    description: 'user and password in a URL (scheme://user:password@host)',
    // RFC 3986 userinfo. The scheme starts after a character that cannot be in a scheme (no quadratic scan of a
    // long word). Templates, documentation words (user:password@) and a password equal to the user are ignored.
    // `?` and `#` end the authority (RFC 3986 asks for them to be percent-encoded in a password), so a query
    // string or a fragment with an @ in it (`http://example.com:8080?next=@foo`) is not a password.
    pattern: /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,30}:\/\/([^/\s:@"'<>?#]{0,128}):([^/\s:@"'<>?#]{3,1024})@/i,
    ignore: isPlaceholderCredential,
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
    // A whole `$NAME`, `${NAME}` or `%NAME%` is a reference to a secret (the kit's own MCP config has one).
    ignore: match => isReference(match[2] ?? ''),
  },
];

/**
 * File names that hold secrets (matched on the lower-cased name and the lower-cased path, whatever
 * the directory).
 *
 * `google-services.json` and `GoogleService-Info.plist` are deliberately NOT here: they are the
 * client configuration of a Firebase app, which Google documents as not secret (the API key in it
 * only identifies the project and is restricted by app and by API). The content rule `gcp-api-key`
 * still reports the key line, so the owner decides: `secrets.allow` takes the fingerprint.
 */
export interface FileNameRule {
  id: string;
  description: string;
  matches(name: string, path: string): boolean;
}

const SSH_KEY_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'];

const ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);

/** Files that exist to hold a credential (a token, a password, a netrc login). */
const CREDENTIAL_DOTFILES = new Set(['.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.pgpass', '.htpasswd', '.dockercfg']);

const inDirectory = (path: string, directory: string, name: string): boolean =>
  path === `${directory}/${name}` || path.endsWith(`/${directory}/${name}`);

export const FILE_NAME_RULES: readonly FileNameRule[] = [
  {
    id: 'env-file',
    description: 'environment file (.env, .env.*)',
    matches: name => (name === '.env' || name.startsWith('.env.')) && !ENV_EXAMPLES.has(name),
  },
  {
    id: 'key-file',
    description: 'key or certificate store (*.pem, *.key, *.p12, *.pfx, *.p8, *.ppk)',
    matches: name => ['.pem', '.key', '.p12', '.pfx', '.p8', '.ppk'].some(extension => name.endsWith(extension)),
  },
  {
    id: 'keystore-file',
    description: 'Java keystore (*.jks, *.keystore)',
    matches: name => name.endsWith('.jks') || name.endsWith('.keystore'),
  },
  {
    id: 'ssh-private-key-file',
    description: 'SSH private key (id_rsa*, id_ed25519*, id_ecdsa*, id_dsa*; not the .pub file)',
    matches: name => SSH_KEY_PREFIXES.some(prefix => name.startsWith(prefix)) && !name.endsWith('.pub'),
  },
  {
    id: 'credentials-file',
    description: 'credentials, service-account or Firebase Admin SDK JSON',
    matches: name =>
      name.endsWith('.json') &&
      (name.startsWith('credentials') || name.startsWith('service-account') || name.includes('firebase-adminsdk')),
  },
  {
    id: 'cloud-credentials-file',
    description: 'cloud CLI credentials (.aws/credentials, application_default_credentials.json)',
    matches: (name, path) => inDirectory(path, '.aws', 'credentials') || name === 'application_default_credentials.json',
  },
  {
    id: 'kubeconfig-file',
    description: 'Kubernetes client configuration (kubeconfig, *.kubeconfig, .kube/config)',
    matches: (name, path) => name === 'kubeconfig' || name.endsWith('.kubeconfig') || inDirectory(path, '.kube', 'config'),
  },
  {
    id: 'terraform-secret-file',
    description: 'Terraform variables or state (*.tfvars, *.tfvars.json, *.tfstate; not *.tfvars.example)',
    matches: name =>
      name.endsWith('.tfvars') || name.endsWith('.tfvars.json') || name.endsWith('.tfstate') || name.includes('.tfstate.'),
  },
  {
    id: 'credential-dotfile',
    description: 'credential file (.npmrc, .pypirc, .netrc, .git-credentials, .pgpass, .htpasswd, .dockercfg)',
    matches: name => CREDENTIAL_DOTFILES.has(name),
  },
  {
    id: 'vpn-profile-file',
    description: 'OpenVPN profile (*.ovpn, usually with embedded keys)',
    matches: name => name.endsWith('.ovpn'),
  },
];
