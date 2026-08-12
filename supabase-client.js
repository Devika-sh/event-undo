/* ==========================================================================
   EventUndo — shared Supabase client + helpers
   Imported by both the admin dashboard and the public pages, so formatting
   (dates, fees, tags) is identical on either side of the product.
   ========================================================================== */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } from './supabase-config.js';

export { isConfigured };

export const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'eventundo-auth' }
    })
  : null;

/* ---------- auth ---------------------------------------------------------- */

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

/** The signed-in user's profile row (role, org, status), or null. */
export async function getProfile() {
  const session = await getSession();
  if (!session) return null;
  // profiles has two FKs into organizations (organization_id for staff
  // affiliation, favorite_organization_id for a user's own pick) — hint
  // which one this embed follows, or PostgREST can't resolve it.
  const { data, error } = await supabase
    .from('profiles')
    .select('*, organizations!organization_id(id, name, slug)')
    .eq('id', session.user.id)
    .maybeSingle();
  if (error) { console.warn('[eventundo] profile load failed:', error.message); return null; }
  return data;
}

export const isAdmin = (profile) => profile?.role === 'admin';
export const isStaff = (profile) => profile?.role === 'admin' || profile?.role === 'volunteer';

export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}

/** Writes an audit-trail row. Failures are swallowed — logging must never
 *  block the action the user actually asked for. */
export async function logActivity(action, entityType, entityId, summary) {
  if (!supabase) return;
  const session = await getSession();
  if (!session) return;
  await supabase.from('activity_log').insert({
    actor_id: session.user.id,
    actor_email: session.user.email,
    action, entity_type: entityType,
    entity_id: entityId ? String(entityId) : null,
    summary
  }).then(null, () => {});
}

/* ---------- formatting ---------------------------------------------------- */

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

function ordinal(n) {
  if (n > 3 && n < 21) return n + 'th';
  return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
}

/** "19th July 2026" — the format the event cards already use. */
export function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${ordinal(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "5:30 PM" */
export function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${suffix}`;
}

/** "Free" or "₹99" */
export function formatFee(amount, currency = 'INR') {
  const n = Number(amount);
  if (!n) return 'Free';
  const symbol = currency === 'INR' ? '₹' : currency + ' ';
  return symbol + (Number.isInteger(n) ? n : n.toFixed(2));
}

/** Short "12 Aug, 5:30 PM" used in dashboard tables. */
export function formatShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}, ${formatTime(iso)}`;
}

export function slugify(text) {
  return String(text).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Escapes anything that came out of the database before it goes into
 *  innerHTML. Every render path in the dashboard goes through this. */
export function esc(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2)
    .map((w) => w[0]).join('').toUpperCase();
}

/* ---------- local cache -----------------------------------------------
   Stale-while-revalidate for the read-only public pages: render whatever's
   cached instantly (no spinner needed), then let the live Supabase fetch
   replace it in the background. Namespaced and versioned so a schema/shape
   change on our end can't hand old code a cache it doesn't understand. */
const CACHE_VERSION = 'v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // stale after a day; still usable, just not trusted for long

export function cacheGet(key) {
  try {
    const raw = localStorage.getItem(`eventundo:${CACHE_VERSION}:${key}`);
    if (!raw) return null;
    const { data, savedAt } = JSON.parse(raw);
    if (Date.now() - savedAt > CACHE_TTL_MS) return null;
    return data;
  } catch { return null; }
}

export function cacheSet(key, data) {
  try {
    localStorage.setItem(`eventundo:${CACHE_VERSION}:${key}`, JSON.stringify({ data, savedAt: Date.now() }));
  } catch { /* private mode / quota — cache is a nicety, not a requirement */ }
}

/** Derives the timing bucket a filter chip like "Upcoming" matches. */
export function timingOf(event) {
  const now = Date.now();
  const start = new Date(event.starts_at).getTime();
  const end = event.ends_at ? new Date(event.ends_at).getTime() : start + 3 * 3600 * 1000;
  if (now < start) return 'upcoming';
  if (now > end) return 'past';
  return 'ongoing';
}
