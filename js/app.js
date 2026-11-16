import {
  SCHOOLS, SCHOOL_NAMES, schoolByName, ASSIGNMENTS, VISIT_TYPES, EVENT_CATEGORIES, CATEGORIES, BLOCKING,
  CAT_CLASS, LAST_DAY_FALLBACK, EVENING_START, esc, toDate, toIso, addDays, todayIso, fmtDate, weekdayName,
  parseTime, fmtTime, weeklyDates, schoolListLabel, downloadIcs, googleCalUrl,
  GROUPS, SITES, TEAMS, ONBOARDING_TAG, DEFAULT_SEMESTER_STARTS,
} from './util.js';
import * as db from './data.js';
import { ctx } from './ctx.js';
import * as avail from './availability.js';
import * as onb from './onboarding.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');
const dlg = $('#dlg');
const desktop = () => matchMedia('(min-width: 860px)').matches;

const S = {
  email: null,
  isAdmin: false,
  leaders: [],
  events: [],
  visits: [],
  allowed: [],
  me: null,          // the signed-in person's own roster row, matched by email
  availability: [],  // weekly time blocks
  availStatus: [],   // when each leader's availability was last saved
  eventNames: [],    // custom "Other" event names
  settings: {},      // app_settings as { key: value }
  prospects: [],
  notes: [],
  history: [],
  onb: { tab: 'pipeline', view: desktop() ? 'board' : 'list' },
  blocked: new Map(), // "school|date" -> { category, title }
  cal: {
    view: desktop() ? 'month' : 'list',
    month: null,
    day: null,
    limit: 40,
    filtersOpen: false,
    filters: { schools: new Set(), cats: new Set(), homeOnly: false, tod: 'any' },
  },
};

// ------------------------------------------------------------------ small UI helpers

let toastTimer;
function toast(msg, bad = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 7000 : 3000);
}
const errText = (e) => e?.message || String(e);

function openDialog(html) {
  dlg.innerHTML = html;
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
}
const closeDialog = () => dlg.open && dlg.close();

const opts = (values, selected) =>
  values.map((v) => `<option${v === selected ? ' selected' : ''}>${esc(v)}</option>`).join('');

// ------------------------------------------------------------------ welcome / sign-in

function showWelcome(state, extra = '') {
  $('#app').hidden = true;
  $('#welcome').hidden = false;
  const body = $('#welcome-body');
  if (state === 'loading') {
    body.innerHTML = '<div class="spinner" role="status" aria-label="Loading"></div>';
  } else if (state === 'signin') {
    body.innerHTML = `
      <form id="signin" class="stack">
        <label>Email
          <input type="email" name="email" required autocomplete="username" inputmode="email" placeholder="you@example.com">
        </label>
        <label>Password
          <input type="password" name="password" required autocomplete="current-password">
        </label>
        <button class="btn primary" type="submit">Sign in</button>
        <p class="muted small">Only approved leaders can sign in. Forgot your password? Ask an admin for a new temporary one.</p>
        <p class="error" id="signin-msg" hidden></p>
      </form>`;
  } else if (state === 'newpass') {
    body.innerHTML = `
      <form id="newpass" class="stack">
        <p><strong>Choose your own password.</strong></p>
        <p class="muted small">You signed in with a temporary password. Set a new one that only you know.</p>
        <label>New password (8 or more characters)
          <input type="password" name="password" required minlength="8" autocomplete="new-password">
        </label>
        <label>Type it again
          <input type="password" name="again" required minlength="8" autocomplete="new-password">
        </label>
        <button class="btn primary" type="submit">Save password</button>
        <button class="btn" type="button" data-action="signout">Sign out</button>
        <p class="error" id="newpass-msg" hidden></p>
      </form>`;
  } else if (state === 'denied') {
    body.innerHTML = `
      <p><strong>${esc(extra)} is not on the approved list.</strong></p>
      <p class="muted">Ask the directory admin to approve your email, then sign in again.</p>
      <button class="btn" data-action="signout">Sign out</button>`;
  } else if (state === 'setup') {
    body.innerHTML = `
      <p><strong>Almost there.</strong></p>
      <p class="muted">This site is not connected to its database yet. The owner needs to fill in
      <code>config.js</code> (see the README).</p>`;
  } else if (state === 'error') {
    body.innerHTML = `
      <p class="error">${esc(extra)}</p>
      <button class="btn" data-action="reload">Try again</button>`;
  }
}

async function handleUser(email) {
  if (email === S.email && email) return;
  S.email = email;
  S.allowed = [];
  S.isAdmin = false;
  if (!email) return showWelcome('signin');
  showWelcome('loading');
  try {
    const mine = (await db.list('allowed_emails')).find((r) => r.email.toLowerCase() === email.toLowerCase());
    if (!mine) return showWelcome('denied', email);
    S.isAdmin = !!mine.is_admin;
    if (mine.must_change_password) return showWelcome('newpass');
  } catch (e) {
    S.email = null;
    return showWelcome('error', `Could not load the directory. ${errText(e)}`);
  }
  await enterApp();
}

async function enterApp() {
  showWelcome('loading');
  try {
    await loadAll();
  } catch (e) {
    S.email = null;
    return showWelcome('error', `Could not load the directory. ${errText(e)}`);
  }
  $('#welcome').hidden = true;
  $('#app').hidden = false;
  route();
}

async function boot() {
  if (db.mode === 'unconfigured') return showWelcome('setup');
  try {
    await db.init();
  } catch (e) {
    return showWelcome('error', `Could not start. ${errText(e)}`);
  }
  db.onAuthChange(handleUser);
  await handleUser(await db.currentEmail());
}

// ------------------------------------------------------------------ data

// table name -> where its rows live in S
const TABLE_KEY = {
  leaders: 'leaders', school_events: 'events', visits: 'visits', allowed_emails: 'allowed',
  availability: 'availability', availability_status: 'availStatus', event_names: 'eventNames',
  prospects: 'prospects', prospect_notes: 'notes', prospect_history: 'history',
};
async function fetchTable(table) {
  if (table === 'app_settings') {
    S.settings = Object.fromEntries((await db.list('app_settings')).map((r) => [r.key, r.value]));
    return;
  }
  S[TABLE_KEY[table]] = await db.list(table);
  if (table === 'school_events') indexBlocked();
  if (table === 'leaders') S.me = S.leaders.find((l) => l.email && l.email.toLowerCase() === S.email.toLowerCase()) || null;
}
async function loadAll() {
  await Promise.all([...Object.keys(TABLE_KEY).filter((t) => t !== 'allowed_emails'), 'app_settings'].map(fetchTable));
}
async function reload(...tables) {
  await Promise.all(tables.map(fetchTable));
  route();
}

const splitSchools = (text) => String(text || '').split('|').map((s) => s.trim()).filter(Boolean);

function indexBlocked() {
  S.blocked = new Map();
  for (const e of S.events) {
    if (!BLOCKING.includes(e.category)) continue;
    for (let d = e.date; d <= (e.end_date || e.date); d = addDays(d, 1)) {
      for (const school of splitSchools(e.schools)) {
        const k = `${school}|${d}`;
        const cur = S.blocked.get(k);
        if (!cur || BLOCKING.indexOf(e.category) < BLOCKING.indexOf(cur.category)) {
          S.blocked.set(k, { category: e.category, title: e.title });
        }
      }
    }
  }
}
const blockedOn = (school, date) => S.blocked.get(`${school}|${date}`);

function lastDay(school) {
  const hits = S.events
    .filter((e) => /last day for students/i.test(e.title) && splitSchools(e.schools).includes(school))
    .map((e) => e.date)
    .sort();
  return hits.at(-1) || LAST_DAY_FALLBACK[schoolByName(school)?.district] || '2027-05-27';
}

const sortLeaders = (list) =>
  [...list].sort((a, b) =>
    (b.is_team_lead ? 1 : 0) - (a.is_team_lead ? 1 : 0) ||
    (a.last || '').localeCompare(b.last || '') || (a.first || '').localeCompare(b.first || ''));

