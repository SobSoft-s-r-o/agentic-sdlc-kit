import { typeRegistry, type Config, type Harness, type TargetConfig } from '../config/schema.js';
import type { EndsOn, EvidenceKind } from '../core/types.js';
import { builtinRoles } from './agents.js';
import type { Change } from './changes.js';
import { parseFrontMatter } from './frontMatter.js';
import { renderTemplate } from './template.js';
import { loadTemplate } from './templates.js';

/** One enabled task type, ready for a template. */
export type RenderType = {
  id: string;
  label: string;
  endsOn: EndsOn;
  /** How the type ends, as a clause after "Ends when". */
  endsOnText: string;
  phases: string[];
  /** `intake → brainstorming → …` */
  phasesText: string;
  /** Evidence kinds required before review, in words (`backup and dry-run`); empty when none. */
  evidenceText: string;
};

/** One deployment target, ready for a template. */
export type RenderTarget = {
  name: string;
  environment: string;
  via: TargetConfig['deploy']['via'];
  /** How it deploys, in words: ``script `./deploy.sh` ``, ``Actions workflow `deploy.yml` ``, `manual`, `release`. */
  deployText: string;
};

/** One role of the agent library; `tier` is `deep`, `standard` or `fast`. */
export type RenderRole = { role: string; description: string; tier: string };

/**
 * The one data object every template gets. Templates fail on a missing key, so every key a
 * template reads is defined here, even when empty.
 */
export type RenderData = {
  /** The normalised config: templates read e.g. `cfg.secrets.productionStore`. */
  cfg: Config;
  kit: { ref: string; npx: string };
  enforce: boolean;
  mergeOwnerOnly: boolean;
  defaultBranch: string;
  types: RenderType[];
  /** The `production-data` task type is enabled. */
  productionData: boolean;
  targets: RenderTarget[];
  qualityGate: string[];
  graphify: boolean;
  superpowers: boolean;
  contentLanguage: string;
  /** Which local-testing commands to show for `secrets.local_store`. */
  secrets: { localMacos: boolean; localLinux: boolean; localWindows: boolean; localOther: boolean };
  /** The role library, for the Roles section; the section is left out while it is empty. */
  roles: RenderRole[];
};

/** The kit's name on the npm registry. */
export const KIT_PACKAGE = 'agentic-sdlc-kit';
const KIT_REPOSITORY = 'github:SobSoft-s-r-o/agentic-sdlc-kit';
/** The kit's git repository, where a branch or commit `kit_ref` must exist (`doctor` checks it with `git ls-remote`). */
export const KIT_GIT_URL = 'https://github.com/SobSoft-s-r-o/agentic-sdlc-kit.git';

/** `v1.2.3` or `v1.2.3-rc.1`: a release tag. */
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

/** The first version on the npm registry; `v0.1.0` and `v0.2.0` are git-only tags. */
const FIRST_NPM_VERSION: readonly [number, number, number] = [0, 3, 0];

/**
 * The npm version a release-tag `kit_ref` names (`v1.2.3` is `1.2.3`); `undefined` for a branch, a commit, anything
 * else, and a release tag below `v0.3.0`, which was never published (a prerelease sorts below its release, so
 * `v0.3.0-rc.1` is below it, and `v0.4.0-rc.1` is not).
 */
export function releaseVersion(ref: string): string | undefined {
  const match = RELEASE_TAG.exec(ref);
  if (match === null) return undefined;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])];
  const prerelease = match[4] !== undefined;
  for (const [index, first] of FIRST_NPM_VERSION.entries()) {
    const part = core[index] ?? 0;
    if (part !== first) return part > first ? ref.slice(1) : undefined;
  }
  return prerelease ? undefined : ref.slice(1);
}

/** A release tag from before the registry (`v0.1.0`, `v0.2.0`): a version, but one that only exists as a git tag. */
export function isGitOnlyReleaseTag(ref: string): boolean {
  return RELEASE_TAG.test(ref) && releaseVersion(ref) === undefined;
}

/**
 * How the kit is run and installed for `kit_ref`. A release tag from `v0.3.0` on uses the registry (`agentic-sdlc-kit@1.2.3`),
 * so the install needs no build from git; a branch, a commit and the git-only tags (`v0.1.0`, `v0.2.0`) use the repository
 * (`github:...#<ref>`).
 */
export function kitCommand(ref: string): { npx: string; source: 'npm' | 'github' } {
  const version = releaseVersion(ref);
  const spec = version === undefined ? `${KIT_REPOSITORY}#${ref}` : `${KIT_PACKAGE}@${version}`;
  return { npx: `npx -y ${spec}`, source: version === undefined ? 'github' : 'npm' };
}

/** How each end condition reads after "Ends when". */
function endsOnText(endsOn: EndsOn, defaultBranch: string): string {
  switch (endsOn) {
    case 'deploy':
      return 'every declared target has a successful deployment containing the merge commit';
    case 'merge':
      return `the final PR is merged to \`${defaultBranch}\``;
    case 'owner_acceptance':
      return 'the owner accepts the published result (`/accept`)';
    case 'owner_confirmation':
      return 'the final PR is merged and the owner confirms they ran it (`/ran`)';
    case 'merge_or_acceptance':
      return `the final PR is merged to \`${defaultBranch}\`, or the owner accepts the attached result (\`/accept\`)`;
  }
}

