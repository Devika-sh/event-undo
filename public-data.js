/* ==========================================================================
   EventUndo — public site ↔ Supabase
   --------------------------------------------------------------------------
   Hydrates the marketing pages from the same tables the admin console writes
   to, and lets a signed-in user save events, RSVP, and pick interests.

   Every list ships as skeleton markup and stays that way until this file has
   real rows to put in its place. Nothing is ever rendered from a cache or
   from demo copy — a shimmer means "still loading", and the only thing that
   replaces it is live data or an explicit "nothing here" message.
   ========================================================================== */

import {
  supabase, isConfigured, getSession, isStaff,
  formatDate, formatTime, formatFee, esc, initials, timingOf
} from './supabase-client.js';
import { initDropzones, resetDropzone } from './dropzone.js';
// Side-effect only: wires every .a-select into the custom dropdown once it's
// in the DOM (the profile edit form's Semester/Favourite org selects). See dropdown.js.
import './dropdown.js';

if (isConfigured) init();
else showUnavailable('This section isn’t available right now.');

let me = null;             // auth user, or null
let savedIds = new Set();  // event ids this user has hearted

/** Clears every skeleton region on the page and says why it's empty. Runs when
 *  the backend can't be reached at all (supabase-config.js still holds the
 *  placeholder keys), so nothing below would ever fire — a skeleton must never
 *  be left shimmering with no request behind it. */
function showUnavailable(message) {
  const note = `<p class="eu-empty">${esc(message)}</p>`;

  ['.event-grid', '.org-list', '.team-grid', '.events-fan'].forEach((sel) => {
    const region = document.querySelector(sel);
    if (!region) return;
    region.removeAttribute('aria-busy');
    region.innerHTML = note;
  });

  ['.filters__set', '.org-filters'].forEach((sel) => {
    const row = document.querySelector(sel);
    if (!row) return;
    row.removeAttribute('aria-busy');
    row.innerHTML = '';
  });

  document.querySelector('.featured')?.setAttribute('hidden', '');
  document.querySelector('.profile-card')?.removeAttribute('data-loading');
  if (document.querySelector('.event-head')) clearEventSkeletons(message);
}

async function init() {
  const session = await getSession();
  me = session?.user ?? null;

  if (me) {
    const { data } = await supabase.from('event_saves').select('event_id').eq('user_id', me.id);
    savedIds = new Set((data || []).map((r) => r.event_id));
  }

  paintAccountLink();
  applySiteSettings();

  // Each page opts in by having the element the hydrator looks for.
  if (document.querySelector('.event-grid'))  hydrateDiscover();
  if (document.querySelector('.org-list'))    hydrateOrganizations();
  if (document.querySelector('.team-grid'))   hydrateTeam();
  if (document.querySelector('.event-head'))  hydrateEventDetails();
  if (document.querySelector('.profile-row')) hydrateProfile();
}

/* ==========================================================================
   Shared bits
   ========================================================================== */

/** Untitled UI `heart`, copied verbatim from the static cards so the rendered
 *  and hand-written markup stay pixel-identical. */
const HEART_SVG = `
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <g transform="translate(0.6667 1.5)">
      <path fill-rule="evenodd" clip-rule="evenodd" d="M9.32774 2.78172C7.66162 0.833877 4.88324 0.309912 2.7957 2.09355C0.708153 3.8772 0.414256 6.85936 2.05361 8.96888C3.41663 10.7228 7.54159 14.422 8.89353 15.6192C9.04479 15.7532 9.12041 15.8202 9.20863 15.8465C9.28562 15.8694 9.36987 15.8694 9.44686 15.8465C9.53507 15.8202 9.6107 15.7532 9.76195 15.6192C11.1139 14.422 15.2389 10.7228 16.6019 8.96888C18.2412 6.85936 17.9832 3.85843 15.8598 2.09355C13.7364 0.328674 10.9939 0.833877 9.32774 2.78172Z"></path>
    </g>
  </svg>`;

const FALLBACK_IMAGE = 'Assets/eventundo-fallback.png';

function toast(message) {
  let host = document.querySelector('.eu-toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'eu-toasts';
    document.body.append(host);
  }
  const el = document.createElement('div');
  el.className = 'eu-toast';
  el.textContent = message;
  host.append(el);
  setTimeout(() => el.remove(), 3600);
}

/** Profile is the one door into an account, so the nav keeps pointing there
 *  whether or not there's a session — signed out, that page shows sign-in. */
function paintAccountLink() {
  if (me) return;
  document.querySelectorAll('a[href="profile.html"]').forEach((link) => {
    if (link.textContent.trim() === 'Profile') link.textContent = 'Sign in';
  });
}

/** Applies the admin-managed page title, favicon and link-preview (Open
 *  Graph) tags from `site_settings`. Favicon is genuinely site-wide, so it's
 *  updated on every page; the title/description/OG fields only override
 *  what's already on the page (index.html ships the OG tags — see its
 *  <head> — everywhere else keeps its own per-page <title>). */
async function applySiteSettings() {
  const { data } = await supabase.from('site_settings').select('value').eq('key', 'site').maybeSingle();
  const s = data?.value;
  if (!s) return;

  const favicon = document.getElementById('site-favicon');
  if (favicon && s.favicon_url) favicon.href = s.favicon_url;

  if (!document.querySelector('.event-grid')) return;   // title/OG only apply on the homepage

  if (s.title) document.title = s.title;

  const setMeta = (selector, content) => {
    if (!content) return;
    const el = document.querySelector(selector);
    if (el) el.setAttribute('content', content);
  };
  setMeta('meta[name="description"]', s.description);
  setMeta('meta[property="og:title"]', s.og_title || s.title);
  setMeta('meta[property="og:description"]', s.og_description || s.description);
  setMeta('meta[property="og:image"]', s.og_image_url);
}