function leadersForSchool(name) {
  const school = schoolByName(name);
  return S.leaders.filter((l) =>
    l.assignment === name || l.assignment === 'All Schools' ||
    (school?.level === 'High' && l.assignment === 'High School Team'));
}
// The team for a site: a school's own leaders (plus the High School Team at high schools),
// or a group's members. All Schools leaders are on every team.
const teamForSite = (site) =>
  (schoolByName(site) ? leadersForSchool(site) : S.leaders.filter((l) => l.assignment === site || l.assignment === 'All Schools'));
const leaderName = (id) => S.leaders.find((l) => l.id === id)?.name;
const visitName = (v) => (v.type === 'Other' ? v.custom_name || 'Other' : v.type);
const visitTitle = (v) => (visitName(v) === v.school ? v.school : `${visitName(v)} at ${v.school}`);
const namesOf = (ids) => (ids || []).map(leaderName).filter(Boolean);

// Events and visits in one shape, for the calendar and school pages.
function allItems() {
  const events = S.events.map((e) => ({
    kind: 'event', id: e.id, date: e.date, end: e.end_date || e.date, title: e.title, category: e.category,
    schools: splitSchools(e.schools), timeText: e.time || '', mins: parseTime(e.time), durationMin: 120,
    location: e.location || '', note: e.note || '', source: e.source || '', people: [], went: [], status: 'scheduled',
  }));
  const visits = S.visits.map((v) => {
    const start = parseTime(v.time);
    const end = parseTime(v.end_time);
    return {
      kind: 'visit', id: v.id, date: v.date, end: v.date, title: visitTitle(v), category: v.type,
      schools: [v.school], timeText: [fmtTime(v.time), fmtTime(v.end_time)].filter(Boolean).join(' to '), mins: start,
      durationMin: start != null && end != null && end > start ? end - start : 60,
      location: v.school, note: v.notes || '', source: '', series: v.series_id,
      status: v.status || 'scheduled', people: namesOf(v.leader_ids), went: namesOf(v.attended_ids),
    };
  });
  return [...events, ...visits].sort((a, b) =>
    a.date.localeCompare(b.date) || (a.mins ?? -1) - (b.mins ?? -1) || a.title.localeCompare(b.title));
}
const findItem = (kind, id) => allItems().find((i) => i.kind === kind && i.id === id);
const icsItem = (it) => ({
  ...it,
  description: [it.note, it.people.length ? `Leaders: ${it.people.join(', ')}` : '', it.kind === 'event' ? it.schools.join(', ') : '']
    .filter(Boolean).join('\n'),
});

// ------------------------------------------------------------------ shared pieces of UI

function personRow(l) {
  const tel = (l.phone || '').replace(/[^\d+]/g, '');
  const contact = [
    tel ? `<a class="pill" href="tel:${esc(tel)}">Call</a><a class="pill" href="sms:${esc(tel)}">Text</a>` : '',
    l.email ? `<a class="pill" href="mailto:${esc(l.email)}">Email</a>` : '',
  ].join('');
  const details = [l.phone, l.email].filter(Boolean).map(esc).join(' · ');
  return `
    <li class="person" data-q="${esc(`${l.name} ${l.church || ''} ${l.assignment}`.toLowerCase())}">
      <div class="p-main">
        <div class="p-name">${esc(l.name)}${l.is_team_lead ? ' <span class="badge lead">Team Lead</span>' : ''}${(l.tags || []).map((t) => ` <span class="badge tag">${esc(t)}</span>`).join('')}</div>
        <div class="p-sub">${esc(l.assignment)}${l.church ? ` · ${esc(l.church)}` : ''}</div>
        <div class="p-sub">${details || '<span class="faint">No phone or email yet</span>'}</div>
      </div>
      <div class="p-actions">
        ${contact}
        ${S.isAdmin ? `<button class="pill" data-action="edit-leader" data-id="${esc(l.id)}">Edit</button>` : ''}
      </div>
    </li>`;
}
const personList = (list) => `<ul class="people">${sortLeaders(list).map(personRow).join('')}</ul>`;

function itemCard(it, { showDate = false } = {}) {
  const range = it.end > it.date ? `${fmtDate(it.date)} to ${fmtDate(it.end)}` : fmtDate(it.date);
  const where = schoolListLabel(it.schools);
  const meta = [showDate ? range : '', it.timeText, it.kind === 'event' ? where[0].toUpperCase() + where.slice(1) : '']
    .filter(Boolean).map(esc).join(' · ');
  const canEdit = it.kind === 'visit' || S.isAdmin;
  const sources = it.source.split(/\s*;\s*/).filter((u) => /^https?:\/\//.test(u));
  const cls = CAT_CLASS[it.category] || 'cal';
  const isVisit = it.kind === 'visit';
  const past = isVisit && it.date <= todayIso();
  const outcome = it.status === 'completed' ? '<span class="badge good">Completed</span>'
    : it.status === 'canceled' ? '<span class="badge bad">Canceled</span>'
    : past && it.date < todayIso() ? '<span class="badge warn">Needs an outcome</span>' : '';
  const who = it.status === 'completed'
    ? `Went: ${it.went.length ? esc(it.went.join(', ')) : 'no one recorded'}`
    : it.status !== 'canceled' && it.people.length ? `Going: ${esc(it.people.join(', '))}` : '';
  return `
    <details class="item c-${cls}${it.status !== 'scheduled' ? ' closed' : ''}${it.status === 'canceled' ? ' canceled' : ''}">
      <summary>
        <span class="item-title">${esc(it.title)}</span>
        <span class="item-meta">${meta || esc(it.category)}${outcome ? ` ${outcome}` : ''}</span>
        ${who ? `<span class="item-meta">${who}</span>` : ''}
      </summary>
      <div class="item-body">
        <div><span class="badge c-${cls}">${esc(it.category)}</span>${it.series ? ' <span class="badge">Repeats weekly</span>' : ''}</div>
        ${showDate ? '' : `<div>${esc(range)}</div>`}
        ${it.location && it.kind === 'event' ? `<div>Where: ${esc(it.location)}</div>` : ''}
        ${it.note ? `<div>${esc(it.note)}</div>` : ''}
        ${isVisit && it.status === 'completed' && it.people.length ? `<div class="muted small">Assigned: ${esc(it.people.join(', '))}</div>` : ''}
        ${isVisit && it.status === 'scheduled' && !it.people.length ? '<div class="faint">No leaders assigned yet</div>' : ''}
        <div class="row">
          ${past ? `<button class="btn small${it.status === 'scheduled' ? ' primary' : ''}" data-action="outcome" data-id="${esc(it.id)}">${it.status === 'scheduled' ? 'Mark completed or canceled' : 'Change outcome'}</button>` : ''}
          <button class="btn small" data-action="ics" data-kind="${it.kind}" data-id="${esc(it.id)}">Add to my calendar</button>
          <a class="btn small" target="_blank" rel="noopener" href="${esc(googleCalUrl(icsItem(it)))}">Google Calendar</a>
          ${canEdit ? `<button class="btn small" data-action="edit-${it.kind}" data-id="${esc(it.id)}">Edit</button>` : ''}
        </div>
        ${sources.length ? `<div class="small">${sources.map((u, i) => `<a target="_blank" rel="noopener" href="${esc(u)}">Source${sources.length > 1 ? ` ${i + 1}` : ''}</a>`).join(' · ')}</div>` : ''}
      </div>
    </details>`;
}

// No-school picture for one day across a set of schools.
function dayStatus(date, schools) {
  const off = [];
  const short = [];
  for (const s of schools) {
    const b = blockedOn(s, date);
    if (b?.category === 'No School') off.push(s);
    else if (b) short.push(s);
  }
  const cls = off.length && off.length === schools.length ? 'off' : off.length ? 'off-some' : short.length ? 'short' : '';
  const parts = [];
  if (off.length) parts.push(off.length === schools.length && schools.length > 1 ? 'No school' : `No school: ${schoolListLabel(off)}`);
  if (short.length) parts.push(`Half day / e-learning: ${schoolListLabel(short)}`);
  return { cls, label: parts.join(' · ') };
}

// ------------------------------------------------------------------ roster

const ROSTER_NOTES = {
  'High School Team': 'Serves Central High, Northridge High, Hillcrest High and Tuscaloosa County High',
  'All Schools': 'Serves every school',
};

function renderRoster() {
  const known = new Set(ASSIGNMENTS);
  const groups = [...ASSIGNMENTS, ...new Set(S.leaders.map((l) => l.assignment).filter((a) => !known.has(a)))];
  view.innerHTML = `
    <div class="page-head">
      <h2>Roster <span class="count">${S.leaders.length}</span></h2>
      ${S.isAdmin ? '<button class="btn primary small" data-action="edit-leader">Add leader</button>' : ''}
    </div>
    <input id="roster-q" class="search" type="search" placeholder="Search by name, church or site" aria-label="Search roster">
    ${groups.map((g) => {
      const list = S.leaders.filter((l) => l.assignment === g);
      if (!list.length) return '';
      const link = [
        TEAMS.includes(g) ? `<a class="small" href="#/availability/${encodeURIComponent(g)}">Availability</a>` : '',
        schoolByName(g) ? `<a class="small" href="#/school/${encodeURIComponent(g)}">School page</a>` : '',
      ].filter(Boolean).join(' · ');
      return `
        <section class="card group">
          <div class="group-head"><h3>${esc(g)} <span class="count">${list.length}</span></h3><span>${link}</span></div>
          ${ROSTER_NOTES[g] ? `<p class="muted small">${ROSTER_NOTES[g]}</p>` : ''}
          ${personList(list)}
        </section>`;
    }).join('')}
    <p id="roster-none" class="muted" hidden>No one matches that search.</p>`;
}

function filterRoster(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const group of $$('.group', view)) {
    let any = false;
    for (const li of $$('.person', group)) {
      const ok = words.every((w) => li.dataset.q.includes(w));
      li.hidden = !ok;
      any ||= ok;
      shown += ok ? 1 : 0;
    }
    group.hidden = !any;
  }
  $('#roster-none').hidden = shown > 0;
}

