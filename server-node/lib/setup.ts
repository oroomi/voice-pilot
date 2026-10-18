// The one place a host app edits: its data tools, its name, its one-sentence description. The three route files import `pilot` from here.
// (Imports have no file extensions on purpose: Next.js resolves them as usual. Only the tests, which Node runs directly, use ".ts".)
import { Registry, createPilot } from "./pilot";
import type { Pilot } from "./pilot";
import { rehearsalClient } from "./fake";

export const registry = new Registry();

// ---- sample data tool: replace with your own read-only lookups (a database call, an internal API) ----------------------------------------
const MATCHES = [
  { slug: "kelpforge", name: "Kelpforge", sector: "Aquaculture", score: 92, why: "Carbon data from two farms fits the fund's ocean-data thesis." },
  { slug: "hullsense", name: "Hullsense", sector: "Shipping", score: 86, why: "Fuel-saving sensors already running on three ferries." },
  { slug: "saltgrid", name: "Saltgrid", sector: "Energy", score: 84, why: "Wave-power units with two paying sites." },
];

registry.tool(
  {
    name: "list_matches",
    description: "The ranked matches, best first, optionally filtered by sector. Sample data.",
    schema: { type: "object", properties: { sector: { type: "string" }, limit: { type: "integer" } } },
    label: "reading the matches",
  },
  async (args) => {
    const sector = typeof args.sector === "string" ? args.sector.toLowerCase() : "";
    const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(10, args.limit)) : 5;
    return { matches: MATCHES.filter((m) => !sector || m.sector.toLowerCase() === sector).slice(0, limit) };
  },
);

// ---- the pilot: kept on globalThis so a dev-server reload does not reset the rate limits and the voice cache --------------------------
const g = globalThis as { __voicePilot?: Pilot };
export const pilot: Pilot = (g.__voicePilot ??= createPilot({
  registry,
  appName: "My app",
  appDescription: "One sentence on what this site does, for the model.",
  // PILOT_REHEARSAL=1 answers from a script instead of the model (a demo on a dead network). Give it your own plan to rehearse real questions.
  rehearsalClient: (question, manifest) => rehearsalClient(undefined, question, manifest),
}));
