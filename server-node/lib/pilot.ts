// voice-pilot, Node/Next.js port of the Python reference server (server/*.py). One file, no runtime dependencies of its own:
// the Anthropic SDK is imported lazily and only when no clientFactory is given, so the tests run without node_modules.
//
//   POST /pilot/chat    {messages, manifest, reports?} -> text/event-stream: status, delta, action, error, done
//   POST /pilot/tts     {text} -> audio/mpeg (ElevenLabs), or 404/400/429/502 JSON so the browser falls back to its own voice
//   GET  /pilot/status  {name, mode, llm, model, tts, tts_chars_left}   booleans and names only, never a key
//
// The handlers use only Web-standard Request / Response / ReadableStream, so they work as Next.js route handlers and in plain Node 22.
// Keys are only ever read from process.env at request time and are never returned, logged or echoed. Use erasable TypeScript only (this file is
// run directly by `node --test`, which strips types).

type Any = Record<string, any>;

// ===================================================================================================================================
// settings (server/config.py): read from the environment on every call, so tests can change it and a restart picks up a new env file
// ===================================================================================================================================
export interface Settings {
  assistantName: string;
  model: string;
  effort: string;
  thinking: string;      // "adaptive" (default) or "between_tools" (Sonnet 5.5 only: no extended thinking, lowest latency)
  fallbacks: string;     // "default" sends the server-side refusal fallback (Claude API); "off" sends nothing
  maxTokens: number;
  maxSteps: number;
  timeoutS: number;
  turnDeadlineS: number;
  ratePerMin: number;
  dailyTurns: number;
  maxActions: number;
  inputChars: number;
  historyTurns: number;
  rehearsal: boolean;
  ttsVoiceId: string;
  ttsModel: string;
  ttsFormat: string;
  ttsDailyChars: number;
  ttsMaxChars: number;
  ttsCacheItems: number;
  ttsRatePerMin: number;
}

function envStr(name: string, def: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? def : raw.trim();
}

function envInt(name: string, def: number): number {
  const raw = (process.env[name] ?? "").trim();
  return /^[+-]?\d+$/.test(raw) ? parseInt(raw, 10) : def;
}

function envNum(name: string, def: number): number {
  const raw = (process.env[name] ?? "").trim();
  const n = raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? n : def;
}

export function settings(): Settings {
  return {
    assistantName: envStr("PILOT_ASSISTANT_NAME", "Aava"),
    model: envStr("PILOT_MODEL", "claude-sonnet-5-5"),
    effort: envStr("PILOT_EFFORT", "low"),
    thinking: envStr("PILOT_THINKING", "adaptive"),
    fallbacks: envStr("PILOT_FALLBACKS", "default"),
    maxTokens: envInt("PILOT_MAX_TOKENS", 4096),
    maxSteps: envInt("PILOT_MAX_STEPS", 5),
    timeoutS: envNum("PILOT_TIMEOUT_S", 30),
    turnDeadlineS: envNum("PILOT_TURN_DEADLINE_S", 45),
    ratePerMin: envInt("PILOT_RATE_PER_MIN", 12),
    dailyTurns: envInt("PILOT_DAILY_TURNS", 400),
    maxActions: envInt("PILOT_MAX_ACTIONS", 8),
    inputChars: envInt("PILOT_INPUT_CHARS", 600),
    historyTurns: envInt("PILOT_HISTORY_TURNS", 10),
    rehearsal: ["1", "true", "yes", "on"].includes(envStr("PILOT_REHEARSAL", "0")),
    ttsVoiceId: envStr("ELEVENLABS_VOICE_ID", ""),
    ttsModel: envStr("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2"),
    ttsFormat: envStr("ELEVENLABS_OUTPUT_FORMAT", "mp3_44100_128"),
    ttsDailyChars: envInt("PILOT_TTS_DAILY_CHARS", 20000),
    ttsMaxChars: envInt("PILOT_TTS_MAX_CHARS", 600),
    ttsCacheItems: envInt("PILOT_TTS_CACHE_ITEMS", 200),
    ttsRatePerMin: envInt("PILOT_TTS_RATE_PER_MIN", 40),
  };
}

export function anthropicKeyPresent(): boolean {
  return (process.env.ANTHROPIC_API_KEY ?? "").trim() !== "";
}

export function elevenlabsKey(): string {
  return (process.env.ELEVENLABS_API_KEY ?? "").trim();
}

