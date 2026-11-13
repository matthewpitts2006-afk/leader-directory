#!/usr/bin/env python3
"""Build supabase/seed.sql from the JSON files in Data/.

The output holds leader names, so it is listed in .gitignore and never committed.
Run from the project folder:  python3 tools/make_seed.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "Data"
OUT = ROOT / "supabase" / "seed.sql"


def q(value):
    if value is None or value == "":
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    return "'" + str(value).replace("'", "''") + "'"


leaders = json.loads((DATA / "leaders.json").read_text())
events = json.loads((DATA / "school_events_jan-may_2027.json").read_text())

lines = [
    "-- Leader Directory seed data. Run AFTER schema.sql, one time only.",
    "-- STEP 1: on the line below, replace YOUR_EMAIL_HERE with the email you will sign in with.",
    "-- STEP 2: paste this whole file into the Supabase SQL editor and press Run.",
    "",
    "begin;",
    "",
    "create temp table _owner on commit drop as select lower(trim('YOUR_EMAIL_HERE')) as email;",
    "",
    "do $$ begin",
    "  if (select email from _owner) = lower('YOUR_' || 'EMAIL_HERE') then",
    "    raise exception 'Replace YOUR_EMAIL_HERE near the top of this file with your email, then run it again.';",
    "  end if;",
    "  if exists (select 1 from public.leaders) then",
    "    raise exception 'The leaders table already has rows. This file was already run; nothing was changed.';",
    "  end if;",
    "end $$;",
    "",
    "insert into public.allowed_emails (email, is_admin, note)",
    "  select email, true, 'Owner' from _owner",
    "  on conflict (email) do update set is_admin = true;",
    "",
    "insert into public.leaders (first, last, name, assignment, church, is_team_lead, phone, email) values",
]
lines.append(",\n".join(
    "  (" + ", ".join([
        q(p["first"]) if p["first"] else "''",
        q(p["last"]) if p["last"] else "''",
        q(p["name"]), q(p["assignment"]), q(p["church"]),
        q(bool(p["is_team_lead"])), q(p["phone"]), q(p["email"]),
    ]) + ")"
    for p in leaders
) + ";")
lines += [
    "",
    'insert into public.school_events (date, end_date, title, category, schools, district, "time", location, note, source) values',
]
lines.append(",\n".join(
    "  (" + ", ".join([
        q(e["date"]), q(e["end"] or e["date"]), q(e["title"]), q(e["category"]),
        q(e["schools"]), q(e["district"]), q(e["time"]), q(e["location"]),
        q(e["note"]), q(e["source"]),
    ]) + ")"
    for e in events
) + ";")
lines += ["", "commit;", ""]

OUT.write_text("\n".join(lines))
print(f"Wrote {OUT.relative_to(ROOT)}: {len(leaders)} leaders, {len(events)} events")
