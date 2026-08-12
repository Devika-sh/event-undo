# EventUndo Admin — setup

The dashboard is plain HTML/CSS/JS like the rest of the site (no build step) and
talks to Supabase directly from the browser.

## 1. Create the database

Supabase dashboard → your **event-undo** project → **SQL Editor** → New query →
paste all of [`supabase-schema.sql`](supabase-schema.sql) → **Run**.

That creates every table, the Row Level Security policies, the triggers, a
public `media` storage bucket, and seeds the filter chips and organisations that
were previously hardcoded into the pages. Re-running it is safe.

## 2. Add your keys

Supabase dashboard → **Project Settings → API**, then edit
[`supabase-config.js`](supabase-config.js):

```js
export const SUPABASE_URL      = 'https://xxxxxxxx.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOi…';
```

Use the **anon public** key. It is meant to ship in the browser — RLS is what
protects the data. Never put the `service_role` key in this file.

## 3. Create the first account

Open `admin-login.html` → "First time here? Create the owner account".

On an empty database the first account to sign up becomes the **admin**;
everyone after that is a plain user until an admin promotes them. If Supabase
email confirmation is on (Authentication → Providers → Email), confirm the
address before signing in.

## Roles

| Role | Can do |
|------|--------|
| **admin** | Everything: events, organisations, categories, volunteers, users, the public team roster, the featured event, the audit log. |
| **volunteer** | Add and edit events for **their own** organisation, and edit that organisation's public page. No people management. |
| **user** | The public site: save events, RSVP, pick interests. |

Roles are enforced in Postgres, not in the browser — the console's role checks
only decide what's worth showing.

## Adding a volunteer

Volunteers → **Add volunteer**.

- If the email already has an account, it is promoted on the spot.
- If it doesn't, Supabase emails a sign-in link. Once they've used it they show
  up under **Users**, and you promote them from the same dialog.

The browser only ever holds the anon key, and creating another person's auth
user needs the `service_role` key. If you want true one-step invites later, put
`supabase.auth.admin.inviteUserByEmail` behind an Edge Function so the service
key stays on the server.

## What the public pages now read from the database

`public-data.js` is loaded by every public page and hydrates it:

| Page | Reads |
|------|-------|
| `index.html` | Published events, the featured event, the filter chips |
| `organizations.html` | Active organisations |
| `team.html` | The `team_members` roster |
| `event-details.html?id=…` | One event, plus more from the same organisation |
| `profile.html` | The signed-in user's interests and saved events |

It is progressive enhancement: with no keys configured, or an empty table, each
page keeps the static markup it already shipped with — nothing is blanked out.

`account.html` is the public sign-in/sign-up page. While signed out, "Profile"
in the nav points there instead.

## Files

| File | What it is |
|------|------------|
| `supabase-schema.sql` | Tables, RLS, triggers, views, storage, seed data |
| `supabase-config.js` | Your project URL + anon key (the only file to edit) |
| `supabase-client.js` | Shared client, auth helpers, date/fee formatting |
| `admin-login.html` | Console sign-in |
| `admin.html` / `admin.js` / `admin.css` | The dashboard |
| `account.html` | Public sign-in / sign-up |
| `public-data.js` | Wires the public pages to the same data |

Design tokens come from `tokens.css` and shared components from `styles.css`,
same as every other page — `admin.css` only adds the shell, tables, forms and
modals the marketing pages never needed.