/** Where an interrupted action parks itself while the user signs in. */
const PENDING_SAVE = 'eventundo:pending-save';
const PENDING_REASON = 'eventundo:pending-reason';

function sendToSignIn(reason, pendingEventId) {
  try {
    sessionStorage.setItem(PENDING_REASON, reason);
    if (pendingEventId) sessionStorage.setItem(PENDING_SAVE, pendingEventId);
  } catch { /* private mode — the redirect still works, just without the note */ }
  toast(reason);
  setTimeout(() => { location.href = 'profile.html'; }, 700);
}

function cardMarkup(event) {
  const liked = savedIds.has(event.id);
  const title = esc(event.title);
  const tags = (event.tags || []).slice(0, 5);

  return `
  <article class="card" data-event="${esc(event.id)}" data-timing="${timingOf(event)}">
    <a class="card__link" href="event-details.html?id=${encodeURIComponent(event.id)}"
       aria-label="View ${title}"></a>
    <div class="card__media">
      <img class="card__photo" src="${esc(event.thumbnail_url || event.banner_url || FALLBACK_IMAGE)}" alt=""
           width="360" height="300" loading="lazy" />
      <div class="card__scrim paint-blur">
        <p class="card__event-title">${title}</p>
        <p class="card__organizer">by ${esc(event.organizer || 'eventundo')}</p>
      </div>
      <button class="like-btn" type="button" aria-pressed="${liked}"
              data-save="${esc(event.id)}"
              aria-label="${liked ? 'Unsave' : 'Save'} ${title}">${HEART_SVG}</button>
    </div>
    <div class="card__details">
      <div class="detail"><span class="detail__label">Date</span><span class="detail__value">${esc(formatDate(event.starts_at))}</span></div>
      <div class="detail"><span class="detail__label">Time</span><span class="detail__value">${esc(formatTime(event.starts_at))}</span></div>
      <div class="detail"><span class="detail__label">Fee</span><span class="detail__value">${esc(formatFee(event.fee_amount, event.currency))}</span></div>
    </div>
    <div class="card__tags">
      ${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}
    </div>
  </article>`;
}

/**
 * One delegated handler covers every heart on the page, including cards that
 * get re-rendered by a filter change.
 *
 * Runs in the CAPTURE phase so it beats the per-button listener each page
 * attaches inline. When there's no session that listener must not run at all —
 * otherwise the heart would visibly fill for a moment before the redirect,
 * which reads as "saved" when nothing was.
 */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.like-btn');
  if (!btn) return;

  // Saving needs an account. Park the event and send them to Profile to sign
  // in; the save is applied for them once they're back.
  if (!me) {
    e.preventDefault();
    e.stopPropagation();
    sendToSignIn('Sign in to save events', btn.dataset.save);
    return;
  }

  // A heart on a static placeholder card has no event behind it — let the
  // page's own listener handle the visual toggle and stay out of it.
  const id = btn.dataset.save;
  if (!id) return;

  e.stopPropagation();
  const nowSaved = btn.getAttribute('aria-pressed') !== 'true';
  btn.setAttribute('aria-pressed', String(nowSaved));

  const { error } = nowSaved
    ? await supabase.from('event_saves').insert({ user_id: me.id, event_id: id })
    : await supabase.from('event_saves').delete().eq('user_id', me.id).eq('event_id', id);

  if (error) {
    btn.setAttribute('aria-pressed', String(!nowSaved));   // roll the pip back
    toast('Could not update your saves');
    return;
  }

  if (nowSaved) savedIds.add(id); else savedIds.delete(id);
}, true);

/* ==========================================================================
   Discover (index.html)
   ========================================================================== */

let allEvents = [];
const activeChips = new Set();

async function hydrateDiscover() {
  const search = document.querySelector('.search-bar__input');
  if (search) search.addEventListener('input', renderGrid);

  const [events, categories] = await Promise.all([
    supabase.from('events_public').select('*')
      .eq('status', 'published').order('starts_at', { ascending: false }),
    supabase.from('categories').select('*')
      .eq('is_active', true).order('group_name').order('sort_order')
  ]);

  // Skeletons have been on screen until now; from here on the page shows
  // either real events or an explicit reason there aren't any.
  if (events.error) { clearDiscoverSkeletons('Events couldn’t be loaded right now.'); return; }
  if (!events.data.length) { clearDiscoverSkeletons('No events have been published yet.'); return; }

  allEvents = events.data;
  buildFilters(categories.data || []);
  hydrateFeatured();
  renderGrid();
}

/** Nothing to show on Discover — drop the skeleton grid, the skeleton chip
 *  row and the skeleton hero rather than leaving any of them shimmering. */
function clearDiscoverSkeletons(message) {
  const grid = document.querySelector('.event-grid');
  if (grid) {
    grid.removeAttribute('aria-busy');
    grid.innerHTML = `<p class="eu-empty">${esc(message)}</p>`;
  }

  const set = document.querySelector('.filters__set');
  if (set) { set.removeAttribute('aria-busy'); set.innerHTML = ''; }

  const featured = document.querySelector('.featured');
  if (featured) featured.hidden = true;
}

