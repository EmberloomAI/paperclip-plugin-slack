import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setAllowedAgentIds,
  isAllowedAgentId,
  resolveAllowedAgentId,
} from "../src/agent-allowlist.js";
import {
  spawnAgent,
  routeMessageToAgent,
  handleAgentOutput,
  handleHandoffAction,
  startDiscussion,
  handleDiscussionAction,
  handleAcpSlashCommand,
} from "../src/acp-bridge.js";
import { executeCommand } from "../src/custom-commands.js";
import { registerWatch, checkWatches } from "../src/proactive-suggestions.js";
import { processMediaFile } from "../src/media-pipeline.js";
import { STATE_KEYS } from "../src/constants.js";
import type { SessionEntry, DiscussionLoop } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures: two agents in COMPANY, one agent in OTHER_COMPANY.
// ---------------------------------------------------------------------------

const COMPANY = "co-1";
const OTHER_COMPANY = "co-2";
const TOKEN = "xoxb-test";
const CHANNEL = "C-test";
const THREAD = "1700000000.000001";

const EMBER = "1111aaaa-0000-0000-0000-000000000001";
const STELLA = "11111111-0000-0000-0000-000000000002";
const WHISPER = "11111111-0000-0000-0000-000000000003";
const FOREIGN = "22222222-0000-0000-0000-000000000001";

const AGENTS: Record<string, Array<{ id: string; name: string; companyId: string }>> = {
  [COMPANY]: [
    { id: EMBER, name: "Ember", companyId: COMPANY },
    { id: STELLA, name: "Stella", companyId: COMPANY },
    { id: WHISPER, name: "whisper-transcriber", companyId: COMPANY },
  ],
  [OTHER_COMPANY]: [{ id: FOREIGN, name: "Foreign", companyId: OTHER_COMPANY }],
};

let store: Map<string, unknown>;

function makeCtx() {
  store = new Map();
  return {
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    activity: { log: vi.fn().mockResolvedValue(undefined) },
    agents: {
      list: vi.fn(async ({ companyId }: { companyId: string }) => AGENTS[companyId] ?? []),
      sessions: {
        create: vi.fn().mockResolvedValue({ sessionId: "sess-native" }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      },
      invoke: vi.fn().mockResolvedValue({ runId: "run-1" }),
    },
    state: {
      get: vi.fn(async ({ stateKey }: { stateKey: string }) => store.get(stateKey) ?? null),
      set: vi.fn(async ({ stateKey }: { stateKey: string }, value: unknown) => {
        store.set(stateKey, value);
      }),
    },
    http: {
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          ok: true,
          ts: "1700000000.000099",
          file: { url_private_download: "https://files.slack.test/a", mimetype: "audio/mpeg", name: "a.mp3" },
        }),
        text: async () => "",
        arrayBuffer: async () => new ArrayBuffer(1),
      })),
    },
    events: { emit: vi.fn(), on: vi.fn() },
  } as any;
}

function session(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "sess-ember",
    agentId: EMBER,
    agentName: "Ember",
    agentDisplayName: "Ember",
    transport: "native",
    status: "active",
    spawnedAt: "2026-11-20T10:00:00Z",
    lastActivityAt: "2026-11-20T10:00:00Z",
    ...overrides,
  };
}

function seedSessions(sessions: SessionEntry[]) {
  store.set(STATE_KEYS.sessionRegistry(CHANNEL, THREAD), sessions);
}

function expectNothingSent(ctx: any) {
  expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
  expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
  expect(ctx.agents.invoke).not.toHaveBeenCalled();
  expect(ctx.events.emit).not.toHaveBeenCalled();
}

// Each path runs under three allowlists: the agent, another agent, and none.
const ALLOWED = [EMBER];
const OTHER_ONLY = [STELLA];
const EMPTY: string[] = [];

let ctx: ReturnType<typeof makeCtx>;
beforeEach(() => {
  ctx = makeCtx();
  setAllowedAgentIds(ALLOWED);
});

// ---------------------------------------------------------------------------
// Allowlist config and name resolution
// ---------------------------------------------------------------------------

