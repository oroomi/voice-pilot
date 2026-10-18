// Port tests: the tool loop with a fake client, target validation, the SSE route, rate limits, the TTS cap and cache, status.
// No network, no keys, no node_modules: the model is lib/fake.ts FakeClient and the voice upstream is a fake async function.
// Run: node --test server-node/test/   (Node >= 22.6 strips the types; relative imports carry the .ts extension for that reason).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { FakeClient, reply, rehearsalClient, text, tool } from "../lib/fake.ts";
import type { Plan, Reply } from "../lib/fake.ts";
import {
  ANSWER_SHAPE, FINAL_NOTE, Limiter, Registry, TOUR_RULES, Turn, UI_TOOLS, cleanManifest, cleanMessages, createPilot, matchPage, pageMap,
  settings, spoken,
} from "../lib/pilot.ts";
import type { SseEvent, Upstream } from "../lib/pilot.ts";

type Any = Record<string, any>;

const MANIFEST = {
  app: { name: "Sample app", description: "A test app." },
  page: { path: "/", title: "Home" },
  targets: [
    { id: "hero", desc: "The hero" }, { id: "apply", desc: "Apply button", safe: true },
    { id: "sector", desc: "Sector filter", fill: { kind: "select", options: ["Aquaculture", "Energy"] } },
  ],
  pages: [
    { path: "/", title: "Home", targets: [] },
    { path: "/matches", title: "Matches", targets: [{ id: "match-1", desc: "Top match" }] },
    { path: "/startups/:slug", title: "Startup", targets: [{ id: "why", desc: "Why it fits" }] },
  ],
};

// ---- environment: every test starts from a clean PILOT_/key environment and restores it afterwards -----------------------------------------
const TOUCHED = /^(PILOT_|ELEVENLABS_|ANTHROPIC_API_KEY$)/;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {};
  for (const k of Object.keys(process.env)) {
    if (TOUCHED.test(k)) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (TOUCHED.test(k)) delete process.env[k];
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
});

const silent = () => {};

function makeTurn(script: (Reply | Error)[] | ((p: Any) => Reply | Error), reg?: Registry, opts: Any = {}) {
  const s = settings();
  const client = new FakeClient(script);
  const turn = new Turn([{ role: "user", content: "show me the best match" }], cleanManifest(MANIFEST), reg ?? new Registry(), client, s, { log: silent, ...opts });
  return { turn, client };
}

async function collect(turn: Turn): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of turn.events()) out.push(e);
  return out;
}

const lastContent = (client: FakeClient, call: number): Any[] => client.calls[call].messages.at(-1).content;

