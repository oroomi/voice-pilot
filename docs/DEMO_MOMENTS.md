# Scripting a judge-facing moment

The moment judges remember: someone asks out loud, the AI answers out loud, and **the app moves by itself while it talks**. Plan it like a
shot list, then make the app able to play it.

## 1. Write the moment as three beats

One question, one spoken answer of 3-4 sentences, one screen change per sentence. Example for a funding matcher:

> **"Aava, show me who should fund Kelpforge."**
>
> 1. *(opens Kelpforge's page, spotlight on the funder card)* "Blue Current Fund should fund Kelpforge."
> 2. *(spotlight moves to "Why it fits")* "It scores 92: two farms already measure carbon, which is exactly their thesis."
> 3. *(spotlight on "Next step")* "Next step: send them the sensor dataset and book a call this week."

For a list question ("who are the top 3?"): navigate to the list, then three highlights, one per sentence, or three in one sentence; the
pilot spreads them over the sentence.

## 2. Make every thing you want shown a target

For each beat, the element on screen gets a stable id and a description the model can match to words:

```html
<section data-pilot="funder" data-pilot-desc="The best funder for this startup">...</section>
<section data-pilot="why" data-pilot-desc="Why it fits: the reason behind each part of the score">...</section>
<section data-pilot="next-step" data-pilot-desc="The recommended next step this week">...</section>
<li data-pilot="match-1" data-pilot-desc="Match #1: Kelpforge with Blue Current Fund, score 92">...</li>
```

Use rank ids (`match-1`, `match-2`, `match-3`) for lists, so "the top 3" maps to ids without knowing names. List every page in
`pilot.manifest.json`, with a `sample` for `:param` pages, so the model can plan a two-page tour in one go.

## 3. Give the model the facts as a data tool

The spoken "why" must come from your data, not from the model's imagination. Register a read-only tool that returns exactly what the
page shows (scores, parts, reasons, next step):

```python
@registry.tool("get_startup", "One startup's record: score parts with reasons, best funder, next step.",
               {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}, label="opening the record")
def get_startup(args):
    return db.startup(args["name"])
```

## 4. Rehearse it three ways

1. **Live:** `python3 tools/live_check.py http://127.0.0.1:8151 "Show me who should fund Kelpforge"` prints every action and spoken
   line with timings, and saves `docs/screens/live-tour.png` mid-tour. Measured on the demo (Claude Sonnet 5.5, `PILOT_THINKING=between_tools`,
   ElevenLabs multilingual v2): the lead-in is heard after about 4.4 s, a 3-step tour ends after about 40 s of speech.
2. **Rehearsal mode** (no network needed for the model): `PILOT_REHEARSAL=1` runs the real tool loop, validation and stream with a scripted
   plan from your app (`rehearsal_plan=` in `make_router`, see `demo/site.py:plan`). The overlay shows a **Rehearsal** badge, so it is
   never passed off as the live model. Use it when the venue Wi-Fi dies, and say so.
3. **A pinned script, no model at all:**

   ```js
   VoicePilot.play({
     text: "[[1]] [[2]] Blue Current Fund should fund Kelpforge. [[3]] It scores 92: two farms already measure carbon. [[4]] Next step: send them the sensor data.",
     actions: [{id: 1, type: "navigate", path: "/startups/kelpforge"}, {id: 2, type: "highlight", target: "funder", caption: "Best funder"},
               {id: 3, type: "highlight", target: "why", caption: "Why it fits"}, {id: 4, type: "highlight", target: "next-step", caption: "Do this week"}],
   });
   ```

   Good for the recorded fallback video. It is a script: label it as one if you show it.

## 5. Stage checklist

- Put the question on the page as a chip (`<button data-pilot-ask="Show me who should fund Kelpforge">`), so the moment works even if the
  room is too loud for the microphone.
- Laptop volume up, tab audio unmuted, one tap on the page before the demo (browsers only start audio after a gesture).
- Chrome or Edge for the microphone (the Web Speech API); Safari works for the voice out, and typing always works.
- Keep the answer short: `ANSWER_SHAPE` caps it at about 70 words; a judge stops listening after 20 seconds.
- Check `/pilot/status` shows `"tts": true` and enough `tts_chars_left` (each tour costs about 400-450 characters).
