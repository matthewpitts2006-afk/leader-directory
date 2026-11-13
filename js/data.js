// Data access. Talks to Supabase when config.js is filled in.
// On your own computer (localhost) with config.js still empty, it runs a private
// demo that keeps everything in this browser, so the app can be tried before setup.

const cfg = window.LEADER_DIRECTORY_CONFIG || {};
const url = String(cfg.SUPABASE_URL || '').trim();
const key = String(cfg.SUPABASE_ANON_KEY || '').trim();
const configured = /^https:\/\/\S+$/.test(url) && key.length > 20 && !/PASTE/.test(url + key);
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

export const mode = configured ? 'supabase' : isLocal ? 'demo' : 'unconfigured';

const PRIMARY_KEY = { allowed_emails: 'email' };
let sb = null;
let demo = null;
const DEMO_KEY = 'leader-directory-demo-v1';
const DEMO_USER = 'demo@example.com';

export async function init() {
  if (mode === 'supabase') {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    sb = createClient(url, key, { auth: { flowType: 'implicit', detectSessionInUrl: true, persistSession: true } });
  } else if (mode === 'demo') {
    try { demo = JSON.parse(localStorage.getItem(DEMO_KEY)); } catch { demo = null; }
    if (!demo) {
      const get = (file) => fetch(file).then((r) => (r.ok ? r.json() : [])).catch(() => []);
      const [leaders, events] = await Promise.all([get('Data/leaders.json'), get('Data/school_events_jan-may_2027.json')]);
      demo = {
        allowed_emails: [{ email: DEMO_USER, is_admin: true, note: 'Demo' }],
        leaders: leaders.map((l) => ({ id: crypto.randomUUID(), ...l })),
        school_events: events.map(({ end, ...e }) => ({ id: crypto.randomUUID(), ...e, end_date: end || e.date })),
        visits: [],
      };
      saveDemo();
    }
  }
}
const saveDemo = () => { try { localStorage.setItem(DEMO_KEY, JSON.stringify(demo)); } catch { /* private window */ } };

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
export async function sendMagicLink(email) {
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true },
  });
  if (error) throw error;
}
export async function signOut() {
  if (mode === 'demo') { localStorage.removeItem(DEMO_KEY); location.reload(); return; }
  await sb.auth.signOut();
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
  if (mode === 'demo') return structuredClone(demo[table]);
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
    return added;
  }
  return check(await sb.from(table).insert(rows).select());
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
