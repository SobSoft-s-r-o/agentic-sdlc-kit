import type { Config } from '../config/schema.js';

/** The login GitHub Actions comments as; its comments are trusted like the tool's own. */
export const ACTIONS_BOT = 'github-actions[bot]';

/**
 * The logins, lowercase, whose state comments and reports are trusted: the tool's own `login`
 * (when known), the configured owners and agents, and the Actions bot.
 */
export function trustedLogins(cfg: Pick<Config, 'owners' | 'agents'>, login: string | undefined): Set<string> {
  return new Set(
    [...(login === undefined ? [] : [login]), ...cfg.owners, ...cfg.agents, ACTIONS_BOT].map(name => name.toLowerCase()),
  );
}