function hydrateFeatured() {
  const section = document.querySelector('.featured');
  const featured = allEvents.find((e) => e.is_featured) || allEvents[0];
  // No event to feature — the hero comes off the page rather than sitting
  // there as a shimmer with nothing behind it.
  if (!featured) { if (section) section.hidden = true; return; }

  // Swaps the skeleton hero for the real one now that there's something to show.
  if (section) section.removeAttribute('data-loading');

  const title = document.querySelector('.featured__title');
  const photo = document.querySelector('.featured__photo');
  if (title) title.textContent = featured.title;
  if (photo) {
    photo.src = featured.thumbnail_url || featured.banner_url || FALLBACK_IMAGE;
    photo.alt = featured.title;
  }

  const href = 'event-details.html?id=' + encodeURIComponent(featured.id);
  const label = 'View ' + featured.title;

  // The whole card opens the event — same transparent-overlay pattern as the
  // grid's own .card__link, sitting under the "View event" button (desktop
  // only; hidden on mobile, see styles.css) so the button keeps its own hit
  // target instead of double-handling the click.
  if (section) {
    let cardLink = section.querySelector('.featured__card-link');
    if (!cardLink) {
      cardLink = document.createElement('a');
      cardLink.className = 'featured__card-link';
      section.prepend(cardLink);
    }
    cardLink.href = href;
    cardLink.setAttribute('aria-label', label);
  }

  const body = document.querySelector('.featured__body');
  if (body) {
    let link = body.querySelector('.featured__link');
    if (!link) {
      link = document.createElement('a');
      link.className = 'featured__link';
      link.textContent = 'View event';
      body.append(link);
    }
    link.href = href;
  }
}

/** Rebuilds the chip row from `categories`, keeping the dot separators between
 *  groups that the static markup establishes. */
function buildFilters(categories) {
  const set = document.querySelector('.filters__set');
  if (!set) return;
  set.removeAttribute('aria-busy');   // skeleton chips are about to be replaced

  const order = ['mode', 'timing', 'organiser', 'topic'];
  const groups = order
    .map((g) => ({ name: g, items: categories.filter((c) => c.group_name === g) }))
    .filter((g) => g.items.length);

  set.innerHTML = groups.map((g) => `
    <div class="filters__group">
      ${g.items.map((c) => `
        <button class="chip" type="button" data-group="${esc(g.name)}"
                data-slug="${esc(c.slug)}">${esc(c.name)}</button>`).join('')}
    </div>`).join('<span class="filters__dot" aria-hidden="true"></span>');

  set.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const slug = chip.dataset.slug;
    if (activeChips.has(slug)) { activeChips.delete(slug); chip.classList.remove('chip--selected'); }
    else { activeChips.add(slug); chip.classList.add('chip--selected'); }
    renderGrid();
  });
}

function renderGrid() {
  const grid = document.querySelector('.event-grid');
  grid.removeAttribute('aria-busy');   // skeleton cards are about to be replaced
  const term = (document.querySelector('.search-bar__input')?.value || '').trim().toLowerCase();

  // Chips within a group are OR'd; across groups they're AND'd — picking
  // "Offline" + "Design" should mean offline AND design, but "Design" + "Web
  // Dev" should widen rather than narrow.
  const chosen = {};
  document.querySelectorAll('.filters__set .chip--selected').forEach((chip) => {
    (chosen[chip.dataset.group] ||= []).push(chip.dataset.slug);
  });

  const rows = allEvents.filter((event) => {
    const tagSlugs = (event.tags || []).map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-'));

    for (const [group, slugs] of Object.entries(chosen)) {
      let ok;
      if (group === 'mode')        ok = slugs.includes(event.mode);
      else if (group === 'timing') ok = slugs.includes(timingOf(event));
      else                         ok = slugs.some((s) => tagSlugs.includes(s));
      if (!ok) return false;
    }

    if (term) {
      const haystack = `${event.title} ${event.organizer || ''} ${(event.tags || []).join(' ')}`;
      if (!haystack.toLowerCase().includes(term)) return false;
    }
    return true;
  });

  grid.innerHTML = rows.length
    ? rows.map(cardMarkup).join('')
    : `<p class="event-grid__empty">No events match those filters yet.</p>`;
}

/* ==========================================================================
   Organizations (organizations.html)
   ========================================================================== */

