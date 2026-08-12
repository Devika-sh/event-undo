/* ==========================================================================
   EventUndo — Admin dashboard
   --------------------------------------------------------------------------
   One page, hash-routed views. Every view follows the same shape:
     load()   → pull rows into `store`
     render() → paint the table body
     edit()   → open the shared modal with a form
   Writes go straight to Supabase; RLS decides what actually lands, so the
   role checks here are for the UI's benefit, not for security.
   ========================================================================== */

import {
  supabase, isConfigured, getSession, getProfile, isAdmin, isStaff,
  signOut, logActivity, formatDate, formatTime, formatFee, formatShort,
  toLocalInput, slugify, esc, initials
} from './supabase-client.js';

/* ==========================================================================
   1. State + tiny DOM helpers
   ========================================================================== */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const store = {
  me: null,
  events: [],
  orgs: [],
  categories: [],
  people: [],        // every profile row
  rsvps: [],
  saves: [],
  interests: [],
  team: [],
  activity: []
};

/** Every filter-chip group, in the fixed order they're shown across the
 *  site — keeps the Categories table and its editor from ever disagreeing. */
const CATEGORY_GROUPS = ['mode', 'timing', 'organiser', 'topic'];

const VIEWS = {
  overview:      { title: 'Overview',      sub: 'How the platform is doing right now' },
  events:        { title: 'Events',        sub: 'Create, edit and publish events' },
  organizations: { title: 'Organisations', sub: 'Clubs and organisations running events' },
  categories:    { title: 'Categories',    sub: 'Filter chips shown across the site' },
  volunteers:    { title: 'Volunteers',    sub: 'People who can add and edit events' },
  users:         { title: 'Users',         sub: 'Everyone signed up on the public site' },
  registrations: { title: 'Registrations', sub: 'RSVPs collected from event pages' },
  team:          { title: 'Site roster',   sub: 'The public “The Team” page' },
  activity:      { title: 'Activity',      sub: 'Who changed what, and when' },
  settings:      { title: 'Settings',      sub: 'Your account and site-wide options' }
};

/* ---- toast --------------------------------------------------------------- */

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = 'a-toast' + (kind ? ' a-toast--' + kind : '');
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}

function fail(error, what) {
  console.error('[eventundo]', what, error);
  toast((error?.message || 'Something went wrong') + ' — ' + what, 'error');
}

/* ---- modal --------------------------------------------------------------- */

let modalCleanup = null;

/**
 * Opens the shared modal.
 * @param {{title:string, body:string, actions:Array, wide?:boolean, narrow?:boolean,
 *          onMount?:(body:HTMLElement)=>void}} config
 */
function openModal({ title, body, actions = [], wide, narrow, onMount }) {
  const modal = $('#modal');
  const box = $('#modal-box');
  box.className = 'a-modal__box' + (wide ? ' a-modal__box--wide' : '')
                                 + (narrow ? ' a-modal__box--narrow' : '');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;

  const foot = $('#modal-foot');
  foot.innerHTML = '';
  actions.forEach((action) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'a-btn' + (action.variant ? ' a-btn--' + action.variant : '');
    btn.textContent = action.label;
    btn.addEventListener('click', () => action.onClick(btn));
    foot.append(btn);
  });

  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  if (onMount) onMount($('#modal-body'));

  const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', onKey);
  modalCleanup = () => document.removeEventListener('keydown', onKey);

  const firstField = $('#modal-body input, #modal-body select, #modal-body textarea');
  if (firstField) firstField.focus();
}

function closeModal() {
  $('#modal').hidden = true;
  document.body.style.overflow = '';
  if (modalCleanup) { modalCleanup(); modalCleanup = null; }
}

$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

/** Small yes/no gate in front of anything destructive. */
function confirmAction({ title, message, confirmLabel = 'Delete', onConfirm }) {
  openModal({
    title,
    narrow: true,
    body: `<p style="margin:0;font-size:var(--font-size-body-xs);color:var(--text-secondary)">${esc(message)}</p>`,
    actions: [
      { label: 'Cancel', variant: 'ghost', onClick: closeModal },
      {
        label: confirmLabel,
        variant: 'danger',
        onClick: async (btn) => {
          btn.disabled = true;
          await onConfirm();
          closeModal();
        }
      }
    ]
  });
}

/* ---- misc ---------------------------------------------------------------- */

function setError(id, message) {
  const box = $('#' + id);
  if (!box) return;
  box.textContent = message || '';
  box.hidden = !message;
}

function skeletonRows(cols, rows = 4) {
  return Array.from({ length: rows }, () =>
    `<tr>${'<td><span class="a-skeleton" style="display:block"></span></td>'.repeat(cols)}</tr>`
  ).join('');
}

function emptyRow(cols, title, message) {
  return `<tr><td colspan="${cols}">
    <div class="a-empty">
      <p class="a-empty__title">${esc(title)}</p>
      <p>${esc(message)}</p>
    </div></td></tr>`;
}

function downloadCsv(filename, rows) {
  const escapeCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = rows.map((r) => r.map(escapeCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const statusBadge = (status) => {
  const cls = status === 'published' ? 'live' : status === 'draft' ? 'soft' : 'muted';
  return `<span class="a-badge a-badge--${cls}">${esc(status)}</span>`;
};

/* ==========================================================================
   2. Boot — config gate, auth guard, reference data
   ========================================================================== */

async function boot() {
  if (!isConfigured) {
    document.body.innerHTML = `
      <div class="a-setup">
        <h2>Connect Supabase to finish setup</h2>
        <ol>
          <li>Open your <strong>event-undo</strong> project → SQL Editor, paste
              <code>supabase-schema.sql</code> and run it.</li>
          <li>Project Settings → API: copy the <strong>Project URL</strong> and the
              <strong>anon public</strong> key into <code>supabase-config.js</code>.</li>
          <li>Reload this page and create the first account — it becomes the admin.</li>
        </ol>
      </div>`;
    return;
  }

  const session = await getSession();
  if (!session) { location.replace('admin-login.html'); return; }

  const profile = await getProfile();
  if (!profile) {
    toast('No profile row for this account.', 'error');
    await signOut();
    location.replace('admin-login.html');
    return;
  }
  if (!isStaff(profile)) {
    // A plain user landed here. Send them back to the site they belong on.
    toast('That account does not have console access.', 'error');
    setTimeout(() => location.replace('index.html'), 1500);
    return;
  }
  if (profile.status === 'suspended') {
    await signOut();
    location.replace('admin-login.html');
    return;
  }

  store.me = profile;
  paintIdentity();
  applyRoleVisibility();

  $('#page-loader').setAttribute('data-hidden', '');
  $('#admin').hidden = false;

  await loadReferenceData();
  wireChrome();
  route();
}

function paintIdentity() {
  const { me } = store;
  $('#me-avatar').textContent = initials(me.full_name || me.email);
  $('#me-name').textContent = me.full_name || me.email;
  $('#me-role').textContent = me.organizations?.name
    ? `${me.role} · ${me.organizations.name}`
    : me.role;
}

/** Volunteers get a narrower console: no people management, no org creation. */
function applyRoleVisibility() {
  if (isAdmin(store.me)) return;
  $$('[data-admin-only]').forEach((el) => { el.hidden = true; });
}

async function loadReferenceData() {
  const [orgs, categories] = await Promise.all([
    supabase.from('organizations').select('*').order('name'),
    supabase.from('categories').select('*').order('group_name').order('sort_order')
  ]);

  if (orgs.error) fail(orgs.error, 'loading organisations');
  if (categories.error) fail(categories.error, 'loading categories');

  store.orgs = orgs.data || [];
  store.categories = categories.data || [];

  const orgFilter = $('#events-org');
  orgFilter.innerHTML = '<option value="">All organisations</option>' +
    store.orgs.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
}

function wireChrome() {
  $$('.a-nav__link[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => { location.hash = '#' + btn.dataset.view; });
  });

  $('#signout').addEventListener('click', async () => {
    await signOut();
    location.replace('admin-login.html');
  });

  $('#menu-btn').addEventListener('click', () => {
    $('#admin').toggleAttribute('data-nav-open');
  });

  window.addEventListener('hashchange', route);

  // Toolbar buttons live inside views, so one delegated listener covers them all.
  document.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    const handler = ACTIONS[action];
    if (handler) handler(e.target.closest('[data-action]'));
  });

  $('#events-search').addEventListener('input', renderEvents);
  $('#events-status').addEventListener('change', renderEvents);
  $('#events-org').addEventListener('change', renderEvents);
  $('#orgs-search').addEventListener('input', renderOrgs);
  $('#volunteers-search').addEventListener('input', renderVolunteers);
  $('#users-search').addEventListener('input', renderUsers);
  $('#reg-event').addEventListener('change', renderRegistrations);
  $('#reg-response').addEventListener('change', renderRegistrations);
  $('#reg-search').addEventListener('input', renderRegistrations);

  $('#account-form').addEventListener('submit', saveAccount);
  $('#password-form').addEventListener('submit', savePassword);
  $('#featured-save').addEventListener('click', saveFeatured);
}

