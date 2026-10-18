# Actions: how Aava drives the page

The model never touches the DOM and never writes CSS. It calls **UI tools** that name **targets** the page declared. The server validates
each call against the page manifest; a valid call becomes an `action` event with a **cue number**, and the model writes that cue as
`[[n]]` at the start of the sentence the action belongs with. The browser runs the action as that sentence starts playing.

```
model ── highlight(target="match-1", caption="Best match") ──▶ server validates against the manifest
                                                               ├─ unknown target → error tool_result listing the real ids (model fixes it, same turn)
                                                               └─ valid → SSE  event: action  {id: 2, type: "highlight", target: "match-1", ...}
model ◀── "Queued as cue [[2]]. Put [[2]] at the start of the sentence it belongs with."
model ── text: "[[1]] Here are the matches. [[2]] The best one is Kelpforge, at 92. ..." ──▶ SSE delta events
browser: sentence "The best one is Kelpforge, at 92." is about to play → run action 2 → start the audio
```

## Declaring targets

Any element with `data-pilot="<id>"` is a target. Ids are stable words (`match-1`, `why`, `filter-sector`), 1-64 characters of
`A-Z a-z 0-9 _ . : -`. Add a short description so the model knows what it is:

```html
<section data-pilot="why" data-pilot-desc="Why it fits: the reason behind each part of the score">...</section>
<li data-pilot="match-1" data-pilot-desc="Match #1: Kelpforge with Blue Current Fund, score 92">...</li>
<select data-pilot="filter-sector" data-pilot-desc="Sector filter">...</select>          <!-- fillable: options are sent along -->
<button data-pilot="filter-80" data-pilot-safe data-pilot-desc="Only scores of 80 or more">80 and up</button>   <!-- clickable -->
```

What the browser sends for each visible target: `id`, `desc` (`data-pilot-desc`, else `aria-label`, else `title`), its visible `text`
(first 200 characters), `href` if it is or holds a same-origin link (so the model can build `/startups/kelpforge`), `safe` for
`data-pilot-safe`, and `fill` (kind, options, current value) for inputs, selects and textareas. Hidden elements are left out.

## The manifest

Sent with every question (`POST /pilot/chat` body `manifest`):

```json
{"app": {"name": "...", "description": "..."},
 "page": {"path": "/matches", "title": "Matches"},
 "targets": [ ...the live page's targets... ],
 "pages": [ {"path": "/", "title": "Overview", "desc": "...", "targets": [...]},
            {"path": "/startups/:slug", "title": "Startup", "desc": "...", "targets": [...]} ]}
```

`pages` comes from `pilot.manifest.json` (option `manifest`). A page without `targets` is fetched once and its `data-pilot` elements are
read (option `crawl`, default on); a `:param` page is read from its `sample` path, and its sample text is dropped so it cannot mislead.
This is what lets the model plan "navigate to /startups/kelpforge, then highlight `why`" before the page is even open.

## Built-in actions