async function hydrateOrganizations() {
  const list = document.querySelector('.org-list');
  const { data, error } = await supabase.from('organizations')
    .select('*').eq('is_active', true).order('name');

  // Skeletons come off here either way — replaced by real cards, or by the
  // reason there aren't any.
  list.removeAttribute('aria-busy');

  if (error || !data?.length) {
    const bar = document.querySelector('.org-filters');
    if (bar) { bar.removeAttribute('aria-busy'); bar.innerHTML = ''; }
    list.innerHTML = `<p class="eu-empty">${
      error ? 'Organizations couldn’t be loaded right now.' : 'No organizations have been added yet.'
    }</p>`;
    return;
  }

  buildOrgFilters(data);

  list.innerHTML = data.map((org) => {
    const paragraphs = (org.about || '').split(/\n{2,}/).filter(Boolean);
    const social = (url, kind, label) => url
      ? `<a href="${esc(url)}" target="_blank" rel="noopener" aria-label="${esc(org.name)} ${label}">
           <span class="org-socials__icon org-socials__icon--${kind} icon-mask"></span></a>`
      : '';

    return `
    <article class="org-card" data-type="${esc(org.type || '')}">
      <div class="org-card__profile">
        ${org.logo_url
          ? `<span class="org-logo org-logo--art"><img src="${esc(org.logo_url)}" alt="" /></span>`
          : `<span class="org-logo" aria-hidden="true">${esc(org.initials || initials(org.name))}</span>`}
        <div class="org-card__identity-col">
          <div class="org-identity">
            <h2 class="org-identity__name">${esc(org.name)}</h2>
            <p class="org-identity__category">${esc(org.category || '')}</p>
            ${org.type ? `<span class="chip org-card__type-chip">${
              esc(org.type.charAt(0).toUpperCase() + org.type.slice(1))}</span>` : ''}
          </div>
          <div class="org-socials">
            ${social(org.instagram_url, 'instagram', 'on Instagram')}
            ${social(org.linkedin_url, 'linkedin', 'on LinkedIn')}
            ${social(org.website_url, 'website', 'website')}
          </div>
        </div>
      </div>
      <div class="org-card__about">
        ${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}
      </div>
    </article>`;
  }).join('');
}

/** Rebuilds the chip row from whatever `type` values actually exist on
 *  active organisations — a new type typed into the dashboard shows up here
 *  automatically, no code change needed. Filtering itself is handled by the
 *  delegated listener in organizations.html, which reads data-type off
 *  whatever cards are on the page — static or this dynamic markup alike. */
function buildOrgFilters(orgs) {
  const bar = document.querySelector('.org-filters');
  if (!bar) return;
  bar.removeAttribute('aria-busy');   // skeleton chips are about to be replaced

  const types = [...new Set(orgs.map((o) => o.type).filter(Boolean))].sort();
  bar.innerHTML = types.map((t) => `
    <button class="chip" type="button" data-type="${esc(t)}">
      ${esc(t.charAt(0).toUpperCase() + t.slice(1))}</button>`).join('');
}

/* ==========================================================================
   The Team (team.html)
   ========================================================================== */

async function hydrateTeam() {
  const grid = document.querySelector('.team-grid');
  const [members, interestRows] = await Promise.all([
    supabase.from('team_members').select('*, organizations(name)')
      .eq('is_active', true).order('sort_order').order('name'),
    supabase.from('team_member_interests').select('team_member_id, categories(name)')
  ]);

  grid.removeAttribute('aria-busy');

  if (members.error || !members.data?.length) {
    grid.innerHTML = `<p class="eu-empty">${
      members.error ? 'The team couldn’t be loaded right now.' : 'The team roster is being put together.'
    }</p>`;
    return;
  }

  const interestsByMember = (interestRows.data || []).reduce((acc, r) => {
    if (!r.categories?.name) return acc;
    (acc[r.team_member_id] ||= []).push(r.categories.name);
    return acc;
  }, {});

  grid.innerHTML = members.data.map((m) => {
    const interests = interestsByMember[m.id] || [];
    return `
    <article class="profile-card">
      <h2 class="profile-card__name">${esc(m.name)}</h2>
      <div class="profile-card__photo${m.photo_url ? '' : ' profile-card__photo--empty'}">
        ${m.photo_url ? `<img src="${esc(m.photo_url)}" alt="${esc(m.name)}" />` : ''}
      </div>
      ${m.role_title || m.organizations?.name
        ? `<p class="profile-card__role">
             ${m.role_title ? esc(m.role_title) : ''}
             ${m.organizations?.name
               ? `<span class="profile-card__org">${esc(m.organizations.name)}</span>`
               : ''}
           </p>`
        : ''}
      <div class="profile-card__socials">
        ${m.instagram_url ? `<a href="${esc(m.instagram_url)}" target="_blank" rel="noopener"
           aria-label="${esc(m.name)} on Instagram"><span class="profile-card__social-icon profile-card__social-icon--instagram icon-mask"></span></a>` : ''}
        ${m.linkedin_url ? `<a href="${esc(m.linkedin_url)}" target="_blank" rel="noopener"
           aria-label="${esc(m.name)} on LinkedIn"><span class="profile-card__social-icon profile-card__social-icon--linkedin icon-mask"></span></a>` : ''}
      </div>
      ${interests.length
        ? `<div class="profile-card__interests" role="group" aria-label="${esc(m.name)}'s interests">
             ${interests.map((name) => `<span class="chip chip--selected">${esc(name)}</span>`).join('')}
           </div>`
        : ''}
    </article>`;
  }).join('');
}

/* ==========================================================================
   Event details (event-details.html?id=…)
   ========================================================================== */

