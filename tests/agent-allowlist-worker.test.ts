import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

// Worker-level checks for the agent allowlist, the removed Slack approvals and
// the manifest tool list. Same host-mock pattern as company-scoped-bootstrap.

const { captured } = vi.hoisted(() => ({ captured: [] as any[] }));

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) captured.push(def);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

import { _resetRuntimeForTests } from "../src/worker.js";
import manifest from "../src/manifest.js";
import { STATE_KEYS } from "../src/constants.js";

const COMPANY = "11111111-1111-1111-1111-111111111111";
const EMBER = "1111aaaa-0000-0000-0000-000000000001";
const STELLA = "1111aaaa-0000-0000-0000-000000000002";
const CHANNEL = "C-thread";
const THREAD = "1700000000.000001";

function storedConfig(overrides: Record<string, unknown> = {}) {
  return {
    slackTokenRef: { type: "secret_ref", secretId: "33333333-3333-3333-3333-333333333333" },
    slackSigningSecretRef: { type: "secret_ref", secretId: "55555555-5555-5555-5555-555555555555" },
    defaultChannelId: "C-default",
    escalationChatId: "C-escalations",
    enableDailyDigest: false,
    allowedAgentIds: [EMBER],
    ...overrides,
  };
}

function buildHost() {
  const store = new Map<string, unknown>();
  const handlers = new Map<string, any>();
  const ctx = {
    config: { get: vi.fn(async () => storedConfig()) },
    secrets: {
      resolve: vi.fn(async (_ref: unknown, opts?: { configPath?: string }) =>
        opts?.configPath === "slackSigningSecretRef" ? "signing-secret" : "xoxb-token"),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: {
      get: vi.fn(async (k: any) => store.get(k.stateKey) ?? null),
      set: vi.fn(async (k: any, v: unknown) => { store.set(k.stateKey, v); }),
      delete: vi.fn(async () => {}),
    },
    metrics: { write: vi.fn(async () => {}) },
    activity: { log: vi.fn(async () => {}) },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: { on: vi.fn((name: string, h: any) => handlers.set(name, h)), emit: vi.fn(), subscribe: vi.fn() },
    companies: { list: vi.fn(async () => [{ id: COMPANY, name: "Co" }]) },
    agents: {
      list: vi.fn(async () => [
        { id: EMBER, name: "Ember", companyId: COMPANY },
        { id: STELLA, name: "Stella", companyId: COMPANY },
      ]),
      invoke: vi.fn(),
      sessions: { create: vi.fn(), sendMessage: vi.fn(async () => {}), close: vi.fn() },
    },
    issues: { list: vi.fn(async () => []) },
    http: {
      fetch: vi.fn(async () => ({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ ok: true, ts: "1700000000.000099" }), text: async () => "",
      })),
    },
  } as any;
  return { ctx, store, handlers };
}

const definition = () => captured[captured.length - 1];
const tool = (ctx: any, name: string) =>
  ctx.tools.register.mock.calls.find((c: any[]) => c[0] === name)![2];

async function setup(config: Record<string, unknown> = {}) {
  const host = buildHost();
  await definition().setup(host.ctx);
  await definition().onConfigChanged(storedConfig(config), { companyId: COMPANY });
  host.ctx.http.fetch.mockClear();
  host.ctx.state.set.mockClear();
  return host;
}

function signed(endpointKey: string, rawBody: string, parsedBody: unknown) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = "v0=" + createHmac("sha256", "signing-secret").update(`v0:${timestamp}:${rawBody}`).digest("hex");
  return definition().onWebhook({
    endpointKey, rawBody, parsedBody, requestId: "r",
    headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
  });
}

function calledUrls(ctx: any): string[] {
  return ctx.http.fetch.mock.calls.map((c: any[]) => String(c[0]));
}

beforeEach(() => {
  _resetRuntimeForTests();
  vi.clearAllMocks();
});

