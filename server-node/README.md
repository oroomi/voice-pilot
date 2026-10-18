# voice-pilot for Next.js

The Node/TypeScript port of the Python reference server (`../server/`). It speaks the same protocol, so the browser client is the same
`client/pilot.js` with `endpoint: "/pilot"` (the default):

| Route | What it does |
|---|---|
| `POST /pilot/chat` | `{messages, manifest, reports?}` in, `text/event-stream` out: `status`, `delta`, `action`, `error`, `done` |
| `POST /pilot/tts` | `{text}` in, `audio/mpeg` out (ElevenLabs, cached, capped per day); 404/400/429/502 JSON otherwise, so the browser voice takes over |
| `GET /pilot/status` | `{name, mode, llm, model, tts, tts_chars_left}`: booleans and names only, never a key |

Everything is in `lib/pilot.ts`, built on Web-standard `Request`/`Response`/`ReadableStream`: the same handlers run as Next.js route handlers
and in plain Node 22. The Anthropic SDK is the only dependency and is imported lazily, so the tests need no `node_modules`.

## Add it to a Next.js app (App Router, TypeScript) in 5 steps

1. **Install the SDK:** `npm i @anthropic-ai/sdk`
2. **Copy the code:** `lib/pilot.ts`, `lib/fake.ts`, `lib/setup.ts` into your app's `lib/`, and the three folders `app/pilot/chat`, `app/pilot/tts`,
   `app/pilot/status` into your `app/` (so the routes are `/pilot/chat`, `/pilot/tts`, `/pilot/status`). The routes import `../../../lib/setup`;
   change that path if your `lib/` lives elsewhere.
3. **Describe your app in `lib/setup.ts`:** set `appName` / `appDescription` and register your read-only data tools:

   ```ts
   registry.tool(
     { name: "list_matches", description: "Ranked matches, best first.", schema: { type: "object", properties: { limit: { type: "integer" } } }, label: "reading the matches" },
     async (args, ctx) => ({ matches: await db.matches(args.limit) }),   // a string, or anything JSON.stringify can write
   );
   ```

   `ctx.manifest` is what the page sent this turn; `ctx.extra` is whatever `createPilot({ extra: (req) => ({ user }) })` returned for the request.
   A tool that throws is reported to the model as an error result and never crashes the turn.
4. **Set the environment** (`.env.local`, or your host's secrets; keys are only ever read from `process.env`): `ANTHROPIC_API_KEY`, and for the
   server voice `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID`. Without a key the routes still answer cleanly (`mode: "off"`, TTS 404).
5. **Serve the client** the way the Python demo does: copy the kit's `client/` folder to `public/pilot/client/` and your manifest to
   `public/pilot.manifest.json`, then on the pages:

   ```html
   <link rel="stylesheet" href="/pilot/client/pilot.css">
   <script type="module">
     import VoicePilot from "/pilot/client/pilot.js";
     VoicePilot.init({ endpoint: "/pilot", manifest: "/pilot.manifest.json" });
   </script>
   ```

   Any way of loading that module script on your pages works; the client only needs the three routes above.

`lib/pilot.ts` and `lib/fake.ts` have no relative runtime imports, and `lib/setup.ts` and the routes import them without file extensions, so no
`tsconfig` change is needed.

## Environment

Same names and defaults as `../server/config.py`. Read on every request.

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | | required for `mode: "live"` |
| `PILOT_MODEL` | `claude-sonnet-5-5` | |
| `PILOT_EFFORT` | `low` | `low` `medium` `high` `xhigh` `max`; sent as `output_config.effort` with `thinking: {type: "adaptive"}` |
| `PILOT_THINKING` | `adaptive` | or `between_tools` (Sonnet 5.5: lowest latency) |
| `PILOT_FALLBACKS` | `default` | `default` sends `fallbacks: "default"` and the `anthropic-beta: server-side-fallback-2026-07-01` header; `off` sends neither |
| `PILOT_MAX_STEPS` / `PILOT_MAX_ACTIONS` | `5` / `8` | model rounds per turn (the last forbids tools) / UI actions per answer |
| `PILOT_RATE_PER_MIN` / `PILOT_DAILY_TURNS` | `12` / `400` | per IP per minute / all chat turns per UTC day |
| `PILOT_ASSISTANT_NAME` | `Aava` | |
| `PILOT_MAX_TOKENS`, `PILOT_TIMEOUT_S`, `PILOT_TURN_DEADLINE_S`, `PILOT_INPUT_CHARS`, `PILOT_HISTORY_TURNS` | `4096`, `30`, `45`, `600`, `10` | |
| `PILOT_REHEARSAL` | `0` | `1` answers from a script (`lib/fake.ts` `rehearsalClient`) for a demo on a dead network; `/pilot/status` says `rehearsal` |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | | both needed for the server voice |
| `ELEVENLABS_MODEL_ID`, `ELEVENLABS_OUTPUT_FORMAT` | `eleven_multilingual_v2`, `mp3_44100_128` | |
| `PILOT_TTS_DAILY_CHARS` / `PILOT_TTS_MAX_CHARS` / `PILOT_TTS_CACHE_ITEMS` | `20000` / `600` / `200` | spoken characters per UTC day / per request / cached answers |

## Things to know

- **The limits and the voice cache live in memory** (a restart resets them), as in the Python server. On serverless each warm instance has its own,
  so the caps are per instance there. A single Node server (`next start`, a VPS, a container) gives you real daily caps.
- **The client IP** for rate limiting comes from `cf-connecting-ip`, then the first `x-forwarded-for`, then `x-real-ip`. A bare Node server with no
  proxy in front sends none of them, and then every visitor shares one bucket.
- **Streaming:** the chat route returns a `ReadableStream`, so the answer arrives as the model writes it. If you put a proxy in front, turn its
  buffering off (`X-Accel-Buffering: no` is already set). A turn can take up to `PILOT_TURN_DEADLINE_S`; on Vercel raise the route's `maxDuration`.
- **Closing the tab stops the model call:** cancelling the response body (or aborting the request's own signal) aborts the SDK request.

## Tests

```
cd .. && node --test server-node/test/      # from the kit root; or `npm test` here
python3 -m pytest -q tests/test_node_port.py   # the same suite, plus a parity check against the Python server
```

Node 22.18 or newer runs the TypeScript directly (22.6 to 22.17 need `--experimental-strip-types`). No network, no keys, no `node_modules`:
the model is `lib/fake.ts` `FakeClient` and the voice upstream is a fake. `test/index.js` only exists because Node 22 runs a directory argument as
one file; it imports `pilot.test.ts`. `npm install && npx tsc -p .` typechecks `lib/`, `app/` and `test/`.

`test/parity_dump.ts` is not a test: `tests/test_node_port.py` feeds the same fixtures to it and to `server/*.py` and requires identical prompts,
UI tool schemas, manifest cleaning, page map, target validation and message cleaning.