async function hydrateEventDetails() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) { clearEventSkeletons('This event could not be found.'); return; }

  const { data: event, error } = await supabase
    .from('events_public').select('*').eq('id', id).maybeSingle();
  if (error || !event) { clearEventSkeletons('This event could not be found.'); return; }

  document.title = `eventundo — ${event.title}`;

  const set = (sel, text) => { const el = document.querySelector(sel); if (el) el.textContent = text; };
  set('.event-head__title', event.title);
  set('.event-head__org', 'by ' + (event.organizer || 'eventundo'));

  const banner = document.querySelector('.banner__photo');
  if (banner) {
    banner.src = event.banner_url || event.thumbnail_url || FALLBACK_IMAGE;
    banner.alt = event.title;
    banner.closest('.banner')?.removeAttribute('data-loading');
  }

  // Meta rows ship in a fixed order: date, time, venue, cost.
  const rows = document.querySelectorAll('.meta__row .meta__text');
  const values = [
    formatDate(event.starts_at),
    formatTime(event.starts_at),
    event.venue || 'To be announced',
    formatFee(event.fee_amount, event.currency)
  ];
  rows.forEach((row, i) => { if (values[i]) row.textContent = values[i]; });

  const about = document.querySelector('.about__text');
  if (about) about.textContent = event.description || event.summary || 'Details coming soon.';

  // Written unconditionally: an event with no tags clears the skeleton chips
  // rather than leaving them shimmering over a row that will never fill.
  const tagRow = document.querySelector('.about__tags');
  if (tagRow) {
    tagRow.innerHTML = (event.tags || [])
      .map((t) => `<span class="chip">${esc(t)}</span>`).join('');
  }

  // A past event is done — nothing left to RSVP to, so the question card
  // comes off the page instead of asking about an event that already happened.
  const question = document.querySelector('.question');
  if (timingOf(event) === 'past') {
    if (question) question.hidden = true;
  } else {
    wireRsvp(event);
  }
  hydrateMoreEvents(event);
  hydrateFriends(event);
}

/** Fetch failed / no id in the URL — clear every skeleton with a plain
 *  message instead of leaving the shimmer spinning forever. */
function clearEventSkeletons(message) {
  document.querySelector('.banner')?.removeAttribute('data-loading');
  const set = (sel, text) => { const el = document.querySelector(sel); if (el) el.textContent = text; };
  set('.event-head__title', message);
  set('.event-head__org', '');
  document.querySelectorAll('.meta__text').forEach((el) => { el.textContent = '—'; });
  const about = document.querySelector('.about__text');
  if (about) about.textContent = message;
  const tagRow = document.querySelector('.about__tags');
  if (tagRow) tagRow.innerHTML = '';
  const question = document.querySelector('.question');
  if (question) question.hidden = true;
}

/** Label (and the trailing redirect arrow) reflect what the button will
 *  actually do for the choice that's selected right now — "Register Now"
 *  never appears next to "No", and neither does the arrow that implies a
 *  redirect is about to happen. */
function updateCtaLabel(submit, choiceValue, hasExternalLink) {
  const label = choiceValue === 'yes' && hasExternalLink ? 'Register Now'
    : choiceValue === 'yes' ? "I'm going"
    : 'Save response';
  submit.firstChild.textContent = label + ' ';

  const icon = submit.querySelector('.btn-cta__icon');
  if (icon) icon.hidden = choiceValue !== 'yes';
}

async function wireRsvp(event) {
  const form = document.querySelector('.question__body');
  if (!form) return;
  const submit = form.querySelector('.btn-cta');
  const radios = form.querySelectorAll('input[name="rsvp"]');
  const hasExternalLink = Boolean(event.register_url);

  radios.forEach((r) => r.addEventListener('change', () => {
    submit.disabled = false;
    updateCtaLabel(submit, r.value, hasExternalLink);
  }));

  if (me) {
    const { data } = await supabase.from('event_rsvps')
      .select('response').eq('event_id', event.id).eq('user_id', me.id).maybeSingle();
    if (data) {
      const existing = form.querySelector(`input[name="rsvp"][value="${data.response}"]`);
      if (existing) existing.checked = true;
      submit.disabled = false;
      updateCtaLabel(submit, data.response, hasExternalLink);
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!me) {
      sendToSignIn('Sign in to register for this event');
      return;
    }

    // Only a "yes" choice is a registration; only that choice may ever open
    // the organiser's external form, and only after the RSVP is recorded.
    const choice = form.querySelector('input[name="rsvp"]:checked');
    if (!choice) return;

    submit.disabled = true;
    const { error } = await supabase.from('event_rsvps').upsert(
      { event_id: event.id, user_id: me.id, response: choice.value },
      { onConflict: 'event_id,user_id' }
    );
    submit.disabled = false;

    if (error) { toast('Could not save your response'); return; }

    toast(choice.value === 'yes' ? "You're on the list" : 'Response saved');

    if (choice.value === 'yes' && event.register_url) {
      window.open(event.register_url, '_blank', 'noopener');
    }
  });
}

/** Real attendees only — no placeholder avatars. Shows the profile photo of
 *  people (besides the viewer) who RSVPed "yes" and hides the whole section
 *  when there's nobody, or nobody with a photo, to show. */
async function hydrateFriends(event) {
  const section = document.querySelector('#friends-section');
  const stack = document.querySelector('#friends-stack');
  if (!section || !stack) return;

  const { data, error } = await supabase
    .from('event_rsvps')
    .select('user_id, profiles(full_name, avatar_url)')
    .eq('event_id', event.id)
    .eq('response', 'yes')
    .neq('user_id', me?.id ?? '00000000-0000-0000-0000-000000000000')
    .limit(4);

  if (error || !data?.length) { section.hidden = true; return; }

  const withPhotos = data.filter((r) => r.profiles?.avatar_url);
  if (!withPhotos.length) { section.hidden = true; return; }

  stack.innerHTML = withPhotos.map((r) => `
    <li><img class="friends__avatar" src="${esc(r.profiles.avatar_url)}"
             alt="${esc(r.profiles.full_name || 'Attendee')}" width="50" height="50" /></li>`).join('');
  section.hidden = false;
}

