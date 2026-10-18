"""The demo's SAMPLE dataset. Every company and funder here is fictional and invented for this demo; no real people appear anywhere.

Scores are computed from three parts (thesis fit 0-40, stage fit 0-30, traction 0-30), so every number on screen has a visible reason.
"""
from __future__ import annotations

FUNDERS = {
    "blue-current": {"name": "Blue Current Fund", "kind": "Seed fund", "thesis": "ocean data and low-carbon shipping", "ticket": "EUR 250k-1M"},
    "north-basin": {"name": "North Basin Capital", "kind": "Series A fund", "thesis": "industrial ocean hardware with paying customers", "ticket": "EUR 1-4M"},
    "harbor-grants": {"name": "Harbor Grants Programme", "kind": "Public grant", "thesis": "early research with a coastal pilot partner", "ticket": "EUR 50-300k"},
}

STARTUPS = [
    {"slug": "kelpforge", "name": "Kelpforge", "sector": "Aquaculture", "stage": "Seed", "city": "Turku",
     "pitch": "Kelp farms that sell certified carbon removal alongside the harvest.", "funder": "blue-current",
     "parts": {"thesis": 37, "stage": 28, "traction": 27},
     "reasons": {"thesis": "Measured carbon data from two farms is exactly the ocean-data thesis.",
                 "stage": "Raising EUR 800k, inside the fund's seed ticket.",
                 "traction": "Two paid offtake letters and 14 months of sensor history."},
     "evidence": ["Pilot farm logbook, 14 months (sample)", "Two signed offtake letters (sample)", "Carbon method review by a third party (sample)"],
     "next": "Send Blue Current the sensor dataset and book a partner call this week."},
    {"slug": "hullsense", "name": "Hullsense", "sector": "Shipping", "stage": "Seed", "city": "Helsinki",
     "pitch": "Hull sensors that tell ferry operators when cleaning saves fuel.", "funder": "blue-current",
     "parts": {"thesis": 35, "stage": 26, "traction": 25},
     "reasons": {"thesis": "Fuel-saving data for ferries is low-carbon shipping.", "stage": "Seed round open, EUR 600k.",
                 "traction": "Running on three ferries; one renewal signed."},
     "evidence": ["Fuel logs from three ferries (sample)", "Renewal order (sample)"],
     "next": "Share the fuel-saving numbers per vessel with Blue Current."},
    {"slug": "saltgrid", "name": "Saltgrid", "sector": "Energy", "stage": "Series A", "city": "Bergen",
     "pitch": "Containerised wave-power units for fish farms off the grid.", "funder": "north-basin",
     "parts": {"thesis": 34, "stage": 27, "traction": 23},
     "reasons": {"thesis": "Industrial ocean hardware, already sold.", "stage": "Raising EUR 3M Series A.", "traction": "Five units in the water, two paying sites."},
     "evidence": ["Unit uptime report (sample)", "Two site contracts (sample)"],
     "next": "Prepare the unit economics per site for North Basin."},
    {"slug": "brinelight", "name": "Brinelight", "sector": "Water", "stage": "Pre-seed", "city": "Tallinn",
     "pitch": "Low-energy desalination membranes for island communities.", "funder": "harbor-grants",
     "parts": {"thesis": 33, "stage": 25, "traction": 18},
     "reasons": {"thesis": "Early membrane research with a coastal town as pilot partner.", "stage": "Grant-sized need, EUR 200k.",
                 "traction": "Lab results only; pilot partner agreed."},
     "evidence": ["Lab test summary (sample)", "Letter of intent from a pilot town (sample)"],
     "next": "Apply to the Harbor Grants spring call with the pilot letter attached."},
    {"slug": "driftmark", "name": "Driftmark", "sector": "Ocean data", "stage": "Seed", "city": "Turku",
     "pitch": "Drifting buoys that map microplastics for port authorities.", "funder": "blue-current",
     "parts": {"thesis": 30, "stage": 22, "traction": 17},
     "reasons": {"thesis": "Ocean data, but the buyers are public bodies.", "stage": "Seed, EUR 500k.", "traction": "One port pilot, unpaid."},
     "evidence": ["Port pilot report (sample)"],
     "next": "Turn the port pilot into a paid contract before pitching."},
    {"slug": "coralyte", "name": "Coralyte", "sector": "Aquaculture", "stage": "Pre-seed", "city": "Helsinki",
     "pitch": "Feed additives that cut disease losses in shrimp farms.", "funder": "harbor-grants",
     "parts": {"thesis": 26, "stage": 24, "traction": 14},
     "reasons": {"thesis": "Research stage with a farm partner.", "stage": "Small grant need.", "traction": "Tank trials only."},
     "evidence": ["Tank trial notes (sample)"],
     "next": "Line up a coastal farm as pilot partner for the grant."},
    {"slug": "tidaloom", "name": "Tidaloom", "sector": "Materials", "stage": "Seed", "city": "Bergen",
     "pitch": "Recycled fishing nets turned into textile yarn.", "funder": "north-basin",
     "parts": {"thesis": 22, "stage": 18, "traction": 20},
     "reasons": {"thesis": "Ocean materials, but not hardware.", "stage": "Seed, below the Series A ticket.", "traction": "Paying fashion customers."},
     "evidence": ["Customer orders (sample)"],
     "next": "Look for a seed fund first; North Basin fits after Series A."},
    {"slug": "nereon", "name": "Nereon Fuels", "sector": "Shipping", "stage": "Pre-seed", "city": "Tallinn",
     "pitch": "Algae-based marine fuel blends.", "funder": "harbor-grants",
     "parts": {"thesis": 20, "stage": 20, "traction": 9},
     "reasons": {"thesis": "Fuel research, no coastal pilot yet.", "stage": "Grant-sized.", "traction": "Lab batches only."},
     "evidence": ["Lab batch log (sample)"],
     "next": "Find a pilot vessel before applying."},
]

for s in STARTUPS:
    s["score"] = sum(s["parts"].values())
STARTUPS.sort(key=lambda s: -s["score"])
for i, s in enumerate(STARTUPS, 1):
    s["rank"] = i
BY_SLUG = {s["slug"]: s for s in STARTUPS}
SECTORS = sorted({s["sector"] for s in STARTUPS})


def find(name_or_slug: str):
    q = (name_or_slug or "").strip().lower()
    return BY_SLUG.get(q) or next((s for s in STARTUPS if s["name"].lower() == q or s["name"].lower().split()[0] == q), None)
