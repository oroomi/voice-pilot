// Evaluates the Node port on fixtures read from stdin (JSON) and prints the results as JSON. tests/test_node_port.py feeds the same fixtures to
// the Python reference (server/*.py) and compares the two, so the prompts, tool schemas and validation cannot drift apart. Not a test itself.
import { readFileSync } from "node:fs";
import {
  ANSWER_SHAPE, FINAL_NOTE, TOUR_RULES, TurnContext, UI_LABELS, UI_TOOLS, cleanManifest, cleanMessages, pageMap, reportNote, settings, spoken,
  systemPrompt,
} from "../lib/pilot.ts";

const cases = JSON.parse(readFileSync(0, "utf8"));
const s = settings();

const out = {
  constants: { ANSWER_SHAPE, TOUR_RULES, FINAL_NOTE, UI_TOOLS, UI_LABELS },
  spoken: cases.spoken.map((t: string) => spoken(t)),
  manifests: cases.manifests.map((raw: unknown) => {
    const m = cleanManifest(raw);
    return { manifest: m, page_map: pageMap(m) };
  }),
  checks: (() => {
    const ctx = new TurnContext(cleanManifest(cases.check_manifest));
    return cases.checks.map(([name, args]: [string, unknown]) => {
      const r = ctx.check(name, args, cases.max_actions);
      return [r.act, r.why];
    });
  })(),
  reports: cases.reports.map((r: unknown) => reportNote(r)),
  messages: cases.messages.map((raw: unknown) => {
    try {
      return cleanMessages(raw, s);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }),
  prompt: systemPrompt(s, "The App", "It does things.", "Be kind."),
};
process.stdout.write(JSON.stringify(out));