async function hydrateMoreEvents(event) {
  const section = document.querySelector('.more-events');
  const track = document.querySelector('.more-events__track');
  if (!section || !track) return;

  // Hidden the moment we know we're hydrating live data, so the four static
  // placeholder cards (unrelated events, not from this organiser) never
  // flash before the real check for "anything else on?" resolves.
  section.hidden = true;
  if (!event.organization_id) return;

  const { data } = await supabase.from('events_public').select('*')
    .eq('status', 'published')
    .eq('organization_id', event.organization_id)
    .neq('id', event.id)
    .order('starts_at', { ascending: true })
    .limit(8);

  // No other events from this organiser — skip the section entirely rather
  // than show cards that don't belong to it.
  if (!data?.length) return;

  const heading = document.querySelector('.more-events__title');
  if (heading) heading.textContent = `More Events from ${event.organizer || 'this organiser'}`;
  track.innerHTML = data.map(cardMarkup).join('');
  section.hidden = false;
}

/* ==========================================================================
   Profile (profile.html)
   ========================================================================== */

async function hydrateProfile() {
  if (!me) { showAuthPanel(); return; }

  // Finish whatever the user was doing before they got sent here to sign in.
  await applyPendingSave();

  const [profile, categories, interests, saves, orgs] = await Promise.all([
    // profiles has two FKs into organizations (organization_id for staff
    // affiliation, favorite_organization_id for this pick), so the embed
    // must be hinted or PostgREST can't tell which relationship to follow.
    supabase.from('profiles').select('*, organizations!favorite_organization_id(name)').eq('id', me.id).maybeSingle(),
    supabase.from('categories').select('*').eq('is_active', true)
      .eq('group_name', 'topic').order('sort_order'),
    supabase.from('user_interests').select('category_id').eq('user_id', me.id),
    supabase.from('event_saves').select('event_id').eq('user_id', me.id),
    supabase.from('organizations').select('id, name').eq('is_active', true).order('name')
  ]);

  // The card shows the picks; the edit form is where they get changed.
  const topics = categories.data || [];
  const mine = new Set((interests.data || []).map((i) => i.category_id));
  const orgList = orgs.data || [];

  paintProfileCard(profile.data);
  paintInterests(topics, mine);
  wireProfileEdit(profile.data, topics, mine, orgList);

  // Saved events replace the skeleton fan. Every branch below writes to it,
  // so the shimmer can't outlive the fetch even when nothing comes back.
  const fan = document.querySelector('.events-fan');
  if (fan) {
    fan.removeAttribute('aria-busy');
    const savedEventIds = (saves.data || []).map((s) => s.event_id);
    let cards = [];
    if (savedEventIds.length) {
      savedIds = new Set(savedEventIds);
      const { data } = await supabase.from('events_public').select('*')
        .in('id', savedEventIds).eq('status', 'published')
        .order('starts_at', { ascending: true });
      cards = data || [];
    }
    fan.innerHTML = cards.length
      ? cards.map(cardMarkup).join('')
      : `<p class="event-grid__empty">
           Nothing saved yet — tap the heart on an event to keep it here.</p>`;
  }

  addAdminLink(profile.data);
  addSignOut();
}

/** Admins and volunteers get a one-click way back into the console they
 *  manage events from — regular users never see it. */
function addAdminLink(profile) {
  const card = document.querySelector('.profile-card');
  if (!card || !isStaff(profile) || card.querySelector('.eu-admin-link')) return;
  const link = document.createElement('a');
  link.className = 'eu-admin-link';
  link.href = 'admin.html';
  link.textContent = 'Go to Admin Dashboard';
  card.append(link);
}

function addSignOut() {
  const card = document.querySelector('.profile-card');
  if (!card || card.querySelector('.eu-signout')) return;
  const btn = document.createElement('button');
  btn.className = 'eu-signout';
  btn.type = 'button';
  btn.textContent = 'Sign out';
  btn.addEventListener('click', async () => {
    await supabase.auth.signOut();
    location.href = 'index.html';
  });
  card.append(btn);
}

function paintProfileCard(profile) {
  // Card ships in its loading state; this is the point real values exist.
  document.querySelector('.profile-card')?.removeAttribute('data-loading');

  const nameEl = document.querySelector('.profile-card__name');
  if (nameEl) nameEl.textContent = profile?.full_name || me.email;

  const photo = document.querySelector('.profile-card__photo');
  if (photo) {
    if (profile?.avatar_url) {
      photo.classList.remove('profile-card__photo--empty');
      photo.innerHTML = `<img src="${esc(profile.avatar_url)}" alt="" />`;
    } else {
      // No photo on file — the neutral portrait slot, not a shimmer.
      photo.classList.add('profile-card__photo--empty');
      photo.innerHTML = `
        <svg viewBox="0 0 261 300" role="img" aria-label="No profile photo">
          <circle cx="130" cy="118" r="52" fill="rgba(255,255,255,0.28)" />
          <path d="M34 300c0-53 43-96 96-96s96 43 96 96z" fill="rgba(255,255,255,0.28)" />
        </svg>`;
    }
  }

  // Department/semester + favourite organisation — same badge treatment as
  // the org highlight on the team roster card.
  const role = document.querySelector('#profile-role');
  if (role) {
    const line = [profile?.department, profile?.semester ? `Semester ${profile.semester}` : null]
      .filter(Boolean).join(' · ');
    const orgName = profile?.organizations?.name;
    role.innerHTML = [
      line ? esc(line) : '',
      orgName ? `<span class="profile-card__org">${esc(orgName)}</span>` : ''
    ].filter(Boolean).join('');
    role.hidden = !line && !orgName;
  }

  // Only show a social link the user actually filled in.
  const socials = document.querySelector('.profile-card__socials');
  if (socials) {
    const links = [
      ['instagram', profile?.instagram_url, 'on Instagram'],
      ['linkedin',  profile?.linkedin_url,  'on LinkedIn']
    ].filter(([, url]) => url);

    socials.innerHTML = links.map(([kind, url, label]) => `
      <a href="${esc(url)}" target="_blank" rel="noopener"
         aria-label="${esc(profile?.full_name || 'This user')} ${label}">
        <span class="profile-card__social-icon profile-card__social-icon--${kind} icon-mask"></span>
      </a>`).join('');
    socials.hidden = links.length === 0;
  }
}

