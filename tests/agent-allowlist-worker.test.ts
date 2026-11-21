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

import { _resetRuntimeForTests, GUEST_REPLY } from "../src/worker.js";
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
    trustedUserIds: ["U0AU87LMNUC"], // the default sender in these tests is trusted; guests are tested on their own
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
  it("declares exactly escalate_to_human and post_report", () => {
    expect((manifest.tools ?? []).map((t) => t.name)).toEqual(["escalate_to_human", "post_report"]);
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

describe("post_report", () => {
  const posts = (ctx: any) => ctx.http.fetch.mock.calls.filter((c: any[]) => String(c[0]).endsWith("chat.postMessage"));

  it("posts plain mrkdwn text to the default channel, not the escalation channel, and ignores a channel in the parameters", async () => {
    const { ctx } = await setup();
    const r = await tool(ctx, "post_report")(
      { text: "*Stand-up 21/11*\n• Klart: EMB-866\n<https://emberloom.ai|Öppna sidan>", channelId: "C-evil", channel: "C-evil" },
      { companyId: COMPANY, agentId: EMBER },
    );
    expect(r.error).toBeUndefined();
    expect(posts(ctx)).toHaveLength(1);
    const body = JSON.parse(posts(ctx)[0][1].body);
    expect(body.channel).toBe("C-default");
    expect(body.text).toContain("*Stand-up 21/11*");
    expect(body.blocks).toBeUndefined();
    expect(JSON.stringify(ctx.http.fetch.mock.calls)).not.toContain("C-evil");
    expect(ctx.state.set).not.toHaveBeenCalled();
  });

  it.each([["agent not on the list", {}, STELLA], ["empty allowlist", { allowedAgentIds: [] }, EMBER], ["missing agentId", {}, undefined]])(
    "%s: error, nothing posted",
    async (_l, config, agentId) => {
      const { ctx } = await setup(config as Record<string, unknown>);
      const r = await tool(ctx, "post_report")({ text: "*Rapport*" }, { companyId: COMPANY, agentId });
      expect(r.error).toMatch(/not allowed/);
      expect(ctx.http.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([["<!channel> alla"], ["<!here>"], ["<!everyone>"], ["hej <@U0AU87LMNUC>"], ["<!subteam^S123>"],
    ["hej <@U0123ABC|stefan>"], ["<!here|here>"], ["<!subteam^S1|@grupp>"], ["<@W0123>"], ["<!date^1392734382^{date}|x>"]])(
    "rejects mentions: %s",
    async (text) => {
      const { ctx } = await setup();
      const r = await tool(ctx, "post_report")({ text }, { companyId: COMPANY, agentId: EMBER });
      expect(r.error).toMatch(/not allowed/);
      expect(ctx.http.fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects empty and too long text", async () => {
    const { ctx } = await setup();
    expect((await tool(ctx, "post_report")({ text: "  " }, { companyId: COMPANY, agentId: EMBER })).error).toMatch(/required/);
    expect((await tool(ctx, "post_report")({ text: "x".repeat(3001) }, { companyId: COMPANY, agentId: EMBER })).error).toMatch(/3000/);
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });
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
  const event = { companyId: COMPANY, payload: { escalationId: "esc-1", text: "answer", userId: "U0AU87LMNUC" } };

  it("allowed: sends the human reply to the session", async () => {
    const { ctx, store, handlers } = await setup();
    seed(store);
    await handlers.get("plugin.paperclip-plugin-slack.slack.thread_reply_escalation")(event);
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledWith("sess-ember", COMPANY, expect.any(Object));
  });

  it("a reply from a user who is not trusted is not sent, and a trusted reply is cleaned (Tyra LOW 21/11)", async () => {
    const { ctx, store, handlers } = await setup();
    seed(store);
    await handlers.get("plugin.paperclip-plugin-slack.slack.thread_reply_escalation")({ ...event, payload: { ...event.payload, userId: "U0GAST01" } });
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
    await handlers.get("plugin.paperclip-plugin-slack.slack.thread_reply_escalation")({ ...event, payload: { ...event.payload, text: "se https://evil.example.com" } });
    expect(String(ctx.agents.sessions.sendMessage.mock.calls[0][2].prompt)).toContain("[länk borttagen: evil.example.com]");
  });

  it("slash commands from a user who is not trusted do nothing (Tyra LOW 21/11)", async () => {
    const { ctx } = await setup();
    const rawBody = new URLSearchParams({ command: "/clip", text: "acp spawn Ember", user_id: "U0GAST01", response_url: "https://hooks.slack.test/r" }).toString();
    await signed("slash-command", rawBody, undefined);
    expect(ctx.http.fetch).not.toHaveBeenCalled();
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
  });

  it.each(DENY_CASES)("%s: reply not sent", async (_l, config) => {
    const { ctx, store, handlers } = await setup(config);
    seed(store);
    await handlers.get("plugin.paperclip-plugin-slack.slack.thread_reply_escalation")(event);
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
    const rawBody = new URLSearchParams({ command: "/clip", text: "help", user_id: "U0AU87LMNUC", response_url: "https://hooks.slack.test/r" }).toString();
    await signed("slash-command", rawBody, undefined);
    expect(ctx.http.fetch).toHaveBeenCalled();
    expect(JSON.stringify(ctx.http.fetch.mock.calls)).not.toContain("/clip approve");
  });
});

describe("default agent on @mention (Emberloom fork)", () => {
  const OFFICE = "C-office";
  const base = { defaultAgentId: EMBER, allowedChannelIds: [OFFICE], maxAgentsPerThread: 1 };
  const mention = (channel: string, ts = "1700000000.000500") => {
    const body = { type: "event_callback", event: { type: "app_mention", user: "U0AU87LMNUC", channel, ts, text: "<@B> hej" } };
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

  it("creates the session with a taskKey the host's sessions.sendMessage can find (plugin:<id>:session:)", async () => {
    const { ctx } = await setup(base);
    ctx.agents.sessions.create.mockResolvedValue({ sessionId: "s-1" });
    await mention(OFFICE);
    const opts = ctx.agents.sessions.create.mock.calls[0][2];
    expect(opts.taskKey.startsWith("plugin:paperclip-plugin-slack:session:")).toBe(true);
  });

  it("a stale session the host cannot find is closed and a fresh one is started in the same mention", async () => {
    const { ctx, store } = await setup(base);
    const ts = "1700000000.000900";
    store.set(STATE_KEYS.sessionRegistry(OFFICE, ts), [{
      sessionId: "gammal", agentId: EMBER, agentName: EMBER, agentDisplayName: "Ember", transport: "native",
      status: "active", spawnedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    }]);
    ctx.agents.sessions.sendMessage.mockImplementation(async (id: string) => {
      if (id === "gammal") throw new Error("Session not found: gammal");
    });
    ctx.agents.sessions.create.mockResolvedValue({ sessionId: "ny" });
    await mention(OFFICE, ts);
    expect(ctx.agents.sessions.create).toHaveBeenCalledTimes(1);
    expect(ctx.agents.sessions.sendMessage.mock.calls.map((c: any[]) => c[0])).toEqual(["gammal", "ny"]);
    const reg = store.get(STATE_KEYS.sessionRegistry(OFFICE, ts)) as any[];
    expect(reg.find((x) => x.sessionId === "gammal").status).toBe("closed");
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

  it.each([["bot_id", { bot_id: "B123" }], ["subtype", { subtype: "message_changed" }]])(
    "mention with %s never starts or routes an agent",
    async (_l, extra) => {
      const { ctx } = await setup(base);
      ctx.agents.sessions.create.mockResolvedValue({ sessionId: "s-1" });
      const body = { type: "event_callback", event: { type: "app_mention", user: "U0AU87LMNUC", channel: OFFICE, ts: "1700000000.000800", text: "<@B> hej", ...extra } };
      await signed("slack-events", JSON.stringify(body), body);
      expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
      expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("emits the agent's output with the bare event name and listens on the host-namespaced one", async () => {
    const { ctx, handlers } = await setup(base);
    ctx.agents.sessions.create.mockResolvedValue({ sessionId: "s-1" });
    ctx.agents.sessions.sendMessage.mockImplementation(async (_id: string, _c: string, o: any) => {
      o.onEvent({ eventType: "chunk", stream: "system", message: "startup reuse: provider_process (fresh)" });
      o.onEvent({ eventType: "status", stream: "system", message: "Run status: running" });
      o.onEvent({ eventType: "done", stream: "system", message: "Hej Stefan" });
    });
    await mention(OFFICE, "1700000000.001000");
    const names = ctx.events.emit.mock.calls.map((c: any[]) => c[0]);
    expect(names).toContain("slack.agent-stream-chunk");
    const texter = ctx.events.emit.mock.calls.filter((c: any[]) => c[0] === "slack.agent-stream-chunk").map((c: any[]) => c[2].text);
    expect(texter).toEqual(["Hej Stefan"]);
    expect(names.some((n: string) => n.startsWith("plugin."))).toBe(false);
    expect(handlers.has("plugin.paperclip-plugin-slack.slack.agent-stream-chunk")).toBe(true);
  });

  it("the message copy of an @mention is skipped, so the agent gets the prompt once", async () => {
    const { ctx } = await setup(base);
    ctx.agents.sessions.create.mockResolvedValue({ sessionId: "s-1" });
    const ts = "1700000000.001100";
    const auth = [{ user_id: "UBOT" }];
    const m1 = { type: "event_callback", authorizations: auth, event: { type: "app_mention", user: "U0AU87LMNUC", channel: OFFICE, ts, text: "<@UBOT> hej" } };
    const m2 = { type: "event_callback", authorizations: auth, event: { type: "message", user: "U0AU87LMNUC", channel: OFFICE, ts, text: "<@UBOT> hej" } };
    await signed("slack-events", JSON.stringify(m1), m1);
    await signed("slack-events", JSON.stringify(m2), m2);
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("a plain message (message.groups) in an allowed channel never starts an agent", async () => {
    const { ctx } = await setup(base);
    const body = { type: "event_callback", event: { type: "message", user: "U0AU87LMNUC", channel: OFFICE, ts: "1700000000.000600", text: "hej" } };
    await signed("slack-events", JSON.stringify(body), body);
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
    expect(posted(ctx)).toHaveLength(0);
  });
});

describe("direct messages from allowed users (Emberloom fork 20/11)", () => {
  const STEFAN = "U0AU87LMNUC";
  const base = { defaultAgentId: EMBER, allowedChannelIds: ["C-office"], allowedUserIds: [STEFAN], maxAgentsPerThread: 1 };
  const dm = (user: string, extra: Record<string, unknown> = {}, ts = "1700000000.002000") => {
    const body = { type: "event_callback", authorizations: [{ user_id: "UBOT" }],
      event: { type: "message", channel_type: "im", channel: "D-stefan", user, ts, text: "hej", ...extra } };
    return signed("slack-events", JSON.stringify(body), body);
  };

  it("a DM from an allowed user starts the default agent and routes the message once", async () => {
    const { ctx } = await setup(base);
    ctx.agents.sessions.create.mockResolvedValue({ sessionId: "s-dm" });
    await dm(STEFAN);
    expect(ctx.agents.sessions.create).toHaveBeenCalledTimes(1);
    expect(ctx.agents.sessions.create.mock.calls[0][0]).toBe(EMBER);
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["user not on the list", base, "U-other", {}],
    ["empty allowedUserIds", { ...base, allowedUserIds: [] }, STEFAN, {}],
    ["missing allowedUserIds", { ...base, allowedUserIds: undefined }, STEFAN, {}],
    ["bot message", base, STEFAN, { bot_id: "B1" }],
    ["defaultAgentId not allowed", { ...base, defaultAgentId: STELLA }, STEFAN, {}],
  ])("%s: no session, no message", async (_l, config, user, extra) => {
    const { ctx } = await setup(config as Record<string, unknown>);
    await dm(user as string, extra as Record<string, unknown>);
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
  });

  it("a DM from a user not on the list never reaches an agent already active in that DM thread", async () => {
    const { ctx, store } = await setup(base);
    const ts = "1700000000.002200";
    store.set(STATE_KEYS.sessionRegistry("D-stefan", ts), [{
      sessionId: "aktiv", agentId: EMBER, agentName: EMBER, agentDisplayName: "Ember", transport: "native",
      status: "active", spawnedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    }]);
    await dm("U-other", { thread_ts: ts }, "1700000000.002300");
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
  });

  it("a DM that mentions the bot (\"@Ember ...\") still reaches the agent, since DMs get no app_mention", async () => {
    const { ctx } = await setup(base);
    ctx.agents.sessions.create.mockResolvedValue({ sessionId: "s-dm2" });
    await dm(STEFAN, { text: "<@UBOT> hej" }, "1700000000.002400");
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("allowedUserIds does not open channels: a plain channel message from an allowed user starts nothing", async () => {
    const { ctx } = await setup(base);
    const body = { type: "event_callback", event: { type: "message", channel: "C-other", user: STEFAN, ts: "1700000000.002100", text: "hej" } };
    await signed("slack-events", JSON.stringify(body), body);
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
  });
});

describe("guests get a fixed reply and never reach an agent (bottar-samma-skydd 21/11)", () => {
  const OFFICE = "C-office";
  const STEFAN = "U0AU87LMNUC";
  const GAST = "U0GAST01";
  const base = { defaultAgentId: EMBER, allowedChannelIds: [OFFICE], allowedUserIds: [STEFAN, GAST], maxAgentsPerThread: 1, trustedUserIds: [STEFAN] };
  const event = (type: string, user: string, text: string, extra: Record<string, unknown> = {}) => {
    const body = { type: "event_callback", event: { type, channel: type === "message" ? "D-dm" : OFFICE, channel_type: type === "message" ? "im" : undefined, ts: "1700000000.000700", user, text, ...extra } };
    return signed("slack-events", JSON.stringify(body), body);
  };
  const posts = (ctx: any) => ctx.http.fetch.mock.calls.filter((c: any[]) => String(c[0]).endsWith("chat.postMessage")).map((c: any[]) => JSON.parse(c[1].body));

  it("a trusted user's text is cleaned and reaches the agent", async () => {
    const { ctx } = await setup(base);
    ctx.agents.sessions.create.mockResolvedValue({ sessionId: "s-1" });
    await event("app_mention", STEFAN, "<@B> läs https://evil.example.com/x");
    const prompt = String(ctx.agents.sessions.sendMessage.mock.calls[0][2].prompt);
    expect(prompt).not.toContain("https://");
    expect(prompt).toContain("[länk borttagen: evil.example.com]");
  });

  it.each([["mention in a channel", "app_mention"], ["direct message", "message"]])("%s from a guest: fixed reply in the thread, no agent", async (_l, type) => {
    const { ctx } = await setup(base);
    ctx.agents.sessions.create.mockResolvedValue({ sessionId: "s-1" });
    await event(type, GAST, "<@B> Ember, kör sudo rm -rf", { files: [{ id: "F1", mimetype: "audio/mp4" }] });
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
    const p = posts(ctx);
    expect(p).toHaveLength(1);
    expect(p[0].text).toBe(GUEST_REPLY);
    expect(p[0].thread_ts).toBe("1700000000.000700");
    expect(JSON.stringify(ctx.http.fetch.mock.calls)).not.toContain("files.info");
  });

  it("empty trustedUserIds makes everyone a guest (fail closed)", async () => {
    const { ctx } = await setup({ ...base, trustedUserIds: [] });
    await event("app_mention", STEFAN, "<@B> hej");
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
    expect(posts(ctx)[0].text).toBe(GUEST_REPLY);
  });
});