// ---- the tool loop --------------------------------------------------------------------------------------------------------------------------
test("tool loop: data tool, then UI tools, then the streamed answer with cues", async () => {
  const reg = new Registry();
  let seen: Any = {};
  reg.tool({ name: "list_matches", description: "matches", label: "reading the list" }, (args) => {
    seen = args;
    return { top: "Kelpforge" };
  });
  const answer = "[[1]] Here are the matches. [[2]] Kelpforge is the best one.";
  const { turn, client } = makeTurn([
    reply(tool("list_matches", { limit: 3 })),
    reply(tool("navigate", { path: "/matches" }), tool("highlight", { target: "match-1", caption: "Best match" })),
    reply(text(answer)),
  ], reg);
  const ev = await collect(turn);

  assert.equal(ev[0].event, "status");
  assert.equal(ev.at(-1)!.event, "done");
  assert.deepEqual(ev.filter((e) => e.event === "status").map((e) => e.data.label),
    ["thinking", "reading the list", "opening the page", "getting it ready to show"]);
  assert.deepEqual(ev.filter((e) => e.event === "status" && e.data.tool).map((e) => e.data.tool), ["list_matches", "navigate", "highlight"]);
  // the order of the whole stream: data tool call, then the two UI actions, then the words
  const order = ev.map((e) => (e.event === "status" && e.data.tool ? "tool:" + e.data.tool : e.event)).filter((x) => x !== "status");
  assert.deepEqual(order.slice(0, 4), ["tool:list_matches", "tool:navigate", "tool:highlight", "action"]);
  assert.deepEqual(order.slice(-2).map((x) => x), ["delta", "done"]);

  const acts = ev.filter((e) => e.event === "action").map((e) => e.data);
  assert.deepEqual(acts.map((a) => [a.id, a.type]), [[1, "navigate"], [2, "highlight"]]);
  assert.equal(acts[1].target, "match-1");
  assert.equal(acts[1].caption, "Best match");
  assert.equal(ev.filter((e) => e.event === "delta").map((e) => e.data.text).join(""), answer);
  assert.deepEqual(seen, { limit: 3 });

  // the data tool's result and the cue numbers went back to the model as tool results; the assistant turn went back unchanged
  const r2 = lastContent(client, 1)[0];
  assert.ok(r2.type === "tool_result" && r2.content.includes("Kelpforge") && r2.tool_use_id.startsWith("toolu_fake_"));
  assert.equal(client.calls[1].messages.at(-2).role, "assistant");
  assert.equal(client.calls[1].messages.at(-2).content[0].type, "tool_use");
  const r3 = lastContent(client, 2);
  assert.equal(r3[0].content, "Queued as cue [[1]]. Put [[1]] at the start of the sentence it belongs with.");
  assert.ok(r3[1].content.includes("[[2]]"));

  const done = ev.at(-1)!.data;
  assert.equal(done.steps, 3);
  assert.equal(done.actions.length, 2);
  assert.equal(done.text, answer);
  assert.equal(done.model, "claude-sonnet-5-5");
  assert.deepEqual(done.usage, { input_tokens: 300, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

  // the request: UI tools + data tools, the page map in the system prompt, adaptive thinking at the configured effort, the fallback extras
  const kw = client.calls[0];
  const names: string[] = kw.tools.map((t: Any) => t.name);
  assert.deepEqual(names, ["navigate", "scroll_to", "highlight", "click", "fill", "wait", "list_matches"]);
  assert.ok(kw.system[1].text.includes("match-1") && kw.system[1].text.includes("/startups/:slug"));
  assert.deepEqual(kw.thinking, { type: "adaptive" });
  assert.deepEqual(kw.output_config, { effort: "low" });
  assert.equal(kw.model, "claude-sonnet-5-5");
  assert.equal(kw.fallbacks, "default");
  assert.deepEqual(client.callOptions[0].headers, { "anthropic-beta": "server-side-fallback-2026-07-01" });
  assert.deepEqual(kw.system[0].cache_control, { type: "ephemeral" });
  assert.ok(kw.system[0].text.includes("ONE short paragraph") && kw.system[0].text.includes("Never mention your tools"));
  assert.ok(kw.system[0].text.includes(TOUR_RULES) && kw.system[0].text.endsWith(ANSWER_SHAPE));
  assert.ok(kw.system[0].text.startsWith("You are Aava, the voice assistant inside Sample app.\n\nA test app."));
  assert.equal(kw.tool_choice, undefined);
});

test("a step that writes words after an earlier step's words gets a space delta between them", async () => {
  const { turn } = makeTurn([
    { content: [text("First thought."), tool("wait", { ms: 100 })], stop_reason: "tool_use" },
    reply(text("Second thought.")),
  ]);
  const ev = await collect(turn);
  const deltas = ev.filter((e) => e.event === "delta").map((e) => [e.data.text, e.data.step]);
  assert.deepEqual(deltas, [["First thought.", 1], [" ", 2], ["Second thought.", 2]]);
  assert.equal(ev.at(-1)!.data.text, "First thought. Second thought.");
});

test("unknown targets and unsafe clicks are refused back to the model and never reach the page", async () => {
  const { turn, client } = makeTurn([
    reply(tool("highlight", { target: "nope" }), tool("click", { target: "hero" }), tool("click", { target: "apply" }),
      tool("fill", { target: "sector", value: "energy" }), tool("navigate", { path: "https://evil.example/" })),
    reply(text("[[1]] Applied. [[2]] Energy only.")),
  ]);
  const ev = await collect(turn);
  const acts = ev.filter((e) => e.event === "action").map((e) => e.data);
  assert.deepEqual(acts.map((a) => [a.type, a.target]), [["click", "apply"], ["fill", "sector"]]);
  assert.equal(acts[1].value, "Energy");                                 // matched to the option's own spelling
  assert.deepEqual(acts.map((a) => a.id), [1, 2]);                        // refused calls take no cue number
  const results = lastContent(client, 1);
  const errs = results.filter((r) => r.is_error);
  assert.equal(errs.length, 3);
  assert.ok(errs[0].content.includes("Unknown target 'nope'") && errs[0].content.includes("hero, apply, sector"));
  assert.ok(errs[1].content.includes("not marked safe"));
  assert.ok(errs[2].content.includes("starts with /"));
  assert.equal(results.filter((r) => !r.is_error).length, 2);
  assert.equal(ev.at(-1)!.event, "done");
});

test("fill rejects a value that is not an option, and a target that is not fillable", async () => {
  const { turn, client } = makeTurn([
    reply(tool("fill", { target: "sector", value: "Mining" }), tool("fill", { target: "hero", value: "x" })),
    reply(text("Done.")),
  ]);
  await collect(turn);
  const [a, b] = lastContent(client, 1);
  assert.ok(a.is_error && a.content === "'Mining' is not an option of 'sector'. Options: Aquaculture | Energy");
  assert.ok(b.is_error && b.content === "'hero' is not fillable.");
});

test("after navigate the targets of the destination page are the valid ones", async () => {
  const { turn, client } = makeTurn([
    reply(tool("navigate", { path: "/startups/kelpforge" }), tool("highlight", { target: "why" }), tool("highlight", { target: "match-1" })),
    reply(text("[[1]] [[2]] It fits.")),
  ]);
  const ev = await collect(turn);
  assert.deepEqual(ev.filter((e) => e.event === "action").map((e) => e.data.type), ["navigate", "highlight"]);
  const err = lastContent(client, 1).find((r) => r.is_error)!;
  assert.ok(err.content.includes("match-1") && err.content.includes("/startups/kelpforge") && err.content.endsWith("Targets there: why."));
});

test("a page the manifest did not describe gives unverified actions, and an unknown page is refused", async () => {
  const m = cleanManifest({ page: { path: "/" }, targets: [{ id: "hero" }], pages: [] });
  const client = new FakeClient([reply(tool("navigate", { path: "/anywhere" }), tool("highlight", { target: "whatever" })), reply(text("Ok."))]);
  const t = new Turn([{ role: "user", content: "go" }], m, new Registry(), client, settings(), { log: silent });
  const acts = (await collect(t)).filter((e) => e.event === "action").map((e) => e.data);
  assert.deepEqual(acts[1], { type: "highlight", caption: "", target: "whatever", unverified: true, id: 2 });

  const { turn, client: c2 } = makeTurn([reply(tool("navigate", { path: "/admin" })), reply(text("Sorry."))]);
  const ev = await collect(turn);
  assert.equal(ev.filter((e) => e.event === "action").length, 0);
  assert.equal(lastContent(c2, 1)[0].content, "Unknown page. Pages: /, /matches, /startups/:slug");
});

test("wait is clamped, the action cap holds, an unknown tool is an error result", async () => {
  process.env.PILOT_MAX_ACTIONS = "2";
  const { turn, client } = makeTurn([
    reply(tool("wait", { ms: 99999 }), tool("wait", { ms: "250" }), tool("wait", { ms: 5 }), tool("wait", { ms: "abc" }), tool("mystery")),
    reply(text("Ok.")),
  ]);
  const ev = await collect(turn);
  assert.deepEqual(ev.filter((e) => e.event === "action").map((e) => e.data.ms), [3000, 250]);
  const r = lastContent(client, 1);
  assert.equal(r[2].content, "At most 2 UI actions per answer. Write the answer now.");
  assert.ok(r[2].is_error && r[3].is_error && r[4].is_error);
  assert.equal(r[4].content, "There is no tool called mystery.");
});

test("the last step forbids tools, and an empty answer is an error", async () => {
  process.env.PILOT_MAX_STEPS = "2";
  let { turn, client } = makeTurn([reply(tool("wait", { ms: 200 })), reply(text("Done waiting."))]);
  let ev = await collect(turn);
  assert.deepEqual(client.calls[1].tool_choice, { type: "none" });
  assert.ok(client.calls[1].system[1].text.endsWith(FINAL_NOTE));
  assert.equal(client.calls[0].tool_choice, undefined);
  assert.equal(ev.at(-1)!.event, "done");

  ({ turn } = makeTurn([reply(text("  "))]));
  ev = await collect(turn);
  assert.equal(ev.at(-1)!.event, "error");
  assert.equal(ev.at(-1)!.data.kind, "empty");
  ({ turn } = makeTurn([reply(text("[[1]] [[2]]"))]));                    // cues alone are not an answer
  assert.equal((await collect(turn)).at(-1)!.data.kind, "empty");
});

test("a refusal ends the turn with an error", async () => {
  const { turn } = makeTurn([{ ...reply(text("no")), stop_reason: "refusal" }]);
  const ev = await collect(turn);
  assert.deepEqual(ev.at(-1), { event: "error", data: { kind: "refusal", message: "Aava can't help with that one." } });
});

test("failed actions from last turn are reported to the model", async () => {
  const { turn, client } = makeTurn([reply(text("Ok."))], undefined, {
    reports: [{ id: 2, type: "highlight", target: "why", ok: false, why: "not on the page" }, { id: 1, type: "navigate", ok: true }],
  });
  await collect(turn);
  const sent: string = client.calls[0].messages.at(-1).content;
  assert.ok(sent.startsWith("show me the best match\n\n(Note from the page:"));
  assert.ok(sent.includes("did not run: highlight why (not on the page)"));
  assert.ok(!sent.includes("navigate"));
});

test("between_tools and fallbacks settings", async () => {
  process.env.PILOT_THINKING = "between_tools";
  let { turn, client } = makeTurn([reply(text("Hi."))]);
  await collect(turn);
  assert.deepEqual(client.calls[0].thinking, { type: "between_tools" });
  assert.ok(!("output_config" in client.calls[0]));
  assert.equal(client.calls[0].fallbacks, "default");
  assert.equal(client.callOptions[0].headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  process.env.PILOT_FALLBACKS = "off";
  ({ turn, client } = makeTurn([reply(text("Hi."))]));
  await collect(turn);
  assert.ok(!("fallbacks" in client.calls[0]));
  assert.equal(client.callOptions[0].headers, undefined);
});

test("a 400 about thinking/effort/fallbacks is retried once without those extras", async () => {
  const bad = Object.assign(new Error("400 thinking.type: adaptive is not supported"), { status: 400 });
  const { turn, client } = makeTurn([bad, reply(text("Fine."))]);
  const ev = await collect(turn);
  assert.equal(ev.at(-1)!.event, "done");
  assert.equal(client.calls.length, 2);
  for (const k of ["thinking", "output_config", "fallbacks"]) assert.ok(!(k in client.calls[1]), k);
  assert.equal(client.callOptions[1].headers, undefined);
  assert.equal(ev.at(-1)!.data.steps, 1);

  // an unrelated 400 is not retried
  const other = Object.assign(new Error("400 messages: bad role"), { status: 400 });
  const r2 = makeTurn([other, reply(text("never"))]);
  const ev2 = await collect(r2.turn);
  assert.deepEqual(ev2.at(-1), { event: "error", data: { kind: "api", message: "Aava's reasoning is not available right now." } });
  assert.equal(r2.client.calls.length, 1);
});

test("API failures become one sentence safe to speak", async () => {
  const cases: [Error, string][] = [
    [Object.assign(new Error("429 rate"), { status: 429 }), "busy"],
    [Object.assign(new Error("401 nope"), { status: 401 }), "auth"],
    [new Error("Request timed out."), "timeout"],
    [new Error("Connection error."), "network"],
    [Object.assign(new Error("500 boom"), { status: 500 }), "api"],
  ];
  for (const [err, kind] of cases) {
    const { turn } = makeTurn([err]);
    const last = (await collect(turn)).at(-1)!;
    assert.equal(last.event, "error");
    assert.equal(last.data.kind, kind, String(err));
    assert.ok(!JSON.stringify(last.data).includes("boom") && !JSON.stringify(last.data).includes("nope"));
  }
});

test("a broken data tool is reported, not raised; async tools and ctx work", async () => {
  const reg = new Registry();
  reg.tool({ name: "boom", description: "fails" }, () => { throw new Error("db down"); });
  reg.tool({ name: "where", description: "page" }, async (_a, ctx) => `${ctx.manifest.page.path}:${String(ctx.extra.tenant)}`);
  const { turn, client } = makeTurn([reply(tool("boom"), tool("where")), reply(text("The records are unavailable."))], reg, { extra: { tenant: "acme" } });
  const ev = await collect(turn);
  assert.equal(ev.at(-1)!.event, "done");
  const [a, b] = lastContent(client, 1);
  assert.ok(a.is_error && a.content.includes("db down") && a.content.startsWith("The tool failed: Error: "));
  assert.ok(!b.is_error && b.content === "/:acme");
  assert.equal(ev.filter((e) => e.event === "status" && e.data.tool === "boom")[0].data.label, "checking the records");
});

test("registry: reserved and malformed names are rejected; big results are cut", async () => {
  const reg = new Registry();
  assert.throws(() => reg.tool({ name: "navigate", description: "x" }, () => 1), /built-in UI tool name/);
  assert.throws(() => reg.tool({ name: "bad name", description: "x" }, () => 1), /1-64 letters/);
  reg.tool({ name: "big", description: "x" }, () => ({ s: "é".repeat(20000) }));
  reg.tool({ name: "nothing", description: "x" }, () => undefined);
  const ctx = new Turn([{ role: "user", content: "x" }], cleanManifest({}), reg, new FakeClient([])).ctx;
  const [body, ok] = await reg.run("big", {}, ctx);
  assert.ok(ok && Array.from(body).length === 12000);
  assert.deepEqual(await reg.run("nothing", {}, ctx), ["null", true]);
  assert.deepEqual(reg.names(), ["big", "nothing"]);
  assert.deepEqual(reg.specs()[0].input_schema, { type: "object", properties: {} });
});

test("the prompt text and UI tool schemas are the reference ones", () => {
  assert.deepEqual(UI_TOOLS.map((t) => t.name), ["navigate", "scroll_to", "highlight", "click", "fill", "wait"]);
  assert.ok(ANSWER_SHAPE.startsWith("Answer shape, every time:") && ANSWER_SHAPE.endsWith("Write nothing before your tool calls are done."));
  assert.ok(TOUR_RULES.startsWith("You can drive this website while you talk.") && TOUR_RULES.endsWith("gets no UI calls."));
});

test("manifest cleaning, page patterns and the page map", () => {
  const m = cleanManifest({
    page: { path: "javascript:alert(1)" },
    targets: [{ id: "ok-1", desc: "x".repeat(500) }, { id: "bad id" }, { id: "ok-1" }],
    pages: [{ path: "/startups/:slug" }, { path: "//evil" }],
  });
  assert.equal(m.page.path, "/");
  assert.deepEqual(m.targets.map((t) => t.id), ["ok-1"]);
  assert.equal(m.targets[0].desc.length, 160);
  assert.deepEqual(m.pages.map((p) => p.path), ["/startups/:slug"]);
  assert.ok(matchPage("/startups/kelpforge?x=1", m.pages));
  assert.equal(matchPage("/startups/a/b", m.pages), null);
  assert.ok(matchPage("/startups/kelpforge/", m.pages));
  const pm = pageMap(cleanManifest(MANIFEST));
  assert.ok(pm.includes("[safe]") && pm.includes("[fillable: select, options Aquaculture | Energy]"));
  assert.ok(pm.startsWith("APP: Sample app. A test app.\nCURRENT PAGE: / (Home)\nTargets on the current page:\n- hero: The hero"));
  assert.ok(pm.includes("OTHER PAGES you can navigate to:\n* /matches (Matches)\n  - match-1: Top match"));
  assert.equal(cleanManifest("junk").page.path, "/");
});

test("messages are cleaned: whitespace, leading assistant turns, merged user turns, limits", () => {
  const s = settings();
  const out = cleanMessages([
    { role: "assistant", content: "stale" }, { role: "user", content: "  hello \n  there " },
    { role: "user", content: "again" }, { role: "assistant", content: "ok" }, { role: "user", content: "last   one" },
  ], s);
  assert.deepEqual(out, [{ role: "user", content: "hello there again" }, { role: "assistant", content: "ok" }, { role: "user", content: "last one" }]);
  assert.throws(() => cleanMessages([], s), /non-empty list/);
  assert.throws(() => cleanMessages([{ role: "system", content: "x" }], s), /needs a role/);
  assert.throws(() => cleanMessages([{ role: "assistant", content: "x" }], s), /last message must be from the user/);
  assert.throws(() => cleanMessages([{ role: "user", content: "x".repeat(601) }], s), /at most 600 characters/);
});

test("settings: defaults, overrides, and invalid numbers fall back", () => {
  let s = settings();
  assert.deepEqual([s.assistantName, s.model, s.effort, s.thinking, s.fallbacks], ["Aava", "claude-sonnet-5-5", "low", "adaptive", "default"]);
  assert.deepEqual([s.maxSteps, s.maxActions, s.ratePerMin, s.dailyTurns, s.ttsDailyChars], [5, 8, 12, 400, 20000]);
  process.env.PILOT_MAX_STEPS = "3";
  process.env.PILOT_RATE_PER_MIN = "abc";
  process.env.PILOT_ASSISTANT_NAME = "  Mira ";
  process.env.PILOT_REHEARSAL = "on";
  s = settings();
  assert.deepEqual([s.maxSteps, s.ratePerMin, s.assistantName, s.rehearsal], [3, 12, "Mira", true]);
});

// ---- the HTTP surface -----------------------------------------------------------------------------------------------------------------------
const post = (path: string, body: unknown, headers: Record<string, string> = {}): Request =>
  new Request("http://localhost" + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

function parseSse(body: string): [string, Any][] {
  return body.trim().split("\n\n").map((block) => {
    const lines = Object.fromEntries(block.split("\n").map((l) => [l.slice(0, l.indexOf(": ")), l.slice(l.indexOf(": ") + 2)]));
    return [lines.event, JSON.parse(lines.data)] as [string, Any];
  });
}

const CHAT = { messages: [{ role: "user", content: "hi" }], manifest: MANIFEST };

test("status says what is switched on, without leaking anything", async () => {
  const pilot = createPilot({ registry: new Registry(), appName: "Test app", log: silent });
  const res = await pilot.status(new Request("http://localhost/pilot/status"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { name: "Aava", mode: "off", llm: false, model: null, tts: false, tts_chars_left: 0 });

  process.env.ANTHROPIC_API_KEY = "test-not-a-key-anthropic";
  process.env.ELEVENLABS_API_KEY = "test-not-a-key-voice";
  process.env.ELEVENLABS_VOICE_ID = "voice123";
  const raw = await (await pilot.status(new Request("http://localhost/pilot/status"))).text();
  assert.deepEqual(JSON.parse(raw), { name: "Aava", mode: "live", llm: true, model: "claude-sonnet-5-5", tts: true, tts_chars_left: 20000 });
  assert.ok(!raw.includes("test-not-a-key") && !raw.includes("voice123"));
});

test("chat without a key says so as an SSE error; bad bodies are 400", async () => {
  const pilot = createPilot({ registry: new Registry(), log: silent });
  const res = await pilot.chat(post("/pilot/chat", CHAT));
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")!.startsWith("text/event-stream"));
  const ev = parseSse(await res.text());
  assert.equal(ev[0][0], "error");
  assert.equal(ev[0][1].kind, "no_key");
  assert.equal((await pilot.chat(post("/pilot/chat", { messages: [] }))).status, 400);
  assert.equal((await pilot.chat(post("/pilot/chat", "not json"))).status, 400);
  assert.equal((await pilot.chat(post("/pilot/chat", [1, 2]))).status, 400);
  const r = await pilot.chat(post("/pilot/chat", { messages: [{ role: "user", content: "x".repeat(700) }] }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /at most 600 characters/);
});

test("chat() returns an SSE Response whose body parses to the expected events; the app name fills an empty manifest", async () => {
  const client = new FakeClient([reply(tool("highlight", { target: "hero", caption: "Hello" })), reply(text("[[1]] Hello there."))]);
  const pilot = createPilot({ registry: new Registry(), appName: "Test app", appDescription: "It tests.", clientFactory: () => client, log: silent });
  const res = await pilot.chat(post("/pilot/chat", { ...CHAT, manifest: { ...MANIFEST, app: {} } }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  const raw = await res.text();
  assert.ok(raw.startsWith('event: status\ndata: {"label":"thinking"}\n\n'));
  const ev = parseSse(raw);
  assert.deepEqual(ev.map(([k]) => k), ["status", "status", "action", "delta", "done"]);
  assert.deepEqual(ev[1][1], { label: "getting it ready to show", tool: "highlight" });
  assert.deepEqual(ev[2][1], { type: "highlight", caption: "Hello", target: "hero", id: 1 });
  assert.deepEqual(ev.filter(([k]) => k === "delta").map(([, d]) => d.text).join(""), "[[1]] Hello there.");
  const done = ev.at(-1)![1];
  assert.equal(done.text, "[[1]] Hello there.");
  assert.equal(done.steps, 2);
  assert.deepEqual(done.actions, [ev[2][1]]);
  assert.ok(typeof done.ms === "number" && done.model === "claude-sonnet-5-5");
  assert.ok(client.calls[0].system[0].text.includes("inside Test app.\n\nIt tests."));
});

test("chat passes the page's action reports and the request to the host's extra()", async () => {
  const client = new FakeClient([reply(text("Noted."))]);
  let tenant = "";
  const reg = new Registry();
  const pilot = createPilot({ registry: reg, clientFactory: () => client, extra: (req) => ({ tenant: req.headers.get("x-tenant") }), log: silent });
  reg.tool({ name: "who", description: "x" }, (_a, ctx) => { tenant = String(ctx.extra.tenant); return "ok"; });
  const body = { ...CHAT, reports: [{ type: "fill", target: "sector", ok: false, why: "no such option" }] };
  const raw = await (await pilot.chat(post("/pilot/chat", body, { "x-tenant": "acme" }))).text();
  assert.equal(parseSse(raw).at(-1)![0], "done");
  assert.ok(String(client.calls[0].messages.at(-1).content).includes("did not run: fill sector (no such option)"));
  assert.equal(client.calls[0].tools.at(-1).name, "who");
  assert.equal(tenant, "");                                                     // the tool was offered, not called
});

test("cancelling the response, or aborting the request, aborts the model call", async () => {
  for (const how of ["cancel", "abort"]) {
    const client = new FakeClient(() => reply(text("A long answer that nobody will hear in full because the listener left.")));
    const pilot = createPilot({ registry: new Registry(), clientFactory: () => client, log: silent });
    const ac = new AbortController();
    const req = new Request("http://localhost/pilot/chat", { method: "POST", signal: ac.signal, body: JSON.stringify(CHAT), headers: { "Content-Type": "application/json" } });
    const res = await pilot.chat(req);
    const reader = res.body!.getReader();
    await reader.read();                                                          // status: thinking
    await reader.read();                                                          // the first words: the model call is under way
    const signal: AbortSignal = client.callOptions[0].signal;
    assert.equal(signal.aborted, false);
    if (how === "cancel") await reader.cancel();
    else ac.abort();
    assert.equal(signal.aborted, true, how);
  }
});

test("chat rate-limits per IP and by the daily cap", async () => {
  process.env.PILOT_RATE_PER_MIN = "2";
  const pilot = createPilot({ registry: new Registry(), clientFactory: () => new FakeClient(() => reply(text("Hello."))), log: silent });
  const ask = (ip: string) => pilot.chat(post("/pilot/chat", CHAT, { "x-forwarded-for": `${ip}, 10.0.0.1` }));
  assert.equal((await ask("1.1.1.1")).status, 200);
  assert.equal((await ask("1.1.1.1")).status, 200);
  const r3 = await ask("1.1.1.1");
  assert.equal(r3.status, 429);
  assert.equal(r3.headers.get("retry-after"), "30");
  assert.equal(parseSse(await r3.text())[0][1].kind, "rate");
  assert.equal((await ask("2.2.2.2")).status, 200);                             // another IP has its own minute
  const viaCf = await pilot.chat(post("/pilot/chat", CHAT, { "cf-connecting-ip": "3.3.3.3", "x-forwarded-for": "1.1.1.1" }));
  assert.equal(viaCf.status, 200);                                              // cf-connecting-ip wins over x-forwarded-for

  process.env.PILOT_DAILY_TURNS = "1";
  pilot.state.limiter.reset();
  assert.equal((await ask("4.4.4.4")).status, 200);
  const capped = await ask("5.5.5.5");
  assert.equal(capped.status, 429);
  assert.equal(capped.headers.get("retry-after"), "3600");
  assert.equal(parseSse(await capped.text())[0][1].kind, "cap");
});

test("limiter: per-minute window slides, tts charges and refunds", () => {
  const l = new Limiter();
  assert.equal(l.check("a", 2, 100, 0), null);
  assert.equal(l.check("a", 2, 100, 10), null);
  assert.equal(l.check("a", 2, 100, 20), "rate");
  assert.equal(l.check("a", 2, 100, 61), null);                                  // the first hit left the window
  assert.equal(l.chargeTts(30, 40), true);
  assert.equal(l.chargeTts(11, 40), false);
  assert.equal(l.ttsLeft(40), 10);
  l.refundTts(30);
  l.refundTts(30);                                                               // never below zero
  assert.equal(l.ttsLeft(40), 40);
});

test("a failing model client is a clean SSE error, not a 500", async () => {
  const pilot = createPilot({ registry: new Registry(), clientFactory: () => { throw new Error("no sdk"); }, log: silent });
  const ev = parseSse(await (await pilot.chat(post("/pilot/chat", CHAT))).text());
  assert.deepEqual(ev, [["error", { kind: "api", message: "Aava's reasoning is not available right now." }]]);
});

test("rehearsal mode runs the real loop with a scripted plan and is labelled as rehearsal", async () => {
  process.env.PILOT_REHEARSAL = "1";
  const plan: Plan = () => [
    { say: "The best match is Kelpforge.", do: [["navigate", { path: "/matches" }], ["highlight", { target: "match-1" }]] },
    { say: "Next step: call them.", do: [["highlight", { target: "nope" }]] },
  ];
  const pilot = createPilot({ registry: new Registry(), rehearsalClient: (q, m) => rehearsalClient(plan, q, m), log: silent });
  assert.equal((await (await pilot.status(new Request("http://localhost/pilot/status"))).json()).mode, "rehearsal");
  const ev = parseSse(await (await pilot.chat(post("/pilot/chat", CHAT))).text());
  const done = ev.at(-1)![1];
  assert.deepEqual(done.actions.map((a: Any) => a.type), ["navigate", "highlight"]);
  assert.equal(done.text, "[[1]] [[2]] The best match is Kelpforge. Next step: call them.");
});

// ---- TTS ------------------------------------------------------------------------------------------------------------------------------------
function fakeUpstream(calls: string[], status = 200, closes: string[] = []): Upstream {
  return async (t) => {
    calls.push(t);
    async function* chunks() {
      yield new TextEncoder().encode("ID3fake-");
      yield new TextEncoder().encode(t);
    }
    return { status, chunks: chunks(), close: async () => { closes.push(t); } };
  };
}

const ttsReq = (body: unknown) => post("/pilot/tts", body);
const statusOf = async (pilot: ReturnType<typeof createPilot>) => (await (await pilot.status(new Request("http://localhost/pilot/status"))).json()) as Any;

function voiceEnv(cap = "40") {
  process.env.ELEVENLABS_API_KEY = "test-not-a-key";
  process.env.ELEVENLABS_VOICE_ID = "voice123";
  process.env.PILOT_TTS_DAILY_CHARS = cap;
}

test("tts streams, caches identical spoken text, enforces the daily cap and refunds a failed upstream", async () => {
  voiceEnv("40");
  const calls: string[] = [];
  const closes: string[] = [];
  const pilot = createPilot({ registry: new Registry(), ttsUpstream: fakeUpstream(calls, 200, closes), log: silent });

  const r = await pilot.tts(ttsReq({ text: "[[1]] Hello **there**, friend." }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/mpeg");
  assert.equal(r.headers.get("x-pilot-cache"), "miss");
  assert.equal(r.headers.get("cache-control"), "no-store");
  const first = Buffer.from(await r.arrayBuffer());
  assert.deepEqual(calls, ["Hello there, friend."]);
  assert.equal(first.toString(), "ID3fake-Hello there, friend.");
  assert.deepEqual(closes, ["Hello there, friend."]);

  const r2 = await pilot.tts(ttsReq({ text: "Hello there, friend." }));            // same spoken text: from the cache, no new characters
  assert.equal(r2.headers.get("x-pilot-cache"), "hit");
  assert.equal(r2.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(Buffer.from(await r2.arrayBuffer()), first);
  assert.equal(calls.length, 1);
  assert.equal((await statusOf(pilot)).tts_chars_left, 40 - 20);

  const r3 = await pilot.tts(ttsReq({ text: "This sentence is far too long for what is left of the cap." }));
  assert.equal(r3.status, 429);
  assert.match((await r3.json()).error, /daily limit/);
  assert.equal(calls.length, 1);

  pilot.state.voice.upstream = fakeUpstream(calls, 401, closes);
  const r4 = await pilot.tts(ttsReq({ text: "Short one." }));
  assert.equal(r4.status, 502);
  assert.match((await r4.json()).error, /answered 401/);
  assert.equal((await statusOf(pilot)).tts_chars_left, 20);                        // refunded
  assert.equal(closes.at(-1), "Short one.");                                       // and the failed upstream was closed
});

test("tts without a key or voice is 404, without text 400, and cue-only text is 400 too", async () => {
  const pilot = createPilot({ registry: new Registry(), ttsUpstream: fakeUpstream([]), log: silent });
  assert.equal((await pilot.tts(ttsReq({ text: "Hello" }))).status, 404);
  assert.equal((await pilot.tts(ttsReq({ nope: 1 }))).status, 400);
  assert.equal((await pilot.tts(post("/pilot/tts", "not json"))).status, 400);
  process.env.ELEVENLABS_API_KEY = "test-not-a-key";
  assert.equal((await pilot.tts(ttsReq({ text: "Hello" }))).status, 404);          // key but no voice id
  process.env.ELEVENLABS_VOICE_ID = "voice123";
  assert.equal((await pilot.tts(ttsReq({ text: "[[1]] [[2]]  " }))).status, 400);
  assert.equal((await pilot.tts(ttsReq({ text: 42 }))).status, 400);
  assert.equal((await pilot.tts(ttsReq({ text: "Hello" }))).status, 200);
});

test("tts: an upstream that is cancelled halfway is not cached and is closed; a long text is cut to the max", async () => {
  voiceEnv("1000");
  process.env.PILOT_TTS_MAX_CHARS = "12";
  const calls: string[] = [];
  const closes: string[] = [];
  const pilot = createPilot({ registry: new Registry(), ttsUpstream: fakeUpstream(calls, 200, closes), log: silent });
  const r = await pilot.tts(ttsReq({ text: "Hello there my friend, how are you?" }));
  assert.equal(calls[0], "Hello there ");                                          // cut to 12 characters
  const reader = r.body!.getReader();
  await reader.read();                                                              // one chunk, then the listener goes away
  await reader.cancel();
  assert.equal(pilot.state.voice.cache.size, 0);
  assert.equal(closes.length, 1);
  const again = await pilot.tts(ttsReq({ text: "Hello there my friend, how are you?" }));
  assert.equal(again.headers.get("x-pilot-cache"), "miss");
  await again.arrayBuffer();
  assert.equal(pilot.state.voice.cache.size, 1);
});

test("tts cache keeps only the most recent entries", async () => {
  voiceEnv("1000");
  process.env.PILOT_TTS_CACHE_ITEMS = "2";
  const calls: string[] = [];
  const pilot = createPilot({ registry: new Registry(), ttsUpstream: fakeUpstream(calls), log: silent });
  for (const t of ["one", "two", "three"]) await (await pilot.tts(ttsReq({ text: t }))).arrayBuffer();
  assert.equal(pilot.state.voice.cache.size, 2);
  const miss = await pilot.tts(ttsReq({ text: "one" }));                              // evicted: spoken again
  assert.equal(miss.headers.get("x-pilot-cache"), "miss");
  await miss.arrayBuffer();
  assert.deepEqual(calls, ["one", "two", "three", "one"]);
});

test("spoken(): cue markers, markdown, links and urls come off", () => {
  assert.equal(spoken("[[1]] Hello **there**, `friend`!"), "Hello there, friend!");
  assert.equal(spoken("[2] See [the docs](https://x.example/a?b=1) at https://example.com/path now."), "See the docs at now.");
  assert.equal(spoken("# Title\n> quote_with_underscores\n\n  spaced   out "), "Title quotewithunderscores spaced out");
  assert.equal(spoken(""), "");
  assert.equal(spoken("[[12]]Ok"), "Ok");
});

// ---- the real SDK client against a fake fetch (skipped when node_modules is absent): proves the request shape and the stream surface -------------
let Anthropic: any;
try {
  Anthropic = (await import("@anthropic-ai/sdk")).default;
} catch {
  Anthropic = undefined;
}

function sseBody(events: [string, Any][]): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`).join("");
}

const HELLO = sseBody([
  ["message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ["content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "highlight", input: {} } }],
  ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"target":"hero","caption":"Hi"}' } }],
  ["content_block_stop", { index: 0 }],
  ["message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }],
  ["message_stop", {}],
]);
const ANSWER = sseBody([
  ["message_start", { message: { id: "msg_2", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } }],
  ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "[[1]] Hello " } }],
  ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "there." } }],
  ["content_block_stop", { index: 0 }],
  ["message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } }],
  ["message_stop", {}],
]);

test("the real Anthropic SDK client: request body and headers, event stream, a 400 retried without the extras", { skip: Anthropic === undefined && "@anthropic-ai/sdk is not installed" }, async () => {
  const seen: { body: Any; headers: Headers }[] = [];
  const replies = [
    () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "thinking.type: adaptive is not supported on this model" } }), { status: 400, headers: { "content-type": "application/json" } }),
    () => new Response(HELLO, { headers: { "content-type": "text/event-stream" } }),
    () => new Response(ANSWER, { headers: { "content-type": "text/event-stream" } }),
  ];
  const fakeFetch = async (_url: unknown, init: RequestInit) => {
    seen.push({ body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    return replies.shift()!();
  };
  const client = new Anthropic({ apiKey: "test-not-a-key", fetch: fakeFetch, maxRetries: 0 });
  const turn = new Turn([{ role: "user", content: "hi" }], cleanManifest(MANIFEST), new Registry(), client, settings(), { log: silent });
  const ev = await collect(turn);

  assert.deepEqual(ev.map((e) => e.event), ["status", "status", "action", "delta", "delta", "done"]);
  assert.deepEqual(ev[2].data, { type: "highlight", caption: "Hi", target: "hero", id: 1 });
  assert.equal(ev.at(-1)!.data.text, "[[1]] Hello there.");
  assert.equal(ev.at(-1)!.data.steps, 2);
  assert.equal(ev.at(-1)!.data.usage.input_tokens, 30);
  // call 1: all the extras; call 2 (the retry after the 400) and call 3: none
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[0].body.thinking, { type: "adaptive" });
  assert.deepEqual(seen[0].body.output_config, { effort: "low" });
  assert.equal(seen[0].body.fallbacks, "default");
  assert.equal(seen[0].body.stream, true);
  assert.equal(seen[0].headers.get("anthropic-beta"), "server-side-fallback-2026-07-01");
  assert.equal(seen[0].body.model, "claude-sonnet-5-5");
  assert.equal(seen[0].body.tools.length, 6);
  for (const i of [1, 2]) {
    for (const k of ["thinking", "output_config", "fallbacks"]) assert.ok(!(k in seen[i].body), `${k} in call ${i}`);
    assert.equal(seen[i].headers.get("anthropic-beta"), null);
  }
  // the assistant turn went back as the SDK parsed it, with the tool result for the cue
  const sent = seen[2].body.messages;
  assert.equal(sent[1].role, "assistant");
  assert.equal(sent[1].content[0].type, "tool_use");
  assert.deepEqual(sent[1].content[0].input, { target: "hero", caption: "Hi" });
  assert.equal(sent[2].content[0].tool_use_id, "toolu_1");
  assert.ok(sent[2].content[0].content.startsWith("Queued as cue [[1]]."));
});
