import {
  SCHOOLS, SCHOOL_NAMES, schoolByName, ASSIGNMENTS, VISIT_TYPES, EVENT_CATEGORIES, CATEGORIES, BLOCKING,
  CAT_CLASS, LAST_DAY_FALLBACK, EVENING_START, esc, toDate, toIso, addDays, todayIso, fmtDate, weekdayName,
  parseTime, fmtTime, weeklyDates, schoolListLabel, downloadIcs, googleCalUrl,
} from './util.js';
import * as db from './data.js';

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
        <label>Your email
          <input type="email" name="email" required autocomplete="email" inputmode="email" placeholder="you@example.com">
        </label>
        <button class="btn primary" type="submit">Email me a sign-in link</button>
        <p class="muted small">Only approved leaders can sign in. No password needed.</p>
        <p class="error" id="signin-msg" hidden></p>
      </form>`;
  } else if (state === 'sent') {
    body.innerHTML = `
      <p><strong>Check your email.</strong></p>
      <p class="muted">We sent a sign-in link to ${esc(extra)}. Open it on this device.</p>
      <button class="btn" data-action="signin-again">Use a different email</button>`;
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
  if (!email) return showWelcome('signin');
  showWelcome('loading');
  try {
    const mine = (await db.list('allowed_emails')).find((r) => r.email.toLowerCase() === email.toLowerCase());
    if (!mine) return showWelcome('denied', email);
    S.isAdmin = !!mine.is_admin;
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

async function loadAll() {
  const [leaders, events, visits] = await Promise.all([db.list('leaders'), db.list('school_events'), db.list('visits')]);
  S.leaders = leaders;
  S.events = events;
  S.visits = visits;
  indexBlocked();
}
async function reload(table) {
  if (table === 'leaders') S.leaders = await db.list('leaders');
  if (table === 'visits') S.visits = await db.list('visits');
  if (table === 'school_events') { S.events = await db.list('school_events'); indexBlocked(); }
  if (table === 'allowed_emails') S.allowed = await db.list('allowed_emails');
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
const leaderName = (id) => S.leaders.find((l) => l.id === id)?.name;

// Events and visits in one shape, for the calendar and school pages.
function allItems() {
  const events = S.events.map((e) => ({
    kind: 'event', id: e.id, date: e.date, end: e.end_date || e.date, title: e.title, category: e.category,
    schools: splitSchools(e.schools), timeText: e.time || '', mins: parseTime(e.time), durationMin: 120,
    location: e.location || '', note: e.note || '', source: e.source || '', people: [],
  }));
  const visits = S.visits.map((v) => ({
    kind: 'visit', id: v.id, date: v.date, end: v.date, title: `${v.type} at ${v.school}`, category: v.type,
    schools: [v.school], timeText: fmtTime(v.time), mins: parseTime(v.time), durationMin: 60,
    location: v.school, note: v.notes || '', source: '', series: v.series_id,
    people: (v.leader_ids || []).map(leaderName).filter(Boolean),
  }));
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
        <div class="p-name">${esc(l.name)}${l.is_team_lead ? ' <span class="badge lead">Team Lead</span>' : ''}</div>
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
  return `
    <details class="item c-${CAT_CLASS[it.category] || 'cal'}">
      <summary>
        <span class="item-title">${esc(it.title)}</span>
        <span class="item-meta">${meta || esc(it.category)}</span>
        ${it.people.length ? `<span class="item-meta">Going: ${esc(it.people.join(', '))}</span>` : ''}
      </summary>
      <div class="item-body">
        <div><span class="badge c-${CAT_CLASS[it.category] || 'cal'}">${esc(it.category)}</span>${it.series ? ' <span class="badge">Repeats weekly</span>' : ''}</div>
        ${showDate ? '' : `<div>${esc(range)}</div>`}
        ${it.location && it.kind === 'event' ? `<div>Where: ${esc(it.location)}</div>` : ''}
        ${it.note ? `<div>${esc(it.note)}</div>` : ''}
        ${it.kind === 'visit' && !it.people.length ? '<div class="faint">No leaders assigned yet</div>' : ''}
        <div class="row">
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
      const link = schoolByName(g) ? `<a class="small" href="#/school/${encodeURIComponent(g)}">School page</a>` : '';
      return `
        <section class="card group">
          <div class="group-head"><h3>${esc(g)} <span class="count">${list.length}</span></h3>${link}</div>
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
      <button class="btn block" data-action="new-visit" data-date="${d}">Schedule a visit this day</button>
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
      <button class="btn primary small" data-action="new-visit">Add visit</button>
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
      ? upcomingList(items)
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
            <span class="muted small">${leadersForSchool(s.name).length} leaders · ${visits} upcoming visit${visits === 1 ? '' : 's'}</span>
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
      <button class="btn primary small" data-action="new-visit" data-school="${esc(name)}">Add visit</button>
    </div>
    <section class="card">
      <h3>Visits <span class="count">${visits.length}</span></h3>
      ${visits.slice(0, 12).map((i) => itemCard(i, { showDate: true })).join('') || '<p class="muted">No visits scheduled yet.</p>'}
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

// ------------------------------------------------------------------ visits

function leaderPicker(school, checked) {
  const here = new Set(leadersForSchool(school).map((l) => l.id));
  const sorted = [...sortLeaders(S.leaders.filter((l) => here.has(l.id))), ...sortLeaders(S.leaders.filter((l) => !here.has(l.id)))];
  return sorted.map((l) => `
    <label class="check pick" data-q="${esc(l.name.toLowerCase())}">
      <input type="checkbox" name="leader" value="${esc(l.id)}"${checked.has(l.id) ? ' checked' : ''}>
      <span>${esc(l.name)} <span class="faint">${esc(l.assignment)}</span></span>
    </label>`).join('');
}

function visitForm(id, preset = {}) {
  const v = S.visits.find((x) => x.id === id);
  const school = v?.school || preset.school || [...S.cal.filters.schools][0] || SCHOOL_NAMES[0];
  const today = todayIso();
  const date = v?.date || preset.date || (today < '2027-01-06' ? '2027-01-06' : today);
  const seriesCount = v?.series_id ? S.visits.filter((x) => x.series_id === v.series_id).length : 0;
  openDialog(`
    <form id="visit-form" class="stack" data-id="${esc(id || '')}" data-series="${esc(v?.series_id || '')}">
      <h3>${v ? 'Edit visit' : 'Schedule a visit'}</h3>
      ${seriesCount > 1 ? `
        <fieldset class="scope">
          <legend>This visit repeats weekly. Change:</legend>
          <label class="check"><input type="radio" name="scope" value="one" checked> Only this visit</label>
          <label class="check"><input type="radio" name="scope" value="series"> The whole series (${seriesCount} visits)</label>
        </fieldset>` : ''}
      <div class="two">
        <label>Type <select name="type">${opts(VISIT_TYPES, v?.type || preset.type || 'Lunch Room Visit')}</select></label>
        <label>School <select name="school">${opts(SCHOOL_NAMES, school)}</select></label>
      </div>
      <div class="two">
        <label>Date <input type="date" name="date" required value="${esc(date)}"></label>
        <label>Time <input type="time" name="time" value="${esc(v?.time || '11:30')}"></label>
      </div>
      ${v ? '' : `
        <label class="check"><input type="checkbox" name="repeat"> Repeat every week</label>
        <label id="until-wrap" hidden>Until (defaults to the school's last day)
          <input type="date" name="until" value="${esc(lastDay(school))}">
        </label>`}
      <div id="conflicts"></div>
      <label>Notes (optional) <textarea name="notes" rows="2">${esc(v?.notes)}</textarea></label>
      <div>
        <div class="f-label">Leaders going <span id="pick-count" class="count"></span></div>
        <input id="pick-q" class="search" type="search" placeholder="Find a leader" aria-label="Find a leader">
        <div id="picker" class="picker">${leaderPicker(school, new Set(v?.leader_ids || []))}</div>
      </div>
      <div class="row end">
        ${v ? '<button type="button" class="btn danger" data-action="delete-visit">Cancel visit</button>' : ''}
        <span class="grow"></span>
        <button type="button" class="btn" data-action="close">Close</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`);
  refreshVisitForm();
}

// What the form currently describes: which dates, and which of them hit a day off.
function visitPlan(form) {
  const f = new FormData(form);
  const school = f.get('school');
  const scope = f.get('scope') || 'one';
  const date = f.get('date');
  let dates = date ? [date] : [];
  if (form.dataset.id && scope === 'series') {
    dates = S.visits.filter((x) => x.series_id === form.dataset.series).map((x) => x.date).sort();
  } else if (!form.dataset.id && f.has('repeat') && date && f.get('until')) {
    dates = weeklyDates(date, f.get('until'));
  }
  const hits = dates.map((d) => ({ date: d, b: blockedOn(school, d) })).filter((x) => x.b);
  return { f, school, scope, dates, hits, repeat: !form.dataset.id && f.has('repeat') };
}

function refreshVisitForm() {
  const form = $('#visit-form');
  if (!form) return;
  const { school, scope, dates, hits, repeat } = visitPlan(form);
  const until = $('#until-wrap', form);
  if (until) until.hidden = !repeat;
  form.elements.date.disabled = scope === 'series';
  $('#pick-count', form).textContent = $$('input[name=leader]:checked', form).length || '';

  const box = $('#conflicts', form);
  const many = dates.length > 1;
  if (!hits.length) {
    box.innerHTML = many ? `<p class="note ok">${dates.length} visits, ${fmtDate(dates[0])} to ${fmtDate(dates.at(-1))}. None fall on a day off at ${esc(school)}.</p>` : '';
    return;
  }
  const keepSkip = $('input[name=skip]', form)?.checked ?? true;
  const allOff = hits.every((h) => h.b.category === 'No School');
  const what = allOff ? 'days with no school' : 'days with no school, a half day or e-learning';
  const sameDay = dates.every((d) => weekdayName(d) === weekdayName(dates[0]));
  const head = many
    ? `${hits.length} of your ${dates.length} ${sameDay ? `${weekdayName(dates[0])}s` : 'visits'} ${hits.length === 1 ? 'falls' : 'fall'} on ${what} at ${esc(school)}.`
    : `Heads up: ${fmtDate(dates[0])} is ${allOff ? 'a day with no school' : 'a half day or e-learning day'} at ${esc(school)}.`;
  box.innerHTML = `
    <div class="note warn">
      <strong>${head}</strong>
      <ul>${hits.map((h) => `<li>${fmtDate(h.date)}: ${esc(h.b.category)} (${esc(h.b.title)})</li>`).join('')}</ul>
      ${many ? `<label class="check"><input type="checkbox" name="skip"${keepSkip ? ' checked' : ''}> Skip those dates automatically</label>` : ''}
    </div>`;
}

async function saveVisit(form) {
  const { f, school, scope, dates, hits } = visitPlan(form);
  const fields = {
    type: f.get('type'), school, time: f.get('time') || null,
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
    msg = keep.length > 1 ? `Scheduled ${keep.length} visits${skip.size ? `, skipped ${skip.size}` : ''}` : 'Visit scheduled';
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
  closeDialog();
  toast(msg);
  await reload('visits');
}

async function deleteVisit(form) {
  const series = new FormData(form).get('scope') === 'series';
  const n = series ? S.visits.filter((x) => x.series_id === form.dataset.series).length : 1;
  if (!confirm(series ? `Cancel all ${n} visits in this series?` : 'Cancel this visit?')) return;
  await db.remove('visits', series ? { series_id: form.dataset.series } : { id: form.dataset.id });
  closeDialog();
  toast(series ? `Cancelled ${n} visits` : 'Visit cancelled');
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
  view.innerHTML = `
    <div class="page-head"><h2>More</h2></div>
    ${db.mode === 'demo' ? '<p class="note warn">Demo mode: this copy is running on this computer only and saves to this browser. Fill in config.js to connect the real database.</p>' : ''}
    ${S.isAdmin ? `
      <section class="card">
        <h3>Admin</h3>
        <div class="row">
          <button class="btn" data-action="edit-leader">Add leader</button>
          <button class="btn" data-action="edit-event">Add school event</button>
        </div>
        <p class="muted small">To change a leader, tap Edit next to their name on the Roster. To change an event, open it on the Calendar and tap Edit.</p>
        <h4>Approved emails <span class="count">${S.allowed.length}</span></h4>
        <p class="muted small">Only these emails can sign in.</p>
        <form id="allow-form" class="row">
          <input class="grow" type="email" name="email" required placeholder="new.leader@example.com" aria-label="Email to approve">
          <label class="check"><input type="checkbox" name="is_admin"> Admin</label>
          <button class="btn primary">Approve</button>
        </form>
        <ul class="people">
          ${[...S.allowed].sort((a, b) => a.email.localeCompare(b.email)).map((a) => `
            <li class="person">
              <div class="p-main"><div class="p-name">${esc(a.email)}${a.is_admin ? ' <span class="badge lead">Admin</span>' : ''}</div></div>
              <div class="p-actions">${a.email.toLowerCase() === S.email.toLowerCase() ? '<span class="faint small">You</span>' : `
                <button class="pill" data-action="toggle-admin" data-email="${esc(a.email)}">${a.is_admin ? 'Remove admin' : 'Make admin'}</button>
                <button class="pill" data-action="unapprove" data-email="${esc(a.email)}">Remove</button>`}</div>
            </li>`).join('')}
        </ul>
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
      <p class="muted small">Signed in as ${esc(S.email)}${S.isAdmin ? ' (admin)' : ''}</p>
      <button class="btn" data-action="signout">${db.mode === 'demo' ? 'Reset demo data' : 'Sign out'}</button>
    </section>`;
}