function leaderForm(id) {
  const l = S.leaders.find((x) => x.id === id) || { assignment: 'TBD' };
  const tags = [...new Set([ONBOARDING_TAG, ...S.leaders.flatMap((x) => x.tags || [])])];
  openDialog(`
    <form id="leader-form" class="stack" data-id="${esc(id || '')}">
      <h3>${id ? 'Edit leader' : 'Add leader'}</h3>
      <div class="two">
        <label>First name <input name="first" required value="${esc(l.first)}"></label>
        <label>Last name <input name="last" value="${esc(l.last)}"></label>
      </div>
      <label>Assignment <select name="assignment">${opts([...new Set([...ASSIGNMENTS, l.assignment])], l.assignment)}</select></label>
      <label>Church <input name="church" value="${esc(l.church)}"></label>
      <label>Phone <input name="phone" type="tel" autocomplete="off" value="${esc(l.phone)}"></label>
      <label>Email <input name="email" type="email" autocomplete="off" value="${esc(l.email)}"></label>
      <label class="check"><input type="checkbox" name="is_team_lead"${l.is_team_lead ? ' checked' : ''}> Team lead</label>
      <fieldset>
        <legend>Tags</legend>
        ${tags.map((t) => `<label class="check"><input type="checkbox" name="tag" value="${esc(t)}"${(l.tags || []).includes(t) ? ' checked' : ''}> ${esc(t)}</label>`).join('')}
        <input name="new_tag" placeholder="Add a new tag (optional)" aria-label="New tag">
        <p class="muted small">Leaders tagged ${esc(ONBOARDING_TAG)} get the daily onboarding reminder email, if they have an email here. A team lead needs their sign-in email here to edit their team's availability.</p>
      </fieldset>
      <div class="row end">
        ${id ? '<button type="button" class="btn danger" data-action="delete-leader">Remove</button>' : ''}
        <span class="grow"></span>
        <button type="button" class="btn" data-action="close">Cancel</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`);
}

async function saveLeader(form) {
  const f = new FormData(form);
  const text = (k) => String(f.get(k) || '').trim();
  const row = {
    first: text('first'), last: text('last'), name: `${text('first')} ${text('last')}`.trim(),
    assignment: text('assignment'), church: text('church') || null, phone: text('phone') || null,
    email: text('email') || null, is_team_lead: f.has('is_team_lead'),
    tags: [...new Set([...f.getAll('tag'), text('new_tag')].filter(Boolean))],
  };
  if (form.dataset.id) await db.update('leaders', { id: form.dataset.id }, row);
  else await db.insert('leaders', [row]);
  closeDialog();
  toast('Saved');
  await reload('leaders');
}

// ------------------------------------------------------------------ calendar

function passes(it) {
  const f = S.cal.filters;
  if (f.schools.size && !it.schools.some((s) => f.schools.has(s))) return false;
  if (f.cats.size && !f.cats.has(it.category)) return false;
  if (f.homeOnly && it.category === 'Basketball' && !/\(home\)/i.test(it.location)) return false;
  const evening = it.mins != null && it.mins >= EVENING_START;
  if (f.tod === 'day' && evening) return false;
  if (f.tod === 'eve' && !evening) return false;
  return true;
}
const shadeSchools = () => (S.cal.filters.schools.size ? [...S.cal.filters.schools] : SCHOOL_NAMES);
const filterCount = () => {
  const f = S.cal.filters;
  return f.schools.size + f.cats.size + (f.homeOnly ? 1 : 0) + (f.tod !== 'any' ? 1 : 0);
};
const chip = (action, value, on, label = value) =>
  `<button class="chip${on ? ' on' : ''}" aria-pressed="${on}" data-action="${action}" data-v="${esc(value)}">${esc(label)}</button>`;

function filterPanel() {
  const f = S.cal.filters;
  return `
    <section class="card filters">
      <div class="f-group">
        <div class="f-label">School
          <span class="quick">
            ${['Middle', 'High', 'City', 'County'].map((q) => `<button class="link" data-action="f-quick" data-v="${q}">${q}</button>`).join('')}
          </span>
        </div>
        <div class="chips">${SCHOOL_NAMES.map((s) => chip('f-school', s, f.schools.has(s))).join('')}</div>
      </div>
      <div class="f-group">
        <div class="f-label">Event type</div>
        <div class="chips">${CATEGORIES.map((c) => chip('f-cat', c, f.cats.has(c))).join('')}</div>
      </div>
      <div class="f-group">
        <div class="f-label">Time of day</div>
        <div class="chips">
          ${chip('f-tod', 'any', f.tod === 'any', 'Any time')}
          ${chip('f-tod', 'day', f.tod === 'day', 'School day')}
          ${chip('f-tod', 'eve', f.tod === 'eve', 'Evening (4 PM or later)')}
          ${chip('f-home', 'home', f.homeOnly, 'Home games only')}
        </div>
      </div>
      <div class="row end">
        <span class="muted small grow">Days are shaded for ${f.schools.size ? 'the schools you picked' : 'all schools'}.</span>
        <button class="btn small" data-action="f-clear">Clear filters</button>
      </div>
    </section>`;
}

function upcomingList(items) {
  const today = todayIso();
  const schools = shadeSchools();
  const list = items.filter((i) => i.end >= today);
  if (!list.length) return '<p class="muted">Nothing coming up matches these filters.</p>';
  const shown = list.slice(0, S.cal.limit);
  let html = '';
  let last = '';
  for (const it of shown) {
    if (it.date !== last) {
      const st = dayStatus(it.date, schools);
      html += `${last ? '</div>' : ''}<div class="day-block ${st.cls}">
        <h4 class="day-head">${fmtDate(it.date, { weekday: 'long', month: 'long', day: 'numeric' })}
          ${st.label ? `<span class="badge shade">${esc(st.label)}</span>` : ''}</h4>`;
      last = it.date;
    }
    html += itemCard(it);
  }
  html += '</div>';
  if (list.length > shown.length) {
    html += `<button class="btn block" data-action="more">Show more (${list.length - shown.length} left)</button>`;
  }
  return html;
}