export type Logger = (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
const consoleLog: Logger = (level, message, data) => {
  const line = `[voice-pilot] ${message}`;
  if (data === undefined) console[level](line);
  else console[level](line, data);
};

// ===================================================================================================================================
// small text helpers (Python slices by code point, so these do too)
// ===================================================================================================================================
function clip(s: string, n: number): string {
  return s.length <= n ? s : Array.from(s).slice(0, n).join("");
}

function squash(v: unknown, n: number): string {       // " ".join(str(v or "").split())[:n]
  const str = v ? String(v) : "";
  return clip(str.split(/\s+/).filter(Boolean).join(" "), n);
}

function pyRepr(s: string): string {                   // the quotes Python's !r puts around a string, so the messages read the same
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  if (q === "'") out = out.replace(/'/g, "\\'");
  return q + out + q;
}

const isObj = (v: unknown): v is Any => typeof v === "object" && v !== null && !Array.isArray(v);
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const errName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);
const errStatus = (e: unknown): number | undefined => (isObj(e) && typeof e.status === "number" ? e.status : undefined);

// ===================================================================================================================================
// the UI tools (server/registry.py): validated against the page manifest, executed by the browser (client/pilot.js)
// ===================================================================================================================================
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const PATH_RE = /^\/(?!\/)[A-Za-z0-9._~%!$&'()*+,;=:@\/?#-]{0,300}$/;

/** A path on this site, and only this site: no '//' or backslash in the path part (even percent-encoded), no '.' or '..' segments,
 *  because a browser resolves '/.//evil.example/x' to the protocol-relative '//evil.example/x'. Mirrors server/registry.py safe_path. */
export function safePath(path: unknown): path is string {
  if (typeof path !== "string" || !PATH_RE.test(path) || path.includes("\\")) return false;
  let bare = path.split("#")[0].split("?")[0];
  try { bare = decodeURIComponent(bare); } catch { return false; }
  if (bare.includes("//") || bare.includes("\\")) return false;
  return !bare.split("/").some((seg) => seg === "." || seg === "..");
}
const MAX_TARGETS = 80;
const MAX_PAGES = 24;

const T = { type: "string", description: "A target id from the PAGE MAP (never a CSS selector)." };
export const UI_TOOLS: Any[] = [
  {
    name: "navigate",
    description: "Open another page of this site. The conversation and your voice continue. `path` is a page path from the PAGE MAP; " +
      "replace :params with values you saw in links (for example /startups/kelpforge).",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "scroll_to", description: "Scroll a target into view.",
    input_schema: { type: "object", properties: { target: T }, required: ["target"], additionalProperties: false },
  },
  {
    name: "highlight",
    description: "Dim the page and spotlight one target with a short caption (at most 8 words). Use it on the thing your sentence is about.",
    input_schema: { type: "object", properties: { target: T, caption: { type: "string" } }, required: ["target"], additionalProperties: false },
  },
  {
    name: "click",
    description: "Press a target marked [safe] in the PAGE MAP (a filter chip, a tab, show more). Nothing else can be clicked.",
    input_schema: { type: "object", properties: { target: T }, required: ["target"], additionalProperties: false },
  },
  {
    name: "fill",
    description: "Set the value of a target marked [fillable] (an input or a select, such as a filter). For a select, use one of its options.",
    input_schema: { type: "object", properties: { target: T, value: { type: "string" } }, required: ["target", "value"], additionalProperties: false },
  },
  {
    name: "wait", description: "Pause the tour before the next action, 100 to 3000 ms.",
    input_schema: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"], additionalProperties: false },
  },
];
export const UI_TOOL_NAMES = new Set(UI_TOOLS.map((t) => t.name as string));
export const UI_LABELS: Record<string, string> = {
  navigate: "opening the page", scroll_to: "finding it on the page", highlight: "getting it ready to show",
  click: "setting it up", fill: "setting the filters", wait: "setting it up",
};

// ---- the manifest the page sends each turn ------------------------------------------------------------------------------------------
export interface FillSpec { kind: string; options: string[]; value?: string }
export interface Target { id: string; desc: string; text: string; href?: string; safe?: true; fill?: FillSpec }
export interface PageSpec { path: string; title: string; desc: string; targets: Target[] }
export interface Manifest {
  app: { name: string; description: string };
  page: { path: string; title: string };
  targets: Target[];
  pages: PageSpec[];
}
export interface Action {
  type: string; path?: string; ms?: number; value?: string; caption?: string; target?: string; unverified?: true; id: number;
}

function cleanTarget(t: unknown): Target | null {
  if (!isObj(t) || typeof t.id !== "string" || !ID_RE.test(t.id)) return null;
  const out: Target = { id: t.id, desc: squash(t.desc, 160), text: squash(t.text, 220) };
  if (safePath(t.href)) out.href = t.href.slice(0, 200);
  if (t.safe === true) out.safe = true;
  const f = t.fill;
  if (isObj(f)) {
    const opts: unknown[] = Array.isArray(f.options) ? f.options.slice(0, 30) : [];
    out.fill = {
      kind: squash(f.kind, 20) || "text",
      options: opts.filter((o) => typeof o === "string" || typeof o === "number").map((o) => squash(o, 60)),
    };
    if (f.value !== undefined && f.value !== null) out.fill.value = squash(f.value, 60);
  }
  return out;
}

function cleanTargets(ts: unknown): Target[] {
  const seen = new Set<string>();
  const out: Target[] = [];
  for (const t of (Array.isArray(ts) ? ts : []).slice(0, MAX_TARGETS)) {
    const c = cleanTarget(t);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

/** What the browser sent, trimmed to known fields and sizes. Never trusted beyond being a description of the page. */
export function cleanManifest(raw: unknown): Manifest {
  const r: Any = isObj(raw) ? raw : {};
  const app: Any = isObj(r.app) ? r.app : {};
  const page: Any = isObj(r.page) ? r.page : {};
  const path = safePath(page.path) ? page.path : "/";
  const pages: PageSpec[] = [];
  for (const p of (Array.isArray(r.pages) ? r.pages : []).slice(0, MAX_PAGES)) {
    if (isObj(p) && safePath(p.path)) {
      pages.push({ path: p.path.slice(0, 200), title: squash(p.title, 80), desc: squash(p.desc, 200), targets: cleanTargets(p.targets) });
    }
  }
  return {
    app: { name: squash(app.name, 80), description: squash(app.description, 400) },
    page: { path, title: squash(page.title, 120) },
    targets: cleanTargets(r.targets),
    pages,
  };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");

function pagePattern(path: string): RegExp {
  const parts = path.split("/").map((seg) => (seg.startsWith(":") || (seg.startsWith("{") && seg.endsWith("}")) ? "[^/]+" : escapeRe(seg)));
  return new RegExp("^" + parts.join("/") + "/?$");
}

export function matchPage(path: string, pages: PageSpec[]): PageSpec | null {
  const bare = path.split("?")[0].split("#")[0] || "/";
  for (const p of pages) if (p.path === bare) return p;                    // an exact page first, then a :param pattern
  for (const p of pages) if ((p.path.includes(":") || p.path.includes("{")) && pagePattern(p.path).test(bare)) return p;
  return null;
}

/** The manifest as the model reads it (the dynamic part of the system prompt). */
export function pageMap(m: Manifest): string {
  const line = (t: Target): string => {
    const bits = [`- ${t.id}: ${t.desc || "element"}`];
    if (t.text) bits.push(`shows "${t.text}"`);
    if (t.href) bits.push(`links to ${t.href}`);
    if (t.safe) bits.push("[safe]");
    if (t.fill) {
      const f = t.fill;
      bits.push("[fillable" + (f.options.length ? `: ${f.kind}, options ` + f.options.join(" | ") : `: ${f.kind}`) + "]");
      if (f.value) bits.push(`now ${pyRepr(f.value)}`);
    }
    return bits.join("; ");
  };
  const out: string[] = [];
  if (m.app.name) out.push(`APP: ${m.app.name}. ${m.app.description}`.trim());
  out.push(`CURRENT PAGE: ${m.page.path} (${m.page.title || "untitled"})`);
  out.push(m.targets.length ? "Targets on the current page:" : "Targets on the current page: none declared.");
  out.push(...m.targets.map(line));
  const others = m.pages.filter((p) => p.path !== m.page.path);
  if (others.length) {
    out.push("OTHER PAGES you can navigate to:");
    for (const p of others) {
      out.push(`* ${p.path} (${p.title || "page"})${p.desc ? ": " + p.desc : ""}`);
      out.push(...p.targets.map((t) => "  " + line(t)));
    }
  }
  return out.join("\n");
}

// ---- one turn's view of the page: which page the tour is on, which targets exist there ----------------------------------------------
export class TurnContext {
  manifest: Manifest;
  extra: Record<string, unknown>;     // anything the host's `extra(req)` returns (user, tenant); data tools read it
  path: string;
  actions: Action[] = [];

  constructor(manifest: Manifest, extra: Record<string, unknown> = {}) {
    this.manifest = manifest;
    this.extra = extra;
    this.path = manifest.page.path;
  }

  /** The targets the tour can use where it is now: the live page's, or after a navigate the declared page's. null when unknown. */
  private targetsHere(): Target[] | null {
    if (this.path === this.manifest.page.path) return this.manifest.targets;
    const p = matchPage(this.path, this.manifest.pages);
    return p && p.targets.length ? p.targets : null;
  }

  /** { act } when the UI call is valid (recorded with the next cue number), else { act: null, why }. */
  check(name: string, rawArgs: unknown, maxActions: number): { act: Action | null; why: string } {
    const args: Any = isObj(rawArgs) ? rawArgs : {};
    const no = (why: string) => ({ act: null, why });
    if (this.actions.length >= maxActions) return no(`At most ${maxActions} UI actions per answer. Write the answer now.`);
    const act: Any = { type: name };
    if (name === "navigate") {
      const path = args.path;
      if (!safePath(path)) return no("path must be a plain site path that starts with / (no other site, no // or .. segments).");
      const pages = this.manifest.pages;
      if (pages.length && !matchPage(path, pages) && path.split("?")[0] !== this.manifest.page.path) {
        return no("Unknown page. Pages: " + pages.map((p) => p.path).join(", "));
      }
      act.path = path;
      this.path = path.split("#")[0];
    } else if (name === "wait") {
      const raw = "ms" in args ? args.ms : 600;
      let n = NaN;
      if (typeof raw === "number") n = Math.trunc(raw);
      else if (typeof raw === "string" && /^\s*[+-]?\d+\s*$/.test(raw)) n = parseInt(raw, 10);
      if (!Number.isFinite(n)) return no("ms must be a number of milliseconds.");
      act.ms = Math.max(100, Math.min(3000, n));
    } else {
      const tid = args.target;
      if (typeof tid !== "string" || !ID_RE.test(tid)) return no("target must be a target id from the PAGE MAP.");
      const here = this.targetsHere();
      const t = here !== null ? here.find((x) => x.id === tid) : undefined;
      if (here !== null && t === undefined) {
        const names = here.slice(0, 40).map((x) => x.id).join(", ") || "none";
        return no(`Unknown target ${pyRepr(tid)} on ${this.path}. Targets there: ${names}.`);
      }
      if (name === "click" && t !== undefined && !t.safe) return no(`${pyRepr(tid)} is not marked safe to click. Use highlight or scroll_to instead.`);
      if (name === "fill") {
        if (t !== undefined && !t.fill) return no(`${pyRepr(tid)} is not fillable.`);
        let value = squash(args.value, 120);
        const opts = t?.fill?.options ?? [];
        if (opts.length && !opts.includes(value)) {
          const low = new Map(opts.map((o) => [o.toLowerCase(), o]));
          const hit = low.get(value.toLowerCase());
          if (hit === undefined) return no(`${pyRepr(value)} is not an option of ${pyRepr(tid)}. Options: ` + opts.join(" | "));
          value = hit;
        }
        act.value = value;
      }
      if (name === "highlight") act.caption = squash(args.caption, 80);
      act.target = tid;
      if (here === null) act.unverified = true;               // a page the manifest did not describe: the browser checks it
    }
    act.id = this.actions.length + 1;
    this.actions.push(act as Action);
    return { act: act as Action, why: "" };
  }
}

// ===================================================================================================================================
// the host app's data tools
// ===================================================================================================================================
export interface ToolSpec {
  name: string;
  description: string;
  schema?: Record<string, unknown>;     // JSON schema of the arguments; default: no arguments
  label?: string;                        // shown in the overlay while it runs ("checking the records")
}
export type ToolFn = (args: Any, ctx: TurnContext) => unknown | Promise<unknown>;

/**
 * The host app registers read-only data tools here:
 *
 *     const registry = new Registry();
 *     registry.tool({ name: "list_matches", description: "Ranked matches, best first.", schema: {...}, label: "reading the list" },
 *                   async (args, ctx) => ({ matches: [...] }));   // a string, or anything JSON.stringify can write
 */
export class Registry {
  #tools = new Map<string, { spec: ToolSpec; fn: ToolFn }>();

  tool(spec: ToolSpec, fn: ToolFn): this {
    if (UI_TOOL_NAMES.has(spec.name)) throw new Error(`${spec.name} is a built-in UI tool name`);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(spec.name)) throw new Error("tool names are 1-64 letters, digits, _ or -");
    this.#tools.set(spec.name, { spec, fn });
    return this;
  }

  names(): string[] { return [...this.#tools.keys()]; }

  has(name: string): boolean { return this.#tools.has(name); }

  label(name: string): string { return this.#tools.get(name)?.spec.label || "checking the records"; }

  specs(): Any[] {
    return [...this.#tools.values()].map(({ spec }) => ({
      name: spec.name, description: spec.description, input_schema: spec.schema ?? { type: "object", properties: {} },
    }));
  }

  /** [body, ok]. A broken tool is reported to the model, never crashes the turn. */
  async run(name: string, args: Any, ctx: TurnContext): Promise<[string, boolean]> {
    const t = this.#tools.get(name);
    if (!t) return [`There is no tool called ${name}.`, false];
    try {
      const out = await t.fn(args ?? {}, ctx);
      const body = typeof out === "string" ? out : (JSON.stringify(out ?? null) ?? "null");
      return [clip(body, 12000), true];
    } catch (e) {
      return [`The tool failed: ${errName(e)}: ${clip(errMessage(e), 200)}`, false];
    }
  }
}

// ===================================================================================================================================
// one voice turn (server/turn.py): a short tool loop over the Anthropic Messages API, as an async generator of events
//
//   status {label, tool?}   delta {text, step}   action {id, type, target?, path?, caption?, value?, ms?, unverified?}
//   error {kind, message}   done {text, actions, steps, ms, usage, model}
// ===================================================================================================================================
export const ANSWER_SHAPE =
  "Answer shape, every time: your words are read aloud, so write ONE short paragraph, no line breaks, at most 4 sentences and about 70 words " +
  "(a greeting or thanks: one sentence). Lead with the direct answer, name at most 3 things, say why with one concrete fact each, and end with one " +
  "next step when it helps. No markdown, no bullets, no emoji, no URLs. Never mention your tools, cues, ids, searches or what they returned, and never " +
  "say 'let me highlight': say what the records show while the page shows it. Before your first tool call you may say one short lead-in of " +
  "at most 8 words, such as 'Let me pull that up.'; otherwise write nothing until your tool calls are done.";

export const TOUR_RULES =
  "You can drive this website while you talk. When the answer is about something on a page, show it: call the UI tools (navigate, scroll_to, " +
  "highlight, fill, click, wait) in the order they should happen; you may call several at once. Each valid UI call answers with a cue like [[2]]. " +
  "Then write the spoken answer and put each cue at the START of the sentence it belongs with, for example: " +
  "\"[[1]] Here are the matches. [[2]] The best one is Kelpforge, at 92, because ... [[3]] Its next step is ...\". " +
  "The page acts as that sentence starts playing. Use only page paths and target ids from the PAGE MAP, never CSS selectors; navigate before you " +
  "highlight something on another page; click only [safe] targets; fill only [fillable] ones. If a UI call is refused, fix it or skip it. " +
  "A question that needs nothing on screen gets no UI calls.";

export const FINAL_NOTE = "This is your last round: do not call a tool. Write the spoken answer now from what you have, with the cues you already got.";
const SPOKEN_CUE = /\[\[\s*\d{1,2}\s*\]\]/g;

export function systemPrompt(s: Settings, appName: string, appDesc: string, persona = ""): string {
  const who = `You are ${s.assistantName}, the voice assistant inside ${appName || "this web app"}.`;
  return [who, appDesc, persona, TOUR_RULES, ANSWER_SHAPE].filter(Boolean).join("\n\n");
}

/** A message the caller can be told about (400): the text is safe to show. */
export class BadInput extends Error {}

export interface ChatMessage { role: "user" | "assistant"; content: string }

/** The conversation as the API wants it: user/assistant text only, the newest a user message. BadInput carries a message safe to show. */
export function cleanMessages(raw: unknown, s: Settings): ChatMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new BadInput("messages must be a non-empty list");
  const out: ChatMessage[] = [];
  for (const m of raw.slice(-s.historyTurns)) {
    if (!isObj(m) || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      throw new BadInput("each message needs a role (user or assistant) and a text content");
    }
    const text = m.content.split(/\s+/).filter(Boolean).join(" ");
    if (text) out.push({ role: m.role, content: clip(text, 2000) });
  }
  while (out.length && out[0].role !== "user") out.shift();
  if (!out.length || out[out.length - 1].role !== "user") throw new BadInput("the last message must be from the user");
  if (Array.from(out[out.length - 1].content).length > s.inputChars) throw new BadInput(`a question can be at most ${s.inputChars} characters`);
  const merged: ChatMessage[] = [];                                 // two user messages in a row (a turn that failed) become one
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) merged[merged.length - 1] = { role: m.role, content: last.content + " " + m.content };
    else merged.push(m);
  }
  return merged;
}

/** Actions the browser could not run last turn, as one line the model reads with the new question. */
export function reportNote(reports: unknown): string {
  const bad: string[] = [];
  for (const r of (Array.isArray(reports) ? reports : []).slice(0, 10)) {
    if (isObj(r) && r.ok === false) {
      const what = clip(["type", "target", "path"].map((k) => String(r[k] || "")).join(" ").trim(), 120);
      bad.push(`${what} (${clip(String(r.why || "failed"), 80)})`);
    }
  }
  return bad.length ? "(Note from the page: these actions from your last answer did not run: " + bad.join("; ") + ".)" : "";
}

/** The slice of the Anthropic client a turn uses. The real SDK client satisfies it; so does lib/fake.ts FakeClient. */
export interface StreamLike { [Symbol.asyncIterator](): AsyncIterator<any>; finalMessage(): Promise<any> }
export interface ClientLike { messages: { stream(params: any, options?: any): StreamLike } }

let sdkClient: { timeout: number; client: ClientLike } | undefined;
/** The real client, loaded lazily so a fake-client test never needs the SDK. It reads ANTHROPIC_API_KEY itself. */
export async function makeClient(s: Settings): Promise<ClientLike> {
  const timeout = s.timeoutS * 1000;
  if (sdkClient && sdkClient.timeout === timeout) return sdkClient.client;
  const mod: Any = await import("@anthropic-ai/sdk");
  const Anthropic = mod.default ?? mod.Anthropic;
  const client = new Anthropic({ timeout, maxRetries: 1 }) as ClientLike;
  sdkClient = { timeout, client };
  return client;
}

export interface SseEvent { event: string; data: Any }

export interface TurnOptions {
  persona?: string;
  extra?: Record<string, unknown>;
  reports?: unknown;
  signal?: AbortSignal;
  log?: Logger;
}

const EXTRAS_REFUSED = /thinking|effort|output_config|fallback/i;

export class Turn {
  s: Settings;
  messages: Any[];
  ctx: TurnContext;
  registry: Registry;
  client: ClientLike;
  persona: string;
  signal?: AbortSignal;
  log: Logger;
  usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  steps = 0;
  text = "";
  trace: Any[] = [];
  noExtras = false;

  constructor(messages: ChatMessage[], manifest: Manifest, registry: Registry, client: ClientLike, s?: Settings, opts: TurnOptions = {}) {
    this.s = s ?? settings();
    this.messages = messages.map((m) => ({ ...m }));
    const note = reportNote(opts.reports);
    if (note) {
      const last = this.messages[this.messages.length - 1];
      this.messages[this.messages.length - 1] = { role: "user", content: last.content + "\n\n" + note };
    }
    this.ctx = new TurnContext(manifest, opts.extra ?? {});
    this.registry = registry;
    this.client = client;
    this.persona = opts.persona ?? "";
    this.signal = opts.signal;
    this.log = opts.log ?? consoleLog;
  }

  // -- the request ------------------------------------------------------------------------------------------------------------------
  /** The Messages API body, and the per-request options (the fallback beta header, the abort signal). */
  request(final: boolean): { params: Any; options: Any | undefined } {
    const s = this.s;
    const m = this.ctx.manifest;
    const system = [
      { type: "text", text: systemPrompt(s, m.app.name, m.app.description, this.persona), cache_control: { type: "ephemeral" } },
      { type: "text", text: "PAGE MAP (what you can show)\n" + pageMap(m) + (final ? `\n\n${FINAL_NOTE}` : "") },
    ];
    const params: Any = {
      model: s.model, max_tokens: s.maxTokens, system, messages: [...this.messages], tools: [...UI_TOOLS, ...this.registry.specs()],
    };
    if (final) params.tool_choice = { type: "none" };
    const options: Any = {};
    if (this.signal) options.signal = this.signal;
    if (!this.noExtras) {
      if (s.thinking === "between_tools") {
        params.thinking = { type: "between_tools" };
      } else {
        params.thinking = { type: "adaptive" };
        if (["low", "medium", "high", "xhigh", "max"].includes(s.effort)) params.output_config = { effort: s.effort };
      }
      if (s.fallbacks === "default") {
        params.fallbacks = "default";
        options.headers = { "anthropic-beta": "server-side-fallback-2026-07-01" };
      }
    }
    return { params, options: Object.keys(options).length ? options : undefined };
  }

  /** Stream one model call: text deltas go out as they arrive; returns the final message. */
  private async *call(final: boolean, step: number): AsyncGenerator<SseEvent, Any, undefined> {
    const { params, options } = this.request(final);
    const stream = this.client.messages.stream(params, options);
    let firstText = true;
    for await (const ev of stream) {
      const t = ev?.type;
      if (t === "content_block_start") {
        const blk = ev.content_block;
        if (blk?.type === "tool_use") {
          const name: string = blk.name ?? "";
          const label = UI_TOOL_NAMES.has(name) ? UI_LABELS[name] : this.registry.label(name);
          yield { event: "status", data: { label, tool: name } };
        }
      } else if (t === "content_block_delta") {
        const d = ev.delta;
        if (d?.type === "text_delta" && d.text) {
          if (firstText && this.text && !this.text.endsWith(" ") && !this.text.endsWith("\n")) {   // a new step's text never glues onto the last word
            this.text += " ";
            yield { event: "delta", data: { text: " ", step } };
          }
          firstText = false;
          this.text += d.text;
          yield { event: "delta", data: { text: d.text, step } };
        }
      }
    }
    return await stream.finalMessage();
  }

  // -- the loop ---------------------------------------------------------------------------------------------------------------------
  async *events(): AsyncGenerator<SseEvent, void, undefined> {
    const s = this.s;
    const t0 = performance.now();
    yield { event: "status", data: { label: "thinking" } };
    let final = false;
    try {
      for (;;) {
        if ((performance.now() - t0) / 1000 > s.turnDeadlineS) {
          yield this.err("timeout", `${s.assistantName} took too long on that one.`);
          return;
        }
        this.steps += 1;
        final = final || this.steps >= s.maxSteps;
        let msg: Any;
        try {
          msg = yield* this.call(final, this.steps);
        } catch (e) {
          if (errStatus(e) === 400 && !this.noExtras && EXTRAS_REFUSED.test(errMessage(e))) {
            this.log("warn", `the API refused the thinking/fallback parameters for ${s.model}; retrying once without them: ${clip(errMessage(e), 200)}`);
            this.noExtras = true;
            msg = yield* this.call(final, this.steps);
          } else {
            throw e;
          }
        }
        this.addUsage(msg?.usage);
        const content: Any[] = Array.isArray(msg?.content) ? [...msg.content] : [];
        const stop: string | null = msg?.stop_reason ?? null;
        const uses = content.filter((b) => b?.type === "tool_use");
        this.trace.push({ step: this.steps, stop, tools: uses.map((b) => b.name), s: Math.round((performance.now() - t0) / 10) / 100 });
        if (stop === "refusal") {
          yield this.err("refusal", `${s.assistantName} can't help with that one.`);
          return;
        }
        if (stop === "tool_use" && uses.length && !final) {
          if (this.text && !this.text.endsWith(" ") && !this.text.endsWith("\n")) {   // close the lead-in now, so the browser can speak it while tools run
            this.text += " ";
            yield { event: "delta", data: { text: " ", step: this.steps } };
          }
          this.messages.push({ role: "assistant", content });          // unchanged: thinking blocks go back as they came
          const results: Any[] = [];
          for (const b of uses) {
            const [body, ok, act] = await this.run(b.name, b.input ?? {});
            if (act) yield { event: "action", data: act };
            results.push({ type: "tool_result", tool_use_id: b.id, content: body, ...(ok ? {} : { is_error: true }) });
          }
          this.messages.push({ role: "user", content: results });
          continue;
        }
        break;
      }
    } catch (e) {
      yield this.classify(e);
      return;
    }
    if (!this.text.replace(SPOKEN_CUE, "").trim()) {
      yield this.err("empty", `${s.assistantName} did not find words for that one. Try asking another way.`);
      return;
    }
    const ms = Math.round(performance.now() - t0);
    this.log("info", "turn " + JSON.stringify({ model: s.model, steps: this.steps, ms, usage: this.usage, trace: this.trace }));
    yield {
      event: "done",
      data: { text: this.text.trim(), actions: this.ctx.actions, steps: this.steps, ms, usage: { ...this.usage }, model: s.model },
    };
  }

  private async run(name: string, args: Any): Promise<[string, boolean, Action | null]> {
    if (UI_TOOL_NAMES.has(name)) {
      const { act, why } = this.ctx.check(name, args, this.s.maxActions);
      if (act === null) return [why, false, null];
      const n = act.id;
      return [`Queued as cue [[${n}]]. Put [[${n}]] at the start of the sentence it belongs with.`, true, act];
    }
    if (this.registry.has(name)) {
      const [body, ok] = await this.registry.run(name, args, this.ctx);
      return [body, ok, null];
    }
    return [`There is no tool called ${name}.`, false, null];
  }

  private addUsage(u: Any | undefined): void {
    for (const k of Object.keys(this.usage) as (keyof Turn["usage"])[]) this.usage[k] += Math.trunc(Number(u?.[k] ?? 0)) || 0;
  }

  private err(kind: string, message: string): SseEvent {
    this.log("warn", `turn ended: ${kind}`);
    return { event: "error", data: { kind, message } };
  }

  /** The SDK's error classes are told apart by HTTP status and message, so this needs no SDK import. */
  private classify(e: unknown): SseEvent {
    const name = this.s.assistantName;
    const status = errStatus(e);
    const msg = errMessage(e);
    if (status === undefined && (/timed out|timeout/i.test(msg) || /timeout/i.test(errName(e)))) return this.err("timeout", `${name} took too long to answer.`);
    if (status === 429) return this.err("busy", `${name} is busy right now. Try again in a moment.`);
    if (status === 401) return this.err("auth", `${name}'s model key was refused.`);
    if (status === undefined && /connection error|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
      return this.err("network", `${name} can't reach the model right now.`);
    }
    this.log("error", `turn failed: ${errName(e)}${status !== undefined ? ` (API status ${status})` : ""}: ${clip(msg, 300)}`);
    return this.err("api", `${name}'s reasoning is not available right now.`);
  }
}

// ===================================================================================================================================
// limits (server/limits.py): in memory (a restart resets them): requests per IP per minute, chat turns per UTC day, spoken characters per UTC day
// ===================================================================================================================================
const today = (): string => new Date().toISOString().slice(0, 10);

export class Limiter {
  hits = new Map<string, number[]>();
  ttsHits = new Map<string, number[]>();
  day = "";
  turns = 0;
  ttsDay = "";
  ttsChars = 0;

  /** true when this IP may request another voice clip this minute (and counts it). */
  ttsRate(ip: string, perMin: number, now = performance.now() / 1000): boolean {
    let q = this.ttsHits.get(ip);
    if (!q) {
      q = [];
      this.ttsHits.set(ip, q);
    }
    while (q.length && now - q[0] > 60) q.shift();
    if (q.length >= perMin) return false;
    q.push(now);
    if (this.ttsHits.size > 5000) for (const [k, v] of this.ttsHits) if (!v.length || now - v[v.length - 1] > 60) this.ttsHits.delete(k);
    return true;
  }

  reset(): void {
    this.hits = new Map();
    this.ttsHits = new Map();
    this.day = "";
    this.turns = 0;
    this.ttsDay = "";
    this.ttsChars = 0;
  }

  /** null when allowed (and counted); 'rate' or 'cap' when refused. */
  check(ip: string, ratePerMin: number, dailyTurns: number, now = performance.now() / 1000): "rate" | "cap" | null {
    if (this.day !== today()) {
      this.day = today();
      this.turns = 0;
    }
    let q = this.hits.get(ip);
    if (!q) {
      q = [];
      this.hits.set(ip, q);
    }
    while (q.length && now - q[0] > 60) q.shift();
    if (q.length >= ratePerMin) return "rate";
    if (this.turns >= dailyTurns) return "cap";
    q.push(now);
    this.turns += 1;
    if (this.hits.size > 5000) {
      for (const [k, v] of [...this.hits]) if (!v.length || now - v[v.length - 1] > 60) this.hits.delete(k);
    }
    return null;
  }

  chargeTts(chars: number, cap: number): boolean {
    if (this.ttsDay !== today()) {
      this.ttsDay = today();
      this.ttsChars = 0;
    }
    if (this.ttsChars + chars > cap) return false;
    this.ttsChars += chars;
    return true;
  }

  refundTts(chars: number): void {
    this.ttsChars = Math.max(0, this.ttsChars - chars);
  }

  ttsLeft(cap: number): number {
    return this.ttsDay !== today() ? cap : Math.max(0, cap - this.ttsChars);
  }
}

export function clientIp(req: Request): string {
  const h = req.headers;
  return (h.get("cf-connecting-ip") || (h.get("x-forwarded-for") || "").split(",")[0].trim() || h.get("x-real-ip") || "?").slice(0, 64);
}

// ===================================================================================================================================
// the spoken voice (server/tts.py): an ElevenLabs streaming proxy with a daily character cap and an in-memory cache of identical text
// ===================================================================================================================================
const CUE = /\[\[\s*\d{1,2}\s*\]\]/g;
const MD_LINK = /\[([^\]]+)\]\([^)]*\)/g;

/** Text as it should be said: cue markers, markdown and URLs off, whitespace collapsed. */
export function spoken(text: string): string {
  let t = (text || "").replace(CUE, "");
  t = t.replace(MD_LINK, "$1");
  t = t.replace(/https?:\/\/\S+/g, "");
  t = t.replace(/[*_`#>]+/g, "");
  return t.split(/\s+/).filter(Boolean).join(" ");
}

export interface UpstreamResult { status: number; chunks: AsyncIterable<Uint8Array>; close: () => Promise<void> }
/** An upstream opens the speech request and answers with its status and a byte stream. Tests replace Voice.upstream; production uses ElevenLabs. */
export type Upstream = (text: string, s: Settings, key: string) => Promise<UpstreamResult>;

async function* noBytes(): AsyncGenerator<Uint8Array, void, undefined> {
  // an empty stream for a failed request
}

export const elevenlabs: Upstream = async (text, s, key) => {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(s.ttsVoiceId)}/stream?output_format=${encodeURIComponent(s.ttsFormat)}`;
  const payload = { text, model_id: s.ttsModel, voice_settings: { stability: 0.5, similarity_boost: 0.8 } };
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {                                  // 30 s without a response or a chunk ends the request
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(), 30_000);
  };
  const close = async () => {
    clearTimeout(timer);
    ac.abort();
  };
  let resp: Response;
  try {
    arm();
    resp = await fetch(url, {
      method: "POST", signal: ac.signal, body: JSON.stringify(payload),
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    });
  } catch {
    await close();
    return { status: 599, chunks: noBytes(), close: async () => {} };
  }
  arm();
  async function* bytes(): AsyncGenerator<Uint8Array, void, undefined> {
    if (!resp.body) return;
    const reader = resp.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        arm();
        if (value) yield value;
      }
    } finally {
      clearTimeout(timer);
      try { await reader.cancel(); } catch { /* already closed */ }
    }
  }
  return { status: resp.status, chunks: bytes(), close };
};

