#!/usr/bin/env python3
"""Build supabase/seed_update2.sql (onboarding prospects) from the JSON files in Data/.

The output holds names and phone numbers, so it is listed in .gitignore and never committed.
Run from the project folder:  python3 tools/make_seed_update2.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "Data"
OUT = ROOT / "supabase" / "seed_update2.sql"

YEARS = {"freshmen": "Freshmen", "freshman": "Freshmen", "soph": "Soph", "sophomore": "Soph",
         "junior": "Junior", "senior": "Senior"}


def q(value):
    if value is None or value == "":
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def arr(values):
    return "array[" + ", ".join(q(v) for v in values) + "]::text[]"


def year(value):
    return YEARS.get(str(value or "").strip().lower())


pipeline = json.loads((DATA / "prospects_pipeline.json").read_text())
holding = json.loads((DATA / "prospects_holding_list.json").read_text())

lines = [
    "-- Leader Directory, update 2 seed: onboarding prospects. Run AFTER migration_002.sql, one time only.",
    "-- Paste this whole file into the Supabase SQL editor and press Run.",
    "",
    "begin;",
    "",
    "do $$ begin",
    "  if exists (select 1 from public.prospects) then",
    "    raise exception 'The prospects table already has rows. This file was already run; nothing was changed.';",
    "  end if;",
    "end $$;",
    "",
    "-- Staging rows; points of contact are first names matched to the roster below.",
    "create temp table _p (",
    "  n int, name text, phone text, church text, referred_by text, year text, has_car boolean, hometown text,",
    "  rating int, site_interest text, pocs text[], note text, next_step text, stage text, status text,",
    "  holding_list text, reason text, needs_review text[]",
    ") on commit drop;",
    "",
    "insert into _p values",
]
rows = []
n = 0
for p in pipeline:
    n += 1
    rows.append("  (" + ", ".join([
        str(n), q(p["name"]), q(p["phone"]), q(p["church"]), q(p["referred_by"]), q(year(p["year"])),
        q(bool(p["has_car"])), q(p["hometown"]), q(p["rating"]), q(p["site_interest"]),
        arr(p["points_of_contact"]), q(p["notes"]), q(p["next_step"]), q(p["stage"]), "'pipeline'",
        "null", "null", arr(p["needs_review"]),
    ]) + ")")
for p in holding:
    n += 1
    rows.append("  (" + ", ".join([
        str(n), q(p["name"]), q(p["phone"]), "null", q(p["referred_by"]), q(year(p["year"])),
        "false", q(p["hometown"]), "null", "null", arr([]),
        q(f"Moved to the holding list from the spreadsheet tab \"{p['source_tab']}\". Reason: {p['reason']}"),
        "null", "'Not Sent'", "'holding'", q(p["list"]), q(p["reason"]), arr([]),
    ]) + ")")
lines.append(",\n".join(rows) + ";")
lines += [
    "",
    "-- A contact name is linked only when exactly one leader has that first name.",
    "create temp table _poc on commit drop as",
    "  select p.n, c.poc,",
    "    (select count(*) from public.leaders l where lower(l.first) = lower(c.poc)) as hits,",
    "    (select min(l.id::text)::uuid from public.leaders l where lower(l.first) = lower(c.poc)) as leader_id",
    "  from _p p, unnest(p.pocs) as c(poc);",
    "",
    "create temp table _ids on commit drop as select n, gen_random_uuid() as id from _p;",
    "",
    "insert into public.prospects (id, name, phone, church, referred_by, year, has_car, hometown, rating,",
    "    site_interest, poc_ids, poc_other, next_step, stage, status, holding_list, reason, needs_review, created_by)",
    "  select i.id, p.name, p.phone, p.church, p.referred_by, p.year, p.has_car, p.hometown, p.rating, p.site_interest,",
    "    coalesce((select array_agg(leader_id) from _poc c where c.n = p.n and c.hits = 1), '{}'),",
    "    (select string_agg(poc, ', ') from _poc c where c.n = p.n and c.hits <> 1),",
    "    p.next_step, p.stage, p.status, p.holding_list, p.reason,",
    "    p.needs_review || coalesce((select array_agg('Point of contact \"' || poc || '\" matches ' ||",
    "        case when hits = 0 then 'no leader' else hits || ' leaders' end || '; pick the right one')",
    "      from _poc c where c.n = p.n and c.hits <> 1), '{}'),",
    "    'Imported from spreadsheet'",
    "  from _p p join _ids i using (n);",
    "",
    "insert into public.prospect_notes (prospect_id, body, author)",
    "  select i.id, p.note, 'Imported from spreadsheet' from _p p join _ids i using (n) where p.note is not null;",
    "",
    "insert into public.prospect_history (prospect_id, to_label, changed_by)",
    "  select i.id, case when p.status = 'holding' then 'Holding list: ' || p.holding_list else p.stage end,",
    "    'Imported from spreadsheet' from _p p join _ids i using (n);",
    "",
    "commit;",
    "",
]

OUT.write_text("\n".join(lines))
print(f"Wrote {OUT.relative_to(ROOT)}: {len(pipeline)} pipeline, {len(holding)} holding")