describe("allowlist config fails closed", () => {
  it.each([
    ["missing", undefined],
    ["empty", []],
    ["not an array", EMBER],
    ["non-string entry", [EMBER, 42]],
    ["empty-string entry", [EMBER, ""]],
    ["object", { 0: EMBER }],
  ])("%s allows no agent", async (_label, value) => {
    setAllowedAgentIds(value);
    expect(isAllowedAgentId(EMBER)).toBe(false);
    expect(await resolveAllowedAgentId(ctx, COMPANY, EMBER)).toBeNull();
    expect(await resolveAllowedAgentId(ctx, COMPANY, "Ember")).toBeNull();
  });

  it("matches ids exactly", () => {
    expect(isAllowedAgentId(EMBER)).toBe(true);
    expect(isAllowedAgentId(EMBER.toUpperCase())).toBe(false);
    expect(isAllowedAgentId(` ${EMBER}`)).toBe(false);
    expect(isAllowedAgentId(undefined)).toBe(false);
  });
});

describe("name resolution", () => {
  it("resolves a unique name case-insensitively within the company", async () => {
    expect(await resolveAllowedAgentId(ctx, COMPANY, "ember")).toBe(EMBER);
    expect(ctx.agents.list).toHaveBeenCalledWith({ companyId: COMPANY, limit: 100, offset: 0 });
  });

  it("resolves an exact id", async () => {
    expect(await resolveAllowedAgentId(ctx, COMPANY, EMBER)).toBe(EMBER);
  });

  it("denies an allowed agent's name when another agent shares it", async () => {
    ctx.agents.list.mockResolvedValue([
      { id: EMBER, name: "Ember", companyId: COMPANY },
      { id: STELLA, name: "EMBER", companyId: COMPANY },
    ]);
    setAllowedAgentIds([EMBER, STELLA]);
    expect(await resolveAllowedAgentId(ctx, COMPANY, "Ember")).toBeNull();
  });

  it("denies an unknown name or id", async () => {
    expect(await resolveAllowedAgentId(ctx, COMPANY, "Nobody")).toBeNull();
    expect(await resolveAllowedAgentId(ctx, COMPANY, "99999999-0000-0000-0000-000000000000")).toBeNull();
  });

  it("denies an allowlisted id from another company", async () => {
    setAllowedAgentIds([EMBER, FOREIGN]);
    expect(await resolveAllowedAgentId(ctx, COMPANY, FOREIGN)).toBeNull();
    expect(await resolveAllowedAgentId(ctx, COMPANY, "Foreign")).toBeNull();
  });

  it("denies an agent the host lists under another company", async () => {
    ctx.agents.list.mockResolvedValue([{ id: EMBER, name: "Ember", companyId: OTHER_COMPANY }]);
    expect(await resolveAllowedAgentId(ctx, COMPANY, EMBER)).toBeNull();
  });

  it("denies when the agent list fails", async () => {
    ctx.agents.list.mockRejectedValue(new Error("host down"));
    expect(await resolveAllowedAgentId(ctx, COMPANY, EMBER)).toBeNull();
  });

  it("denies an allowed name that resolves to a non-allowed id", async () => {
    expect(await resolveAllowedAgentId(ctx, COMPANY, "Stella")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// spawnAgent (/clip acp spawn)
// ---------------------------------------------------------------------------

describe("spawnAgent", () => {
  it("allowed: creates the native session with the resolved id", async () => {
    const entry = await spawnAgent(ctx, COMPANY, CHANNEL, THREAD, "ember", "Ember");
    expect(ctx.agents.sessions.create).toHaveBeenCalledWith(EMBER, COMPANY, expect.any(Object));
    expect(entry?.agentId).toBe(EMBER);
  });

  it("allowed: ACP fallback emits the resolved id", async () => {
    ctx.agents.sessions.create.mockRejectedValue(new Error("no native"));
    const entry = await spawnAgent(ctx, COMPANY, CHANNEL, THREAD, "Ember", "Ember");
    expect(ctx.events.emit).toHaveBeenCalledWith("acp-spawn", COMPANY, expect.objectContaining({ agentId: EMBER }));
    expect(entry?.agentId).toBe(EMBER);
  });

  it.each([["other agent", OTHER_ONLY], ["empty allowlist", EMPTY]])("%s: denied", async (_l, ids) => {
    setAllowedAgentIds(ids);
    ctx.agents.sessions.create.mockRejectedValue(new Error("no native"));
    expect(await spawnAgent(ctx, COMPANY, CHANNEL, THREAD, "Ember", "Ember")).toBeNull();
    expectNothingSent(ctx);
    expect(store.has(STATE_KEYS.sessionRegistry(CHANNEL, THREAD))).toBe(false);
  });

  it("uses the configured maxAgentsPerThread", async () => {
    setAllowedAgentIds([EMBER, STELLA]);
    seedSessions([session({ agentId: STELLA, agentName: "Stella" })]);
    expect(await spawnAgent(ctx, COMPANY, CHANNEL, THREAD, "Ember", "Ember", undefined, 1)).toBeNull();
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
  });

  it("/clip acp spawn passes the configured maxAgentsPerThread", async () => {
    setAllowedAgentIds([EMBER, STELLA]);
    seedSessions([session({ agentId: STELLA, agentName: "Stella" })]);
    await handleAcpSlashCommand(ctx, TOKEN, {
      channel: CHANNEL, threadTs: THREAD, text: "spawn Ember", companyId: COMPANY, maxAgentsPerThread: 1,
    });
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
  });

  it("/clip acp spawn of a non-allowed agent sends nothing", async () => {
    await handleAcpSlashCommand(ctx, TOKEN, {
      channel: CHANNEL, threadTs: THREAD, text: "spawn Stella", companyId: COMPANY, maxAgentsPerThread: 5,
    });
    expectNothingSent(ctx);
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// routeMessageToAgent (@mention, reply-to, most recent)
// ---------------------------------------------------------------------------

describe("routeMessageToAgent", () => {
  it("allowed: routes via @mention", async () => {
    seedSessions([session()]);
    expect(await routeMessageToAgent(ctx, COMPANY, CHANNEL, THREAD, "@Ember hi")).toBe(true);
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledWith("sess-ember", COMPANY, expect.any(Object));
  });

  it("allowed: ACP transport emits the session's agent id", async () => {
    seedSessions([session({ transport: "acp" })]);
    expect(await routeMessageToAgent(ctx, COMPANY, CHANNEL, THREAD, "hi")).toBe(true);
    expect(ctx.events.emit).toHaveBeenCalledWith("acp-message", COMPANY, expect.objectContaining({ agentId: EMBER }));
  });

  it.each([["other agent", OTHER_ONLY], ["empty allowlist", EMPTY]])("%s: denied", async (_l, ids) => {
    setAllowedAgentIds(ids);
    seedSessions([session()]);
    expect(await routeMessageToAgent(ctx, COMPANY, CHANNEL, THREAD, "@Ember hi")).toBe(false);
    expectNothingSent(ctx);
  });

  it("refuses an @mentioned non-allowed session even when an allowed one exists", async () => {
    seedSessions([
      session(),
      session({ sessionId: "sess-stella", agentId: STELLA, agentName: "Stella", agentDisplayName: "Stella" }),
    ]);
    expect(await routeMessageToAgent(ctx, COMPANY, CHANNEL, THREAD, "@Stella hi")).toBe(false);
    expectNothingSent(ctx);
  });

  it("refuses a reply-to target that is not allowed", async () => {
    seedSessions([
      session({ lastActivityAt: "2026-11-20T12:00:00Z" }),
      session({ sessionId: "sess-stella", agentId: STELLA, agentName: "Stella" }),
    ]);
    store.set(STATE_KEYS.msgAgent(CHANNEL, "1700000000.000050"), "Stella");
    expect(await routeMessageToAgent(ctx, COMPANY, CHANNEL, THREAD, "hi", "1700000000.000050")).toBe(false);
    expectNothingSent(ctx);
  });

  it("refuses an old session entry that stored a name as agentId", async () => {
    seedSessions([session({ agentId: "Ember" })]);
    expect(await routeMessageToAgent(ctx, COMPANY, CHANNEL, THREAD, "hi")).toBe(false);
    expectNothingSent(ctx);
  });
});

// ---------------------------------------------------------------------------
// handleHandoffAction (approved)
// ---------------------------------------------------------------------------

describe("handleHandoffAction", () => {
  function seedHandoff(toAgent: string) {
    store.set(STATE_KEYS.handoff("h1"), {
      id: "h1", fromAgent: "Stella", toAgent, reason: "r", channelId: CHANNEL, threadTs: THREAD, status: "pending",
    });
  }

  it("allowed: sends to the target session", async () => {
    seedHandoff("Ember");
    seedSessions([session()]);
    await handleHandoffAction(ctx, TOKEN, COMPANY, "h1", true, "U1");
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledWith("sess-ember", COMPANY, expect.any(Object));
  });

  it("allowed without a session: ACP message uses the resolved id", async () => {
    seedHandoff("ember");
    await handleHandoffAction(ctx, TOKEN, COMPANY, "h1", true, "U1");
    expect(ctx.events.emit).toHaveBeenCalledWith("acp-message", COMPANY, expect.objectContaining({ agentId: EMBER }));
  });

  it.each([["other agent", OTHER_ONLY], ["empty allowlist", EMPTY]])("%s: denied", async (_l, ids) => {
    setAllowedAgentIds(ids);
    seedHandoff("Ember");
    seedSessions([session()]);
    await handleHandoffAction(ctx, TOKEN, COMPANY, "h1", true, "U1");
    expectNothingSent(ctx);
  });
});

// ---------------------------------------------------------------------------
// startDiscussion
// ---------------------------------------------------------------------------

describe("startDiscussion", () => {
  const params = { initiatorAgent: "Stella", targetAgent: "Ember", topic: "t", channelId: CHANNEL, threadTs: THREAD, maxTurns: 10 };

  it("allowed: kicks off the target", async () => {
    setAllowedAgentIds([EMBER, STELLA]);
    seedSessions([session()]);
    const result = await startDiscussion(ctx, TOKEN, COMPANY, params);
    expect(result.status).toBe("active");
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledWith("sess-ember", COMPANY, expect.any(Object));
  });

  it.each([["other agent", OTHER_ONLY], ["empty allowlist", EMPTY], ["initiator not allowed", ALLOWED]])(
    "%s: denied before any state or Slack post",
    async (_l, ids) => {
      setAllowedAgentIds(ids);
      seedSessions([session()]);
      ctx.state.set.mockClear();
      const result = await startDiscussion(ctx, TOKEN, COMPANY, params);
      expect(result.status).toBe("denied");
      expect(ctx.state.set).not.toHaveBeenCalled();
      expect(ctx.http.fetch).not.toHaveBeenCalled();
      expectNothingSent(ctx);
    },
  );
});

// ---------------------------------------------------------------------------
// Discussion continuation (advanceDiscussionLoop, handleDiscussionAction)
// ---------------------------------------------------------------------------

describe("discussion continuation", () => {
  function seedDiscussion(turns: number) {
    const loop: DiscussionLoop = {
      id: "d1", channelId: CHANNEL, threadTs: THREAD, initiatorAgent: "Stella", targetAgent: "Ember",
      reason: "t", turns, maxTurns: 20, status: "active",
      lastTurnAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    };
    store.set(STATE_KEYS.discussion("d1"), loop);
    store.set(STATE_KEYS.activeDiscussion(CHANNEL, THREAD), "d1");
  }

  it("allowed: agent output is passed on to the next agent", async () => {
    seedDiscussion(0);
    seedSessions([session()]);
    await handleAgentOutput(ctx, TOKEN, COMPANY, { channel: CHANNEL, threadTs: THREAD, text: "hi", agentName: "Stella" });
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledWith("sess-ember", COMPANY, expect.any(Object));
  });

  it.each([["other agent", OTHER_ONLY], ["empty allowlist", EMPTY]])("%s: next turn denied", async (_l, ids) => {
    setAllowedAgentIds(ids);
    seedDiscussion(0);
    seedSessions([session()]);
    await handleAgentOutput(ctx, TOKEN, COMPANY, { channel: CHANNEL, threadTs: THREAD, text: "hi", agentName: "Stella" });
    expectNothingSent(ctx);
  });

  it("allowed: Continue button resumes with the next agent", async () => {
    seedDiscussion(4);
    seedSessions([session()]);
    await handleDiscussionAction(ctx, TOKEN, COMPANY, "d1", "continue", "U1");
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledWith("sess-ember", COMPANY, expect.any(Object));
  });

  it.each([["other agent", OTHER_ONLY], ["empty allowlist", EMPTY]])("%s: Continue denied", async (_l, ids) => {
    setAllowedAgentIds(ids);
    seedDiscussion(4);
    seedSessions([session()]);
    await handleDiscussionAction(ctx, TOKEN, COMPANY, "d1", "continue", "U1");
    expectNothingSent(ctx);
  });
});

// ---------------------------------------------------------------------------
// ctx.agents.invoke call sites
// ---------------------------------------------------------------------------

describe("custom command invoke_agent step", () => {
  const command = {
    name: "ask", description: "", usage: "!ask",
    steps: [{ type: "invoke_agent" as const, agentId: "Ember", prompt: "hi" }],
  };

  it("allowed: invokes the resolved id", async () => {
    await executeCommand(ctx, TOKEN, COMPANY, CHANNEL, THREAD, command, []);
    expect(ctx.agents.invoke).toHaveBeenCalledWith(EMBER, COMPANY, expect.any(Object));
  });

  it.each([["other agent", OTHER_ONLY], ["empty allowlist", EMPTY]])("%s: denied", async (_l, ids) => {
    setAllowedAgentIds(ids);
    await executeCommand(ctx, TOKEN, COMPANY, CHANNEL, THREAD, command, []);
    expectNothingSent(ctx);
  });
});

describe("proactive watch", () => {
  async function run() {
    await registerWatch(ctx, COMPANY, {
      companyId: COMPANY, channelId: CHANNEL, threadTs: THREAD, eventPattern: "issue.created",
      agentId: EMBER, prompt: "p", createdBy: "U1",
    } as any);
    return checkWatches(ctx, TOKEN, COMPANY, [{ eventType: "issue.created", payload: {} }]);
  }

  it("allowed: invokes the watch agent", async () => {
    expect(await run()).toBe(1);
    expect(ctx.agents.invoke).toHaveBeenCalledWith(EMBER, COMPANY, expect.any(Object));
  });

  it.each([["other agent", OTHER_ONLY], ["empty allowlist", EMPTY]])("%s: denied", async (_l, ids) => {
    setAllowedAgentIds(ids);
    expect(await run()).toBe(0);
    expectNothingSent(ctx);
  });
});

describe("media pipeline", () => {
  it("allowed: invokes the transcriber and brief agent by id", async () => {
    setAllowedAgentIds([WHISPER, EMBER]);
    await processMediaFile(ctx, TOKEN, COMPANY, "F1", CHANNEL, THREAD, "Ember");
    expect(ctx.agents.invoke).toHaveBeenCalledWith(WHISPER, COMPANY, expect.any(Object));
    expect(ctx.agents.invoke).toHaveBeenCalledWith(EMBER, COMPANY, expect.any(Object));
  });

  it("other agent: neither the transcriber nor the brief agent is invoked", async () => {
    setAllowedAgentIds(OTHER_ONLY);
    await processMediaFile(ctx, TOKEN, COMPANY, "F1", CHANNEL, THREAD, "Ember");
    expectNothingSent(ctx);
  });

  it("brief agent not allowed: only the transcriber is invoked", async () => {
    setAllowedAgentIds([WHISPER]);
    await processMediaFile(ctx, TOKEN, COMPANY, "F1", CHANNEL, THREAD, "Ember");
    expect(ctx.agents.invoke).toHaveBeenCalledTimes(1);
    expect(ctx.agents.invoke).toHaveBeenCalledWith(WHISPER, COMPANY, expect.any(Object));
  });

  it("empty allowlist: nothing is invoked", async () => {
    setAllowedAgentIds(EMPTY);
    await processMediaFile(ctx, TOKEN, COMPANY, "F1", CHANNEL, THREAD, "Ember");
    expectNothingSent(ctx);
  });
});
