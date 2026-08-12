<div align="center">

<img src="Assets/eventundo-logo.svg" alt="eventundo" width="240" />

<br /><br />

**Discover, RSVP, and manage college events — one platform for students, clubs, and organisers.**

[![Frontend](https://img.shields.io/badge/Frontend-HTML%20%C2%B7%20CSS%20%C2%B7%20JavaScript-FF4800?style=for-the-badge)](.)
[![Backend](https://img.shields.io/badge/Backend-Supabase-FF4800?style=for-the-badge)](.)
[![Status](https://img.shields.io/badge/Status-Active-FF4800?style=for-the-badge)](.)

</div>

<br />

<img src="Assets/eventundo-fallback.png" width="100%" alt="" />

## About

**eventundo** is a college event-discovery and management platform. Students browse and save
events, RSVP, and follow the organisations they care about; volunteers and admins run everything —
events, organisations, categories, and their own accounts — from a dedicated dashboard, all backed
by the same Supabase project with Row Level Security enforcing who can do what.

It's a static, no-build site (plain HTML/CSS/vanilla JS ES modules) talking directly to Postgres —
no server layer to deploy or maintain.

<br />

## Features

### Discover, for everyone

- Searchable, filterable **Discover** feed of published events, sorted newest-first
- Save events to a personal fan of upcoming/saved events, and RSVP yes/no
- **Organisations** and **The Team** pages, live from the database, with category/type filter chips
- Category tags drive both event filtering and a user's personal interests
- Event detail pages with date/time/venue/fee, an organiser's other events, and a "friends attending"
  strip pulled from real RSVPs
- A profile you actually own: name, department, semester, favourite organisation, profile photo,
  bio, Instagram/LinkedIn, and up to five interest tags — edited from a pop-up on the public site
  *or* from the dashboard, since both write to the same row

### The Admin Dashboard

- Dedicated, role-gated console (`admin.html`) — Postgres Row Level Security is the real
  authorization boundary, not just hidden UI
- Full event lifecycle: create, edit, publish / draft / cancel, feature on the Discover hero, tag
  with categories, set capacity, fee and registration link
- A segmented **Day / Month / Year** date picker and a custom dropdown listbox (checkmark on the
  selected row, brand-gradient highlight) replace every native form control across the console
- **Volunteers are scoped to their own organisation** — they can only create or edit events that
  belong to it, enforced in both the UI and the database
- Organisation management: create orgs, upload a logo, free-type new organisation *types* that
  instantly show up as filter chips on the public Organisations page
- Category management, grouped by kind (mode / timing / organiser / topic)
- People management: invite or promote volunteers and admins, assign their organisation/club tag,
  suspend or remove accounts, browse the public Users list
- Registrations view with a per-event RSVP breakdown and CSV export
- Site roster management for **The Team** page, with interests and an organisation highlight
- A full activity log — every dashboard action, audited
- **Settings**, open to admins and volunteers alike, for editing their *own* personal profile —
  the same fields, the same row, the same edit the public Profile page makes
- A one-click switch between the public Profile page and the Admin Dashboard for staff accounts

### Design system

- `tokens.css` mirrors the **EU Design System** Figma library — colour, type, spacing, radius — one
  source of truth every page and component reads from, no hardcoded values
- Brand-orange gradients, pill-shaped controls, and a single typeface (Google Sans Flex) across
  every screen
- Shared components — file dropzone, custom dropdown, event card — built once and reused rather
  than re-implemented per page

<br />

## Tech stack

| Layer          | Technology                                                       |
| -------------- | ----------------------------------------------------------------- |
| Frontend       | Static HTML, CSS and vanilla JavaScript (ES modules) — no build step |
| Backend        | [Supabase](https://supabase.com) — Postgres, Auth, Storage, Row Level Security |
| Typeface       | Google Sans Flex                                                  |
| Design system  | EU Design System (Figma), mirrored in `tokens.css`                |

<br />

## Getting started

1. Create a [Supabase](https://supabase.com) project and run `supabase-schema.sql` in its SQL editor.
2. Copy your project's URL and anon public key into `supabase-config.js`.
3. Serve the folder with any static file server and open `index.html`.
4. Create an account through the public sign-up flow — the **first** account created becomes the
   admin. Full walkthrough in [`ADMIN-SETUP.md`](ADMIN-SETUP.md).

<br />

## Project structure

```
index.html            Discover — the event feed and Discover hero
organizations.html     Organisations directory
team.html               The Team roster
event-details.html      Single event page
profile.html             Signed-in user profile + edit pop-up
admin.html / admin.js    Admin & volunteer dashboard
admin-login.html         Dashboard sign-in

public-data.js          Hydrates every public page from Supabase
supabase-client.js       Shared Supabase client + helpers
dropdown.js               Custom listbox dropdown component
dropzone.js                 Shared drag-and-drop file upload component

tokens.css                Design tokens — colour, type, spacing, radius
styles.css                  Shared styles used across every page
supabase-schema.sql          Full database schema, RLS policies, seed data
```

<br />

---

<div align="center">

### Built by

**Agnivesh P S**  ·  **Devika S H**  ·  **Sabareesh P R**

*under the supervision of*

**PIT Solutions Ltd., Technopark, Trivandrum**

</div>