const EVIDENCE_WORDS: Record<EvidenceKind, string> = { backup: 'backup', dry_run: 'dry-run' };

function deployText(target: TargetConfig): string {
  const { via, command, workflow } = target.deploy;
  switch (via) {
    case 'script':
      return command ? `script \`${command}\`` : 'script';
    case 'actions':
      return workflow ? `Actions workflow \`${workflow}\`` : 'GitHub Actions';
    case 'manual':
      return 'manual deployment';
    case 'release':
      return 'a GitHub Release';
  }
}

/** `auto` shows every OS keystore; the named stores show only theirs; anything else names a password-manager CLI. */
function secretFlags(localStore: string): RenderData['secrets'] {
  const auto = localStore === 'auto';
  const known = ['keychain', 'secret-service', 'wincred'].includes(localStore);
  return {
    localMacos: auto || localStore === 'keychain',
    localLinux: auto || localStore === 'secret-service',
    localWindows: auto || localStore === 'wincred',
    localOther: !auto && !known,
  };
}

/**
 * The data every template (instructions, skills, agents, GitHub files) is rendered with. `roles`
 * is the role library the block lists; it defaults to the built-in roles, and a repository with
 * custom roles passes `loadRoles(fs).roles`. Pass `[]` to leave the Roles section out.
 */
export function renderData(cfg: Config, roles: readonly RenderRole[] = builtinRoles()): RenderData {
  const types = [...typeRegistry(cfg).values()].map(
    (def): RenderType => ({
      id: def.id,
      label: def.label,
      endsOn: def.endsOn,
      endsOnText: endsOnText(def.endsOn, cfg.github.defaultBranch),
      phases: [...def.phases],
      phasesText: def.phases.join(' → '),
      evidenceText: def.requiresBeforeReview.map(kind => EVIDENCE_WORDS[kind]).join(' and '),
    }),
  );
  return {
    cfg,
    kit: { ref: cfg.kitRef, npx: kitCommand(cfg.kitRef).npx },
    enforce: cfg.mode === 'enforce',
    mergeOwnerOnly: cfg.mergePolicy === 'owner_only',
    defaultBranch: cfg.github.defaultBranch,
    types,
    productionData: types.some(type => type.id === 'production-data'),
    targets: cfg.targets.map(
      (target): RenderTarget => ({
        name: target.name,
        environment: target.environment,
        via: target.deploy.via,
        deployText: deployText(target),
      }),
    ),
    qualityGate: [...cfg.qualityGate],
    graphify: cfg.stack.graphify,
    superpowers: cfg.stack.superpowers,
    contentLanguage: cfg.contentLanguage,
    secrets: secretFlags(cfg.secrets.localStore),
    roles: roles.map(({ role, description, tier }): RenderRole => ({ role, description, tier })),
  };
}

/** Where each harness reads its project instructions. Codex and `agents-md` share `AGENTS.md`. */
const INSTRUCTION_FILE: Record<Harness, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md',
  'agents-md': 'AGENTS.md',
};

/** Where each harness loads skills from. Only Claude has its own directory. */
const SKILL_DIR: Record<Harness, string> = {
  claude: '.claude/skills',
  codex: '.agents/skills',
  gemini: '.agents/skills',
  'agents-md': '.agents/skills',
};

/** The skills the kit ships; each is `templates/skills/sdlc-<name>/SKILL.md`. */
const SKILLS = ['sdlc-task-tracking', 'sdlc-delivery', 'sdlc-orientation'] as const;

function renderSkill(name: string, data: RenderData): string {
  const text = renderTemplate(loadTemplate(`skills/${name}/SKILL.md`), data, `skills/${name}/SKILL.md`);
  // Codex needs both; a template that loses one must fail here, not in the owner's repository.
  const { data: header } = parseFrontMatter(text);
  if (header.name !== name || typeof header.description !== 'string' || header.description.trim() === '') {
    throw new Error(`skills/${name}/SKILL.md: front matter needs name "${name}" and a description`);
  }
  return text;
}

/**
 * The managed instruction block for `harness`'s instruction file, and the three sdlc skills. The
 * block does not depend on the harness, so Codex and `agents-md` render the same `AGENTS.md` block
 * and the same skills (the same paths and text; deduplicate them by path). `_cfg` is part of the
 * signature every renderer shares; the text comes from `data`.
 */
export function renderInstructions(_cfg: Config, harness: Harness, data: RenderData): Change[] {
  const block = renderTemplate(loadTemplate('instructions/block.md'), data, 'instructions/block.md');
  return [
    // The merge writes the markers around a body without trailing newlines.
    { kind: 'md-block', path: INSTRUCTION_FILE[harness], content: block.replace(/\n+$/, '') },
    ...SKILLS.map(
      (name): Change => ({ kind: 'file', path: `${SKILL_DIR[harness]}/${name}/SKILL.md`, content: renderSkill(name, data) }),
    ),
  ];
}
