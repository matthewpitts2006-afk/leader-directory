// Data access. Talks to Supabase when config.js is filled in.
// On your own computer (localhost) with config.js still empty, it runs a private
// demo that keeps everything in this browser, so the app can be tried before setup.

const cfg = window.LEADER_DIRECTORY_CONFIG || {};
const url = String(cfg.SUPABASE_URL || '').trim();
const key = String(cfg.SUPABASE_ANON_KEY || '').trim();
const configured = /^https:\/\/\S+$/.test(url) && key.length > 20 && !/PASTE/.test(url + key);
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
// Add ?demo to the address on your own computer to try the demo even when config.js is filled in.
const forceDemo = isLocal && new URLSearchParams(location.search).has('demo');

export const mode = forceDemo ? 'demo' : configured ? 'supabase' : isLocal ? 'demo' : 'unconfigured';

const PRIMARY_KEY = { allowed_emails: 'email', app_settings: 'key', event_names: 'name', availability_status: 'leader_id' };
const TABLES = [
  'allowed_emails', 'leaders', 'school_events', 'visits', 'availability', 'availability_status',
  'event_names', 'app_settings', 'prospects', 'prospect_notes', 'prospect_history',
];
let sb = null;
let demo = null;
const DEMO_KEY = 'leader-directory-demo-v2';
const DEMO_USER = 'demo@example.com';

export async function init() {
  if (mode === 'supabase') {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    // The session is kept on this device and renewed automatically until the leader signs out.
    sb = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  } else if (mode === 'demo') {
    try { demo = JSON.parse(localStorage.getItem(DEMO_KEY)); } catch { demo = null; }
    if (!demo) {
      demo = await buildDemo();
      saveDemo();
    }
  }
}
const saveDemo = () => { try { localStorage.setItem(DEMO_KEY, JSON.stringify(demo)); } catch { /* private window */ } };

async function buildDemo() {
  const get = (file) => fetch(file).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const [leaders, events, pipeline, holding] = await Promise.all([
    get('Data/leaders.json'), get('Data/school_events_jan-may_2027.json'),
    get('Data/prospects_pipeline.json'), get('Data/prospects_holding_list.json'),
  ]);
  const now = new Date().toISOString();
  const d = Object.fromEntries(TABLES.map((t) => [t, []]));
  d.allowed_emails = [{ email: DEMO_USER, is_admin: true, note: 'Demo', must_change_password: false }];
  d.leaders = leaders.map((l) => ({ id: crypto.randomUUID(), tags: [], ...l }));
  d.school_events = events.map(({ end, ...e }) => ({ id: crypto.randomUUID(), ...e, end_date: end || e.date }));
  const years = { freshman: 'Freshmen', freshmen: 'Freshmen', soph: 'Soph', junior: 'Junior', senior: 'Senior' };
  const add = (p, extra, note) => {
    const id = crypto.randomUUID();
    const pocs = (p.points_of_contact || []).map((name) => ({
      name, hits: d.leaders.filter((l) => (l.first || '').toLowerCase() === name.toLowerCase()),
    }));
    const loose = pocs.filter((c) => c.hits.length !== 1);
    d.prospects.push({
      id, name: p.name, phone: p.phone || null, church: p.church || null, referred_by: p.referred_by || null,
      year: years[String(p.year || '').toLowerCase()] || null, has_car: !!p.has_car, hometown: p.hometown || null,
      rating: p.rating || null, site_interest: p.site_interest || null,
      poc_ids: pocs.filter((c) => c.hits.length === 1).map((c) => c.hits[0].id),
      poc_other: loose.map((c) => c.name).join(', ') || null, next_step: p.next_step || null,
      stage: p.stage || 'Not Sent', stage_changed_at: now, status: 'pipeline', holding_list: null, reason: null,
      status_changed_at: now, leader_id: null, created_by: 'Imported from spreadsheet', created_at: now,
      needs_review: [...(p.needs_review || []), ...loose.map((c) =>
        `Point of contact "${c.name}" matches ${c.hits.length ? `${c.hits.length} leaders` : 'no leader'}; pick the right one`)],
      ...extra,
    });
    if (note) d.prospect_notes.push({ id: crypto.randomUUID(), prospect_id: id, body: note, author: 'Imported from spreadsheet', created_at: now });
  };
  pipeline.forEach((p) => add(p, {}, p.notes));
  holding.forEach((p) => add(p, { status: 'holding', holding_list: p.list, reason: p.reason },
    `Moved to the holding list from the spreadsheet tab "${p.source_tab}". Reason: ${p.reason}`));
  return d;
}

