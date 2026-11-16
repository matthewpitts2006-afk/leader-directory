// Weekly availability: exact time blocks per leader, entered by each team's lead.
import { ctx } from './ctx.js';
import {
  esc, TEAMS, DAYS, DAY_SHORT, DEFAULT_SEMESTER_STARTS, fmtMins, minsToInput, parseTime, toDate, todayIso,
  dayDiff, localDay, fmtDate,
} from './util.js';

const REVIEW_DAYS = 30; // how long the semester reminder stays up
const DISMISS_KEY = 'leader-directory-semester-dismissed';

export const teamMembers = (team) =>
  ctx.sortLeaders(ctx.S.leaders.filter((l) => l.assignment === team || l.assignment === 'All Schools'));

// Teams the signed-in person may edit: admins all of them, a team lead their own.
export function myTeams() {
  const { S } = ctx;
  if (S.isAdmin) return TEAMS;
  return S.me?.is_team_lead && TEAMS.includes(S.me.assignment) ? [S.me.assignment] : [];
}

const blocksFor = (id) =>
  ctx.S.availability.filter((b) => b.leader_id === id).sort((a, b) => a.weekday - b.weekday || a.start_min - b.start_min);
const statusFor = (id) => ctx.S.availStatus.find((s) => s.leader_id === id);

// Is this leader free for the whole event? 'unknown' when nothing has been entered for them.
export function check(leaderId, date, start, end) {
  if (!statusFor(leaderId)) return 'unknown';
  const weekday = toDate(date).getUTCDay();
  const blocks = blocksFor(leaderId).filter((b) => b.weekday === weekday);
  if (start == null) return blocks.length ? 'yes' : 'no';
  const finish = end != null && end > start ? end : start;
  return blocks.some((b) => b.start_min <= start && b.end_min >= finish) ? 'yes' : 'no';
}

function summary(id) {
  const blocks = blocksFor(id);
  if (!blocks.length) return statusFor(id) ? 'No available times' : '';
  return blocks.map((b) => `${DAY_SHORT[b.weekday]} ${fmtMins(b.start_min)}–${fmtMins(b.end_min)}`).join(' · ');
}

export function render(team) {
  const { S, view, opts } = ctx;
  if (!TEAMS.includes(team)) team = myTeams()[0] || TEAMS[0];
  const canEdit = myTeams().includes(team);
  const members = teamMembers(team);
  view.innerHTML = `
    <div class="page-head"><h2>Availability</h2></div>
    <label>Team <select id="avail-team">${opts(TEAMS, team)}</select></label>
    <p class="muted small">${canEdit
      ? 'Enter the exact times each leader is free in a normal week. These are used when leaders are assigned to events.'
      : 'Each team\'s lead keeps this up to date. Ask your team lead or an admin to change yours.'}</p>
    <section class="card">
      <h3>${esc(team)} <span class="count">${members.length}</span></h3>
      <ul class="people">
        ${members.map((l) => {
          const st = statusFor(l.id);
          return `
          <li class="person">
            <div class="p-main">
              <div class="p-name">${esc(l.name)}${l.assignment === 'All Schools' ? ' <span class="faint small">All Schools</span>' : ''}</div>
              <div class="p-sub">${esc(summary(l.id)) || '<span class="faint">Not entered yet</span>'}</div>
              <div class="p-sub faint">${st ? `Last updated ${fmtDate(localDay(st.updated_at), { month: 'short', day: 'numeric', year: 'numeric' })}${st.updated_by ? ` by ${esc(st.updated_by)}` : ''}` : ''}</div>
            </div>
            <div class="p-actions">${canEdit ? `<button class="pill" data-action="edit-avail" data-id="${esc(l.id)}">Edit</button>` : ''}</div>
          </li>`;
        }).join('') || '<li class="muted">No leaders on this team yet.</li>'}
      </ul>
    </section>
    ${!S.me && !S.isAdmin ? '<p class="muted small">Team leads: if you cannot edit your team, ask an admin to put your sign-in email on your roster entry.</p>' : ''}`;
}

const blockRow = (b = {}) => `
  <div class="block-row">
    <select name="weekday" aria-label="Day">${DAYS.map((d, i) => `<option value="${i}"${i === (b.weekday ?? 1) ? ' selected' : ''}>${d}</option>`).join('')}</select>
    <input type="time" name="start" required aria-label="From" value="${b.start_min != null ? minsToInput(b.start_min) : ''}">
    <input type="time" name="end" required aria-label="Until" value="${b.end_min != null ? minsToInput(b.end_min) : ''}">
    <button type="button" class="pill" data-action="avail-del" aria-label="Remove this time block">Remove</button>
  </div>`;