// Events whose date has passed, newest first, so anyone can record what happened.
function pastList(items) {
  const today = todayIso();
  const past = items.filter((i) => i.kind === 'visit' && i.date < today).reverse();
  if (!past.length) return '';
  const open = past.filter((i) => i.status === 'scheduled').length;
  return `
    <details class="card" id="past-events"${S.cal.pastOpen ? ' open' : ''}>
      <summary><strong>Past events</strong> <span class="count">${past.length}</span>${open ? ` <span class="badge warn">${open} need${open === 1 ? 's' : ''} an outcome</span>` : ''}</summary>
      ${past.slice(0, 30).map((i) => itemCard(i, { showDate: true })).join('')}
      ${past.length > 30 ? '<p class="muted small">Showing the latest 30. Use the Month view for older ones.</p>' : ''}
    </details>`;
}

function monthGrid(items) {
  const [y, m] = S.cal.month.split('-').map(Number);
  const first = toIso(new Date(Date.UTC(y, m - 1, 1)));
  const nextMonth = toIso(new Date(Date.UTC(y, m, 1)));
  const start = addDays(first, -toDate(first).getUTCDay());
  const schools = shadeSchools();
  const today = todayIso();
  let cells = '';
  for (let d = start; d < nextMonth || toDate(d).getUTCDay() !== 0; d = addDays(d, 1)) {
    const inMonth = d >= first && d < nextMonth;
    const st = dayStatus(d, schools);
    const dayItems = items.filter((i) => i.date <= d && i.end >= d);
    const classes = ['cell', st.cls, inMonth ? '' : 'out', d === today ? 'today' : '', d === S.cal.day ? 'sel' : ''].join(' ');
    cells += `
      <button class="${classes}" data-action="day" data-date="${d}" aria-label="${fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric' })}, ${dayItems.length} items${st.label ? `, ${esc(st.label)}` : ''}">
        <span class="num">${Number(d.slice(8))}</span>
        <span class="marks">
          ${dayItems.slice(0, 3).map((i) => `<span class="mark c-${CAT_CLASS[i.category] || 'cal'}">${esc(i.title)}</span>`).join('')}
          ${dayItems.length > 3 ? `<span class="extra">+${dayItems.length - 3}</span>` : ''}
        </span>
      </button>`;
  }
  return `
    <div class="month-nav">
      <button class="btn small" data-action="month" data-v="-1" aria-label="Previous month">&lsaquo;</button>
      <h3>${fmtDate(first, { month: 'long', year: 'numeric' })}</h3>
      <button class="btn small" data-action="month" data-v="1" aria-label="Next month">&rsaquo;</button>
    </div>
    <div class="grid" role="grid">
      ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="dow">${d}</div>`).join('')}
      ${cells}
    </div>
    <div class="legend">
      <span><i class="sw off"></i>No school</span>
      <span><i class="sw off-some"></i>No school at some</span>
      <span><i class="sw short"></i>Half day / e-learning</span>
    </div>`;
}

function dayPanel(items) {
  const d = S.cal.day;
  if (!d) return '<aside class="day-panel card"><p class="muted">Tap a day to see what is happening.</p></aside>';
  const st = dayStatus(d, shadeSchools());
  const dayItems = items.filter((i) => i.date <= d && i.end >= d);
  return `
    <aside class="day-panel card ${st.cls}">
      <h3>${fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
      ${st.label ? `<p><span class="badge shade">${esc(st.label)}</span></p>` : ''}
      ${dayItems.map((i) => itemCard(i)).join('') || '<p class="muted">Nothing on this day.</p>'}
      <button class="btn block" data-action="new-visit" data-date="${d}">Schedule an event this day</button>
    </aside>`;
}

function renderCalendar() {
  const c = S.cal;
  if (!c.month) {
    const today = todayIso();
    c.month = (today < '2027-01-01' ? '2027-01-01' : today).slice(0, 7);
    if (today.startsWith(c.month)) c.day = today;
  }
  const items = allItems().filter(passes);
  const n = filterCount();
  view.innerHTML = `
    <div class="page-head">
      <h2>Calendar</h2>
      <button class="btn primary small" data-action="new-visit">Add event</button>
    </div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Calendar view">
        <button class="${c.view === 'list' ? 'on' : ''}" data-action="cal-view" data-v="list">Upcoming</button>
        <button class="${c.view === 'month' ? 'on' : ''}" data-action="cal-view" data-v="month">Month</button>
      </div>
      <button class="btn small" data-action="f-toggle" aria-expanded="${c.filtersOpen}">Filters${n ? ` (${n})` : ''}</button>
    </div>
    ${c.filtersOpen ? filterPanel() : ''}
    ${c.view === 'list'
      ? pastList(items) + upcomingList(items)
      : `<div class="month-wrap"><div class="month card">${monthGrid(items)}</div>${dayPanel(items)}</div>`}`;
}

// ------------------------------------------------------------------ schools

function renderSchools() {
  view.innerHTML = `
    <div class="page-head"><h2>Schools</h2></div>
    ${['City', 'County'].map((district) => `
      <h3 class="section-title">Tuscaloosa ${district} Schools</h3>
      <div class="tiles">
        ${SCHOOLS.filter((s) => s.district === district).map((s) => {
          const visits = S.visits.filter((v) => v.school === s.name && v.date >= todayIso()).length;
          return `<a class="tile card" href="#/school/${encodeURIComponent(s.name)}">
            <strong>${esc(s.name)}</strong>
            <span class="muted small">${leadersForSchool(s.name).length} leaders · ${visits} upcoming event${visits === 1 ? '' : 's'}</span>
          </a>`;
        }).join('')}
      </div>`).join('')}`;
}

function renderSchool(name) {
  const school = schoolByName(name);
  if (!school) { location.hash = '#/schools'; return; }
  const today = todayIso();
  const items = allItems().filter((i) => i.schools.includes(name) && i.end >= today);
  const visits = items.filter((i) => i.kind === 'visit');
  const daysOff = items.filter((i) => BLOCKING.includes(i.category));
  const events = items.filter((i) => i.kind === 'event' && !BLOCKING.includes(i.category));
  view.innerHTML = `
    <a class="small" href="#/schools">&lsaquo; All schools</a>
    <div class="page-head">
      <div><h2>${esc(name)}</h2><p class="muted small">Tuscaloosa ${school.district} Schools · last day for students ${fmtDate(lastDay(name))}</p></div>
      <span class="row">
        <a class="btn small" href="#/availability/${encodeURIComponent(school.level === 'High' ? 'High School Team' : name)}">Availability</a>
        <button class="btn primary small" data-action="new-visit" data-school="${esc(name)}">Add event</button>
      </span>
    </div>
    <section class="card">
      <h3>Our events <span class="count">${visits.length}</span></h3>
      ${visits.slice(0, 12).map((i) => itemCard(i, { showDate: true })).join('') || '<p class="muted">Nothing scheduled yet.</p>'}
      ${visits.length > 12 ? `<p class="muted small">Showing the next 12 of ${visits.length}.</p>` : ''}
    </section>
    <section class="card">
      <h3>Days off and short days <span class="count">${daysOff.length}</span></h3>
      ${daysOff.map((i) => itemCard(i, { showDate: true })).join('') || '<p class="muted">None coming up.</p>'}
    </section>
    <section class="card">
      <h3>Events <span class="count">${events.length}</span></h3>
      ${events.slice(0, 15).map((i) => itemCard(i, { showDate: true })).join('') || '<p class="muted">No events listed.</p>'}
      <button class="btn block" data-action="school-cal" data-school="${esc(name)}">See ${esc(name)} on the calendar</button>
    </section>
    <section class="card">
      <h3>Leaders <span class="count">${leadersForSchool(name).length}</span></h3>
      ${personList(leadersForSchool(name))}
    </section>`;
}

// ------------------------------------------------------------------ events leaders schedule (visits)

const AVAIL_BADGE = { yes: 'good', no: 'bad', unknown: '' };

// How one leader's weekly availability lines up with every date of the event being edited.
function availabilityAcross(leaderId, plan) {
  const results = plan.dates.map((d) => avail.check(leaderId, d, plan.start, plan.end));
  if (!results.length || results.includes('unknown')) return { state: 'unknown', label: 'No availability entered', misses: 0 };
  const misses = results.filter((r) => r === 'no').length;
  if (!misses) return { state: 'yes', label: 'Available', misses };
  return { state: 'no', label: results.length > 1 ? `Not available ${misses} of ${results.length} dates` : 'Not available', misses };
}

// Only the site's team (plus All Schools leaders), and anyone already assigned from elsewhere.
function leaderPicker(plan, checked) {
  const team = teamForSite(plan.school);
  const ids = new Set(team.map((l) => l.id));
  const extra = S.leaders.filter((l) => checked.has(l.id) && !ids.has(l.id));
  const rows = [...sortLeaders(team), ...sortLeaders(extra)];
  if (!rows.length) return '<p class="muted small">No leaders are on this team yet.</p>';
  return rows.map((l) => {
    const a = availabilityAcross(l.id, plan);
    return `
      <label class="check pick pick-row">
        <span class="check"><input type="checkbox" name="leader" value="${esc(l.id)}" data-state="${a.state}" data-label="${esc(a.label)}" data-name="${esc(l.name)}"${checked.has(l.id) ? ' checked' : ''}>
          <span>${esc(l.name)}${ids.has(l.id) ? '' : ` <span class="faint">${esc(l.assignment)}</span>`}</span></span>
        <span class="badge ${AVAIL_BADGE[a.state]}">${esc(a.label)}</span>
      </label>`;
  }).join('');
}

function visitForm(id, preset = {}) {
  const v = S.visits.find((x) => x.id === id);
  const site = v?.school || preset.school || [...S.cal.filters.schools][0] || SITES[0];
  const today = todayIso();
  const date = v?.date || preset.date || (today < '2027-01-06' ? '2027-01-06' : today);
  const seriesCount = v?.series_id ? S.visits.filter((x) => x.series_id === v.series_id).length : 0;
  const type = v?.type || preset.type || 'Lunch Room Visit';
  const group = (label, names) => `<optgroup label="${label}">${opts(names, site)}</optgroup>`;
  openDialog(`
    <form id="visit-form" class="stack" data-id="${esc(id || '')}" data-series="${esc(v?.series_id || '')}">
      <h3>${v ? 'Edit event' : 'Schedule an event'}</h3>
      ${seriesCount > 1 ? `
        <fieldset class="scope">
          <legend>This event repeats weekly. Change:</legend>
          <label class="check"><input type="radio" name="scope" value="one" checked> Only this one</label>
          <label class="check"><input type="radio" name="scope" value="series"> The whole series (${seriesCount} events)</label>
        </fieldset>` : ''}
      <div class="two">
        <label>Type <select name="type">${opts(VISIT_TYPES, type)}</select></label>
        <label>Site <select name="school">${group('Schools', SCHOOL_NAMES)}${group('Groups', GROUPS)}</select></label>
      </div>
      <label id="custom-wrap" hidden>Name of this event
        <input name="custom_name" list="event-names" maxlength="60" placeholder="For example: Field Day" value="${esc(v?.custom_name)}">
        <datalist id="event-names">${S.eventNames.map((n) => `<option value="${esc(n.name)}">`).join('')}</datalist>
      </label>
      <label>Date <input type="date" name="date" required value="${esc(date)}"></label>
      <div class="two">
        <label>Starts <input type="time" name="time" value="${esc(v ? v.time || '' : '11:30')}"></label>
        <label>Ends <input type="time" name="end_time" value="${esc(v ? v.end_time || '' : '12:30')}"></label>
      </div>
      ${v ? '' : `
        <label class="check"><input type="checkbox" name="repeat"> Repeat every week</label>
        <label id="until-wrap" hidden>Until (defaults to the last day of school)
          <input type="date" name="until" value="${esc(lastDay(site))}">
        </label>`}
      <div id="conflicts"></div>
      <label>Notes (optional) <textarea name="notes" rows="2">${esc(v?.notes)}</textarea></label>
      <div>
        <div class="f-label"><span>Leaders going <span id="pick-count" class="count"></span></span><span id="pick-team" class="faint"></span></div>
        <div id="picker" class="picker" data-checked="${esc((v?.leader_ids || []).join(','))}"></div>
        <div id="avail-warn"></div>
      </div>
      <div class="row end">
        ${v ? '<button type="button" class="btn danger" data-action="delete-visit">Delete</button>' : ''}
        <span class="grow"></span>
        <button type="button" class="btn" data-action="close">Close</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`);
  refreshVisitForm();
}

// What the form currently describes: which dates and times, and which dates hit a day off.
function visitPlan(form) {
  const f = new FormData(form);
  const school = f.get('school');
  const scope = f.get('scope') || 'one';
  const date = f.get('date') || form.elements.date.value;
  let dates = date ? [date] : [];
  if (form.dataset.id && scope === 'series') {
    dates = S.visits.filter((x) => x.series_id === form.dataset.series).map((x) => x.date).sort();
  } else if (!form.dataset.id && f.has('repeat') && date && f.get('until')) {
    dates = weeklyDates(date, f.get('until'));
  }
  const hits = dates.map((d) => ({ date: d, b: blockedOn(school, d) })).filter((x) => x.b);
  return {
    f, school, scope, dates, hits, repeat: !form.dataset.id && f.has('repeat'),
    start: parseTime(f.get('time')), end: parseTime(f.get('end_time')),
  };
}

function refreshVisitForm({ picker = true } = {}) {
  const form = $('#visit-form');
  if (!form) return;
  const plan = visitPlan(form);
  const { school, scope, dates, hits, repeat } = plan;
  const until = $('#until-wrap', form);
  if (until) until.hidden = !repeat;
  form.elements.date.disabled = scope === 'series';
  const other = form.elements.type.value === 'Other';
  $('#custom-wrap', form).hidden = !other;
  form.elements.custom_name.required = other;

  const box = $('#picker', form);
  if (picker) {
    const checked = box.dataset.checked != null
      ? new Set(box.dataset.checked.split(',').filter(Boolean))
      : new Set($$('input[name=leader]:checked', form).map((b) => b.value));
    delete box.dataset.checked;
    box.innerHTML = leaderPicker(plan, checked);
    $('#pick-team', form).textContent = `${school} team`;
  }
  const picked = $$('input[name=leader]:checked', form);
  $('#pick-count', form).textContent = picked.length || '';
  const away = picked.filter((b) => b.dataset.state === 'no');
  $('#avail-warn', form).innerHTML = away.length ? `
    <p class="note warn"><strong>Heads up:</strong> ${away.map((b) => `${esc(b.dataset.name)} (${esc(b.dataset.label.toLowerCase())})`).join(', ')}
    ${away.length === 1 ? 'is' : 'are'} marked not available at this time. You can still assign them.</p>` : '';

  const conflicts = $('#conflicts', form);
  const many = dates.length > 1;
  if (!hits.length) {
    conflicts.innerHTML = many ? `<p class="note ok">${dates.length} events, ${fmtDate(dates[0])} to ${fmtDate(dates.at(-1))}.${schoolByName(school) ? ` None fall on a day off at ${esc(school)}.` : ''}</p>` : '';
    return;
  }
  const keepSkip = $('input[name=skip]', form)?.checked ?? true;
  const allOff = hits.every((h) => h.b.category === 'No School');
  const what = allOff ? 'days with no school' : 'days with no school, a half day or e-learning';
  const sameDay = dates.every((d) => weekdayName(d) === weekdayName(dates[0]));
  const head = many
    ? `${hits.length} of your ${dates.length} ${sameDay ? `${weekdayName(dates[0])}s` : 'events'} ${hits.length === 1 ? 'falls' : 'fall'} on ${what} at ${esc(school)}.`
    : `Heads up: ${fmtDate(dates[0])} is ${allOff ? 'a day with no school' : 'a half day or e-learning day'} at ${esc(school)}.`;
  conflicts.innerHTML = `
    <div class="note warn">
      <strong>${head}</strong>
      <ul>${hits.map((h) => `<li>${fmtDate(h.date)}: ${esc(h.b.category)} (${esc(h.b.title)})</li>`).join('')}</ul>
      ${many ? `<label class="check"><input type="checkbox" name="skip"${keepSkip ? ' checked' : ''}> Skip those dates automatically</label>` : ''}
    </div>`;
}

async function saveVisit(form) {
  const { f, school, scope, dates, hits, start, end } = visitPlan(form);
  if (start != null && end != null && end <= start) return toast('The end time needs to be after the start time.', true);
  const type = f.get('type');
  const custom = type === 'Other' ? String(f.get('custom_name') || '').trim() : null;
  if (type === 'Other' && !custom) return toast('Give this event a name.', true);
  const fields = {
    type, custom_name: custom, school, time: f.get('time') || null, end_time: f.get('end_time') || null,
    notes: String(f.get('notes') || '').trim() || null, leader_ids: f.getAll('leader'),
  };
  const skip = f.has('skip') ? new Set(hits.map((h) => h.date)) : new Set();
  const id = form.dataset.id;
  let msg = 'Saved';
  if (!id) {
    const keep = dates.filter((d) => !skip.has(d));
    if (!keep.length) return toast('Every date was skipped, so there is nothing to save.', true);
    const series_id = dates.length > 1 ? crypto.randomUUID() : null;
    await db.insert('visits', keep.map((date) => ({ ...fields, date, series_id, created_by: S.email })));
    msg = keep.length > 1 ? `Scheduled ${keep.length} events${skip.size ? `, skipped ${skip.size}` : ''}` : 'Event scheduled';
  } else if (scope === 'series') {
    await db.update('visits', { series_id: form.dataset.series }, fields);
    if (skip.size) {
      const ids = S.visits.filter((x) => x.series_id === form.dataset.series && skip.has(x.date)).map((x) => x.id);
      await db.remove('visits', { id: ids });
      msg = `Series updated, removed ${ids.length} on days off`;
    } else msg = 'Series updated';
  } else {
    await db.update('visits', { id }, { ...fields, date: f.get('date') });
  }
  // Remember a new custom name so it is offered next time.
  const tables = ['visits'];
  if (custom && !S.eventNames.some((n) => n.name.toLowerCase() === custom.toLowerCase())) {
    await db.insert('event_names', [{ name: custom, created_by: S.email }]).catch(() => {});
    tables.push('event_names');
  }
  closeDialog();
  toast(msg);
  await reload(...tables);
}

async function deleteVisit(form) {
  const series = new FormData(form).get('scope') === 'series';
  const n = series ? S.visits.filter((x) => x.series_id === form.dataset.series).length : 1;
  if (!confirm(series ? `Delete all ${n} events in this series?` : 'Delete this event? To keep it on the calendar as canceled, use "Mark completed or canceled" instead.')) return;
  await db.remove('visits', series ? { series_id: form.dataset.series } : { id: form.dataset.id });
  closeDialog();
  toast(series ? `Deleted ${n} events` : 'Event deleted');
  await reload('visits');
}

// After the date: completed (and who actually went) or canceled.
function outcomeForm(id) {
  const v = S.visits.find((x) => x.id === id);
  if (!v) return;
  const status = v.status === 'canceled' ? 'canceled' : 'completed';
  const team = teamForSite(v.school);
  const ids = new Set(team.map((l) => l.id));
  const assigned = new Set(v.leader_ids || []);
  const extra = S.leaders.filter((l) => (assigned.has(l.id) || (v.attended_ids || []).includes(l.id)) && !ids.has(l.id));
  const ticked = new Set(v.status === 'completed' ? v.attended_ids || [] : v.leader_ids || []);
  openDialog(`
    <form id="outcome-form" class="stack" data-id="${esc(id)}">
      <h3>${esc(visitTitle(v))}</h3>
      <p class="muted small">${fmtDate(v.date, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      <fieldset>
        <legend>What happened?</legend>
        <label class="check"><input type="radio" name="status" value="completed"${status === 'completed' ? ' checked' : ''}> Completed</label>
        <label class="check"><input type="radio" name="status" value="canceled"${status === 'canceled' ? ' checked' : ''}> Canceled</label>
      </fieldset>
      <div id="went-wrap">
        <div class="f-label">Who actually went?</div>
        <div class="picker">
          ${[...sortLeaders(team), ...sortLeaders(extra)].map((l) => `
            <label class="check pick"><input type="checkbox" name="went" value="${esc(l.id)}"${ticked.has(l.id) ? ' checked' : ''}>
              <span>${esc(l.name)}${assigned.has(l.id) ? ' <span class="faint">assigned</span>' : ''}</span></label>`).join('') || '<p class="muted small">No leaders on this team.</p>'}
        </div>
      </div>
      <div class="row end">
        ${v.status !== 'scheduled' ? '<button type="button" class="btn" data-action="outcome-clear">Clear outcome</button>' : ''}
        <span class="grow"></span>
        <button type="button" class="btn" data-action="close">Close</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`);
  $('#went-wrap').hidden = status !== 'completed';
}

async function saveOutcome(form) {
  const f = new FormData(form);
  const status = f.get('status');
  await db.update('visits', { id: form.dataset.id }, {
    status, attended_ids: status === 'completed' ? f.getAll('went') : [], closed_by: S.email, closed_at: new Date().toISOString(),
  });
  closeDialog();
  toast(status === 'completed' ? 'Marked completed' : 'Marked canceled');
  await reload('visits');
}

// ------------------------------------------------------------------ school events (admin)

function eventForm(id) {
  const e = S.events.find((x) => x.id === id) || {};
  const picked = new Set(splitSchools(e.schools));
  openDialog(`
    <form id="event-form" class="stack" data-id="${esc(id || '')}">
      <h3>${id ? 'Edit school event' : 'Add school event'}</h3>
      <label>Title <input name="title" required value="${esc(e.title)}"></label>
      <label>Type <select name="category">${opts(EVENT_CATEGORIES, e.category || 'School Calendar')}</select></label>
      <div class="two">
        <label>Date <input type="date" name="date" required value="${esc(e.date)}"></label>
        <label>Last day (if more than one) <input type="date" name="end_date" value="${esc(e.end_date && e.end_date !== e.date ? e.end_date : '')}"></label>
      </div>
      <div>
        <div class="f-label">Schools
          <span class="quick">${['All', 'City', 'County', 'None'].map((q) => `<button type="button" class="link" data-action="ev-quick" data-v="${q}">${q}</button>`).join('')}</span>
        </div>
        <div class="picker short">${SCHOOLS.map((s) => `
          <label class="check"><input type="checkbox" name="school" value="${esc(s.name)}"${picked.has(s.name) ? ' checked' : ''}> ${esc(s.name)}</label>`).join('')}</div>
      </div>
      <div class="two">
        <label>Time (optional) <input name="time" placeholder="6:00 PM" value="${esc(e.time)}"></label>
        <label>Location (optional) <input name="location" placeholder="Central High (home)" value="${esc(e.location)}"></label>
      </div>
      <label>Note (optional) <input name="note" value="${esc(e.note)}"></label>
      <label>Source link (optional) <input name="source" value="${esc(e.source)}"></label>
      <p class="muted small">For home basketball games, end the location with "(home)" so the home games filter finds it.</p>
      <div class="row end">
        ${id ? '<button type="button" class="btn danger" data-action="delete-event">Delete</button>' : ''}
        <span class="grow"></span>
        <button type="button" class="btn" data-action="close">Cancel</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`);
}

async function saveEvent(form) {
  const f = new FormData(form);
  const text = (k) => String(f.get(k) || '').trim();
  const schools = f.getAll('school');
  if (!schools.length) return toast('Pick at least one school.', true);
  const districts = new Set(schools.map((s) => schoolByName(s).district));
  const end = text('end_date');
  const row = {
    title: text('title'), category: text('category'), date: text('date'),
    end_date: end && end > text('date') ? end : text('date'), schools: schools.join('|'),
    district: districts.size > 1 ? 'City & County' : [...districts][0],
    time: text('time'), location: text('location'), note: text('note'), source: text('source'),
  };
  if (form.dataset.id) await db.update('school_events', { id: form.dataset.id }, row);
  else await db.insert('school_events', [row]);
  closeDialog();
  toast('Saved');
  await reload('school_events');
}

// ------------------------------------------------------------------ more / about / admin

function renderMore() {
  const starts = S.settings.semester_starts || DEFAULT_SEMESTER_STARTS;
  const md = '(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])';
  view.innerHTML = `
    <div class="page-head"><h2>More</h2></div>
    ${db.mode === 'demo' ? '<p class="note warn">Demo mode: this copy is running on this computer only and saves to this browser. Nothing here reaches the real database.</p>' : ''}
    <section class="card">
      <h3>Team availability</h3>
      <p class="muted small">Weekly time blocks for each leader, kept up to date by team leads.</p>
      <a class="btn" href="#/availability">Open availability</a>
    </section>
    ${S.isAdmin ? `
      <section class="card">
        <h3>Admin</h3>
        <div class="row">
          <button class="btn" data-action="edit-leader">Add leader</button>
          <button class="btn" data-action="edit-event">Add school event</button>
        </div>
        <p class="muted small">To change a leader or their tags, tap Edit next to their name on the Roster. To change a school event, open it on the Calendar and tap Edit.</p>

        <h4>Accounts <span class="count">${S.allowed.length}</span></h4>
        <p class="muted small">Only these emails can sign in. Creating an account shows you a temporary password once, for you to pass on. The leader chooses their own password the first time they sign in.</p>
        <form id="allow-form" class="row">
          <input class="grow" type="email" name="email" required placeholder="new.leader@example.com" aria-label="Email for the new account">
          <label class="check"><input type="checkbox" name="is_admin"> Admin</label>
          <button class="btn primary">Create account</button>
        </form>
        <ul class="people">
          ${[...S.allowed].sort((a, b) => a.email.localeCompare(b.email)).map((a) => {
            const self = a.email.toLowerCase() === S.email.toLowerCase();
            return `
            <li class="person">
              <div class="p-main"><div class="p-name">${esc(a.email)}${a.is_admin ? ' <span class="badge lead">Admin</span>' : ''}${self ? ' <span class="faint small">You</span>' : ''}</div>
                ${a.must_change_password ? '<div class="p-sub">Has a temporary password</div>' : ''}</div>
              <div class="p-actions">${self ? '' : `
                <button class="pill" data-action="reset-password" data-email="${esc(a.email)}">Reset password</button>
                <button class="pill" data-action="toggle-admin" data-email="${esc(a.email)}">${a.is_admin ? 'Remove admin' : 'Make admin'}</button>
                <button class="pill" data-action="unapprove" data-email="${esc(a.email)}">Remove</button>`}</div>
            </li>`;
          }).join('')}
        </ul>

        <h4>Saved event names</h4>
        <p class="muted small">Names typed under the "Other" event type. Removing one only stops it being suggested.</p>
        <div class="chips">${S.eventNames.map((n) => `<button class="chip" data-action="del-event-name" data-v="${esc(n.name)}" aria-label="Remove ${esc(n.name)}">${esc(n.name)} &times;</button>`).join('') || '<span class="faint small">None yet.</span>'}</div>

        <h4>Semester start dates</h4>
        <p class="muted small">For about a month after each date, team leads see a reminder to review their team's availability. Nothing is deleted.</p>
        <form id="semester-form" class="row">
          <label>Spring (month-day) <input name="s0" required pattern="${md}" placeholder="01-06" value="${esc(starts[0] || '')}"></label>
          <label>Fall (month-day) <input name="s1" required pattern="${md}" placeholder="08-01" value="${esc(starts[1] || '')}"></label>
          <button class="btn primary">Save</button>
        </form>
      </section>` : ''}
    <section class="card prose">
      <h3>About this calendar</h3>
      <ul>
        <li>Days off and calendar dates come from the Tuscaloosa City Schools and Tuscaloosa County Schools 2026&ndash;27 calendars. County dates on April 22&ndash;23 may become weather make-up days.</li>
        <li>Basketball games come from MaxPreps varsity schedules as of November 2026 and are incomplete.</li>
        <li>Not yet included: spring sports, fine arts, PTO and school-wide events, and middle school athletics. Admins can add these as they are announced.</li>
      </ul>
      <p class="muted small">Always confirm with the school before a visit. Phone numbers and emails are visible only to signed-in leaders.</p>
    </section>
    <section class="card">
      <h3>Your account</h3>
      <p class="muted small">Signed in as ${esc(S.email)}${S.isAdmin ? ' (admin)' : ''}. You stay signed in on this device until you sign out.</p>
      <details class="sub">
        <summary>Change my password</summary>
        <form id="mypass-form" class="stack">
          <label>New password (8 or more characters) <input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
          <label>Type it again <input type="password" name="again" required minlength="8" autocomplete="new-password"></label>
          <button class="btn primary">Save password</button>
        </form>
      </details>
      <p><button class="btn" data-action="signout">${db.mode === 'demo' ? 'Reset demo data' : 'Sign out'}</button></p>
    </section>`;
}

// A temporary password is shown one time only; it is never stored where anyone can read it back.
function showTempPassword(email, password) {
  openDialog(`
    <div class="stack">
      <h3>Temporary password</h3>
      <p>For <strong>${esc(email)}</strong>. Pass it on in person, by phone or by text. They will be asked to choose their own password when they sign in.</p>
      <div class="code" id="temp-pw">${esc(password)}</div>
      <p class="muted small">This is shown only once. If it gets lost, use Reset password to make a new one.</p>
      <div class="row end">
        <span class="grow"></span>
        <button class="btn" data-action="copy-temp">Copy</button>
        <button class="btn primary" data-action="close">Done</button>
      </div>
    </div>`);
}

function readNewPassword(form) {
  const f = new FormData(form);
  const password = String(f.get('password'));
  if (password !== f.get('again')) throw new Error('The two passwords do not match.');
  if (password.length < 8) throw new Error('Use 8 or more characters.');
  return password;
}

// ------------------------------------------------------------------ routing

async function route() {
  if ($('#app').hidden) return;
  const [, page = 'roster', arg] = location.hash.split('/');
  const tab = page === 'school' ? 'schools' : page === 'availability' ? 'roster'
    : ['roster', 'calendar', 'schools', 'onboarding', 'more'].includes(page) ? page : 'roster';
  $$('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  $('#banner').innerHTML = page === 'availability' ? '' : avail.semesterBanner();
  if (page === 'calendar') renderCalendar();
  else if (page === 'schools') renderSchools();
  else if (page === 'school') renderSchool(decodeURIComponent(arg || ''));
  else if (page === 'availability') avail.render(decodeURIComponent(arg || ''));
  else if (page === 'onboarding') onb.render();
  else if (page === 'more') {
    if (S.isAdmin && !S.allowed.length) S.allowed = await db.list('allowed_emails').catch(() => []);
    renderMore();
  } else renderRoster();
}
let lastHash = '';
addEventListener('hashchange', () => {
  if (location.hash !== lastHash) { lastHash = location.hash; scrollTo(0, 0); }
  route();
});

// ------------------------------------------------------------------ events

const toggle = (set, v) => (set.has(v) ? set.delete(v) : set.add(v));

const actions = {
  reload: () => location.reload(),
  close: closeDialog,
  signout: async () => { await db.signOut(); },

  'edit-leader': (el) => leaderForm(el.dataset.id),
  'delete-leader': async () => {
    const form = $('#leader-form');
    if (!confirm('Remove this leader from the roster?')) return;
    await db.remove('leaders', { id: form.dataset.id });
    closeDialog();
    await reload('leaders');
  },

  'new-visit': (el) => visitForm(null, { date: el.dataset.date, school: el.dataset.school }),
  'edit-visit': (el) => visitForm(el.dataset.id),
  'delete-visit': () => deleteVisit($('#visit-form')),
  outcome: (el) => outcomeForm(el.dataset.id),
  'outcome-clear': async () => {
    await db.update('visits', { id: $('#outcome-form').dataset.id }, { status: 'scheduled', attended_ids: [], closed_by: null, closed_at: null });
    closeDialog();
    await reload('visits');
  },

  'edit-event': (el) => eventForm(el.dataset.id),
  'delete-event': async () => {
    if (!confirm('Delete this school event?')) return;
    await db.remove('school_events', { id: $('#event-form').dataset.id });
    closeDialog();
    await reload('school_events');
  },
  'ev-quick': (el) => {
    const v = el.dataset.v;
    $$('#event-form input[name=school]').forEach((box) => {
      box.checked = v === 'All' || (v !== 'None' && schoolByName(box.value).district === v);
    });
  },

  ics: (el) => {
    const it = findItem(el.dataset.kind, el.dataset.id);
    if (it) downloadIcs(icsItem(it));
  },

  'cal-view': (el) => { S.cal.view = el.dataset.v; renderCalendar(); },
  'f-toggle': () => { S.cal.filtersOpen = !S.cal.filtersOpen; renderCalendar(); },
  'f-school': (el) => { toggle(S.cal.filters.schools, el.dataset.v); renderCalendar(); },
  'f-cat': (el) => { toggle(S.cal.filters.cats, el.dataset.v); renderCalendar(); },
  'f-tod': (el) => { S.cal.filters.tod = el.dataset.v; renderCalendar(); },
  'f-home': () => { S.cal.filters.homeOnly = !S.cal.filters.homeOnly; renderCalendar(); },
  'f-quick': (el) => {
    const v = el.dataset.v;
    S.cal.filters.schools = new Set(SCHOOLS.filter((s) => s.level === v || s.district === v).map((s) => s.name));
    renderCalendar();
  },
  'f-clear': () => { S.cal.filters = { schools: new Set(), cats: new Set(), homeOnly: false, tod: 'any' }; renderCalendar(); },
  more: () => { S.cal.limit += 40; renderCalendar(); },
  day: (el) => { S.cal.day = el.dataset.date; S.cal.month = el.dataset.date.slice(0, 7); renderCalendar(); if (!desktop()) $('.day-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); },
  month: (el) => {
    const [y, m] = S.cal.month.split('-').map(Number);
    S.cal.month = toIso(new Date(Date.UTC(y, m - 1 + Number(el.dataset.v), 1))).slice(0, 7);
    S.cal.day = null;
    renderCalendar();
  },
  'school-cal': (el) => {
    S.cal.filters = { schools: new Set([el.dataset.school]), cats: new Set(), homeOnly: false, tod: 'any' };
    location.hash = '#/calendar';
  },

  'toggle-admin': async (el) => {
    const row = S.allowed.find((a) => a.email === el.dataset.email);
    await db.update('allowed_emails', { email: row.email }, { is_admin: !row.is_admin });
    await reload('allowed_emails');
  },
  unapprove: async (el) => {
    if (!confirm(`Remove ${el.dataset.email}? Their account is deleted and they can no longer sign in.`)) return;
    await db.callFunction('admin-users', { action: 'remove', email: el.dataset.email });
    await reload('allowed_emails');
  },
  'reset-password': async (el) => {
    const email = el.dataset.email;
    if (!confirm(`Give ${email} a new temporary password? Their current password stops working.`)) return;
    const out = await db.callFunction('admin-users', { action: 'set-temp-password', email });
    await reload('allowed_emails');
    showTempPassword(email, out.temp_password);
  },
  'copy-temp': async () => {
    await navigator.clipboard.writeText($('#temp-pw').textContent);
    toast('Copied');
  },
  'del-event-name': async (el) => {
    if (!confirm(`Stop suggesting "${el.dataset.v}"? Events already using it are not changed.`)) return;
    await db.remove('event_names', { name: el.dataset.v });
    await reload('event_names');
  },
};
Object.assign(actions, avail.actions, onb.actions);

document.addEventListener('click', async (e) => {
  if (e.target === dlg) return closeDialog(); // tap outside the form
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  if (el.tagName === 'BUTTON' || el.tagName === 'A') e.preventDefault();
  try {
    await actions[el.dataset.action](el);
  } catch (err) {
    toast(errText(err), true);
  }
});

const submits = {
  signin: async (form) => {
    const f = new FormData(form);
    const msg = $('#signin-msg');
    msg.hidden = true;
    try {
      await db.signIn(String(f.get('email')).trim().toLowerCase(), String(f.get('password')));
    } catch (err) {
      msg.textContent = /invalid login/i.test(errText(err))
        ? 'That email and password do not match. Check them, or ask an admin for a new temporary password.'
        : `Could not sign in. ${errText(err)}`;
      msg.hidden = false;
    }
  },
  newpass: async (form) => {
    const msg = $('#newpass-msg');
    msg.hidden = true;
    try {
      await db.changePassword(readNewPassword(form));
    } catch (err) {
      msg.textContent = errText(err);
      msg.hidden = false;
      return;
    }
    await enterApp();
  },
  'mypass-form': async (form) => {
    await db.changePassword(readNewPassword(form));
    form.reset();
    form.closest('details').open = false;
    toast('Password changed');
  },
  'leader-form': saveLeader,
  'visit-form': saveVisit,
  'outcome-form': saveOutcome,
  'event-form': saveEvent,
  'allow-form': async (form) => {
    const f = new FormData(form);
    const email = String(f.get('email')).trim().toLowerCase();
    if (S.allowed.some((a) => a.email.toLowerCase() === email)) return toast('That email already has an account. Use Reset password instead.', true);
    const out = await db.callFunction('admin-users', { action: 'set-temp-password', email, is_admin: f.has('is_admin'), create: true });
    form.reset();
    await reload('allowed_emails');
    showTempPassword(email, out.temp_password);
  },
  'semester-form': async (form) => {
    const f = new FormData(form);
    await db.upsert('app_settings', [{ key: 'semester_starts', value: [f.get('s0'), f.get('s1')] }]);
    toast('Saved');
    await reload('app_settings');
  },
};
Object.assign(submits, avail.submits, onb.submits);

document.addEventListener('submit', async (e) => {
  const handler = submits[e.target.id];
  if (!handler) return;
  e.preventDefault();
  const button = $('button.primary', e.target);
  if (button) button.disabled = true;
  try {
    await handler(e.target);
  } catch (err) {
    toast(errText(err), true);
  } finally {
    if (button) button.disabled = false;
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'roster-q') return filterRoster(t.value);
  if (t.closest('#outcome-form')) {
    if (t.name === 'status') $('#went-wrap').hidden = t.value !== 'completed';
    return;
  }
  const form = t.closest('#visit-form');
  if (!form) return;
  if (t.name === 'school' && form.elements.until) form.elements.until.value = lastDay(t.value);
  if (!['notes', 'skip', 'custom_name'].includes(t.name)) refreshVisitForm({ picker: t.name !== 'leader' });
});

// Keep the "Past events" section open while outcomes are being recorded.
document.addEventListener('toggle', (e) => {
  if (e.target.id === 'past-events') S.cal.pastOpen = e.target.open;
}, true);

// Pick up visits other leaders added while this tab was in the background.
let lastRefresh = Date.now();
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || $('#app').hidden || dlg.open || Date.now() - lastRefresh < 60000) return;
  lastRefresh = Date.now();
  try {
    await Promise.all(['visits', 'prospects', 'prospect_notes', 'availability', 'availability_status'].map(fetchTable));
    route();
  } catch { /* offline; keep what we have */ }
});

Object.assign(ctx, { S, db, $, $$, view, toast, openDialog, closeDialog, reload, route, opts, sortLeaders, desktop });
boot();
