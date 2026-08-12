/* ==========================================================================
   EventUndo — Supabase connection
   --------------------------------------------------------------------------
   Fill these two values in from your Supabase project:
     Dashboard → Project Settings → API
       • Project URL   → SUPABASE_URL
       • anon / public → SUPABASE_ANON_KEY

   The anon key is designed to ship in the browser — every table is protected
   by the Row Level Security policies in supabase-schema.sql, so it grants
   nothing beyond what the signed-in user is allowed to do. Never put the
   *service_role* key here.
   ========================================================================== */

export const SUPABASE_URL      = 'https://YOUR-PROJECT-REF.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';

/** False until the placeholders above are replaced. Public pages use this to
 *  fall back to their built-in static content instead of erroring. */
export const isConfigured =
  !SUPABASE_URL.includes('YOUR-PROJECT-REF') &&
  !SUPABASE_ANON_KEY.includes('YOUR-ANON');
