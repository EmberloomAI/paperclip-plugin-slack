import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Agents that Slack may start or message, by Paperclip agent id.
 *
 * Fails closed: until a valid `allowedAgentIds` list is configured, no agent is
 * allowed. A missing, empty or malformed value never means "all agents".
 */
let allowedIds: ReadonlySet<string> = new Set();

export function setAllowedAgentIds(value: unknown): void {
  const valid =
    Array.isArray(value) && value.every((id) => typeof id === "string" && id.length > 0);
  allowedIds = new Set(valid ? (value as string[]) : []);
}

/**
 * Slack channels where an @mention may start the default agent. Fails closed like
 * the agent list: missing, empty or malformed means no channel.
 */
let allowedChannels: ReadonlySet<string> = new Set();

export function setAllowedChannelIds(value: unknown): void {
  const valid =
    Array.isArray(value) && value.every((id) => typeof id === "string" && id.length > 0);
  allowedChannels = new Set(valid ? (value as string[]) : []);
}

export function isAllowedChannelId(id: unknown): boolean {
  return typeof id === "string" && allowedChannels.has(id);
}

/**
 * Slack users who may start the default agent in a direct message (Stefan 20/11 via Lyra: Stefan, Emma, Adán).
 * Fails closed like the other lists.
 */
let allowedUsers: ReadonlySet<string> = new Set();

export function setAllowedUserIds(value: unknown): void {
  const valid =
    Array.isArray(value) && value.every((id) => typeof id === "string" && id.length > 0);
  allowedUsers = new Set(valid ? (value as string[]) : []);
}

export function isAllowedUserId(id: unknown): boolean {
  return typeof id === "string" && allowedUsers.has(id);
}

/**
 * Emberloom fork 21/11 (bottar-samma-skydd): the users whose text is not treated as a guest's. Everyone else
 * (also an allowed DM user who is not on this list) is a guest: shorter cleaned text, no files, no commands,
 * and no posting tools while the guest's turn runs. Fails closed: empty or invalid means nobody is trusted.
 */
let trustedUsers: ReadonlySet<string> = new Set();
let guestUntil = new Map<string, number>();
export const GUEST_WINDOW_MS = 15 * 60 * 1000;

export function setTrustedUserIds(value: unknown): void {
  const valid = Array.isArray(value) && value.every((id) => typeof id === "string" && id.length > 0);
  trustedUsers = new Set(valid ? (value as string[]) : []);
}

export function isTrustedUserId(id: unknown): boolean {
  return typeof id === "string" && trustedUsers.has(id);
}

/** A guest's message was routed to the agent: its posting tools are off for the window. */
export function markGuestTurn(agentId: string, now = Date.now()): void {
  guestUntil.set(agentId, now + GUEST_WINDOW_MS);
}

export function inGuestTurn(agentId: unknown, now = Date.now()): boolean {
  return typeof agentId === "string" && (guestUntil.get(agentId) ?? 0) > now;
}

export function _resetGuestTurnsForTests(): void {
  guestUntil = new Map();
}

export function isAllowedAgentId(id: unknown): boolean {
  return typeof id === "string" && allowedIds.has(id);
}

/**
 * Resolve an agent name or id to an allowed agent id in `companyId`.
 * Requires exactly one agent in the company whose id equals `nameOrId` or whose
 * name equals it case-insensitively. Returns null when there is no match, more
 * than one match, or the matched id is not in the allowlist.
 */
export async function resolveAllowedAgentId(
  ctx: PluginContext,
  companyId: string,
  nameOrId: unknown,
): Promise<string | null> {
  if (allowedIds.size === 0 || typeof nameOrId !== "string" || !nameOrId || !companyId) {
    ctx.logger.warn("Agent not allowed from Slack", { agent: nameOrId, reason: "empty" });
    return null;
  }

  let agents: Array<{ id: string; name?: string; companyId?: string }>;
  try {
    agents = await ctx.agents.list({ companyId, limit: 100, offset: 0 });
  } catch (err) {
    ctx.logger.warn("Agent not allowed from Slack", { agent: nameOrId, reason: "list failed", err });
    return null;
  }

  const wanted = nameOrId.toLowerCase();
  const matches = agents.filter(
    (a) =>
      (!a.companyId || a.companyId === companyId) &&
      (a.id === nameOrId || (typeof a.name === "string" && a.name.toLowerCase() === wanted)),
  );
  if (matches.length !== 1 || !isAllowedAgentId(matches[0].id)) {
    ctx.logger.warn("Agent not allowed from Slack", { agent: nameOrId, matches: matches.length });
    return null;
  }
  return matches[0].id;
}

/** Like resolveAllowedAgentId, but throws when the agent is not allowed. */
export async function requireAllowedAgentId(
  ctx: PluginContext,
  companyId: string,
  nameOrId: unknown,
): Promise<string> {
  const id = await resolveAllowedAgentId(ctx, companyId, nameOrId);
  if (!id) throw new Error(`Agent ${String(nameOrId)} is not allowed from Slack`);
  return id;
}
