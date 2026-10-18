"""The demo site: three server-rendered pages over the SAMPLE dataset, the data tools Aava may call, and the rehearsal plan."""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.templating import Jinja2Templates

from server.registry import Registry

from . import data

HERE = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(HERE / "templates"))
router = APIRouter()
APP_NAME = "Matchboard (sample)"
APP_DESC = ("Matchboard ranks which fictional ocean-tech startups each fictional funder should meet, with a score out of 100 made of thesis fit "
            "(0-40), stage fit (0-30) and traction (0-30). All companies and funders are invented sample data; say so if asked.")


def _page(request: Request, name: str, **ctx):
    return templates.TemplateResponse(request, name, {"startups": data.STARTUPS, "funders": data.FUNDERS, "sectors": data.SECTORS, **ctx})


@router.get("/", response_class=HTMLResponse)
def home(request: Request):
    return _page(request, "home.html", page="home", top=data.STARTUPS[0])


@router.get("/matches", response_class=HTMLResponse)
def matches(request: Request):
    return _page(request, "matches.html", page="matches")


@router.get("/startups/{slug}", response_class=HTMLResponse)
def startup(request: Request, slug: str):
    s = data.BY_SLUG.get(slug)
    if not s:
        return HTMLResponse("<!doctype html><title>Not found</title><p>No such sample startup.</p>", status_code=404)
    return _page(request, "startup.html", page="startup", s=s, f=data.FUNDERS[s["funder"]])


@router.get("/pilot.manifest.json")
def manifest():
    return FileResponse(HERE / "static" / "pilot.manifest.json", media_type="application/json")


# ---- data tools ---------------------------------------------------------------------------------------------------------------------------
registry = Registry()


def _brief(s: dict) -> dict:
    f = data.FUNDERS[s["funder"]]
    return {"rank": s["rank"], "name": s["name"], "path": f"/startups/{s['slug']}", "sector": s["sector"], "stage": s["stage"], "score": s["score"],
            "best_funder": f["name"], "parts": s["parts"]}


@registry.tool("list_matches", "The ranked startup-to-funder matches, best first, optionally filtered. Sample data.",
               {"type": "object", "properties": {"sector": {"type": "string"}, "min_score": {"type": "integer"}, "limit": {"type": "integer"}}},
               label="reading the match list")
def list_matches(args):
    rows = [s for s in data.STARTUPS
            if (not args.get("sector") or s["sector"].lower() == str(args["sector"]).lower()) and s["score"] >= int(args.get("min_score") or 0)]
    return {"matches": [_brief(s) for s in rows[: int(args.get("limit") or 8)]], "total": len(rows)}


@registry.tool("get_startup", "One startup's full record: score parts with reasons, evidence, best funder and next step. Sample data.",
               {"type": "object", "properties": {"name": {"type": "string", "description": "name or slug"}}, "required": ["name"]},
               label="opening the record")
def get_startup(args):
    s = data.find(args.get("name", ""))
    if not s:
        return {"error": "no such startup", "known": [x["name"] for x in data.STARTUPS]}
    return {**_brief(s), "pitch": s["pitch"], "city": s["city"], "reasons": s["reasons"], "evidence": s["evidence"], "next_step": s["next"],
            "funder": data.FUNDERS[s["funder"]]}


# ---- rehearsal plan (PILOT_REHEARSAL=1): the same tour, scripted, for a dead network ---------------------------------------------------
def plan(question: str, manifest: dict) -> list[dict]:
    q = question.lower()
    named = next((s for s in data.STARTUPS if re.search(r"\b" + re.escape(s["name"].lower().split()[0]) + r"\b", q)), None)
    if named and ("fund" in q or "who" in q):
        f = data.FUNDERS[named["funder"]]
        return [{"say": f"{f['name']} should fund {named['name']}.", "do": [("navigate", {"path": f"/startups/{named['slug']}"}),
                                                                         ("highlight", {"target": "funder", "caption": f["name"]})]},
                {"say": f"It scores {named['score']} out of 100: {named['reasons']['thesis']}", "do": [("highlight", {"target": "why", "caption": "Why it fits"})]},
                {"say": named["next"], "do": [("highlight", {"target": "next-step", "caption": "Next step"})]}]
    if "filter" in q or "aquaculture" in q or "sector" in q:
        return [{"say": "Here are the aquaculture matches only.", "do": [("navigate", {"path": "/matches"}), ("fill", {"target": "filter-sector", "value": "Aquaculture"})]},
                {"say": "Kelpforge leads them at 92.", "do": [("highlight", {"target": "match-1", "caption": "Kelpforge, 92"})]}]
    if "best" in q or "top" in q or "why" in q:
        top = data.STARTUPS[0]
        f = data.FUNDERS[top["funder"]]
        return [{"say": f"The best match is {top['name']} with {f['name']}, at {top['score']} out of 100.",
                 "do": [("navigate", {"path": "/matches"}), ("highlight", {"target": "match-1", "caption": f"Best match: {top['score']}"})]},
                {"say": f"Why: {top['reasons']['thesis']} {top['reasons']['traction']}",
                 "do": [("navigate", {"path": f"/startups/{top['slug']}"}), ("highlight", {"target": "why", "caption": "Why it fits"})]},
                {"say": f"Next step: {top['next']}", "do": [("highlight", {"target": "next-step", "caption": "Do this week"})]}]
    return [{"say": "I can take you to the best match, explain a score, or filter the list by sector. What would you like to see?",
             "do": [("highlight", {"target": "ask-chips", "caption": "Try one of these"})] if any(t["id"] == "ask-chips" for t in manifest["targets"]) else []}]