const DENY_CASES: Array<[string, Record<string, unknown>]> = [
  ["other agent", { allowedAgentIds: [STELLA] }],
  ["empty allowlist", { allowedAgentIds: [] }],
  ["missing allowlist", { allowedAgentIds: undefined }],
];

describe("manifest tools", () => {
  it("declares exactly escalate_to_human", () => {
    expect((manifest.tools ?? []).map((t) => t.name)).toEqual(["escalate_to_human"]);
  });

  it("registers escalate_to_human with the declared schema", async () => {
    const { ctx } = buildHost();
    await definition().setup(ctx);
    const call = ctx.tools.register.mock.calls.find((c: any[]) => c[0] === "escalate_to_human");
    expect(call[1].parametersSchema).toEqual(manifest.tools![0].parametersSchema);
    expect(Object.keys(call[1].parametersSchema.properties)).not.toContain("channelId");
  });
});

describe("escalate_to_human channel", () => {
  it("ignores a channel in the parameters and posts to the configured escalation channel", async () => {
    const { ctx } = await setup();
    await tool(ctx, "escalate_to_human")(
      { reason: "help", channelId: "C-evil", channel: "C-evil", chatId: "C-evil" },
      { companyId: COMPANY, agentId: EMBER },
    );
    const posts = ctx.http.fetch.mock.calls.filter((c: any[]) => String(c[0]).endsWith("chat.postMessage"));
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0][1].body);
    expect(body.channel).toBe("C-escalations");
    expect(JSON.stringify(ctx.http.fetch.mock.calls)).not.toContain("C-evil");
    expect(Object.keys(body).sort()).toEqual(["blocks", "channel", "text"]);
  });

  it("falls back to defaultChannelId, not the approvals channel", async () => {
    const { ctx } = await setup({ escalationChatId: "", approvalsChannelId: "C-approvals" });
    await tool(ctx, "escalate_to_human")({ reason: "help", channelId: "C-evil" }, { companyId: COMPANY, agentId: EMBER });
    const post = ctx.http.fetch.mock.calls.find((c: any[]) => String(c[0]).endsWith("chat.postMessage"));
    expect(JSON.parse(post[1].body).channel).toBe("C-default");
  });
});

describe("escalate_to_human caller", () => {
  it("allowed agent posts, and the name shown comes from its id, not the parameters", async () => {
    const { ctx } = await setup();
    const r = await tool(ctx, "escalate_to_human")({ reason: "help", agentName: "Someone Else" }, { companyId: COMPANY, agentId: EMBER });
    expect(r.error).toBeUndefined();
    const post = ctx.http.fetch.mock.calls.find((c: any[]) => String(c[0]).endsWith("chat.postMessage"));
    expect(post).toBeDefined();
    expect(post[1].body).not.toContain("Someone Else");
  });

  it.each([["agent not on the list", {}, STELLA], ["empty allowlist", { allowedAgentIds: [] }, EMBER], ["missing agentId", {}, undefined]])(
    "%s: error, nothing posted or stored",
    async (_l, config, agentId) => {
      const { ctx } = await setup(config as Record<string, unknown>);
      const r = await tool(ctx, "escalate_to_human")({ reason: "help", agentName: "Ember" }, { companyId: COMPANY, agentId });
      expect(r.error).toMatch(/not allowed/);
      expect(ctx.http.fetch).not.toHaveBeenCalled();
      expect(ctx.state.set).not.toHaveBeenCalled();
    },
  );
});