| Tool the model calls | What the browser does | Server-side checks |
|---|---|---|
| `navigate(path)` | Fetches the page and swaps `[data-pilot-main]` and every `[data-pilot-region="x"]` in place, runs scripts inside them, updates `document.title` and history (`pushState`; Back works). The overlay, the voice and the conversation survive. With `opts.navigate` it calls your SPA router instead and waits for the DOM to settle. | Same-origin path starting with `/`; must match a declared page or `:param` pattern when pages are declared. After a navigate, the destination page's targets are the valid ones. |
| `scroll_to(target)` | Smooth-scrolls the target to the middle of the screen (skips if already in view) and waits for the scroll to stop. | Target exists on the page the tour is on. |
| `highlight(target, caption)` | Scrolls it into view, dims the rest of the page and puts a cyan spotlight around it with the caption above (or below near the top). It follows scrolling and resizing; the next highlight moves it; it fades `holdSpotlightMs` (3.5 s) after the answer ends. | Target exists; caption trimmed to 80 characters. |
| `click(target)` | Clicks it, but only if the element carries `data-pilot-safe` (checked again in the browser). A pulse ring shows what was pressed. | Target is marked safe. |
| `fill(target, value)` | Sets an input, textarea, checkbox or select (by option value or text, any case) and fires `input` + `change`; React-controlled inputs see it too. | Target is fillable; for a select the value must be one of its options (matched to the option's own spelling). |
| `wait(ms)` | Pauses the tour 100-3000 ms. | Clamped. |

At most `PILOT_MAX_ACTIONS` (8) actions per answer.

## Timing: the rule, and why

**An action fires immediately before the beat that holds its cue starts playing. Actions always run in the order the model called them:
when a cue fires, every earlier action that has not run yet runs first.**

The text is cut into sentences as it streams, and sentences are grouped into **beats**: the first sentence is its own beat (so the voice
starts as early as possible), a sentence with a cue starts a new beat, other sentences join the beat before them (up to ~260 characters).
Each beat is one TTS clip, fetched in order while the previous one plays. When a beat starts:

1. its non-highlight actions run in order (`navigate`, `scroll_to`, `fill`, `click`, `wait`), awaited, so the page is there before the words;
2. its highlights run on a clock across the beat: the first at once (the audio waits for it at most 0.7 s), the next ones spread over the
   beat's estimated length, so "Kelpforge ... Hullsense ... Saltgrid" in one sentence still gets three spotlights in turn;
3. the clip plays (or the browser voice speaks) and the words are revealed in step with it.

Why this design: a per-sentence clip gives an exact start time for every sentence, with no word-timestamp alignment and no guessing inside
one long clip. Cues tie each action to words the model chose, and the order rule keeps a highlight from running before the navigate it
depends on even if the model puts cues in an odd order. It degrades well:

- **No cues at all:** each beat takes the next pending actions up to and including one highlight; leftovers are spread over the beats not
  yet spoken when the answer ends; if nothing is left to speak they run at once.
- **A lead-in said while tools run** ("Let me pull that up."): the server closes it as soon as the tool step ends, the browser speaks it
  while the model works, and it takes no actions (only actions that arrived before a beat's words began can be taken by a cue-less beat).
- **A target missing from the page:** the action is skipped, the voice carries on, and the failure (`{id, type, target, ok: false, why}`)
  goes back with the next question as `reports`, which the server turns into a note the model reads.

## Hooks

```js
VoicePilot.init({
  navigate: async (path) => router.push(path),     // SPA router; resolve when the new page is on screen
  onAction: async (action, pilot) => {             // see or take over any action
    if (action.type === "fill" && action.target === "budget") { myStore.setBudget(action.value); return true; }  // handled
    if (action.type === "click" && !userIsLoggedIn) return false;                                                  // refused, reported
    // return undefined to let the pilot run it
  },
});
const p = VoicePilot.instance;
p.on("action", (r) => console.log(r));            // also document events: pilot:action, pilot:navigated, pilot:state, pilot:answer, ...
```

Events (`p.on(name, fn)` or `document.addEventListener("pilot:" + name, ...)`): `open`, `close`, `dock`, `state`, `ask`, `action`,
`navigated`, `answer`. Re-initialise your own widgets on `pilot:navigated` if they are not delegated.

## SSE protocol (for porting the server)

`POST {endpoint}/chat` with `{messages: [{role, content}], manifest, reports?}` answers `text/event-stream`:

| event | data |
|---|---|
| `status` | `{label, tool?}` what Aava is doing ("reading the match list") |
| `delta` | `{text, step}` answer text as written, cues included |
| `action` | `{id, type, target?, path?, caption?, value?, ms?, unverified?}` |
| `error` | `{kind, message}` a sentence to show and speak; the turn ends |
| `done` | `{text, actions, steps, ms, usage, model}` |

`server/turn.py` (Python) and `server-node/lib/pilot.ts` (TypeScript) implement it; `tests/test_node_port.py` checks they agree.