const jsonResponse = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

export class Voice {
  limiter: Limiter;
  upstream: Upstream;
  cache = new Map<string, Uint8Array>();
  log: Logger;

  constructor(limiter: Limiter, upstream?: Upstream, log: Logger = consoleLog) {
    this.limiter = limiter;
    this.upstream = upstream ?? elevenlabs;
    this.log = log;
  }

  key(text: string, s: Settings): string {
    return `${s.ttsVoiceId}|${s.ttsModel}|${s.ttsFormat}|${text}`;
  }

  cached(k: string): Uint8Array | undefined {
    const b = this.cache.get(k);
    if (b !== undefined) {                               // most recently used goes last
      this.cache.delete(k);
      this.cache.set(k, b);
    }
    return b;
  }

  store(k: string, b: Uint8Array, s: Settings): void {
    this.cache.delete(k);
    this.cache.set(k, b);
    while (this.cache.size > Math.max(1, s.ttsCacheItems)) this.cache.delete(this.cache.keys().next().value as string);
  }

  /** A Response for {text}: audio/mpeg (streamed, or from the cache) or a JSON error the browser falls back on. */
  async respond(rawText: unknown): Promise<Response> {
    const s = settings();
    const key = elevenlabsKey();
    if (!key || !s.ttsVoiceId) return jsonResponse({ error: "the server voice is not configured; the browser voice is used" }, 404);
    const text = clip(spoken(typeof rawText === "string" ? rawText : String(rawText ?? "")), s.ttsMaxChars);
    if (!text) return jsonResponse({ error: "no text" }, 400);
    const k = this.key(text, s);
    const hit = this.cached(k);
    if (hit !== undefined) {                              // identical text: no new characters are spent
      return new Response(hit as unknown as BodyInit, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-Pilot-Cache": "hit" } });
    }
    const chars = Array.from(text).length;
    if (!this.limiter.chargeTts(chars, s.ttsDailyChars)) {
      return jsonResponse({ error: "the daily limit of spoken characters is used up; the browser voice is used" }, 429);
    }
    const { status, chunks, close } = await this.upstream(text, s, key);
    if (status !== 200) {
      try { await close(); } catch { /* nothing to close */ }
      this.limiter.refundTts(chars);
      this.log("warn", `the voice service answered ${status}`);
      return jsonResponse({ error: `the voice service answered ${status}` }, 502);
    }
    const it = chunks[Symbol.asyncIterator]();
    const buf: Uint8Array[] = [];
    let finished = false;
    const finish = async (done: boolean) => {
      if (finished) return;
      finished = true;
      try { await close(); } catch { /* nothing to close */ }
      if (done && buf.length) this.store(k, concat(buf), s);      // only a complete answer is cached
    };
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const r = await it.next();
          if (r.done) {
            await finish(true);
            controller.close();
          } else {
            buf.push(r.value);
            controller.enqueue(r.value);
          }
        } catch (e) {
          await finish(false);
          controller.error(e);
        }
      },
      cancel: async () => {
        try { await it.return?.(); } catch { /* the upstream is going away anyway */ }
        await finish(false);
      },
    });
    return new Response(body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-Pilot-Cache": "miss" } });
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ===================================================================================================================================
// the HTTP surface (server/router.py): handler factories for Next.js route handlers (or any fetch-style server)
// ===================================================================================================================================
const SSE_HEADERS = { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" };

export function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export type ClientFactory = (s: Settings, question: string, manifest: Manifest) => ClientLike | Promise<ClientLike>;

export interface PilotOptions {
  registry: Registry;
  appName?: string;
  appDescription?: string;
  persona?: string;
  /** Builds the model client for a turn. Default: the Anthropic SDK (lazy import, reads ANTHROPIC_API_KEY). Tests pass a FakeClient. */
  clientFactory?: ClientFactory;
  /** Rehearsal mode (PILOT_REHEARSAL=1): a scripted model for a demo on a dead network. See lib/fake.ts rehearsalClient. */
  rehearsalClient?: (question: string, manifest: Manifest, assistantName: string) => ClientLike;
  /** Anything the host wants data tools to see per request (user, tenant): ctx.extra. */
  extra?: (req: Request) => Record<string, unknown>;
  /** Replaces the ElevenLabs call (tests). */
  ttsUpstream?: Upstream;
  limiter?: Limiter;
  log?: Logger;
}

export interface Pilot {
  chat(req: Request): Promise<Response>;
  tts(req: Request): Promise<Response>;
  status(req: Request): Promise<Response>;
  /** The live state, for tests and hosts: swap state.options.clientFactory or voice.upstream, reset limiter. */
  state: { options: PilotOptions; limiter: Limiter; voice: Voice };
}

export function createPilot(options: PilotOptions): Pilot {
  const log = options.log ?? consoleLog;
  const limiter = options.limiter ?? new Limiter();
  const voice = new Voice(limiter, options.ttsUpstream, log);
  const state = { options, limiter, voice };

  const mode = (s: Settings): "rehearsal" | "live" | "off" => {
    if (s.rehearsal && state.options.rehearsalClient) return "rehearsal";
    return anthropicKeyPresent() ? "live" : "off";
  };

  const refuse = (kind: string, message: string, code: number, headers: Record<string, string> = {}): Response =>
    new Response(sse("error", { kind, message }), { status: code, headers: { ...SSE_HEADERS, ...headers } });

  const status = async (_req: Request): Promise<Response> => {
    const s = settings();
    const m = mode(s);
    const tts = !!(elevenlabsKey() && s.ttsVoiceId);
    return jsonResponse({
      name: s.assistantName, mode: m, llm: m !== "off", model: m === "live" ? s.model : null,
      tts, tts_chars_left: tts ? limiter.ttsLeft(s.ttsDailyChars) : 0,
    }, 200, { "Cache-Control": "no-store" });
  };

  const chat = async (req: Request): Promise<Response> => {
    const s = settings();
    const opt = state.options;
    let body: Any;
    try {
      const parsed: unknown = await req.json();
      if (!isObj(parsed)) throw new Error("not an object");
      body = parsed;
    } catch {
      return jsonResponse({ error: "send a JSON body {messages, manifest}" }, 400);
    }
    let messages: ChatMessage[];
    try {
      messages = cleanMessages(body.messages, s);
    } catch (e) {
      if (e instanceof BadInput) return jsonResponse({ error: e.message }, 400);
      throw e;
    }
    const manifest = cleanManifest(body.manifest);
    if (opt.appName && !manifest.app.name) manifest.app.name = opt.appName;
    if (opt.appDescription && !manifest.app.description) manifest.app.description = opt.appDescription;
    if (mode(s) === "off" && !opt.clientFactory) {
      return refuse("no_key", `${s.assistantName}'s reasoning is not switched on yet: the server needs ANTHROPIC_API_KEY.`, 200);
    }
    const refused = limiter.check(clientIp(req), s.ratePerMin, s.dailyTurns);
    if (refused === "rate") return refuse("rate", "That is a lot of questions in a minute. Give me a moment and ask again.", 429, { "Retry-After": "30" });
    if (refused === "cap") return refuse("cap", `${s.assistantName} has answered all the questions it can for today.`, 429, { "Retry-After": "3600" });
    const question = messages[messages.length - 1].content;
    let client: ClientLike;
    try {
      if (opt.clientFactory) client = await opt.clientFactory(s, question, manifest);
      else if (mode(s) === "rehearsal") client = opt.rehearsalClient!(question, manifest, s.assistantName);
      else client = await makeClient(s);
    } catch (e) {
      log("error", `could not build the model client: ${errName(e)}`);
      return refuse("api", `${s.assistantName}'s reasoning is not available right now.`, 200);
    }
    const ac = new AbortController();                     // the browser went away: stop paying for the answer
    req.signal?.addEventListener("abort", () => ac.abort());
    const turn = new Turn(messages, manifest, opt.registry, client, s, {
      persona: opt.persona, extra: opt.extra ? opt.extra(req) : {}, reports: body.reports, signal: ac.signal, log,
    });
    const events = turn.events();
    const enc = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const r = await events.next();
          if (cancelled) return;
          if (r.done) controller.close();
          else controller.enqueue(enc.encode(sse(r.value.event, r.value.data)));
        } catch (e) {
          if (cancelled) return;
          log("error", `stream failed: ${errName(e)}: ${clip(errMessage(e), 300)}`);
          controller.enqueue(enc.encode(sse("error", { kind: "internal", message: `${s.assistantName} hit a snag.` })));
          controller.close();
        }
      },
      cancel: () => {
        cancelled = true;
        ac.abort();
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  };

  const tts = async (req: Request): Promise<Response> => {
    if (!limiter.ttsRate(clientIp(req), settings().ttsRatePerMin)) {
      return jsonResponse({ error: "too many voice requests this minute; the browser voice is used" }, 429, { "Retry-After": "30" });
    }
    let text: unknown;
    try {
      const body: unknown = await req.json();
      text = isObj(body) ? body.text : undefined;
    } catch {
      text = undefined;
    }
    if (typeof text !== "string") return jsonResponse({ error: "send {text}" }, 400);
    return voice.respond(text);
  };

  return { chat, tts, status, state };
}
