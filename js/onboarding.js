// Onboarding: the prospect pipeline, the holding list, and released prospects.
// Only the stage is tracked. Background-check results or details are never stored.
import { ctx } from './ctx.js';
import {
  esc, STAGES, DEFAULT_THRESHOLDS, YEARS, HOLDING_LISTS, ONBOARDING_TAG, SITES, ASSIGNMENTS, daysSince, fmtDate, localDay,
} from './util.js';

const clamp = (n) => Math.min(5, Math.max(2, Math.round(Number(n)) || 3));
const threshold = (stage) => clamp(ctx.S.settings.stall_thresholds?.[stage] ?? DEFAULT_THRESHOLDS[stage]);
const days = (p) => daysSince(p.stage_changed_at);
const stalled = (p) => p.status === 'pipeline' && days(p) >= threshold(p.stage);
const who = () => ctx.S.me?.name || ctx.S.email;
const now = () => new Date().toISOString();
const find = (id) => ctx.S.prospects.find((p) => p.id === id);
const byName = (a, b) => a.name.localeCompare(b.name);
const shortDate = (ts) => fmtDate(localDay(ts), { month: 'short', day: 'numeric', year: 'numeric' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function pocNames(p) {
  const names = (p.poc_ids || []).map((id) => ctx.S.leaders.find((l) => l.id === id)?.name).filter(Boolean);
  return [...names, p.poc_other].filter(Boolean).join(', ');
}
const label = (p) => (p.status === 'pipeline' ? p.stage
  : p.status === 'holding' ? `Holding list: ${p.holding_list}`
  : p.status === 'released' ? 'Released' : 'Added to roster');

// ------------------------------------------------------------------ page

function card(p) {
  const sub = [p.year, p.site_interest].filter(Boolean).map(esc).join(' · ');
  const contacts = pocNames(p);
  const badges = [];
  if (p.status === 'pipeline') {
    badges.push(`<span class="badge">${plural(days(p), 'day')} in stage</span>`);
    if (stalled(p)) badges.push('<span class="badge bad">Stalled</span>');
  }
  if (p.needs_review?.length) badges.push('<span class="badge warn">Needs review</span>');
  return `
    <button class="pcard${stalled(p) ? ' stalled' : ''}" data-action="open-prospect" data-id="${esc(p.id)}">
      <span class="p-name">${esc(p.name)}</span>
      ${sub ? `<span class="p-sub">${sub}</span>` : ''}
      ${p.status === 'pipeline'
        ? `<span class="p-sub">${contacts ? `Contact: ${esc(contacts)}` : '<span class="faint">No point of contact</span>'}</span>`
        : `<span class="p-sub">${esc(p.reason || '')}</span>`}
      ${badges.length ? `<span class="badges">${badges.join('')}</span>` : ''}
    </button>`;
}

function pipelineView(list) {
  const { S } = ctx;
  const cols = STAGES.map((stage) => ({ stage, items: list.filter((p) => p.stage === stage).sort((a, b) => days(b) - days(a) || byName(a, b)) }));
  if (S.onb.view === 'board') {
    return `<div class="board">${cols.map((c) => `
      <div class="col">
        <h4><span>${esc(c.stage)}</span><span class="count">${c.items.length}</span></h4>
        ${c.items.map(card).join('') || '<p class="faint small">No one here.</p>'}
      </div>`).join('')}</div>`;
  }
  return cols.map((c) => `
    <section class="card">
      <h3>${esc(c.stage)} <span class="count">${c.items.length}</span> <span class="faint small">stalls after ${plural(threshold(c.stage), 'day')}</span></h3>
      ${c.items.map(card).join('') || '<p class="faint small">No one here.</p>'}
    </section>`).join('');
}

function settingsCard() {
  const { S } = ctx;
  const team = S.leaders.filter((l) => (l.tags || []).includes(ONBOARDING_TAG));
  const noEmail = team.filter((l) => !l.email);
  return `
    <details class="card">
      <summary><strong>Onboarding settings</strong> <span class="faint small">admins only</span></summary>
      <h4>Stall reminders</h4>
      <p class="muted small">A prospect is "stalled" after this many days in a stage (2 to 5). Each morning at 7:30 Central, one summary email goes to everyone tagged ${esc(ONBOARDING_TAG)}, only if someone is stalled.</p>
      <form id="thresholds-form" class="stack">
        <div class="thresholds">
          ${STAGES.map((s) => `<label>${esc(s)} <input type="number" name="${esc(s)}" min="2" max="5" step="1" required value="${threshold(s)}"></label>`).join('')}
        </div>
        <div><button class="btn primary">Save days</button></div>
      </form>
      <h4>${esc(ONBOARDING_TAG)} <span class="count">${team.length}</span></h4>
      <p class="small">${team.length ? esc(team.map((l) => l.name).join(', ')) : '<span class="faint">No one is tagged yet, so no reminder emails will be sent.</span>'}</p>
      ${noEmail.length ? `<p class="note warn">No email on file, so they will not get reminders: ${esc(noEmail.map((l) => l.name).join(', '))}</p>` : ''}
      <p class="muted small">To add or remove someone: Roster &gt; Edit next to their name &gt; Tags.</p>
      <h4>Test the emails</h4>
      <p class="muted small">Sends to your own email only, right now. The weekly export normally goes to all admins every Monday morning.</p>
      <div class="row">
        <button class="btn" data-action="test-email" data-v="stall">Send me a test reminder</button>
        <button class="btn" data-action="test-email" data-v="export">Send me a test weekly export</button>
      </div>
    </details>`;
}

export function render() {
  const { S, view } = ctx;
  const o = S.onb;
  const pipeline = S.prospects.filter((p) => p.status === 'pipeline');
  const holding = S.prospects.filter((p) => p.status === 'holding');
  const released = S.prospects.filter((p) => p.status === 'released');
  const added = S.prospects.filter((p) => p.status === 'added');
  const tab = (id, text, n) => `<button class="${o.tab === id ? 'on' : ''}" data-action="onb-tab" data-v="${id}">${text} <span class="count">${n}</span></button>`;
  let body;
  if (o.tab === 'holding') {
    body = HOLDING_LISTS.map((name) => {
      const items = holding.filter((p) => p.holding_list === name).sort(byName);
      return `
        <section class="card">
          <h3>${esc(name)} <span class="count">${items.length}</span></h3>
          <p class="muted small">${name === 'Next Semester' ? 'People who want to be contacted next semester.' : 'Anyone else worth remembering.'}</p>
          ${items.map(card).join('') || '<p class="faint small">No one here.</p>'}
        </section>`;
    }).join('');
  } else if (o.tab === 'released') {
    body = `
      <section class="card">
        <h3>Released <span class="count">${released.length}</span></h3>
        ${released.sort(byName).map(card).join('') || '<p class="faint small">No one has been released.</p>'}
      </section>
      <section class="card">
        <h3>Added to the roster <span class="count">${added.length}</span></h3>
        ${added.sort(byName).map(card).join('') || '<p class="faint small">No one yet.</p>'}
      </section>`;
  } else {
    const nStalled = pipeline.filter(stalled).length;
    body = `
      <div class="toolbar">
        <span class="muted small">${nStalled ? `${nStalled} stalled` : 'No one is stalled'}</span>
        <div class="seg" role="group" aria-label="Pipeline view">
          <button class="${o.view === 'board' ? 'on' : ''}" data-action="onb-view" data-v="board">Board</button>
          <button class="${o.view === 'list' ? 'on' : ''}" data-action="onb-view" data-v="list">List</button>
        </div>
      </div>
      ${pipelineView(pipeline)}`;
  }
  view.innerHTML = `
    <div class="page-head">
      <h2>Onboarding</h2>
      <button class="btn primary small" data-action="edit-prospect">Add prospect</button>
    </div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Onboarding lists">
        ${tab('pipeline', 'Pipeline', pipeline.length)}${tab('holding', 'Holding', holding.length)}${tab('released', 'Released', released.length)}
      </div>
    </div>
    ${body}
    ${S.isAdmin ? settingsCard() : ''}`;
}

// ------------------------------------------------------------------ one prospect

function detail(id) {
  const { S, opts } = ctx;
  const p = find(id);
  if (!p) return ctx.closeDialog();
  const notes = S.notes.filter((n) => n.prospect_id === id).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const history = S.history.filter((h) => h.prospect_id === id).sort((a, b) => b.changed_at.localeCompare(a.changed_at));
  const tel = (p.phone || '').replace(/[^\d+]/g, '');
  const row = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : '');
  const inPipeline = p.status === 'pipeline';
  const holdForm = (title, open = false) => `
    <details class="sub"${open ? ' open' : ''}>
      <summary>${title}</summary>
      <form id="hold-form" class="stack" data-id="${esc(id)}">
        <label>Which list <select name="list">${opts(HOLDING_LISTS, p.holding_list || 'Next Semester')}</select></label>
        <label>Reason (optional) <input name="reason" value="${esc(p.status === 'holding' ? p.reason : '')}"></label>
        <div><button class="btn primary">Move to holding list</button></div>
      </form>
    </details>`;
  const releaseForm = `
    <details class="sub">
      <summary>Release</summary>
      <form id="release-form" class="stack" data-id="${esc(id)}">
        <label>Reason (required) <input name="reason" required placeholder="For example: schedule conflict"></label>
        <div><button class="btn primary">Release</button></div>
      </form>
    </details>`;
  const restoreForm = `
    <details class="sub">
      <summary>Move back into the pipeline</summary>
      <form id="restore-form" class="stack" data-id="${esc(id)}">
        <label>Stage <select name="stage">${opts(STAGES, p.stage)}</select></label>
        <div><button class="btn primary">Move to pipeline</button></div>
      </form>
    </details>`;
  ctx.openDialog(`
    <div class="stack">
      <div class="page-head">
        <h3>${esc(p.name)}</h3>
        <button class="btn small" data-action="edit-prospect" data-id="${esc(id)}">Edit</button>
      </div>
      <div>
        <span class="badge">${esc(label(p))}</span>
        ${inPipeline ? `<span class="badge">${plural(days(p), 'day')} in stage</span>` : ''}
        ${stalled(p) ? '<span class="badge bad">Stalled</span>' : ''}
      </div>
      ${p.needs_review?.length ? `
        <div class="note warn">
          <strong>Needs review</strong>
          <ul>${p.needs_review.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
          ${S.isAdmin ? `<button class="btn small" data-action="clear-review" data-id="${esc(id)}">Mark as reviewed</button>` : '<span class="small">An admin can clear this once it is fixed.</span>'}
        </div>` : ''}
      <dl class="kv">
        ${row('Phone', tel ? `<a href="tel:${esc(tel)}">${esc(p.phone)}</a> · <a href="sms:${esc(tel)}">Text</a>` : '')}
        ${row('Year', esc(p.year))}
        ${row('Site interest', esc(p.site_interest))}
        ${row('Contacts', esc(pocNames(p)))}
        ${row('Next step', esc(p.next_step))}
        ${row('Church', esc(p.church))}
        ${row('Hometown', esc(p.hometown))}
        ${row('Referred by', esc(p.referred_by))}
        ${row('Has a car', p.has_car ? 'Yes' : '')}
        ${row('Rating', p.rating ? `${p.rating} of 3` : '')}
        ${row(p.status === 'released' ? 'Release reason' : 'Reason', inPipeline ? '' : esc(p.reason))}
      </dl>

      ${inPipeline ? `
        <form id="stage-form" class="row" data-id="${esc(id)}">
          <label class="grow">Stage <select name="stage">${opts(STAGES, p.stage)}</select></label>
          <button class="btn primary">Move</button>
        </form>
        ${p.stage === 'Final Decision' ? `
          <details class="sub" open>
            <summary>Add to roster</summary>
            <form id="roster-form" class="stack" data-id="${esc(id)}">
              <p class="muted small">Copies their name, phone and church into the leader roster.</p>
              <label>Assignment <select name="assignment">${opts(ASSIGNMENTS, ASSIGNMENTS.includes(p.site_interest) ? p.site_interest : 'TBD')}</select></label>
              <div><button class="btn primary">Add to roster</button></div>
            </form>
          </details>` : ''}
        ${holdForm('Move to the holding list')}
        ${releaseForm}` : ''}
      ${p.status === 'holding' ? restoreForm + holdForm('Change list or reason') + releaseForm : ''}
      ${p.status === 'released' ? restoreForm + holdForm('Move to the holding list') : ''}

      <div>
        <h4>Notes <span class="count">${notes.length}</span></h4>
        <form id="note-form" class="stack" data-id="${esc(id)}">
          <textarea name="body" rows="2" required placeholder="Add a note. Do not record background-check results."></textarea>
          <div><button class="btn primary small">Add note</button></div>
        </form>
        <ul class="notes">
          ${notes.map((n) => `<li><div>${esc(n.body)}</div><div class="faint small">${shortDate(n.created_at)} · ${esc(n.author || 'Unknown')}</div></li>`).join('')}
        </ul>
      </div>
      <details class="sub">
        <summary>History</summary>
        <ul class="notes">
          ${history.map((h) => `<li><div>${h.from_label ? `${esc(h.from_label)} &rarr; ` : ''}${esc(h.to_label)}</div><div class="faint small">${shortDate(h.changed_at)} · ${esc(h.changed_by || 'Unknown')}</div></li>`).join('') || '<li class="faint">No changes recorded.</li>'}
        </ul>
      </details>
      <div class="row end"><span class="grow"></span><button class="btn" data-action="close">Close</button></div>
    </div>`);
}

function editForm(id) {
  const { S, opts } = ctx;
  const p = find(id) || { stage: 'Not Sent', poc_ids: [] };
  const picked = new Set(p.poc_ids || []);
  const blank = (values, selected) => `<option value="">Not set</option>${opts(values, selected)}`;
  ctx.openDialog(`
    <form id="prospect-form" class="stack" data-id="${esc(id || '')}">
      <h3>${id ? 'Edit prospect' : 'Add prospect'}</h3>
      <label>Name <input name="name" required value="${esc(p.name)}"></label>
      <div class="two">
        <label>Phone <input name="phone" type="tel" autocomplete="off" value="${esc(p.phone)}"></label>
        <label>Year <select name="year">${blank(YEARS, p.year)}</select></label>
      </div>
      <div class="two">
        <label>Church <input name="church" value="${esc(p.church)}"></label>
        <label>Hometown <input name="hometown" value="${esc(p.hometown)}"></label>
      </div>
      <div class="two">
        <label>Referred by <input name="referred_by" value="${esc(p.referred_by)}"></label>
        <label>Rating <select name="rating">${blank(['1', '2', '3'], String(p.rating || ''))}</select></label>
      </div>
      <label>Site interest <select name="site_interest">${blank([...new Set([...SITES, p.site_interest].filter(Boolean))], p.site_interest)}</select></label>
      <label class="check"><input type="checkbox" name="has_car"${p.has_car ? ' checked' : ''}> Has a car</label>
      ${id ? '' : `<label>Stage <select name="stage">${opts(STAGES, p.stage)}</select></label>`}
      <label>Next step <input name="next_step" value="${esc(p.next_step)}"></label>
      <div>
        <div class="f-label">Points of contact</div>
        <div class="picker">
          ${ctx.sortLeaders(S.leaders).sort((a, b) => (picked.has(b.id) ? 1 : 0) - (picked.has(a.id) ? 1 : 0)).map((l) => `
            <label class="check pick"><input type="checkbox" name="poc" value="${esc(l.id)}"${picked.has(l.id) ? ' checked' : ''}>
              <span>${esc(l.name)} <span class="faint">${esc(l.assignment)}</span></span></label>`).join('')}
        </div>
      </div>
      <label>Other contact (someone not on the roster) <input name="poc_other" value="${esc(p.poc_other)}"></label>
      <div class="row end">
        ${id && S.isAdmin ? '<button type="button" class="btn danger" data-action="delete-prospect">Delete</button>' : ''}
        <span class="grow"></span>
        <button type="button" class="btn" data-action="${id ? 'open-prospect' : 'close'}" data-id="${esc(id || '')}">Cancel</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`);
}

// ------------------------------------------------------------------ saving

const refresh = () => ctx.reload('prospects', 'prospect_notes', 'prospect_history');
const log = (p, to) => ctx.db.insert('prospect_history', [{ prospect_id: p.id, from_label: label(p), to_label: to, changed_by: who(), changed_at: now() }]);

async function saveProspect(form) {
  const { db } = ctx;
  const f = new FormData(form);
  const text = (k) => String(f.get(k) || '').trim() || null;
  const row = {
    name: text('name'), phone: text('phone'), church: text('church'), hometown: text('hometown'),
    referred_by: text('referred_by'), year: text('year'), rating: Number(f.get('rating')) || null,
    site_interest: text('site_interest'), has_car: f.has('has_car'), next_step: text('next_step'),
    poc_ids: f.getAll('poc'), poc_other: text('poc_other'),
  };
  let id = form.dataset.id;
  if (id) {
    await db.update('prospects', { id }, row);
  } else {
    const stamp = now();
    const [made] = await db.insert('prospects', [{
      ...row, stage: f.get('stage'), stage_changed_at: stamp, status: 'pipeline', status_changed_at: stamp,
      needs_review: [], created_by: who(),
    }]);
    id = made.id;
    await db.insert('prospect_history', [{ prospect_id: id, from_label: null, to_label: f.get('stage'), changed_by: who(), changed_at: stamp }]);
  }
  ctx.toast('Saved');
  await refresh();
  detail(id);
}

export const submits = {
  'prospect-form': saveProspect,
  'note-form': async (form) => {
    const body = String(new FormData(form).get('body')).trim();
    if (!body) return;
    await ctx.db.insert('prospect_notes', [{ prospect_id: form.dataset.id, body, author: who(), created_at: now() }]);
    await refresh();
    detail(form.dataset.id);
  },
  'stage-form': async (form) => {
    const p = find(form.dataset.id);
    const stage = new FormData(form).get('stage');
    if (stage === p.stage) return ctx.toast('They are already in that stage.');
    await log(p, stage);
    await ctx.db.update('prospects', { id: p.id }, { stage, stage_changed_at: now() });
    ctx.toast(`Moved to ${stage}`);
    await refresh();
    detail(p.id);
  },
  'release-form': async (form) => {
    const p = find(form.dataset.id);
    const reason = String(new FormData(form).get('reason')).trim();
    if (!reason) throw new Error('A reason is required to release someone.');
    await log(p, 'Released');
    await ctx.db.update('prospects', { id: p.id }, { status: 'released', reason, holding_list: null, status_changed_at: now() });
    ctx.closeDialog();
    ctx.toast(`${p.name} released`);
    await refresh();
  },
  'hold-form': async (form) => {
    const p = find(form.dataset.id);
    const f = new FormData(form);
    const list = f.get('list');
    await log(p, `Holding list: ${list}`);
    await ctx.db.update('prospects', { id: p.id }, {
      status: 'holding', holding_list: list, reason: String(f.get('reason') || '').trim() || p.reason || null, status_changed_at: now(),
    });
    ctx.closeDialog();
    ctx.toast(`${p.name} is on the ${list} list`);
    await refresh();
  },
  'restore-form': async (form) => {
    const p = find(form.dataset.id);
    const stage = new FormData(form).get('stage');
    await log(p, stage);
    await ctx.db.update('prospects', { id: p.id }, { status: 'pipeline', stage, holding_list: null, stage_changed_at: now(), status_changed_at: now() });
    ctx.S.onb.tab = 'pipeline';
    ctx.toast(`${p.name} is back in the pipeline`);
    await refresh();
    detail(p.id);
  },
  'roster-form': async (form) => {
    const p = find(form.dataset.id);
    const assignment = new FormData(form).get('assignment');
    await ctx.db.rpc('add_prospect_to_roster', { p_id: p.id, p_assignment: assignment });
    ctx.closeDialog();
    ctx.toast(`${p.name} added to the roster (${assignment})`);
    await ctx.reload('prospects', 'prospect_history', 'leaders');
  },
  'thresholds-form': async (form) => {
    const f = new FormData(form);
    const value = Object.fromEntries(STAGES.map((s) => [s, clamp(f.get(s))]));
    await ctx.db.upsert('app_settings', [{ key: 'stall_thresholds', value }]);
    ctx.toast('Saved');
    await ctx.reload('app_settings');
  },
};

export const actions = {
  'onb-tab': (el) => { ctx.S.onb.tab = el.dataset.v; render(); },
  'onb-view': (el) => { ctx.S.onb.view = el.dataset.v; render(); },
  'open-prospect': (el) => detail(el.dataset.id),
  'edit-prospect': (el) => editForm(el.dataset.id),
  'delete-prospect': async () => {
    const id = ctx.$('#prospect-form').dataset.id;
    if (!confirm('Delete this prospect and their notes for good? To keep a record, release them instead.')) return;
    await ctx.db.remove('prospects', { id });
    ctx.closeDialog();
    await refresh();
  },
  'clear-review': async (el) => {
    await ctx.db.update('prospects', { id: el.dataset.id }, { needs_review: [] });
    await refresh();
    detail(el.dataset.id);
  },
  'test-email': async (el) => {
    el.disabled = true;
    try {
      const out = await ctx.db.callFunction('onboarding-email', { kind: el.dataset.v, test: true });
      ctx.toast(out.message || 'Sent. Check your inbox.');
    } finally {
      el.disabled = false;
    }
  },
};