describe("handoff_to_agent tool", () => {
  const params = { fromAgent: "Stella", toAgent: "Ember", reason: "r", channelId: CHANNEL, threadTs: THREAD };

  it("allowed: records the handoff and posts the prompt", async () => {
    const { ctx } = await setup();
    const result = await tool(ctx, "handoff_to_agent")(params, { companyId: COMPANY });
    expect(result.error).toBeUndefined();
    expect(ctx.state.set).toHaveBeenCalled();
  });

  it.each(DENY_CASES)("%s: error result, nothing written or posted", async (_l, config) => {
    const { ctx } = await setup(config);
    const result = await tool(ctx, "handoff_to_agent")(params, { companyId: COMPANY });
    expect(result.error).toMatch(/not allowed/);
    expect(ctx.state.set).not.toHaveBeenCalled();
    expect(ctx.http.fetch).not.toHaveBeenCalled();
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
    expect(ctx.events.emit).not.toHaveBeenCalled();
  });
});

describe("discuss_with_agent tool", () => {
  const params = { initiatorAgent: "Ember", targetAgent: "Ember", topic: "t", channelId: CHANNEL, threadTs: THREAD };

  it("allowed: starts the discussion", async () => {
    const { ctx } = await setup();
    const result = await tool(ctx, "discuss_with_agent")(params, { companyId: COMPANY });
    expect(JSON.parse(result.content).status).toBe("active");
    expect(ctx.events.emit).toHaveBeenCalledWith("acp-message", COMPANY, expect.objectContaining({ agentId: EMBER }));
  });

  it.each(DENY_CASES)("%s: error result, nothing written or sent", async (_l, config) => {
    const { ctx } = await setup(config);
    const result = await tool(ctx, "discuss_with_agent")(params, { companyId: COMPANY });
    expect(result.error).toMatch(/not allowed/);
    expect(ctx.state.set).not.toHaveBeenCalled();
    expect(ctx.http.fetch).not.toHaveBeenCalled();
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
    expect(ctx.events.emit).not.toHaveBeenCalled();
  });
});

describe("escalation reply to an agent session", () => {
  function seed(store: Map<string, unknown>) {
    store.set(STATE_KEYS.escalationRecord("esc-1"), {
      id: "esc-1", sessionId: "sess-ember", agentName: "Ember", channelId: CHANNEL, threadTs: THREAD,
    });
    store.set(STATE_KEYS.sessionRegistry(CHANNEL, THREAD), [{
      sessionId: "sess-ember", agentId: EMBER, agentName: "Ember", agentDisplayName: "Ember",
      transport: "native", status: "active", spawnedAt: "", lastActivityAt: "",
    }]);
  }
  const event = { companyId: COMPANY, payload: { escalationId: "esc-1", text: "answer", userId: "U1" } };

  it("allowed: sends the human reply to the session", async () => {
    const { ctx, store, handlers } = await setup();
    seed(store);
    await handlers.get("plugin.slack.thread_reply_escalation")(event);
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledWith("sess-ember", COMPANY, expect.any(Object));
  });

  it.each(DENY_CASES)("%s: reply not sent", async (_l, config) => {
    const { ctx, store, handlers } = await setup(config);
    seed(store);
    await handlers.get("plugin.slack.thread_reply_escalation")(event);
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
  });
});

describe("approvals are not decided from Slack", () => {
  it.each(["approval_approve", "approval_reject"])("%s click is logged and ignored", async (actionId) => {
    const { ctx } = await setup();
    const parsedBody = {
      type: "block_actions", response_url: "https://hooks.slack.test/r", user: { id: "U1" },
      actions: [{ action_id: actionId, value: "apr-1" }],
    };
    await signed("slack-interactivity", JSON.stringify(parsedBody), parsedBody);
    expect(calledUrls(ctx).some((u) => u.includes("/api/approvals"))).toBe(false);
    expect(ctx.http.fetch).not.toHaveBeenCalled();
    expect(ctx.metrics.write).not.toHaveBeenCalledWith("slack.approvals.decided", expect.anything(), expect.anything());
    expect(ctx.logger.warn).toHaveBeenCalledWith("Ignoring Slack approval action", expect.objectContaining({ actionId }));
  });

  it("/clip approve is no longer a command", async () => {
    const { ctx } = await setup();
    const rawBody = new URLSearchParams({
      command: "/clip", text: "approve apr-1", response_url: "https://hooks.slack.test/r", channel_id: CHANNEL,
    }).toString();
    await signed("slash-command", rawBody, undefined);
    expect(calledUrls(ctx).some((u) => u.includes("/api/approvals"))).toBe(false);
  });

  it("help text no longer lists /clip approve", async () => {
    const { ctx } = await setup();
    const rawBody = new URLSearchParams({ command: "/clip", text: "help", response_url: "https://hooks.slack.test/r" }).toString();
    await signed("slash-command", rawBody, undefined);
    expect(ctx.http.fetch).toHaveBeenCalled();
    expect(JSON.stringify(ctx.http.fetch.mock.calls)).not.toContain("/clip approve");
  });
});

