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

export const SUPABASE_URL      = 'https://mrfryhrybznxkyftgqsm.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1yZnJ5aHJ5YnpueGt5ZnRncXNtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0MzcyNjksImV4cCI6MjEwMjAxMzI2OX0.sg2IgEdJ6fIAOVvL1TJlx8p5jOE_18NOQfr-gNdM_Lg';

/** False until the placeholders above are replaced. Public pages use this to
 *  fall back to their built-in static content instead of erroring. */
export const isConfigured =
  !SUPABASE_URL.includes('YOUR-PROJECT-REF') &&
  !SUPABASE_ANON_KEY.includes('YOUR-ANON');
