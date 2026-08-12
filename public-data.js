/* ==========================================================================
   EventUndo — public site ↔ Supabase
   --------------------------------------------------------------------------
   Hydrates the marketing pages from the same tables the admin console writes
   to, and lets a signed-in user save events, RSVP, and pick interests.

   Progressive enhancement on purpose: if supabase-config.js still holds the
   placeholders, or a table comes back empty, the page keeps the static markup
   it shipped with. Nothing here removes content without having something real
   to put in its place.
   ========================================================================== */

import {
  supabase, isConfigured, getSession,
  formatDate, formatTime, formatFee, esc, initials, timingOf
} from './supabase-client.js';

if (isConfigured) init();

let me = null;             // auth user, or null
let savedIds = new Set();  // event ids this user has hearted

async function init() {
  const session = await getSession();
  me = session?.user ?? null;

  if (me) {
    const { data } = await supabase.from('event_saves').select('event_id').eq('user_id', me.id);
    savedIds = new Set((data || []).map((r) => r.event_id));
  }

  paintAccountLink();

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

const FALLBACK_IMAGE = 'Assets/Event Card Image.png';

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

/** Swaps the "Profile" nav entries for "Sign in" when nobody is signed in, so
 *  the site never sends a stranger to an empty profile page. */
function paintAccountLink() {
  if (me) return;
  document.querySelectorAll('a[href="profile.html"]').forEach((link) => {
    link.setAttribute('href', 'account.html');
    if (link.textContent.trim() === 'Profile') link.textContent = 'Sign in';
  });
}

function cardMarkup(event) {
  const liked = savedIds.has(event.id);
  const title = esc(event.title);
  const tags = (event.tags || []).slice(0, 5);

  return `
  <article class="card" data-event="${esc(event.id)}">
    <div class="card__media">
      <a href="event-details.html?id=${encodeURIComponent(event.id)}" aria-label="${title}">
        <img class="card__photo" src="${esc(event.banner_url || FALLBACK_IMAGE)}" alt=""
             width="360" height="300" loading="lazy" />
      </a>
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

/** One delegated handler covers every heart on the page, including cards that
 *  get re-rendered by a filter change. */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-save]');
  if (!btn) return;

  if (!me) {
    toast('Sign in to save events');
    return;
  }

  const id = btn.dataset.save;
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
});

/* ==========================================================================
   Discover (index.html)
   ========================================================================== */

let allEvents = [];
const activeChips = new Set();

async function hydrateDiscover() {
  const [events, categories] = await Promise.all([
    supabase.from('events_public').select('*')
      .eq('status', 'published').order('starts_at', { ascending: true }),
    supabase.from('categories').select('*')
      .eq('is_active', true).order('group_name').order('sort_order')
  ]);

  if (events.error || !events.data?.length) return;   // keep the static grid
  allEvents = events.data;

  if (categories.data?.length) buildFilters(categories.data);
  hydrateFeatured();
  renderGrid();

  const search = document.querySelector('.search-bar__input');
  if (search) search.addEventListener('input', renderGrid);
}

function hydrateFeatured() {
  const featured = allEvents.find((e) => e.is_featured) || allEvents[0];
  if (!featured) return;

  const title = document.querySelector('.featured__title');
  const photo = document.querySelector('.featured__photo');
  if (title) title.textContent = featured.title;
  if (photo && featured.banner_url) {
    photo.src = featured.banner_url;
    photo.alt = featured.title;
  }

  const body = document.querySelector('.featured__body');
  if (body && !body.querySelector('.featured__link')) {
    const link = document.createElement('a');
    link.className = 'featured__link';
    link.href = 'event-details.html?id=' + encodeURIComponent(featured.id);
    link.textContent = 'View event';
    body.append(link);
  }
}

/** Rebuilds the chip row from `categories`, keeping the dot separators between
 *  groups that the static markup establishes. */
function buildFilters(categories) {
  const set = document.querySelector('.filters__set');
  if (!set) return;

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
  if (error || !data?.length) return;

  list.innerHTML = data.map((org) => {
    const paragraphs = (org.about || '').split(/\n{2,}/).filter(Boolean);
    const social = (url, kind, label) => url
      ? `<a href="${esc(url)}" target="_blank" rel="noopener" aria-label="${esc(org.name)} ${label}">
           <span class="org-socials__icon org-socials__icon--${kind} icon-mask"></span></a>`
      : '';

    return `
    <article class="org-card">
      <div class="org-card__profile">
        ${org.logo_url
          ? `<span class="org-logo org-logo--art"><img src="${esc(org.logo_url)}" alt="" /></span>`
          : `<span class="org-logo" aria-hidden="true">${esc(org.initials || initials(org.name))}</span>`}
        <div class="org-card__identity-col">
          <div class="org-identity">
            <h2 class="org-identity__name">${esc(org.name)}</h2>
            <p class="org-identity__category">${esc(org.category || '')}</p>
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

/* ==========================================================================
   The Team (team.html)
   ========================================================================== */

async function hydrateTeam() {
  const grid = document.querySelector('.team-grid');
  const { data, error } = await supabase.from('team_members')
    .select('*').eq('is_active', true).order('sort_order').order('name');
  if (error || !data?.length) return;

  // The static grid opens with a heading card; keep whatever isn't a person.
  const lead = grid.querySelector(':scope > :not(.profile-card)');
  const cards = data.map((m) => `
    <article class="profile-card">
      <h2 class="profile-card__name">${esc(m.name)}</h2>
      <div class="profile-card__photo${m.photo_url ? '' : ' profile-card__photo--empty'}">
        ${m.photo_url ? `<img src="${esc(m.photo_url)}" alt="${esc(m.name)}" />` : ''}
      </div>
      <div class="profile-card__socials">
        ${m.instagram_url ? `<a href="${esc(m.instagram_url)}" target="_blank" rel="noopener"
           aria-label="${esc(m.name)} on Instagram"><span class="profile-card__social-icon profile-card__social-icon--instagram icon-mask"></span></a>` : ''}
        ${m.linkedin_url ? `<a href="${esc(m.linkedin_url)}" target="_blank" rel="noopener"
           aria-label="${esc(m.name)} on LinkedIn"><span class="profile-card__social-icon profile-card__social-icon--linkedin icon-mask"></span></a>` : ''}
      </div>
      ${m.role_title
        ? `<div class="profile-card__interests" role="group" aria-label="${esc(m.name)}'s role">
             <span class="chip">${esc(m.role_title)}</span>
           </div>`
        : ''}
    </article>`).join('');

  grid.innerHTML = (lead ? lead.outerHTML : '') + cards;
}

/* ==========================================================================
   Event details (event-details.html?id=…)
   ========================================================================== */

async function hydrateEventDetails() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return;

  const { data: event, error } = await supabase
    .from('events_public').select('*').eq('id', id).maybeSingle();
  if (error || !event) return;

  document.title = `eventundo — ${event.title}`;

  const set = (sel, text) => { const el = document.querySelector(sel); if (el) el.textContent = text; };
  set('.event-head__title', event.title);
  set('.event-head__org', 'by ' + (event.organizer || 'eventundo'));

  const banner = document.querySelector('.banner__photo');
  if (banner && event.banner_url) {
    banner.src = event.banner_url;
    banner.alt = event.title;
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

  const tagRow = document.querySelector('.about__tags');
  if (tagRow && event.tags?.length) {
    tagRow.innerHTML = event.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('');
  }

  wireRsvp(event);
  hydrateMoreEvents(event);
}

async function wireRsvp(event) {
  const form = document.querySelector('.question__body');
  if (!form) return;
  const submit = form.querySelector('.btn-cta');
  const radios = form.querySelectorAll('input[name="rsvp"]');

  radios.forEach((r) => r.addEventListener('change', () => { submit.disabled = false; }));

  if (me) {
    const { data } = await supabase.from('event_rsvps')
      .select('response').eq('event_id', event.id).eq('user_id', me.id).maybeSingle();
    if (data) {
      const existing = form.querySelector(`input[name="rsvp"][value="${data.response}"]`);
      if (existing) existing.checked = true;
      submit.disabled = false;
      submit.firstChild.textContent = 'Update response ';
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!me) {
      toast('Sign in to register for this event');
      setTimeout(() => { location.href = 'account.html?next=' + encodeURIComponent(location.href); }, 900);
      return;
    }

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

    // An external registration form, if the organiser set one, opens only
    // after the RSVP is recorded — never as a surprise redirect.
    if (choice.value === 'yes' && event.register_url) {
      window.open(event.register_url, '_blank', 'noopener');
    }
  });
}

async function hydrateMoreEvents(event) {
  const track = document.querySelector('.more-events__track');
  if (!track || !event.organization_id) return;

  const { data } = await supabase.from('events_public').select('*')
    .eq('status', 'published')
    .eq('organization_id', event.organization_id)
    .neq('id', event.id)
    .order('starts_at', { ascending: true })
    .limit(8);

  if (!data?.length) return;

  const heading = document.querySelector('.more-events__title');
  if (heading) heading.textContent = `More Events from ${event.organizer || 'this organiser'}`;
  track.innerHTML = data.map(cardMarkup).join('');
}

/* ==========================================================================
   Profile (profile.html)
   ========================================================================== */

async function hydrateProfile() {
  if (!me) { location.replace('account.html?next=profile.html'); return; }

  const [profile, categories, interests, saves] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', me.id).maybeSingle(),
    supabase.from('categories').select('*').eq('is_active', true)
      .eq('group_name', 'topic').order('sort_order'),
    supabase.from('user_interests').select('category_id').eq('user_id', me.id),
    supabase.from('event_saves').select('event_id').eq('user_id', me.id)
  ]);

  const nameEl = document.querySelector('.profile-card__name');
  if (nameEl) nameEl.textContent = profile.data?.full_name || me.email;

  const photo = document.querySelector('.profile-card__photo');
  if (photo && profile.data?.avatar_url) {
    photo.classList.remove('profile-card__photo--empty');
    photo.innerHTML = `<img src="${esc(profile.data.avatar_url)}" alt="" />`;
  }

  // Interests: every topic chip, the user's own picks pre-selected. Clicking
  // one writes straight through, so there is no save button to forget.
  const chipRow = document.querySelector('.profile-card__interests');
  if (chipRow && categories.data?.length) {
    const mine = new Set((interests.data || []).map((i) => i.category_id));
    chipRow.innerHTML = categories.data.map((c) => `
      <button class="chip${mine.has(c.id) ? ' chip--selected' : ''}" type="button"
              data-interest="${esc(c.id)}">${esc(c.name)}</button>`).join('');

    chipRow.addEventListener('click', async (e) => {
      const chip = e.target.closest('[data-interest]');
      if (!chip) return;
      const id = chip.dataset.interest;
      const adding = !chip.classList.contains('chip--selected');
      chip.classList.toggle('chip--selected', adding);

      const { error } = adding
        ? await supabase.from('user_interests').insert({ user_id: me.id, category_id: id })
        : await supabase.from('user_interests').delete()
            .eq('user_id', me.id).eq('category_id', id);

      if (error) { chip.classList.toggle('chip--selected', !adding); toast('Could not save that'); }
    });
  }

  // Saved + upcoming events replace the placeholder fan.
  const fan = document.querySelector('.events-fan');
  const savedEventIds = (saves.data || []).map((s) => s.event_id);
  if (fan && savedEventIds.length) {
    savedIds = new Set(savedEventIds);
    const { data } = await supabase.from('events_public').select('*')
      .in('id', savedEventIds).eq('status', 'published')
      .order('starts_at', { ascending: true });
    if (data?.length) fan.innerHTML = data.map(cardMarkup).join('');
  } else if (fan) {
    fan.innerHTML = `<p class="event-grid__empty">
      Nothing saved yet — tap the heart on an event to keep it here.</p>`;
  }

  addSignOut();
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