/** Read-only chips on the card. Empty stays empty rather than showing a row of
 *  unpicked options — the pencil is the affordance for adding some. */
function paintInterests(topics, mine) {
  const row = document.querySelector('.profile-card__interests');
  if (!row) return;

  const picked = topics.filter((c) => mine.has(c.id));
  row.innerHTML = picked
    .map((c) => `<span class="chip chip--selected">${esc(c.name)}</span>`).join('');
  row.hidden = picked.length === 0;
}

/* ---- Edit mode (pop-up) --------------------------------------------------- */

/** How many interests a user may pick. */
const MAX_INTERESTS = 5;

function wireProfileEdit(profile, topics, mine, orgs) {
  const toggle = document.querySelector('.edit-btn');
  const modal = document.getElementById('profile-edit-modal');
  const form = document.getElementById('profile-edit');
  if (!toggle || !modal || !form) return;

  initDropzones(modal);

  const picker = document.getElementById('pe-interests');
  const counter = document.getElementById('pe-interests-count');
  const orgSelect = document.getElementById('pe-org');

  orgSelect.innerHTML = '<option value="">None</option>' +
    orgs.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');

  const selectedIds = () =>
    [...picker.querySelectorAll('.chip--selected')].map((c) => c.dataset.cat);

  /** Disables the unpicked chips once the cap is reached, so the limit is felt
   *  before it's hit rather than reported after. */
  const refreshPicker = () => {
    const n = picker.querySelectorAll('.chip--selected').length;
    const atCap = n >= MAX_INTERESTS;

    picker.querySelectorAll('.chip').forEach((chip) => {
      chip.disabled = atCap && !chip.classList.contains('chip--selected');
    });

    counter.textContent = atCap
      ? `${n} of ${MAX_INTERESTS} — deselect one to swap it out.`
      : `${n} of ${MAX_INTERESTS} selected.`;
  };

  const buildPicker = () => {
    picker.innerHTML = topics.map((c) => `
      <button class="chip${mine.has(c.id) ? ' chip--selected' : ''}" type="button"
              data-cat="${esc(c.id)}" aria-pressed="${mine.has(c.id)}">${esc(c.name)}</button>`).join('');
    refreshPicker();
  };

  picker.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || chip.disabled) return;
    const on = chip.classList.toggle('chip--selected');
    chip.setAttribute('aria-pressed', String(on));
    refreshPicker();
  });

  const openEditor = () => {
    document.getElementById('pe-name').value = profile?.full_name || '';
    document.getElementById('pe-email').value = profile?.email || me.email || '';
    document.getElementById('pe-phone').value = profile?.phone || '';
    document.getElementById('pe-department').value = profile?.department || '';
    document.getElementById('pe-semester').value = profile?.semester || '';
    orgSelect.value = profile?.favorite_organization_id || '';
    document.getElementById('pe-bio').value = profile?.bio || '';
    document.getElementById('pe-instagram').value = profile?.instagram_url || '';
    document.getElementById('pe-linkedin').value = profile?.linkedin_url || '';
    resetDropzone(document.getElementById('pe-photo'));
    buildPicker();   // rebuilt each time, so Cancel really does discard
    setFormError('profile-error', '');

    toggle.setAttribute('aria-pressed', 'true');
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    document.getElementById('pe-name').focus();
  };

  const closeEditor = () => {
    toggle.setAttribute('aria-pressed', 'false');
    modal.hidden = true;
    document.body.style.overflow = '';
  };

  toggle.addEventListener('click', openEditor);
  document.getElementById('pe-close').addEventListener('click', closeEditor);
  document.getElementById('pe-cancel').addEventListener('click', closeEditor);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeEditor(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeEditor();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormError('profile-error', '');

    const save = document.getElementById('pe-save');
    save.disabled = true;
    save.textContent = 'Saving…';

    const payload = {
      full_name: document.getElementById('pe-name').value.trim() || null,
      phone: document.getElementById('pe-phone').value.trim() || null,
      department: document.getElementById('pe-department').value.trim() || null,
      semester: document.getElementById('pe-semester').value || null,
      favorite_organization_id: orgSelect.value || null,
      bio: document.getElementById('pe-bio').value.trim() || null,
      instagram_url: document.getElementById('pe-instagram').value.trim() || null,
      linkedin_url: document.getElementById('pe-linkedin').value.trim() || null
    };

    const file = document.getElementById('pe-photo').files[0];
    if (file) {
      const path = `avatars/${me.id}-${Date.now()}`;
      const up = await supabase.storage.from('media').upload(path, file, { upsert: true });
      if (up.error) {
        setFormError('profile-error', 'Photo upload failed: ' + up.error.message);
        save.disabled = false;
        save.textContent = 'Save';
        return;
      }
      payload.avatar_url = supabase.storage.from('media').getPublicUrl(path).data.publicUrl;
    }

    const { error } = await supabase.from('profiles').update(payload).eq('id', me.id);
    if (error) {
      setFormError('profile-error', error.message);
      save.disabled = false;
      save.textContent = 'Save';
      return;
    }

    // Interests are a join table, so send only what actually changed rather
    // than clearing and re-inserting the whole set on every save.
    const chosen = new Set(selectedIds());
    const added = [...chosen].filter((id) => !mine.has(id));
    const removed = [...mine].filter((id) => !chosen.has(id));

    if (removed.length) {
      await supabase.from('user_interests').delete()
        .eq('user_id', me.id).in('category_id', removed);
    }
    if (added.length) {
      await supabase.from('user_interests')
        .insert(added.map((category_id) => ({ user_id: me.id, category_id })));
    }

    mine.clear();
    chosen.forEach((id) => mine.add(id));

    save.disabled = false;
    save.textContent = 'Save';

    Object.assign(profile, payload);
    profile.organizations = orgSelect.value
      ? { name: orgSelect.options[orgSelect.selectedIndex].textContent }
      : null;
    paintProfileCard(profile);
    paintInterests(topics, mine);
    closeEditor();
    toast('Profile updated');
  });
}