// ------------------------------------------------------------------ routing

async function route() {
  if ($('#app').hidden) return;
  const [, page = 'roster', arg] = location.hash.split('/');
  const tab = page === 'school' ? 'schools' : ['roster', 'calendar', 'schools', 'more'].includes(page) ? page : 'roster';
  $$('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  if (page === 'calendar') renderCalendar();
  else if (page === 'schools') renderSchools();
  else if (page === 'school') renderSchool(decodeURIComponent(arg || ''));
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
  'signin-again': () => showWelcome('signin'),

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
    if (!confirm(`Remove ${el.dataset.email}? They will no longer be able to see the directory.`)) return;
    await db.remove('allowed_emails', { email: el.dataset.email });
    await reload('allowed_emails');
  },
};

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
    const email = new FormData(form).get('email').trim().toLowerCase();
    const msg = $('#signin-msg');
    msg.hidden = true;
    try {
      await db.sendMagicLink(email);
      showWelcome('sent', email);
    } catch (err) {
      msg.textContent = `We could not send a link to that address. If it is not on the approved list, ask the admin to add it. (${errText(err)})`;
      msg.hidden = false;
    }
  },
  'leader-form': saveLeader,
  'visit-form': saveVisit,
  'event-form': saveEvent,
  'allow-form': async (form) => {
    const f = new FormData(form);
    const email = String(f.get('email')).trim().toLowerCase();
    if (S.allowed.some((a) => a.email.toLowerCase() === email)) return toast('That email is already approved.');
    await db.insert('allowed_emails', [{ email, is_admin: f.has('is_admin') }]);
    toast(`${email} can now sign in`);
    await reload('allowed_emails');
  },
};

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
  if (t.id === 'pick-q') {
    const q = t.value.toLowerCase().trim();
    $$('#picker .pick').forEach((row) => { row.hidden = !row.dataset.q.includes(q); });
    return;
  }
  const form = t.closest('#visit-form');
  if (!form) return;
  if (t.name === 'school') {
    const checked = new Set($$('input[name=leader]:checked', form).map((b) => b.value));
    $('#picker', form).innerHTML = leaderPicker(t.value, checked);
    $('#pick-q', form).value = '';
    if (form.elements.until) form.elements.until.value = lastDay(t.value);
  }
  if (t.name !== 'notes' && t.name !== 'skip') refreshVisitForm();
});

// Pick up visits other leaders added while this tab was in the background.
let lastRefresh = Date.now();
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || $('#app').hidden || dlg.open || Date.now() - lastRefresh < 60000) return;
  lastRefresh = Date.now();
  try { S.visits = await db.list('visits'); route(); } catch { /* offline; keep what we have */ }
});

boot();
