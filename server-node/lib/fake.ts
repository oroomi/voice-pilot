// A stand-in for the Anthropic client with the same `messages.stream(params, options)` surface: used by the unit tests and by rehearsal mode.
// Mirrors server/fake.py. Rehearsal runs the real tool loop, validation and SSE stream with a scripted "model" built from the host's plan
// function, so a demo still works on a dead network. It is labelled as rehearsal in /pilot/status; it is never presented as the live model.
import type { Manifest } from "./pilot";

type Any = Record<string, any>;
export interface TextBlock { type: "text"; text: string }
export interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: Any }
export type Block = TextBlock | ToolUseBlock;
export interface Reply { content: Block[]; stop_reason: string }

let nextId = 1;

export function text(t: string): TextBlock {
  return { type: "text", text: t };
}

export function tool(name: string, input: Any = {}): ToolUseBlock {
  return { type: "tool_use", id: `toolu_fake_${nextId++}`, name, input };
}

export function reply(...blocks: Block[]): Reply {
  return { content: blocks, stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" };
}

/** One scripted model call, as the object `messages.stream()` returns: async-iterable events plus finalMessage(). */
export class FakeStream {
  r: Reply;
  chunk: number;

  constructor(r: Reply, chunkWords = 3) {
    this.r = r;
    this.chunk = chunkWords;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Any, void, undefined> {
    for (let i = 0; i < this.r.content.length; i++) {
      const b = this.r.content[i];
      yield { type: "content_block_start", index: i, content_block: b };
      if (b.type === "text") {
        const words = b.text.split(" ");
        for (let j = 0; j < words.length; j += this.chunk) {
          const piece = words.slice(j, j + this.chunk).join(" ") + (j + this.chunk < words.length ? " " : "");
          yield { type: "content_block_delta", index: i, delta: { type: "text_delta", text: piece } };
        }
      }
      yield { type: "content_block_stop", index: i };
    }
  }

  async finalMessage(): Promise<Any> {
    return {
      content: this.r.content, stop_reason: this.r.stop_reason,
      usage: { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  }
}

export type Script = (Reply | Error)[] | ((params: Any) => Reply | Error);

/** `script` is a list of replies (or Errors to throw) used in order, or a function(params) -> reply. Every request is kept in `.calls` (and its options in `.callOptions`). */
export class FakeClient {
  calls: Any[] = [];
  callOptions: Any[] = [];
  script: Script;
  messages: { stream: (params: Any, options?: Any) => FakeStream };

  constructor(script: Script) {
    this.script = script;
    this.messages = {
      stream: (params: Any, options?: Any) => {
        const snap = { ...params, messages: [...(params.messages ?? [])] };   // a snapshot: the turn keeps appending to its own list
        this.calls.push(snap);
        this.callOptions.push(options ?? {});
        const r = typeof this.script === "function" ? this.script(snap) : this.script.shift();
        if (r === undefined) throw new Error("FakeClient script is exhausted");
        if (r instanceof Error) throw r;
        return new FakeStream(r);
      },
    };
  }
}

// ---- rehearsal: a plan becomes tool calls, then the answer with the cues the real validator handed out ------------------------------------
export interface Beat { say: string; do?: [string, Any][] }
/** (question, manifest) -> [{ say: "...", do: [["highlight", { target: "x" }], ...] }, ...] */
export type Plan = (question: string, manifest: Manifest) => Beat[];

export function rehearsalClient(plan: Plan | undefined, question: string, manifest: Manifest): FakeClient {
  const beats = (plan ? plan(question, manifest) : null) ?? [];
  const use = beats.length ? beats : [{ say: "Rehearsal mode is on, and I have no rehearsed answer for that. Try asking for the best match.", do: [] }];
  const calls: [number, ToolUseBlock][] = [];              // (beat index, tool_use block)
  use.forEach((b, i) => {
    for (const [name, args] of b.do ?? []) calls.push([i, tool(name, args)]);
  });

  const script = (params: Any): Reply => {
    const msgs: Any[] = params.messages;
    const last = msgs[msgs.length - 1];
    const results: Any[] | null = Array.isArray(last?.content) ? last.content : null;
    if (calls.length && results === null) return reply(...calls.map(([, c]) => c));
    const cueOf = new Map<string, string>();
    for (const r of results ?? []) {
      if (r && r.type === "tool_result" && !r.is_error) {
        const m = /\[\[(\d+)\]\]/.exec(String(r.content));
        if (m) cueOf.set(r.tool_use_id, m[1]);
      }
    }
    const parts = use.map((b, i) => {
      const cues = calls.filter(([bi, c]) => bi === i && cueOf.has(c.id)).map(([, c]) => `[[${cueOf.get(c.id)}]] `).join("");
      return cues + b.say;
    });
    return reply(text(parts.join(" ")));
  };
  return new FakeClient(script);
}