/* ==========================================================================
   3. Router
   ========================================================================== */

const LOADERS = {
  overview: loadOverview,
  events: loadEvents,
  organizations: loadOrgs,
  categories: loadCategories,
  volunteers: loadPeople,
  users: loadPeople,
  registrations: loadRegistrations,
  team: loadTeam,
  activity: loadActivity,
  settings: loadSettings
};

// Volunteers only add/edit organisations and events — everything else in
// the console (overview, categories, people, registrations, activity,
// settings) is admin-only.
const VOLUNTEER_VIEWS = ['events', 'organizations'];

function route() {
  let name = location.hash.replace('#', '') || 'overview';
  if (!VIEWS[name]) name = 'overview';
  if (!isAdmin(store.me) && !VOLUNTEER_VIEWS.includes(name)) name = 'events';

  $$('.a-view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
  $$('.a-nav__link[data-view]').forEach((b) => {
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });

  $('#view-title').textContent = VIEWS[name].title;
  $('#view-sub').textContent = VIEWS[name].sub;
  $('#admin').removeAttribute('data-nav-open');

  LOADERS[name]();
}

/* ==========================================================================
   4. Overview
   ========================================================================== */

async function loadOverview() {
  const stats = $('#stats');
  stats.innerHTML = Array.from({ length: 5 }, () =>
    `<div class="a-stat"><span class="a-skeleton" style="width:60%"></span>
     <p class="a-stat__value" style="margin-top:12px"><span class="a-skeleton" style="width:40%;height:28px"></span></p></div>`
  ).join('');

  const [events, people, rsvps, saves] = await Promise.all([
    supabase.from('events_public').select('*').order('starts_at', { ascending: true }),
    supabase.from('profiles').select('id, role, created_at'),
    supabase.from('event_rsvps').select('id, response'),
    supabase.from('event_saves').select('event_id')
  ]);

  if (events.error) { fail(events.error, 'loading events'); return; }

  store.events = events.data || [];
  const allPeople = people.data || [];
  const now = Date.now();
  const upcoming = store.events.filter((e) => new Date(e.starts_at).getTime() > now);
  const published = store.events.filter((e) => e.status === 'published');

  const tiles = [
    { label: 'Published events', value: published.length, note: `${store.events.length} total`, brand: true },
    { label: 'Upcoming', value: upcoming.length, note: 'Starting after today' },
    { label: 'Organisations', value: store.orgs.length, note: `${store.orgs.filter((o) => o.is_active).length} visible` },
    { label: 'Volunteers', value: allPeople.filter((p) => p.role === 'volunteer').length, note: `${allPeople.filter((p) => p.role === 'admin').length} admins` },
    { label: 'RSVPs', value: (rsvps.data || []).filter((r) => r.response === 'yes').length, note: `${(saves.data || []).length} saves` }
  ];

  stats.innerHTML = tiles.map((t) => `
    <div class="a-stat${t.brand ? ' a-stat--brand' : ''}">
      <p class="a-stat__label">${esc(t.label)}</p>
      <p class="a-stat__value">${t.value}</p>
      <p class="a-stat__note">${esc(t.note)}</p>
    </div>`).join('');

  // Counts in the sidebar
  setCount('events', store.events.length);
  setCount('organizations', store.orgs.length);
  setCount('volunteers', allPeople.filter((p) => p.role === 'volunteer').length);
  setCount('users', allPeople.filter((p) => p.role === 'user').length);

  // Next up
  const next = upcoming.slice(0, 5);
  $('#upcoming-list').innerHTML = next.length
    ? `<ul class="a-list">${next.map((e) => `
        <li class="a-list__item">
          <span class="a-list__dot" aria-hidden="true"></span>
          <div style="flex:1;min-width:0">
            <p class="a-list__text"><strong>${esc(e.title)}</strong></p>
            <p class="a-list__time">${esc(formatDate(e.starts_at))} · ${esc(formatTime(e.starts_at))} · ${esc(e.organizer || '—')}</p>
          </div>
          ${statusBadge(e.status)}
        </li>`).join('')}</ul>`
    : `<div class="a-empty"><p class="a-empty__title">Nothing scheduled</p>
       <p>Create an event to see it here.</p></div>`;

  // Most saved
  const popular = [...store.events].sort((a, b) => (b.save_count || 0) - (a.save_count || 0)).slice(0, 5);
  const max = Math.max(1, ...popular.map((e) => e.save_count || 0));
  $('#popular').innerHTML = popular.length && max > 0
    ? popular.map((e) => `
        <div style="margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;gap:16px;margin-bottom:6px">
            <span style="font-weight:var(--font-weight-medium)">${esc(e.title)}</span>
            <span style="color:var(--text-tertiary)">${e.save_count || 0} saves · ${e.rsvp_count || 0} RSVPs</span>
          </div>
          <div class="a-bar"><div class="a-bar__fill" style="width:${Math.round(((e.save_count || 0) / max) * 100)}%"></div></div>
        </div>`).join('')
    : '<p style="margin:0;color:var(--text-tertiary)">No saves yet.</p>';

  const activity = await supabase.from('activity_log')
    .select('*').order('created_at', { ascending: false }).limit(6);
  $('#activity-preview').innerHTML = renderActivityList(activity.data || []);
}

function setCount(name, value) {
  const el = document.querySelector(`[data-count="${name}"]`);
  if (el) el.textContent = value;
}

/* ==========================================================================
   5. Events
   ========================================================================== */

async function loadEvents() {
  $('#events-rows').innerHTML = skeletonRows(8);
  const { data, error } = await supabase
    .from('events_public').select('*').order('starts_at', { ascending: false });
  if (error) { fail(error, 'loading events'); return; }
  store.events = data || [];
  setCount('events', store.events.length);
  renderEvents();
}

function renderEvents() {
  const term = $('#events-search').value.trim().toLowerCase();
  const status = $('#events-status').value;
  const org = $('#events-org').value;

  const rows = store.events.filter((e) =>
    (!status || e.status === status) &&
    (!org || e.organization_id === org) &&
    (!term || `${e.title} ${e.organizer || ''} ${(e.tags || []).join(' ')}`.toLowerCase().includes(term))
  );

  $('#events-rows').innerHTML = rows.length ? rows.map((e) => `
    <tr>
      <td>
        <div class="a-cell-media">
          ${e.banner_url
            ? `<img class="a-thumb" src="${esc(e.banner_url)}" alt="" loading="lazy" />`
            : '<span class="a-thumb"></span>'}
          <span>
            <span class="a-cell-title">${esc(e.title)}</span>
            <span class="a-cell-sub">${esc(e.organizer || 'No organisation')}</span>
          </span>
        </div>
      </td>
      <td><span class="a-cell-title">${esc(formatDate(e.starts_at))}</span>
          <span class="a-cell-sub">${esc(formatTime(e.starts_at))}</span></td>
      <td><span class="a-badge">${esc(e.mode)}</span></td>
      <td>${esc(formatFee(e.fee_amount, e.currency))}</td>
      <td>${statusBadge(e.status)}${e.is_featured ? ' <span class="a-badge a-badge--soft">featured</span>' : ''}</td>
      <td>${e.save_count || 0}</td>
      <td>${e.rsvp_count || 0}</td>
      <td>
        <div class="a-table__actions">
          <button class="a-icon-btn" type="button" title="Attendees"
                  data-action="event-attendees" data-id="${esc(e.id)}">
            <span class="a-icon-btn__glyph a-icon-btn__glyph--people"></span></button>
          <button class="a-icon-btn" type="button" title="Edit"
                  data-action="edit-event" data-id="${esc(e.id)}">
            <span class="a-icon-btn__glyph a-icon-btn__glyph--edit"></span></button>
          <button class="a-icon-btn" type="button" title="Delete"
                  data-action="delete-event" data-id="${esc(e.id)}">
            <span class="a-icon-btn__glyph a-icon-btn__glyph--delete"></span></button>
        </div>
      </td>
    </tr>`).join('')
    : emptyRow(8, 'No events match', 'Adjust the filters, or create a new event.');
}

function eventForm(ev = {}) {
  const orgOptions = store.orgs.map((o) =>
    `<option value="${esc(o.id)}"${ev.organization_id === o.id ? ' selected' : ''}>${esc(o.name)}</option>`
  ).join('');

  const selectedTags = new Set(ev._tagIds || []);
  const chips = store.categories.map((c) => `
    <button class="chip${selectedTags.has(c.id) ? ' chip--selected' : ''}" type="button"
            data-cat="${esc(c.id)}">${esc(c.name)}</button>`).join('');

  return `
  <form class="a-form" id="event-form">
    <p class="a-form__error" id="event-error" hidden role="alert"></p>

    <div class="a-field">
      <label class="a-field__label" for="ev-title">Event title</label>
      <input class="a-input" id="ev-title" required value="${esc(ev.title || '')}"
             placeholder="Catalyst Evening Cafe" />
    </div>

    <div class="a-form__row">
      <div class="a-field">
        <label class="a-field__label" for="ev-org">Organisation</label>
        <select class="a-select" id="ev-org" required>
          <option value="">Choose…</option>${orgOptions}
        </select>
      </div>
      <div class="a-field">
        <label class="a-field__label" for="ev-organizer">Organiser label</label>
        <input class="a-input" id="ev-organizer" value="${esc(ev.organizer_label || '')}"
               placeholder="Optional — overrides the org name on the card" />
      </div>
    </div>

    <div class="a-form__row">
      <div class="a-field">
        <label class="a-field__label" for="ev-start">Starts</label>
        <input class="a-input" id="ev-start" type="datetime-local" required
               value="${esc(toLocalInput(ev.starts_at))}" />
      </div>
      <div class="a-field">
        <label class="a-field__label" for="ev-end">Ends</label>
        <input class="a-input" id="ev-end" type="datetime-local"
               value="${esc(toLocalInput(ev.ends_at))}" />
      </div>
    </div>

    <div class="a-form__row">
      <div class="a-field">
        <label class="a-field__label" for="ev-mode">Mode</label>
        <select class="a-select" id="ev-mode">
          ${['offline', 'online', 'hybrid'].map((m) =>
            `<option value="${m}"${ev.mode === m ? ' selected' : ''}>${m}</option>`).join('')}
        </select>
      </div>
      <div class="a-field">
        <label class="a-field__label" for="ev-venue">Venue</label>
        <input class="a-input" id="ev-venue" value="${esc(ev.venue || '')}"
               placeholder="Seminar Hall / Zoom link" />
      </div>
    </div>

    <div class="a-form__row">
      <div class="a-field">
        <label class="a-field__label" for="ev-fee">Fee (₹)</label>
        <input class="a-input" id="ev-fee" type="number" min="0" step="1"
               value="${esc(ev.fee_amount ?? 0)}" />
        <span class="a-field__hint">0 shows as “Free” on the card.</span>
      </div>
      <div class="a-field">
        <label class="a-field__label" for="ev-capacity">Capacity</label>
        <input class="a-input" id="ev-capacity" type="number" min="0"
               value="${esc(ev.capacity ?? '')}" placeholder="Leave blank for unlimited" />
      </div>
    </div>

    <div class="a-field">
      <label class="a-field__label" for="ev-summary">Card summary</label>
      <input class="a-input" id="ev-summary" value="${esc(ev.summary || '')}"
             placeholder="One line shown under the title" />
    </div>

    <div class="a-field">
      <label class="a-field__label" for="ev-description">Description</label>
      <textarea class="a-textarea" id="ev-description"
                placeholder="Full write-up for the event detail page">${esc(ev.description || '')}</textarea>
    </div>

    <div class="a-form__row">
      <div class="a-field">
        <label class="a-field__label" for="ev-banner">Banner image URL</label>
        <input class="a-input" id="ev-banner" value="${esc(ev.banner_url || '')}"
               placeholder="Assets/Event Card Image.png" />
        <span class="a-field__hint">Or upload below to the <code>media</code> bucket.</span>
      </div>
      <div class="a-field">
        <label class="a-field__label" for="ev-banner-file">Upload banner</label>
        <input class="a-input" id="ev-banner-file" type="file" accept="image/*" />
      </div>
    </div>

    <div class="a-field">
      <label class="a-field__label" for="ev-register">Registration link</label>
      <input class="a-input" id="ev-register" type="url" value="${esc(ev.register_url || '')}"
             placeholder="https://…" />
    </div>

    <div class="a-field">
      <span class="a-field__label">Categories</span>
      <div class="a-chips" id="ev-tags">${chips}</div>
    </div>

    <div class="a-form__row">
      <div class="a-field">
        <label class="a-field__label" for="ev-status">Status</label>
        <select class="a-select" id="ev-status">
          ${['draft', 'published', 'cancelled'].map((s) =>
            `<option value="${s}"${(ev.status || 'draft') === s ? ' selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="a-field">
        <span class="a-field__label">Featured</span>
        <label class="a-switch">
          <input type="checkbox" id="ev-featured"${ev.is_featured ? ' checked' : ''} />
          <span class="a-switch__track" aria-hidden="true"></span>
          <span>Show in the Discover hero</span>
        </label>
      </div>
    </div>
  </form>`;
}

async function openEventEditor(id) {
  let ev = {};
  if (id) {
    const [row, tags] = await Promise.all([
      supabase.from('events').select('*').eq('id', id).single(),
      supabase.from('event_categories').select('category_id').eq('event_id', id)
    ]);
    if (row.error) { fail(row.error, 'loading the event'); return; }
    ev = row.data;
    ev._tagIds = (tags.data || []).map((t) => t.category_id);
  } else if (store.me.organization_id) {
    ev.organization_id = store.me.organization_id;
  }

  openModal({
    title: id ? 'Edit event' : 'New event',
    wide: true,
    body: eventForm(ev),
    onMount: (body) => {
      // Chips toggle in place, exactly like the public filter row.
      body.querySelectorAll('#ev-tags .chip').forEach((chip) => {
        chip.addEventListener('click', () => chip.classList.toggle('chip--selected'));
      });
    },
    actions: [
      { label: 'Cancel', variant: 'ghost', onClick: closeModal },
      { label: id ? 'Save changes' : 'Create event', onClick: (btn) => saveEvent(id, btn) }
    ]
  });
}

async function saveEvent(id, btn) {
  setError('event-error', '');
  const title = $('#ev-title').value.trim();
  const orgId = $('#ev-org').value;
  const startsAt = $('#ev-start').value;

  if (!title)     { setError('event-error', 'The event needs a title.'); return; }
  if (!orgId)     { setError('event-error', 'Pick the organisation running this.'); return; }
  if (!startsAt)  { setError('event-error', 'Pick a start date and time.'); return; }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  let bannerUrl = $('#ev-banner').value.trim();
  const file = $('#ev-banner-file').files[0];
  if (file) {
    const uploaded = await uploadMedia(file, 'events');
    if (uploaded) bannerUrl = uploaded;
  }

  const payload = {
    title,
    slug: slugify(title) + '-' + startsAt.slice(0, 10),
    organization_id: orgId,
    organizer_label: $('#ev-organizer').value.trim() || null,
    summary: $('#ev-summary').value.trim() || null,
    description: $('#ev-description').value.trim() || null,
    banner_url: bannerUrl || null,
    starts_at: new Date(startsAt).toISOString(),
    ends_at: $('#ev-end').value ? new Date($('#ev-end').value).toISOString() : null,
    venue: $('#ev-venue').value.trim() || null,
    mode: $('#ev-mode').value,
    fee_amount: Number($('#ev-fee').value || 0),
    capacity: $('#ev-capacity').value ? Number($('#ev-capacity').value) : null,
    register_url: $('#ev-register').value.trim() || null,
    status: $('#ev-status').value,
    is_featured: $('#ev-featured').checked,
    updated_by: store.me.id
  };

  let eventId = id;
  let error;

  if (id) {
    ({ error } = await supabase.from('events').update(payload).eq('id', id));
  } else {
    payload.created_by = store.me.id;
    const res = await supabase.from('events').insert(payload).select('id').single();
    error = res.error;
    eventId = res.data?.id;
  }

  if (error) {
    setError('event-error', error.message);
    btn.disabled = false;
    btn.textContent = id ? 'Save changes' : 'Create event';
    return;
  }

  // Replace the tag set wholesale — simpler than diffing, and the join table
  // is tiny.
  const chosen = $$('#ev-tags .chip--selected').map((c) => c.dataset.cat);
  await supabase.from('event_categories').delete().eq('event_id', eventId);
  if (chosen.length) {
    await supabase.from('event_categories')
      .insert(chosen.map((category_id) => ({ event_id: eventId, category_id })));
  }

  await logActivity(id ? 'updated' : 'created', 'event', eventId, title);
  closeModal();
  toast(id ? 'Event updated' : 'Event created', 'success');
  loadEvents();
}

async function uploadMedia(file, folder) {
  const path = `${folder}/${Date.now()}-${slugify(file.name.replace(/\.[^.]+$/, ''))}` +
               (file.name.match(/\.[^.]+$/)?.[0] || '');
  const { error } = await supabase.storage.from('media').upload(path, file, { upsert: true });
  if (error) { toast('Upload failed: ' + error.message, 'error'); return null; }
  return supabase.storage.from('media').getPublicUrl(path).data.publicUrl;
}

async function showAttendees(id) {
  const event = store.events.find((e) => e.id === id);
  openModal({
    title: 'Attendees — ' + (event?.title || ''),
    body: `<div class="a-table-wrap"><table class="a-table">
      <thead><tr><th>Name</th><th>Email</th><th>Response</th><th>When</th></tr></thead>
      <tbody>${skeletonRows(4, 3)}</tbody>
    </table></div>`,
    actions: [{ label: 'Close', variant: 'ghost', onClick: closeModal }]
  });

  const { data, error } = await supabase
    .from('event_rsvps')
    .select('response, created_at, profiles(full_name, email)')
    .eq('event_id', id)
    .order('created_at', { ascending: false });

  if (error) { $('#modal-body').innerHTML = `<p class="a-form__error">${esc(error.message)}</p>`; return; }

  $('#modal-body').innerHTML = data.length ? `
    <div class="a-table-wrap">
      <table class="a-table">
        <thead><tr><th>Name</th><th>Email</th><th>Response</th><th>When</th></tr></thead>
        <tbody>${data.map((r) => `
          <tr>
            <td>${esc(r.profiles?.full_name || '—')}</td>
            <td>${esc(r.profiles?.email || '—')}</td>
            <td><span class="a-badge ${r.response === 'yes' ? 'a-badge--live' : 'a-badge--muted'}">${esc(r.response)}</span></td>
            <td>${esc(formatShort(r.created_at))}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`
    : '<div class="a-empty"><p class="a-empty__title">No RSVPs yet</p><p>Responses from the event page land here.</p></div>';
}

/* ==========================================================================
   6. Organisations
   ========================================================================== */

async function loadOrgs() {
  $('#orgs-rows').innerHTML = skeletonRows(6);
  const [orgs, counts] = await Promise.all([
    supabase.from('organizations').select('*').order('name'),
    supabase.from('events').select('organization_id')
  ]);
  if (orgs.error) { fail(orgs.error, 'loading organisations'); return; }

  store.orgs = orgs.data || [];
  store._eventCountByOrg = (counts.data || []).reduce((acc, e) => {
    acc[e.organization_id] = (acc[e.organization_id] || 0) + 1;
    return acc;
  }, {});
  setCount('organizations', store.orgs.length);
  renderOrgs();
}

function renderOrgs() {
  const term = $('#orgs-search').value.trim().toLowerCase();
  const canEdit = (o) => isAdmin(store.me) || o.id === store.me.organization_id;

  const rows = store.orgs.filter((o) =>
    !term || `${o.name} ${o.category || ''}`.toLowerCase().includes(term));

  $('#orgs-rows').innerHTML = rows.length ? rows.map((o) => `
    <tr>
      <td>
        <div class="a-cell-media">
          <span class="a-avatar">${esc(o.initials || initials(o.name))}</span>
          <span>
            <span class="a-cell-title">${esc(o.name)}</span>
            <span class="a-cell-sub">${esc(o.slug)}</span>
          </span>
        </div>
      </td>
      <td>${esc(o.category || '—')}</td>
      <td><span class="a-badge">${esc(o.type)}</span></td>
      <td>${store._eventCountByOrg?.[o.id] || 0}</td>
      <td>${o.is_active
            ? '<span class="a-badge a-badge--live">visible</span>'
            : '<span class="a-badge a-badge--muted">hidden</span>'}</td>
      <td>
        <div class="a-table__actions">
          ${canEdit(o) ? `
          <button class="a-icon-btn" type="button" title="Edit"
                  data-action="edit-org" data-id="${esc(o.id)}">
            <span class="a-icon-btn__glyph a-icon-btn__glyph--edit"></span></button>` : ''}
          ${isAdmin(store.me) ? `
          <button class="a-icon-btn" type="button" title="Delete"
                  data-action="delete-org" data-id="${esc(o.id)}">
            <span class="a-icon-btn__glyph a-icon-btn__glyph--delete"></span></button>` : ''}
        </div>
      </td>
    </tr>`).join('')
    : emptyRow(6, 'No organisations', 'Add the clubs and societies that run events.');
}

function openOrgEditor(id) {
  const o = store.orgs.find((x) => x.id === id) || {};

  openModal({
    title: id ? 'Edit organisation' : 'New organisation',
    wide: true,
    body: `
    <form class="a-form" id="org-form">
      <p class="a-form__error" id="org-error" hidden role="alert"></p>

      <div class="a-form__row">
        <div class="a-field">
          <label class="a-field__label" for="og-name">Name</label>
          <input class="a-input" id="og-name" required value="${esc(o.name || '')}" placeholder="Catalyst IEDC" />
        </div>
        <div class="a-field">
          <label class="a-field__label" for="og-category">Category line</label>
          <input class="a-input" id="og-category" value="${esc(o.category || '')}"
                 placeholder="Innovation &amp; Entrepreneurship" />
        </div>
      </div>

      <div class="a-form__row">
        <div class="a-field">
          <label class="a-field__label" for="og-type">Type</label>
          <select class="a-select" id="og-type">
            ${['club', 'organisation'].map((t) =>
              `<option value="${t}"${o.type === t ? ' selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="a-field">
          <label class="a-field__label" for="og-initials">Initials mark</label>
          <input class="a-input" id="og-initials" maxlength="4" value="${esc(o.initials || '')}"
                 placeholder="CI" />
          <span class="a-field__hint">Shown when there's no logo.</span>
        </div>
      </div>

      <div class="a-form__row">
        <div class="a-field">
          <label class="a-field__label" for="og-logo">Logo URL</label>
          <input class="a-input" id="og-logo" value="${esc(o.logo_url || '')}" />
        </div>
        <div class="a-field">
          <label class="a-field__label" for="og-logo-file">Upload logo</label>
          <input class="a-input" id="og-logo-file" type="file" accept="image/*" />
        </div>
      </div>

      <div class="a-field">
        <label class="a-field__label" for="og-about">About</label>
        <textarea class="a-textarea" id="og-about" style="min-height:160px"
                  placeholder="Leave a blank line between paragraphs.">${esc(o.about || '')}</textarea>
      </div>

      <div class="a-form__row">
        <div class="a-field">
          <label class="a-field__label" for="og-instagram">Instagram</label>
          <input class="a-input" id="og-instagram" type="url" value="${esc(o.instagram_url || '')}" />
        </div>
        <div class="a-field">
          <label class="a-field__label" for="og-linkedin">LinkedIn</label>
          <input class="a-input" id="og-linkedin" type="url" value="${esc(o.linkedin_url || '')}" />
        </div>
        <div class="a-field">
          <label class="a-field__label" for="og-website">Website</label>
          <input class="a-input" id="og-website" type="url" value="${esc(o.website_url || '')}" />
        </div>
      </div>

      <div class="a-field">
        <label class="a-switch">
          <input type="checkbox" id="og-active"${o.id === undefined || o.is_active ? ' checked' : ''} />
          <span class="a-switch__track" aria-hidden="true"></span>
          <span>Visible on the public Organisations page</span>
        </label>
      </div>
    </form>`,
    actions: [
      { label: 'Cancel', variant: 'ghost', onClick: closeModal },
      { label: id ? 'Save changes' : 'Create', onClick: (btn) => saveOrg(id, btn) }
    ]
  });
}

async function saveOrg(id, btn) {
  setError('org-error', '');
  const name = $('#og-name').value.trim();
  if (!name) { setError('org-error', 'Give the organisation a name.'); return; }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  let logoUrl = $('#og-logo').value.trim();
  const file = $('#og-logo-file').files[0];
  if (file) {
    const uploaded = await uploadMedia(file, 'orgs');
    if (uploaded) logoUrl = uploaded;
  }

  const payload = {
    name,
    slug: slugify(name),
    category: $('#og-category').value.trim() || null,
    type: $('#og-type').value,
    initials: $('#og-initials').value.trim() || null,
    logo_url: logoUrl || null,
    about: $('#og-about').value.trim() || null,
    instagram_url: $('#og-instagram').value.trim() || null,
    linkedin_url: $('#og-linkedin').value.trim() || null,
    website_url: $('#og-website').value.trim() || null,
    is_active: $('#og-active').checked
  };

  const { error } = id
    ? await supabase.from('organizations').update(payload).eq('id', id)
    : await supabase.from('organizations').insert({ ...payload, created_by: store.me.id });

  if (error) {
    setError('org-error', error.message);
    btn.disabled = false;
    btn.textContent = id ? 'Save changes' : 'Create';
    return;
  }

  await logActivity(id ? 'updated' : 'created', 'organization', id, name);
  closeModal();
  toast(id ? 'Organisation updated' : 'Organisation created', 'success');
  await loadReferenceData();
  loadOrgs();
}

/* ==========================================================================
   7. Categories
   ========================================================================== */

async function loadCategories() {
  $('#categories-rows').innerHTML = skeletonRows(7);
  const [cats, links] = await Promise.all([
    supabase.from('categories').select('*').order('group_name').order('sort_order'),
    supabase.from('event_categories').select('category_id')
  ]);
  if (cats.error) { fail(cats.error, 'loading categories'); return; }

  store.categories = cats.data || [];
  const usage = (links.data || []).reduce((acc, l) => {
    acc[l.category_id] = (acc[l.category_id] || 0) + 1;
    return acc;
  }, {});

  $('#categories-rows').innerHTML = store.categories.length
    ? CATEGORY_GROUPS.flatMap((group) => {
        const rows = store.categories.filter((c) => c.group_name === group);
        if (!rows.length) return [];
        return [
          `<tr class="a-table__group"><td colspan="7">${esc(group)}</td></tr>`,
          ...rows.map((c) => `
          <tr>
            <td><span class="chip">${esc(c.name)}</span></td>
            <td><span class="a-badge">${esc(c.group_name)}</span></td>
            <td><span class="a-cell-sub">${esc(c.slug)}</span></td>
            <td>${c.sort_order}</td>
            <td>${c.is_active
                  ? '<span class="a-badge a-badge--live">active</span>'
                  : '<span class="a-badge a-badge--muted">hidden</span>'}</td>
            <td>${usage[c.id] || 0} events</td>
            <td>
              <div class="a-table__actions">
                <button class="a-icon-btn" type="button" title="Edit"
                        data-action="edit-category" data-id="${esc(c.id)}">
                  <span class="a-icon-btn__glyph a-icon-btn__glyph--edit"></span></button>
                <button class="a-icon-btn" type="button" title="Delete"
                        data-action="delete-category" data-id="${esc(c.id)}">
                  <span class="a-icon-btn__glyph a-icon-btn__glyph--delete"></span></button>
              </div>
            </td>
          </tr>`)
        ];
      }).join('')
    : emptyRow(7, 'No categories', 'Add the chips that appear in the Discover filter row.');
}

function openCategoryEditor(id) {
  const c = store.categories.find((x) => x.id === id) || {};

  openModal({
    title: id ? 'Edit category' : 'New category',
    narrow: true,
    body: `
    <form class="a-form" id="cat-form">
      <p class="a-form__error" id="cat-error" hidden role="alert"></p>
      <div class="a-field">
        <label class="a-field__label" for="ct-name">Name</label>
        <input class="a-input" id="ct-name" required value="${esc(c.name || '')}" />
      </div>
      <div class="a-field">
        <label class="a-field__label" for="ct-group">Filter group</label>
        <select class="a-select" id="ct-group">
          ${CATEGORY_GROUPS.map((g) => `<option value="${g}"${c.group_name === g ? ' selected' : ''}>${g}</option>`).join('')}
        </select>
        <span class="a-field__hint">Groups are separated by dots in the filter row.</span>
      </div>
      <div class="a-field">
        <label class="a-field__label" for="ct-order">Sort order</label>
        <input class="a-input" id="ct-order" type="number" value="${esc(c.sort_order ?? 0)}" />
      </div>
      <div class="a-field">
        <label class="a-switch">
          <input type="checkbox" id="ct-active"${c.id === undefined || c.is_active ? ' checked' : ''} />
          <span class="a-switch__track" aria-hidden="true"></span>
          <span>Show on the site</span>
        </label>
      </div>
    </form>`,
    actions: [
      { label: 'Cancel', variant: 'ghost', onClick: closeModal },
      { label: id ? 'Save' : 'Create', onClick: (btn) => saveCategory(id, btn) }
    ]
  });
}

async function saveCategory(id, btn) {
  setError('cat-error', '');
  const name = $('#ct-name').value.trim();
  if (!name) { setError('cat-error', 'Name is required.'); return; }

  btn.disabled = true;
  const payload = {
    name,
    slug: slugify(name),
    group_name: $('#ct-group').value,
    sort_order: Number($('#ct-order').value || 0),
    is_active: $('#ct-active').checked
  };

  const { error } = id
    ? await supabase.from('categories').update(payload).eq('id', id)
    : await supabase.from('categories').insert(payload);

  if (error) { setError('cat-error', error.message); btn.disabled = false; return; }

  closeModal();
  toast('Saved', 'success');
  await loadReferenceData();
  loadCategories();
}

/* ==========================================================================
   8. People — volunteers and users share one fetch
   ========================================================================== */

async function loadPeople() {
  $('#volunteers-rows').innerHTML = skeletonRows(6);
  $('#users-rows').innerHTML = skeletonRows(7);

  const [people, saves, rsvps, interests] = await Promise.all([
    supabase.from('profiles').select('*, organizations(name)').order('created_at', { ascending: false }),
    supabase.from('event_saves').select('user_id'),
    supabase.from('event_rsvps').select('user_id, response'),
    supabase.from('user_interests').select('user_id, categories(name)')
  ]);

  if (people.error) { fail(people.error, 'loading people'); return; }

  store.people = people.data || [];
  store.saves = saves.data || [];
  store.rsvps = rsvps.data || [];
  store.interests = interests.data || [];

  setCount('volunteers', store.people.filter((p) => p.role === 'volunteer').length);
  setCount('users', store.people.filter((p) => p.role === 'user').length);

  renderVolunteers();
  renderUsers();
}

function renderVolunteers() {
  const term = $('#volunteers-search').value.trim().toLowerCase();
  const rows = store.people
    .filter((p) => p.role === 'admin' || p.role === 'volunteer')
    .filter((p) => !term || `${p.full_name || ''} ${p.email || ''}`.toLowerCase().includes(term));

  $('#volunteers-rows').innerHTML = rows.length ? rows.map((p) => `
    <tr>
      <td>
        <div class="a-cell-media">
          <span class="a-avatar a-avatar--sm">${esc(initials(p.full_name || p.email))}</span>
          <span>
            <span class="a-cell-title">${esc(p.full_name || '—')}</span>
            <span class="a-cell-sub">${esc(p.email || '')}</span>
          </span>
        </div>
      </td>
      <td><span class="a-badge ${p.role === 'admin' ? 'a-badge--live' : 'a-badge--soft'}">${esc(p.role)}</span></td>
      <td>${esc(p.organizations?.name || '—')}</td>
      <td>${p.status === 'active'
            ? '<span class="a-badge a-badge--live">active</span>'
            : '<span class="a-badge a-badge--muted">suspended</span>'}</td>
      <td>${esc(formatDate(p.created_at))}</td>
      <td>
        <div class="a-table__actions">
          <button class="a-icon-btn" type="button" title="Edit access"
                  data-action="edit-person" data-id="${esc(p.id)}">
            <span class="a-icon-btn__glyph a-icon-btn__glyph--edit"></span></button>
          ${p.id !== store.me.id ? `
          <button class="a-icon-btn" type="button" title="Remove"
                  data-action="delete-person" data-id="${esc(p.id)}">
            <span class="a-icon-btn__glyph a-icon-btn__glyph--delete"></span></button>` : ''}
        </div>
      </td>
    </tr>`).join('')
    : emptyRow(6, 'No volunteers yet', 'Add one, or promote someone from the Users list.');
}

function renderUsers() {
  const term = $('#users-search').value.trim().toLowerCase();
  const savesBy = countBy(store.saves, 'user_id');
  const rsvpsBy = countBy(store.rsvps.filter((r) => r.response === 'yes'), 'user_id');

  const rows = store.people
    .filter((p) => p.role === 'user')
    .filter((p) => !term || `${p.full_name || ''} ${p.email || ''}`.toLowerCase().includes(term));

  $('#users-rows').innerHTML = rows.length ? rows.map((p) => {
    const tags = store.interests
      .filter((i) => i.user_id === p.id)
      .map((i) => i.categories?.name)
      .filter(Boolean);
    return `
    <tr>
      <td>
        <div class="a-cell-media">
          <span class="a-avatar a-avatar--sm">${esc(initials(p.full_name || p.email))}</span>
          <span>
            <span class="a-cell-title">${esc(p.full_name || '—')}</span>
            <span class="a-cell-sub">${esc(p.email || '')}</span>
          </span>
        </div>
      </td>
      <td>${tags.length
            ? `<div class="a-tag-row">${tags.slice(0, 3).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}${
                tags.length > 3 ? `<span class="a-cell-sub">+${tags.length - 3}</span>` : ''}</div>`
            : '<span class="a-cell-sub">None picked</span>'}</td>
      <td>${savesBy[p.id] || 0}</td>
      <td>${rsvpsBy[p.id] || 0}</td>
      <td>${p.status === 'active'
            ? '<span class="a-badge a-badge--live">active</span>'
            : '<span class="a-badge a-badge--muted">suspended</span>'}</td>
      <td>${esc(formatDate(p.created_at))}</td>
      <td>
        <div class="a-table__actions">
          <button class="a-icon-btn" type="button" title="Manage access"
                  data-action="edit-person" data-id="${esc(p.id)}">
            <span class="a-icon-btn__glyph a-icon-btn__glyph--edit"></span></button>
          ${p.id !== store.me.id ? `
          <button class="a-icon-btn" type="button" title="Delete user"
                  data-action="delete-person" data-id="${esc(p.id)}">
            <span class="a-icon-btn__glyph a-icon-btn__glyph--delete"></span></button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('')
    : emptyRow(7, 'No users yet', 'People who sign up on the public site appear here.');
}

const countBy = (rows, key) => rows.reduce((acc, r) => {
  acc[r[key]] = (acc[r[key]] || 0) + 1;
  return acc;
}, {});

function openPersonEditor(id) {
  const p = store.people.find((x) => x.id === id);
  if (!p) return;
  const orgOptions = store.orgs.map((o) =>
    `<option value="${esc(o.id)}"${p.organization_id === o.id ? ' selected' : ''}>${esc(o.name)}</option>`).join('');

  openModal({
    title: p.full_name || p.email,
    narrow: true,
    body: `
    <form class="a-form" id="person-form">
      <p class="a-form__error" id="person-error" hidden role="alert"></p>

      <div class="a-field">
        <label class="a-field__label" for="pf-name">Full name</label>
        <input class="a-input" id="pf-name" value="${esc(p.full_name || '')}" />
      </div>

      <div class="a-field">
        <label class="a-field__label" for="pf-role">Role</label>
        <select class="a-select" id="pf-role"${p.id === store.me.id ? ' disabled' : ''}>
          ${['user', 'volunteer', 'admin'].map((r) =>
            `<option value="${r}"${p.role === r ? ' selected' : ''}>${r}</option>`).join('')}
        </select>
        ${p.id === store.me.id
          ? '<span class="a-field__hint">You can\'t change your own role.</span>'
          : '<span class="a-field__hint">Volunteers can add and edit events for their organisation.</span>'}
      </div>

      <div class="a-field">
        <label class="a-field__label" for="pf-org">Organisation</label>
        <select class="a-select" id="pf-org">
          <option value="">None</option>${orgOptions}
        </select>
      </div>

      <div class="a-field">
        <label class="a-switch">
          <input type="checkbox" id="pf-active"${p.status === 'active' ? ' checked' : ''}
                 ${p.id === store.me.id ? 'disabled' : ''} />
          <span class="a-switch__track" aria-hidden="true"></span>
          <span>Account active</span>
        </label>
      </div>
    </form>`,
    actions: [
      { label: 'Cancel', variant: 'ghost', onClick: closeModal },
      { label: 'Save', onClick: (btn) => savePerson(id, btn) }
    ]
  });
}

async function savePerson(id, btn) {
  setError('person-error', '');
  btn.disabled = true;

  const payload = {
    full_name: $('#pf-name').value.trim() || null,
    organization_id: $('#pf-org').value || null
  };
  // Role and status are locked on your own row, so only send them when present.
  if (!$('#pf-role').disabled) {
    payload.role = $('#pf-role').value;
    payload.status = $('#pf-active').checked ? 'active' : 'suspended';
  }

  const { error } = await supabase.from('profiles').update(payload).eq('id', id);
  if (error) { setError('person-error', error.message); btn.disabled = false; return; }

  await logActivity('updated', 'profile', id, `${payload.role || ''} access`.trim());
  closeModal();
  toast('Access updated', 'success');
  loadPeople();
}

/**
 * Adding a volunteer.
 *
 * The browser only ever holds the anon key, and creating another person's auth
 * user requires the service_role key — which must never ship to a page. So the
 * flow splits: if the address already has an account, promote it right here;
 * if it doesn't, send a sign-in link and promote them once they've accepted.
 */
function openInvite() {
  const orgOptions = store.orgs.map((o) =>
    `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');

  openModal({
    title: 'Add a volunteer',
    narrow: true,
    body: `
    <form class="a-form" id="invite-form">
      <p class="a-form__error" id="invite-error" hidden role="alert"></p>

      <div class="a-field">
        <label class="a-field__label" for="iv-email">Email</label>
        <input class="a-input" id="iv-email" type="email" required placeholder="name@college.edu" />
      </div>

      <div class="a-field">
        <label class="a-field__label" for="iv-org">Organisation</label>
        <select class="a-select" id="iv-org"><option value="">None</option>${orgOptions}</select>
      </div>

      <div class="a-field">
        <label class="a-field__label" for="iv-role">Role</label>
        <select class="a-select" id="iv-role">
          <option value="volunteer">volunteer</option>
          <option value="admin">admin</option>
        </select>
      </div>

      <div class="a-note">
        If this person already has an eventundo account they're promoted straight
        away. If not, they get a sign-in link by email — promote them here once
        they've used it.
      </div>
    </form>`,
    actions: [
      { label: 'Cancel', variant: 'ghost', onClick: closeModal },
      { label: 'Add', onClick: sendInvite }
    ]
  });
}

async function sendInvite(btn) {
  setError('invite-error', '');
  const email = $('#iv-email').value.trim().toLowerCase();
  if (!email) { setError('invite-error', 'Enter an email address.'); return; }

  btn.disabled = true;
  btn.textContent = 'Working…';

  const existing = store.people.find((p) => (p.email || '').toLowerCase() === email);

  if (existing) {
    const { error } = await supabase.from('profiles').update({
      role: $('#iv-role').value,
      organization_id: $('#iv-org').value || null,
      status: 'active'
    }).eq('id', existing.id);

    if (error) { setError('invite-error', error.message); btn.disabled = false; btn.textContent = 'Add'; return; }

    await logActivity('updated', 'profile', existing.id, 'promoted to ' + $('#iv-role').value);
    closeModal();
    toast(`${email} is now a ${$('#iv-role').value}`, 'success');
    loadPeople();
    return;
  }

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: location.origin + location.pathname
    }
  });

  btn.disabled = false;
  btn.textContent = 'Add';

  if (error) { setError('invite-error', error.message); return; }

  closeModal();
  toast(`Sign-in link sent to ${email}. Promote them once they accept.`, 'success');
}

/* ==========================================================================
   9. Registrations
   ========================================================================== */

async function loadRegistrations() {
  $('#registrations-rows').innerHTML = skeletonRows(6);
  $('#reg-stats').innerHTML = Array.from({ length: 3 }, () =>
    `<div class="a-stat"><span class="a-skeleton" style="width:60%"></span>
     <p class="a-stat__value" style="margin-top:12px"><span class="a-skeleton" style="width:40%;height:28px"></span></p></div>`
  ).join('');

  if (!store.events.length) {
    const { data } = await supabase.from('events_public').select('*').order('starts_at', { ascending: false });
    store.events = data || [];
  }

  const select = $('#reg-event');
  const current = select.value;
  select.innerHTML = '<option value="">All events</option>' +
    store.events.map((e) => `<option value="${esc(e.id)}">${esc(e.title)}</option>`).join('');
  select.value = current;

  const { data, error } = await supabase
    .from('event_rsvps')
    .select('id, response, created_at, event_id, profiles(full_name, email, organizations(name))')
    .order('created_at', { ascending: false });

  if (error) { fail(error, 'loading registrations'); return; }
  store.rsvps = data || [];
  renderRegistrations();
}

function renderRegistrations() {
  const eventId = $('#reg-event').value;
  const response = $('#reg-response').value;
  const term = $('#reg-search').value.trim().toLowerCase();
  const eventById = Object.fromEntries(store.events.map((e) => [e.id, e]));

  const rows = store.rsvps.filter((r) =>
    (!eventId || r.event_id === eventId) &&
    (!response || r.response === response) &&
    (!term || `${r.profiles?.full_name || ''} ${r.profiles?.email || ''}`.toLowerCase().includes(term)));

  const yes = rows.filter((r) => r.response === 'yes').length;
  $('#reg-stats').innerHTML = [
    { label: 'Registrations shown', value: rows.length },
    { label: 'Attending (yes)', value: yes },
    { label: 'Not attending (no)', value: rows.length - yes }
  ].map((t) => `
    <div class="a-stat">
      <p class="a-stat__label">${esc(t.label)}</p>
      <p class="a-stat__value">${t.value}</p>
    </div>`).join('');

  $('#registrations-rows').innerHTML = rows.length ? rows.map((r) => {
    const event = eventById[r.event_id];
    return `
    <tr>
      <td>
        <span class="a-cell-title">${esc(r.profiles?.full_name || '—')}</span>
        <span class="a-cell-sub">${esc(r.profiles?.email || '')}</span>
      </td>
      <td>${esc(r.profiles?.organizations?.name || '—')}</td>
      <td>
        <span class="a-cell-title">${esc(event?.title || '—')}</span>
        <span class="a-cell-sub">${esc(event?.organizer || '')}</span>
      </td>
      <td>${event
            ? `<span class="a-cell-title">${esc(formatDate(event.starts_at))}</span>
               <span class="a-cell-sub">${esc(formatTime(event.starts_at))} · ${esc(event.venue || '—')}</span>`
            : '—'}</td>
      <td><span class="a-badge ${r.response === 'yes' ? 'a-badge--live' : 'a-badge--muted'}">${esc(r.response)}</span></td>
      <td>${esc(formatShort(r.created_at))}</td>
    </tr>`;
  }).join('')
    : emptyRow(6, 'No registrations', 'RSVPs submitted on event pages show up here.');
}

/* ==========================================================================
   10. Site roster (team.html)
   ========================================================================== */

async function loadTeam() {
  $('#team-rows').innerHTML = skeletonRows(5);
  const { data, error } = await supabase.from('team_members')
    .select('*').order('sort_order').order('name');
  if (error) { fail(error, 'loading the roster'); return; }
  store.team = data || [];

  $('#team-rows').innerHTML = store.team.length ? store.team.map((m) => `
    <tr>
      <td>
        <div class="a-cell-media">
          <span class="a-avatar a-avatar--sm">${esc(initials(m.name))}</span>
          <span class="a-cell-title">${esc(m.name)}</span>
        </div>
      </td>
      <td>${esc(m.role_title || '—')}</td>
      <td>${m.sort_order}</td>
      <td>${m.is_active
            ? '<span class="a-badge a-badge--live">visible</span>'
            : '<span class="a-badge a-badge--muted">hidden</span>'}</td>
      <td>
        <div class="a-table__actions">
          <button class="a-icon-btn" type="button" title="Edit"
                  data-action="edit-team-member" data-id="${esc(m.id)}">
            <span class="a-icon-btn__glyph a-icon-btn__glyph--edit"></span></button>
          <button class="a-icon-btn" type="button" title="Delete"
                  data-action="delete-team-member" data-id="${esc(m.id)}">
            <span class="a-icon-btn__glyph a-icon-btn__glyph--delete"></span></button>
        </div>
      </td>
    </tr>`).join('')
    : emptyRow(5, 'Roster is empty', 'Add the people who should appear on The Team page.');
}

function openTeamEditor(id) {
  const m = store.team.find((x) => x.id === id) || {};

  openModal({
    title: id ? 'Edit member' : 'Add member',
    narrow: true,
    body: `
    <form class="a-form" id="team-form">
      <p class="a-form__error" id="team-error" hidden role="alert"></p>
      <div class="a-field">
        <label class="a-field__label" for="tm-name">Name</label>
        <input class="a-input" id="tm-name" required value="${esc(m.name || '')}" />
      </div>
      <div class="a-field">
        <label class="a-field__label" for="tm-role">Role</label>
        <input class="a-input" id="tm-role" value="${esc(m.role_title || '')}" placeholder="Design Lead" />
      </div>
      <div class="a-field">
        <label class="a-field__label" for="tm-photo">Photo URL</label>
        <input class="a-input" id="tm-photo" value="${esc(m.photo_url || '')}" />
      </div>
      <div class="a-form__row">
        <div class="a-field">
          <label class="a-field__label" for="tm-instagram">Instagram</label>
          <input class="a-input" id="tm-instagram" type="url" value="${esc(m.instagram_url || '')}" />
        </div>
        <div class="a-field">
          <label class="a-field__label" for="tm-linkedin">LinkedIn</label>
          <input class="a-input" id="tm-linkedin" type="url" value="${esc(m.linkedin_url || '')}" />
        </div>
      </div>
      <div class="a-field">
        <label class="a-field__label" for="tm-order">Sort order</label>
        <input class="a-input" id="tm-order" type="number" value="${esc(m.sort_order ?? 0)}" />
      </div>
      <div class="a-field">
        <label class="a-switch">
          <input type="checkbox" id="tm-active"${m.id === undefined || m.is_active ? ' checked' : ''} />
          <span class="a-switch__track" aria-hidden="true"></span>
          <span>Show on the public page</span>
        </label>
      </div>
    </form>`,
    actions: [
      { label: 'Cancel', variant: 'ghost', onClick: closeModal },
      { label: id ? 'Save' : 'Add', onClick: (btn) => saveTeamMember(id, btn) }
    ]
  });
}

async function saveTeamMember(id, btn) {
  setError('team-error', '');
  const name = $('#tm-name').value.trim();
  if (!name) { setError('team-error', 'Name is required.'); return; }

  btn.disabled = true;
  const payload = {
    name,
    role_title: $('#tm-role').value.trim() || null,
    photo_url: $('#tm-photo').value.trim() || null,
    instagram_url: $('#tm-instagram').value.trim() || null,
    linkedin_url: $('#tm-linkedin').value.trim() || null,
    sort_order: Number($('#tm-order').value || 0),
    is_active: $('#tm-active').checked
  };

  const { error } = id
    ? await supabase.from('team_members').update(payload).eq('id', id)
    : await supabase.from('team_members').insert(payload);

  if (error) { setError('team-error', error.message); btn.disabled = false; return; }

  closeModal();
  toast('Roster updated', 'success');
  loadTeam();
}

/* ==========================================================================
   11. Activity
   ========================================================================== */

function renderActivityList(rows) {
  if (!rows.length) {
    return '<div class="a-empty"><p class="a-empty__title">Nothing logged yet</p><p>Changes made from this console appear here.</p></div>';
  }
  return `<ul class="a-list">${rows.map((r) => `
    <li class="a-list__item">
      <span class="a-list__dot" aria-hidden="true"></span>
      <div style="flex:1;min-width:0">
        <p class="a-list__text">
          <strong>${esc(r.actor_email || 'someone')}</strong>
          ${esc(r.action)} ${esc(r.entity_type)}${r.summary ? ' — ' + esc(r.summary) : ''}
        </p>
        <p class="a-list__time">${esc(formatShort(r.created_at))}</p>
      </div>
    </li>`).join('')}</ul>`;
}

async function loadActivity() {
  $('#activity-rows').innerHTML = '<div class="a-panel__body"><span class="a-skeleton" style="display:block"></span></div>';
  const { data, error } = await supabase.from('activity_log')
    .select('*').order('created_at', { ascending: false }).limit(150);
  if (error) { fail(error, 'loading activity'); return; }
  $('#activity-rows').innerHTML = renderActivityList(data || []);
}

/* ==========================================================================
   12. Settings
   ========================================================================== */

async function loadSettings() {
  const { me } = store;
  $('#acc-name').value = me.full_name || '';
  $('#acc-email').value = me.email || '';
  $('#acc-phone').value = me.phone || '';
  $('#acc-bio').value = me.bio || '';

  if (!isAdmin(me)) return;

  if (!store.events.length) {
    const { data } = await supabase.from('events_public').select('*').order('starts_at', { ascending: false });
    store.events = data || [];
  }
  const featured = store.events.find((e) => e.is_featured);
  $('#featured-select').innerHTML = '<option value="">None</option>' +
    store.events.filter((e) => e.status === 'published').map((e) =>
      `<option value="${esc(e.id)}"${featured?.id === e.id ? ' selected' : ''}>${esc(e.title)}</option>`).join('');
}

async function saveAccount(e) {
  e.preventDefault();
  setError('account-error', '');
  const payload = {
    full_name: $('#acc-name').value.trim() || null,
    phone: $('#acc-phone').value.trim() || null,
    bio: $('#acc-bio').value.trim() || null
  };
  const { error } = await supabase.from('profiles').update(payload).eq('id', store.me.id);
  if (error) { setError('account-error', error.message); return; }

  Object.assign(store.me, payload);
  paintIdentity();
  toast('Profile saved', 'success');
}

async function savePassword(e) {
  e.preventDefault();
  setError('password-error', '');
  const next = $('#pw-new').value;
  if (next !== $('#pw-confirm').value) {
    setError('password-error', 'The two passwords do not match.');
    return;
  }
  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) { setError('password-error', error.message); return; }
  $('#password-form').reset();
  toast('Password updated', 'success');
}

async function saveFeatured() {
  const id = $('#featured-select').value;
  // The events_single_featured trigger clears the previous one, but an empty
  // selection has no row to fire it, so unset explicitly.
  if (!id) {
    await supabase.from('events').update({ is_featured: false }).eq('is_featured', true);
    toast('Featured slot cleared', 'success');
  } else {
    const { error } = await supabase.from('events').update({ is_featured: true }).eq('id', id);
    if (error) { fail(error, 'setting the featured event'); return; }
    toast('Featured event updated', 'success');
  }
  loadEvents();
}

/* ==========================================================================
   13. Delegated actions
   ========================================================================== */

const ACTIONS = {
  'new-event':        () => openEventEditor(null),
  'edit-event':       (el) => openEventEditor(el.dataset.id),
  'event-attendees':  (el) => showAttendees(el.dataset.id),
  'delete-event':     (el) => {
    const ev = store.events.find((e) => e.id === el.dataset.id);
    confirmAction({
      title: 'Delete event',
      message: `“${ev?.title || 'This event'}” and its RSVPs will be removed. This can't be undone.`,
      onConfirm: async () => {
        const { error } = await supabase.from('events').delete().eq('id', el.dataset.id);
        if (error) { fail(error, 'deleting the event'); return; }
        await logActivity('deleted', 'event', el.dataset.id, ev?.title);
        toast('Event deleted', 'success');
        loadEvents();
      }
    });
  },

  'new-org':    () => openOrgEditor(null),
  'edit-org':   (el) => openOrgEditor(el.dataset.id),
  'delete-org': (el) => {
    const org = store.orgs.find((o) => o.id === el.dataset.id);
    confirmAction({
      title: 'Delete organisation',
      message: `“${org?.name || 'This organisation'}” will be removed. Its events stay, but lose their organisation.`,
      onConfirm: async () => {
        const { error } = await supabase.from('organizations').delete().eq('id', el.dataset.id);
        if (error) { fail(error, 'deleting the organisation'); return; }
        await logActivity('deleted', 'organization', el.dataset.id, org?.name);
        toast('Organisation deleted', 'success');
        await loadReferenceData();
        loadOrgs();
      }
    });
  },

  'new-category':    () => openCategoryEditor(null),
  'edit-category':   (el) => openCategoryEditor(el.dataset.id),
  'delete-category': (el) => {
    const cat = store.categories.find((c) => c.id === el.dataset.id);
    confirmAction({
      title: 'Delete category',
      message: `“${cat?.name || 'This category'}” will disappear from every event that uses it.`,
      onConfirm: async () => {
        const { error } = await supabase.from('categories').delete().eq('id', el.dataset.id);
        if (error) { fail(error, 'deleting the category'); return; }
        toast('Category deleted', 'success');
        await loadReferenceData();
        loadCategories();
      }
    });
  },

  'invite-volunteer': () => openInvite(),
  'edit-person':      (el) => openPersonEditor(el.dataset.id),
  'delete-person':    (el) => {
    const person = store.people.find((p) => p.id === el.dataset.id);
    confirmAction({
      title: 'Remove access',
      message: `${person?.full_name || person?.email} will lose their profile and console access.`,
      confirmLabel: 'Remove',
      onConfirm: async () => {
        const { error } = await supabase.from('profiles').delete().eq('id', el.dataset.id);
        if (error) { fail(error, 'removing the profile'); return; }
        await logActivity('deleted', 'profile', el.dataset.id, person?.email);
        toast('Profile removed. Delete the auth user in Supabase to fully revoke sign-in.', 'success');
        loadPeople();
      }
    });
  },

  'new-team-member':    () => openTeamEditor(null),
  'edit-team-member':   (el) => openTeamEditor(el.dataset.id),
  'delete-team-member': (el) => {
    const m = store.team.find((x) => x.id === el.dataset.id);
    confirmAction({
      title: 'Remove from roster',
      message: `${m?.name || 'This member'} will no longer appear on The Team page.`,
      confirmLabel: 'Remove',
      onConfirm: async () => {
        const { error } = await supabase.from('team_members').delete().eq('id', el.dataset.id);
        if (error) { fail(error, 'removing the member'); return; }
        toast('Removed', 'success');
        loadTeam();
      }
    });
  },

  'export-users': () => {
    const savesBy = countBy(store.saves, 'user_id');
    const rsvpsBy = countBy(store.rsvps.filter((r) => r.response === 'yes'), 'user_id');
    downloadCsv('eventundo-users.csv', [
      ['Name', 'Email', 'Role', 'Status', 'Saves', 'RSVPs', 'Joined'],
      ...store.people.filter((p) => p.role === 'user').map((p) => [
        p.full_name, p.email, p.role, p.status,
        savesBy[p.id] || 0, rsvpsBy[p.id] || 0, formatDate(p.created_at)
      ])
    ]);
  },

  'export-rsvps': () => {
    const eventById = Object.fromEntries(store.events.map((e) => [e.id, e]));
    const eventId = $('#reg-event').value;
    const response = $('#reg-response').value;
    const term = $('#reg-search').value.trim().toLowerCase();
    downloadCsv('eventundo-registrations.csv', [
      ['Attendee', 'Email', 'Organisation', 'Event', 'Event date', 'Venue', 'Response', 'Registered'],
      ...store.rsvps
        .filter((r) =>
          (!eventId || r.event_id === eventId) &&
          (!response || r.response === response) &&
          (!term || `${r.profiles?.full_name || ''} ${r.profiles?.email || ''}`.toLowerCase().includes(term)))
        .map((r) => {
          const event = eventById[r.event_id];
          return [
            r.profiles?.full_name, r.profiles?.email, r.profiles?.organizations?.name,
            event?.title, event ? formatDate(event.starts_at) : '', event?.venue,
            r.response, formatShort(r.created_at)
          ];
        })
    ]);
  }
};

/* ========================================================================== */

boot();