function editForm(id) {
  const l = ctx.S.leaders.find((x) => x.id === id);
  if (!l) return;
  const blocks = blocksFor(id);
  ctx.openDialog(`
    <form id="avail-form" class="stack" data-id="${esc(id)}">
      <h3>${esc(l.name)}: weekly availability</h3>
      <p class="muted small">Add one row for each stretch of time they are free, for example Tuesday 11:15 AM to 1:30 PM. Several rows on the same day are fine. Leave it empty if they have no free times.</p>
      <div class="blocks" id="avail-blocks">${blocks.map(blockRow).join('')}</div>
      <button type="button" class="btn" data-action="avail-add">Add a time block</button>
      <div class="row end">
        <span class="grow"></span>
        <button type="button" class="btn" data-action="close">Cancel</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`);
}

async function save(form) {
  const { S, db } = ctx;
  const id = form.dataset.id;
  const rows = ctx.$$('.block-row', form).map((row) => ({
    leader_id: id,
    weekday: Number(ctx.$('[name=weekday]', row).value),
    start_min: parseTime(ctx.$('[name=start]', row).value),
    end_min: parseTime(ctx.$('[name=end]', row).value),
  }));
  if (rows.some((r) => r.start_min == null || r.end_min == null)) throw new Error('Fill in both times on every row, or remove the row.');
  if (rows.some((r) => r.end_min <= r.start_min)) throw new Error('Each block needs an end time after its start time.');
  // Replace this leader's blocks with what is on the form. Old blocks are only removed here, by hand.
  await db.remove('availability', { leader_id: id });
  if (rows.length) await db.insert('availability', rows);
  await db.upsert('availability_status', [{ leader_id: id, updated_at: new Date().toISOString(), updated_by: S.me?.name || S.email }]);
  ctx.closeDialog();
  ctx.toast('Availability saved');
  await ctx.reload('availability', 'availability_status');
}

// ---- semester reminder for team leads

function semesterStart() {
  const today = todayIso();
  const year = Number(today.slice(0, 4));
  const starts = ctx.S.settings.semester_starts || DEFAULT_SEMESTER_STARTS;
  const past = [year, year - 1].flatMap((y) => starts.map((md) => `${y}-${md}`)).filter((d) => d <= today).sort();
  const latest = past.at(-1);
  return latest && dayDiff(latest, today) <= REVIEW_DAYS ? latest : null;
}

export function semesterBanner() {
  const teams = myTeams();
  const start = teams.length && semesterStart();
  if (!start) return '';
  try { if (localStorage.getItem(DISMISS_KEY) === start) return ''; } catch { /* private window */ }
  const stale = new Set();
  for (const team of teams) {
    for (const l of teamMembers(team)) {
      const st = statusFor(l.id);
      if (!st || localDay(st.updated_at) < start) stale.add(l.id);
    }
  }
  if (!stale.size) return '';
  return `
    <div class="note warn banner">
      <span class="grow"><strong>New semester.</strong> Please review your team's availability: ${stale.size} leader${stale.size === 1 ? ' has' : 's have'} not been updated since ${fmtDate(start, { month: 'long', day: 'numeric' })}.</span>
      <a class="btn small primary" href="#/availability/${encodeURIComponent(teams[0])}">Review</a>
      <button class="btn small" data-action="banner-dismiss" data-v="${start}">Dismiss</button>
    </div>`;
}

export const actions = {
  'edit-avail': (el) => editForm(el.dataset.id),
  'avail-add': () => ctx.$('#avail-blocks').insertAdjacentHTML('beforeend', blockRow()),
  'avail-del': (el) => el.closest('.block-row').remove(),
  'banner-dismiss': (el) => {
    try { localStorage.setItem(DISMISS_KEY, el.dataset.v); } catch { /* private window */ }
    ctx.$('#banner').innerHTML = '';
  },
};
export const submits = { 'avail-form': save };

document.addEventListener('change', (e) => {
  if (e.target.id === 'avail-team') location.hash = `#/availability/${encodeURIComponent(e.target.value)}`;
});