/* ---- Signed-out panel ---------------------------------------------------- */

function setFormError(id, message) {
  const box = document.getElementById(id);
  if (!box) return;
  box.textContent = message || '';
  box.hidden = !message;
}

function showAuthPanel() {
  const panel = document.getElementById('auth-panel');
  const row = document.querySelector('.profile-row');
  if (!panel) return;

  panel.hidden = false;
  if (row) row.hidden = true;

  // If they were bounced here mid-action, say which one.
  let reason = null;
  try { reason = sessionStorage.getItem(PENDING_REASON); } catch { /* ignore */ }
  if (reason) {
    const note = document.getElementById('auth-reason');
    note.textContent = reason;
    note.hidden = false;
  }

  const signin = document.getElementById('signin-form');
  const signup = document.getElementById('signup-form');
  const toggle = document.getElementById('auth-toggle');
  const title = document.getElementById('auth-title');
  const sub = document.getElementById('auth-sub');

  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    const showingSignup = !signup.hidden;
    signup.hidden = showingSignup;
    signin.hidden = !showingSignup;
    title.textContent = showingSignup ? 'Sign in' : 'Create your account';
    sub.textContent = showingSignup
      ? 'Sign in to save events, RSVP, and keep your interests.'
      : 'Free, and takes about ten seconds.';
    toggle.textContent = showingSignup
      ? 'New here? Create an account'
      : 'Already have an account? Sign in';
  });

  signin.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormError('signin-error', '');
    const btn = document.getElementById('signin-submit');
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    const { error } = await supabase.auth.signInWithPassword({
      email: document.getElementById('in-email').value.trim(),
      password: document.getElementById('in-password').value
    });

    if (error) {
      setFormError('signin-error', error.message);
      btn.disabled = false;
      btn.textContent = 'Sign in';
      return;
    }
    location.reload();   // comes back as the signed-in branch
  });

  signup.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormError('signup-error', '');
    const btn = document.getElementById('signup-submit');
    btn.disabled = true;
    btn.textContent = 'Creating…';

    const { data, error } = await supabase.auth.signUp({
      email: document.getElementById('up-email').value.trim(),
      password: document.getElementById('up-password').value,
      options: { data: { full_name: document.getElementById('up-name').value.trim() } }
    });

    btn.disabled = false;
    btn.textContent = 'Create account';

    if (error) { setFormError('signup-error', error.message); return; }

    // With email confirmation on, signUp returns no session — say so rather
    // than reloading into a page that will just ask them to sign in again.
    if (data.session) location.reload();
    else setFormError('signup-error', 'Check your inbox to confirm your email, then sign in.');
  });

  document.getElementById('google-signin').addEventListener('click', async () => {
    setFormError('signin-error', '');
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname }
    });
    // On success the browser navigates to Google, so this only ever runs on failure.
    if (error) setFormError('signin-error', error.message);
  });

  document.getElementById('reset-btn').addEventListener('click', async () => {
    const email = document.getElementById('in-email').value.trim();
    if (!email) { setFormError('signin-error', 'Enter your email first.'); return; }
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: location.href
    });
    if (error) { setFormError('signin-error', error.message); return; }
    toast('Reset link sent to ' + email);
  });
}

/** Applies a heart the user clicked before signing in, then clears the note. */
async function applyPendingSave() {
  let pending = null;
  try {
    pending = sessionStorage.getItem(PENDING_SAVE);
    sessionStorage.removeItem(PENDING_SAVE);
    sessionStorage.removeItem(PENDING_REASON);
  } catch { return; }

  if (!pending) return;

  const { error } = await supabase.from('event_saves')
    .upsert({ user_id: me.id, event_id: pending }, { onConflict: 'user_id,event_id' });

  if (!error) {
    savedIds.add(pending);
    toast('Saved — it’s in your list below');
  }
}
