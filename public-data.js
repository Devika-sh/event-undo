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

/** Profile is the one door into an account, so the nav keeps pointing there
 *  whether or not there's a session — signed out, that page shows sign-in. */
function paintAccountLink() {
  if (me) return;
  document.querySelectorAll('a[href="profile.html"]').forEach((link) => {
    if (link.textContent.trim() === 'Profile') link.textContent = 'Sign in';
  });
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
      <img class="card__photo" src="${esc(event.banner_url || FALLBACK_IMAGE)}" alt=""
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
  const [members, interestRows] = await Promise.all([
    supabase.from('team_members').select('*, organizations(name)')
      .eq('is_active', true).order('sort_order').order('name'),
    supabase.from('team_member_interests').select('team_member_id, categories(name)')
  ]);
  if (members.error || !members.data?.length) return;

  const interestsByMember = (interestRows.data || []).reduce((acc, r) => {
    if (!r.categories?.name) return acc;
    (acc[r.team_member_id] ||= []).push(r.categories.name);
    return acc;
  }, {});

  // The static grid opens with a heading card; keep whatever isn't a person.
  const lead = grid.querySelector(':scope > :not(.profile-card)');
  const cards = members.data.map((m) => {
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

  grid.innerHTML = (lead ? lead.outerHTML : '') + cards;
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
  hydrateFriends(event);
}

/** Fetch failed / no id in the URL — clear every skeleton with a plain
 *  message instead of leaving the shimmer spinning forever. */
function clearEventSkeletons(message) {
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

  const [profile, categories, interests, saves] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', me.id).maybeSingle(),
    supabase.from('categories').select('*').eq('is_active', true)
      .eq('group_name', 'topic').order('sort_order'),
    supabase.from('user_interests').select('category_id').eq('user_id', me.id),
    supabase.from('event_saves').select('event_id').eq('user_id', me.id)
  ]);

  // The card shows the picks; the edit form is where they get changed.
  const topics = categories.data || [];
  const mine = new Set((interests.data || []).map((i) => i.category_id));

  paintProfileCard(profile.data);
  paintInterests(topics, mine);
  wireProfileEdit(profile.data, topics, mine);

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

function paintProfileCard(profile) {
  const nameEl = document.querySelector('.profile-card__name');
  if (nameEl) nameEl.textContent = profile?.full_name || me.email;

  const photo = document.querySelector('.profile-card__photo');
  if (photo && profile?.avatar_url) {
    photo.classList.remove('profile-card__photo--empty');
    photo.innerHTML = `<img src="${esc(profile.avatar_url)}" alt="" />`;
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

/* ---- Edit mode ----------------------------------------------------------- */

/** Elements the edit form stands in for. The photo deliberately stays put so
 *  the user can see what they're changing. */
const VIEW_PARTS = '.profile-card__name, .profile-card__socials, .profile-card__interests, .eu-signout';

/** Of those, the ones that are legitimately empty for a new user. */
const EMPTY_WHEN_UNSET = ['profile-card__socials', 'profile-card__interests'];

/** How many interests a user may pick. */
const MAX_INTERESTS = 5;

function wireProfileEdit(profile, topics, mine) {
  const toggle = document.querySelector('.edit-btn');
  const form = document.getElementById('profile-edit');
  if (!toggle || !form) return;

  const picker = document.getElementById('pe-interests');
  const counter = document.getElementById('pe-interests-count');

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

  const setEditing = (on) => {
    toggle.setAttribute('aria-pressed', String(on));
    toggle.setAttribute('aria-label', on ? 'Cancel editing' : 'Edit profile');
    form.hidden = !on;
    document.querySelectorAll(VIEW_PARTS).forEach((el) => {
      // Socials and interests render nothing until the user fills them in.
      // Those stay hidden on the way back out, so leaving edit mode doesn't
      // reopen an empty gap in the card.
      const emptyContainer = EMPTY_WHEN_UNSET.some((c) => el.classList.contains(c))
                             && !el.children.length;
      el.hidden = on || emptyContainer;
    });
  };

  const fill = () => {
    document.getElementById('pe-name').value = profile?.full_name || '';
    document.getElementById('pe-bio').value = profile?.bio || '';
    document.getElementById('pe-instagram').value = profile?.instagram_url || '';
    document.getElementById('pe-linkedin').value = profile?.linkedin_url || '';
    document.getElementById('pe-photo').value = '';
    buildPicker();   // rebuilt each time, so Cancel really does discard
    setFormError('profile-error', '');
  };

  toggle.addEventListener('click', () => {
    const opening = toggle.getAttribute('aria-pressed') !== 'true';
    if (opening) fill();
    setEditing(opening);
  });

  document.getElementById('pe-cancel').addEventListener('click', () => setEditing(false));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormError('profile-error', '');

    const save = document.getElementById('pe-save');
    save.disabled = true;
    save.textContent = 'Saving…';

    const payload = {
      full_name: document.getElementById('pe-name').value.trim() || null,
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
    paintProfileCard(profile);
    paintInterests(topics, mine);
    setEditing(false);
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