describe("default agent on @mention (Emberloom fork)", () => {
  const OFFICE = "C-office";
  const base = { defaultAgentId: EMBER, allowedChannelIds: [OFFICE], maxAgentsPerThread: 1 };
  const mention = (channel: string, ts = "1700000000.000500") => {
    const body = { type: "event_callback", event: { type: "app_mention", channel, ts, text: "<@B> hej" } };
    return signed("slack-events", JSON.stringify(body), body);
  };
  const posted = (ctx: any) => calledUrls(ctx).filter((u) => u.endsWith("chat.postMessage"));

  it("mention in an allowed channel starts the default agent and routes the message", async () => {
    const { ctx } = await setup(base);
    ctx.agents.sessions.create.mockResolvedValue({ sessionId: "s-1" });
    await mention(OFFICE);
    expect(ctx.agents.sessions.create).toHaveBeenCalledTimes(1);
    expect(ctx.agents.sessions.create.mock.calls[0][0]).toBe(EMBER);
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not start a second session when the thread already has an active one", async () => {
    const { ctx } = await setup(base);
    ctx.agents.sessions.create.mockResolvedValue({ sessionId: "s-1" });
    await mention(OFFICE);
    await mention(OFFICE);
    expect(ctx.agents.sessions.create).toHaveBeenCalledTimes(1);
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not start the default agent when another agent is active in the thread, even with a higher maxAgentsPerThread", async () => {
    const { ctx, store } = await setup({ ...base, maxAgentsPerThread: 5 });
    const ts = "1700000000.000700";
    store.set(STATE_KEYS.sessionRegistry(OFFICE, ts), [{
      sessionId: "old", agentId: STELLA, agentName: "Stella", agentDisplayName: "Stella", transport: "native",
      status: "active", spawnedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    }]);
    await mention(OFFICE, ts);
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["mention in another channel", base, "C-other"],
    ["defaultAgentId not in allowedAgentIds", { ...base, defaultAgentId: STELLA }, OFFICE],
    ["empty allowedChannelIds", { ...base, allowedChannelIds: [] }, OFFICE],
    ["missing allowedChannelIds", { ...base, allowedChannelIds: undefined }, OFFICE],
    ["empty allowedAgentIds", { ...base, allowedAgentIds: [] }, OFFICE],
    ["empty defaultAgentId", { ...base, defaultAgentId: "" }, OFFICE],
  ])("%s: no session, no message, no reply", async (_l, config, channel) => {
    const { ctx } = await setup(config as Record<string, unknown>);
    await mention(channel as string);
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
    expect(ctx.events.emit).not.toHaveBeenCalledWith("acp-spawn", expect.anything(), expect.anything());
    expect(posted(ctx)).toHaveLength(0);
  });

  it("a plain message (message.groups) in an allowed channel never starts an agent", async () => {
    const { ctx } = await setup(base);
    const body = { type: "event_callback", event: { type: "message", channel: OFFICE, ts: "1700000000.000600", text: "hej" } };
    await signed("slack-events", JSON.stringify(body), body);
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
    expect(posted(ctx)).toHaveLength(0);
  });
});