// ---- sign-in
export async function currentEmail() {
  if (mode === 'demo') return DEMO_USER;
  const { data } = await sb.auth.getSession();
  return data.session?.user?.email || null;
}
export function onAuthChange(cb) {
  if (mode !== 'supabase') return;
  // Supabase asks that no other Supabase call runs inside this callback, hence the timeout.
  sb.auth.onAuthStateChange((_event, session) => setTimeout(() => cb(session?.user?.email || null), 0));
}
export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}
// Sets the signed-in leader's own password. Supabase keeps only a hash of it.
export async function changePassword(password) {
  if (mode === 'demo') {
    demo.allowed_emails.forEach((r) => { if (r.email === DEMO_USER) r.must_change_password = false; });
    saveDemo();
    return;
  }
  const { error } = await sb.auth.updateUser({ password });
  if (error) throw error;
  check(await sb.rpc('password_changed'));
}
export async function signOut() {
  if (mode === 'demo') { localStorage.removeItem(DEMO_KEY); location.reload(); return; }
  await sb.auth.signOut();
}

// ---- server functions (Supabase Edge Functions) and database functions
export async function callFunction(name, body) {
  if (mode === 'demo') return demoFunction(name, body);
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* no details */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
export async function rpc(name, args) {
  if (mode === 'demo') return demoRpc(name, args);
  return check(await sb.rpc(name, args));
}

function demoFunction(name, body) {
  if (name === 'admin-users') {
    const email = String(body.email || '').toLowerCase();
    if (body.action === 'remove') {
      demo.allowed_emails = demo.allowed_emails.filter((r) => r.email !== email);
      saveDemo();
      return {};
    }
    const row = demo.allowed_emails.find((r) => r.email === email);
    if (row) Object.assign(row, { must_change_password: true });
    else demo.allowed_emails.push({ email, is_admin: !!body.is_admin, must_change_password: true });
    saveDemo();
    return { temp_password: 'Demo-Temp-1234' };
  }
  if (name === 'onboarding-email') return { sent: 0, message: 'Demo mode: no email is sent from this computer.' };
  throw new Error(`Unknown function ${name}`);
}
function demoRpc(name, args) {
  if (name === 'add_prospect_to_roster') {
    const p = demo.prospects.find((x) => x.id === args.p_id);
    const [first, ...rest] = p.name.trim().split(/\s+/);
    const leader = {
      id: crypto.randomUUID(), first, last: rest.join(' '), name: p.name.trim(), assignment: args.p_assignment || 'TBD',
      church: p.church, phone: p.phone, email: null, is_team_lead: false, tags: [],
    };
    demo.leaders.push(leader);
    demo.prospect_history.push({
      id: crypto.randomUUID(), prospect_id: p.id, from_label: p.stage, to_label: `Added to roster (${leader.assignment})`,
      changed_by: DEMO_USER, changed_at: new Date().toISOString(),
    });
    Object.assign(p, { status: 'added', leader_id: leader.id, status_changed_at: new Date().toISOString() });
    saveDemo();
    return leader.id;
  }
  throw new Error(`Unknown database function ${name}`);
}

// ---- tables. `match` is { column: value } or { column: [values] }.
const matches = (row, match) =>
  Object.entries(match).every(([k, v]) => (Array.isArray(v) ? v.includes(row[k]) : row[k] === v));
const applyMatch = (query, match) => {
  for (const [k, v] of Object.entries(match)) query = Array.isArray(v) ? query.in(k, v) : query.eq(k, v);
  return query;
};
const check = ({ data, error }) => { if (error) throw error; return data; };

export async function list(table) {
  if (mode === 'demo') return structuredClone(demo[table] || []);
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = check(await sb.from(table).select('*').order(PRIMARY_KEY[table] || 'id').range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
export async function insert(table, rows) {
  if (mode === 'demo') {
    const added = rows.map((r) => ({ id: crypto.randomUUID(), ...r }));
    demo[table].push(...added);
    saveDemo();
    return structuredClone(added);
  }
  return check(await sb.from(table).insert(rows).select());
}
// Insert, or replace the row that has the same primary key.
export async function upsert(table, rows) {
  if (mode === 'demo') {
    const pk = PRIMARY_KEY[table] || 'id';
    for (const r of rows) {
      const at = demo[table].findIndex((x) => x[pk] === r[pk]);
      if (at >= 0) Object.assign(demo[table][at], r); else demo[table].push({ ...r });
    }
    saveDemo();
    return;
  }
  check(await sb.from(table).upsert(rows));
}
export async function update(table, match, patch) {
  if (mode === 'demo') {
    demo[table].forEach((row) => { if (matches(row, match)) Object.assign(row, patch); });
    saveDemo();
    return;
  }
  check(await applyMatch(sb.from(table).update(patch), match));
}
export async function remove(table, match) {
  if (mode === 'demo') {
    demo[table] = demo[table].filter((row) => !matches(row, match));
    saveDemo();
    return;
  }
  check(await applyMatch(sb.from(table).delete(), match));
}
