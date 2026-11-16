// Edge Function: onboarding-email
// Sends two emails from the owner's Gmail account:
//   kind "stall"  : the daily summary of stalled prospects, to leaders tagged "Onboarding Team"
//   kind "export" : the Monday CSV of everyone removed from the pipeline, to the admins
//
// Scheduled runs (see supabase/cron.sql) only send around 7:30 AM Central, and at
// most once a day per kind. A signed-in admin can also call it from the app as a
// test; a test goes to that admin's own email only.
//
// Secrets, set by the owner in the Supabase dashboard (never in code or chat):
//   GMAIL_USER          the Gmail address to send from
//   GMAIL_APP_PASSWORD  a Gmail App Password for that account
//
// Deploy with "Verify JWT" turned OFF; this function checks the caller itself.
import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const STAGES = ["Not Sent", "Sent App", "Application Review", "Background Check", "Prerequisites", "Final Decision"];
const DEFAULTS: Record<string, number> = {
  "Not Sent": 3, "Sent App": 4, "Application Review": 3, "Background Check": 5, "Prerequisites": 5, "Final Decision": 3,
};
const TAG = "Onboarding Team";
const TZ = "America/Chicago";

// The date, hour and weekday in Central time, whatever the season.
function central(at: Date | string = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short",
    }).formatToParts(new Date(at)).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday: parts.weekday };
}
const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const html = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const csvCell = (v: unknown) => {
  let s = String(v ?? "");
  if (/^[=+@\t]/.test(s)) s = `'${s}`; // keep spreadsheets from treating text as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  try {
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const body = await req.json().catch(() => ({}));
    const kind = body.kind === "export" ? "export" : "stall";
    const today = central();

    // A signed-in admin means "test": send to them only, right now.
    let tester: string | null = null;
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (token.split(".").length === 3) {
      const { data } = await db.auth.getUser(token);
      const email = data?.user?.email?.toLowerCase();
      if (email) {
        const { data: row } = await db.from("allowed_emails").select("is_admin").ilike("email", email).maybeSingle();
        if (row?.is_admin) tester = email;
      }
    }

    if (!tester) {
      // Scheduled run. Anyone can reach this address, so it only ever does the
      // one planned send: in the 7 AM Central hour, once per day per kind.
      if (today.hour !== 7) return json({ sent: 0, message: "Not the 7 AM Central hour; nothing sent." });
      if (kind === "export" && today.weekday !== "Mon") return json({ sent: 0, message: "The export only goes out on Mondays." });
      const { error } = await db.from("email_log").insert({ kind, sent_on: today.date, detail: "started" });
      if (error) return json({ sent: 0, message: "Already handled today." });
    }
    const finish = async (recipients: number, detail: string) => {
      if (!tester) await db.from("email_log").update({ recipients, detail }).eq("kind", kind).eq("sent_on", today.date);
      return json({ sent: recipients, message: detail });
    };

    const user = Deno.env.get("GMAIL_USER");
    const pass = Deno.env.get("GMAIL_APP_PASSWORD");
    if (!user || !pass) {
      return await finish(0, "Email is not set up yet: add the GMAIL_USER and GMAIL_APP_PASSWORD secrets in Supabase (see the README).");
    }
    // Gmail over port 465 (TLS from the start). Supabase blocks ports 25 and 587.
    const mailer = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
    const from = `"Leader Directory" <${user}>`;

    const { data: prospects, error: pErr } = await db.from("prospects").select("*");
    if (pErr) throw pErr;
    const { data: leaders, error: lErr } = await db.from("leaders").select("id, name, email, tags");
    if (lErr) throw lErr;

    if (kind === "stall") {
      const { data: setting } = await db.from("app_settings").select("value").eq("key", "stall_thresholds").maybeSingle();
      const limit = (stage: string) => Math.min(5, Math.max(2, Number(setting?.value?.[stage]) || DEFAULTS[stage] || 3));
      const stalled = (prospects || [])
        .filter((p) => p.status === "pipeline")
        .map((p) => ({ p, days: Math.max(0, dayDiff(central(p.stage_changed_at).date, today.date)) }))
        .filter((x) => x.days >= limit(x.p.stage))
        .sort((a, b) => STAGES.indexOf(a.p.stage) - STAGES.indexOf(b.p.stage) || b.days - a.days);

      const to = tester ? [tester] : [...new Set((leaders || [])
        .filter((l) => (l.tags || []).includes(TAG) && l.email).map((l) => String(l.email).trim().toLowerCase()))];
      if (!stalled.length && !tester) return await finish(0, "No one is stalled; nothing sent.");
      if (!to.length) return await finish(0, `No one tagged ${TAG} has an email on file; nothing sent.`);

      const ids = stalled.map((x) => x.p.id);
      const { data: notes } = ids.length
        ? await db.from("prospect_notes").select("prospect_id, body, author, created_at").in("prospect_id", ids).order("created_at", { ascending: false })
        : { data: [] };
      const nameOf = new Map((leaders || []).map((l) => [l.id, l.name]));
      const rows = stalled.map(({ p, days }) => {
        const note = (notes || []).find((n) => n.prospect_id === p.id);
        return {
          name: p.name, stage: p.stage, days,
          contacts: [...(p.poc_ids || []).map((id: string) => nameOf.get(id)), p.poc_other].filter(Boolean).join(", ") || "None",
          note: note ? `${note.body} (${note.author || "Unknown"}, ${central(note.created_at).date})` : "No notes yet",
        };
      });
      const subject = `${tester ? "[Test] " : ""}Onboarding: ${rows.length} stalled prospect${rows.length === 1 ? "" : "s"}`;
      const text = rows.length
        ? rows.map((r) => `${r.name}\n  Stage: ${r.stage}\n  Days stalled: ${r.days}\n  Points of contact: ${r.contacts}\n  Latest note: ${r.note}`).join("\n\n")
        : "No prospects are stalled right now. This is a test, so it was sent anyway.";
      const table = rows.length ? `
        <table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
          <tr style="background:#eef2f6"><th align="left">Name</th><th align="left">Stage</th><th align="left">Days stalled</th><th align="left">Points of contact</th><th align="left">Latest note</th></tr>
          ${rows.map((r) => `<tr><td>${html(r.name)}</td><td>${html(r.stage)}</td><td>${r.days}</td><td>${html(r.contacts)}</td><td>${html(r.note)}</td></tr>`).join("")}
        </table>` : `<p>${html(text)}</p>`;
      await mailer.sendMail({
        from, to, subject,
        text: `Stalled prospects as of ${today.date}\n\n${text}\n\nOpen the Onboarding page in the Leader Directory to update them.`,
        html: `<p style="font-family:sans-serif">Stalled prospects as of ${today.date}</p>${table}<p style="font-family:sans-serif;color:#555">Open the Onboarding page in the Leader Directory to update them.</p>`,
      });
      return await finish(to.length, tester ? `Test reminder sent to ${tester}.` : `Reminder sent to ${to.length} people.`);
    }

    // kind === "export": everyone removed from the pipeline.
    const { data: admins, error: aErr } = await db.from("allowed_emails").select("email").eq("is_admin", true);
    if (aErr) throw aErr;
    const to = tester ? [tester] : (admins || []).map((a) => a.email);
    if (!to.length) return await finish(0, "No admins to send to.");
    const removed = (prospects || [])
      .filter((p) => p.status === "released" || p.status === "holding")
      .sort((a, b) => String(a.status).localeCompare(String(b.status)) || String(a.holding_list).localeCompare(String(b.holding_list)) || a.name.localeCompare(b.name));
    const header = ["Name", "List", "Reason", "Phone", "Year", "Hometown", "Church", "Referred by", "Site interest", "Last stage", "Date moved"];
    const lines = [header, ...removed.map((p) => [
      p.name, p.status === "released" ? "Released" : `Holding: ${p.holding_list}`, p.reason, p.phone, p.year, p.hometown,
      p.church, p.referred_by, p.site_interest, p.stage, central(p.status_changed_at).date,
    ])].map((cells) => cells.map(csvCell).join(","));
    const count = (f: (p: any) => boolean) => removed.filter(f).length;
    const summary = `Released: ${count((p) => p.status === "released")}\n` +
      `Holding, Next Semester: ${count((p) => p.holding_list === "Next Semester")}\n` +
      `Holding, Keep in Mind: ${count((p) => p.holding_list === "Keep in Mind")}`;
    await mailer.sendMail({
      from, to,
      subject: `${tester ? "[Test] " : ""}Onboarding weekly export, ${today.date}`,
      text: `Attached is everyone removed from the onboarding pipeline as of ${today.date}.\n\n${summary}\n\nOpen the attachment in Excel, Numbers or Google Sheets.`,
      attachments: [{ filename: `removed-from-pipeline-${today.date}.csv`, content: "﻿" + lines.join("\r\n") + "\r\n", contentType: "text/csv; charset=utf-8" }],
    });
    return await finish(to.length, tester ? `Test export sent to ${tester}.` : `Export sent to ${to.length} admins.`);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
