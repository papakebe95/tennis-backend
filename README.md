<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

# Tennis Backend

API backend for a tennis app: club discovery, court booking, partner-finding,
match recording/scoring, and competitions with bracket progression. Built to
serve the [`flutter-quickstart-template`](../flutter-quickstart-template)
mobile client (a sibling project — this repo doesn't depend on it).

## Stack

- [NestJS](https://nestjs.com/) (TypeScript, strict mode, ESM/`nodenext`)
- [Prisma ORM](https://www.prisma.io/) + PostgreSQL
- JWT access/refresh authentication (`@nestjs/jwt`, `@nestjs/passport`, `passport-jwt`)
- `class-validator` / `class-transformer` for request validation

> **Prisma version note:** this project pins `prisma` / `@prisma/client` to
> `7.10.0`. Prisma 7's client uses a WASM query compiler with no bundled
> native engine, so `PrismaClient` is constructed with a database **driver
> adapter** (`@prisma/adapter-pg`, backed by `pg`) rather than reading
> `DATABASE_URL` directly — see `src/prisma/prisma.service.ts`. The Prisma
> CLI also now reads its config from `prisma.config.ts` (schema path,
> migrations path, datasource URL) instead of only `prisma/schema.prisma`.

## Getting started

```bash
npm install

# Start Postgres locally (requires Docker)
docker compose up -d

# Copy env vars if you haven't already (a working .env with placeholder
# JWT secrets is committed for local dev convenience)
cp .env.example .env   # then fill in real JWT secrets

# Apply the schema to your database and generate the Prisma Client
npx prisma migrate dev --name init

# Start the API in watch mode
npm run start:dev
```

The API listens on `http://localhost:3000` by default (`PORT` in `.env`).

### Environment variables

| Variable             | Description                                        |
| --------------------- | --------------------------------------------------- |
| `DATABASE_URL`        | Postgres connection string                          |
| `JWT_ACCESS_SECRET`   | Secret used to sign 15m access tokens                |
| `JWT_REFRESH_SECRET`  | Server-side pepper mixed into refresh token hashes   |
| `PORT`                | HTTP port (default `3000`)                           |
| `CORS_ORIGINS`        | Comma-separated browser origins allowed with credentials (the back-office). Unset: any origin, no cookies |
| `DEFAULT_CALLING_CODE`| Country code assumed for phone numbers typed without one at login (default `221`) |
| `TRUST_PROXY`         | `1` behind one reverse proxy (client IP for audit log and rate limiting) |

## Languages (i18n)

The API answers in English (`en`, the default) or French (`fr`), chosen per
request with a `lang` header (`lang: fr`; `fr-FR` also works). Anything
unsupported or missing falls back to English, and every response carries
`Content-Language`.

- **Errors and validation messages** are translated in the response `message`;
  the response shape is unchanged.
- **Notifications** are stored as a key plus facts (`messageKey`, `params`) and
  worded when read, so they follow the reader's current language. Rows without
  a key keep their stored English text.
- **Database content** (country/city names, product category labels, club and
  tournament descriptions, story titles/slides) keeps its English text in the
  plain columns and holds other languages in a `translations` JSON column:
  `{ "fr": { "label": "Raquettes" } }`. A missing translation falls back to
  the English column, field by field. Club `amenities` stay unchanged for
  matching; `amenityLabels` carries the display text.

To add a message, put the key in `src/i18n/locales/en.ts` and `fr.ts` (the
build fails if they differ) and use `t('errors.…')`. To add a language, add
it to `SUPPORTED_LANGS` and create its locale file.

## Back-office: accounts, roles and permissions

The Angular back-office lives in the sibling project
[`tennis-backoffice`](../tennis-backoffice); its architecture and roadmap are
in `tennis-backoffice/docs/ARCHITECTURE.md`.

- **Authorization is permission-based and scoped.** Permissions are defined in
  code (`src/authz/permissions.ts`) and synced to the `Permission` table at
  boot. Roles (`Role`) group permissions, and a user holds roles through
  `UserRole` grants that apply platform-wide, to one organization (federation,
  club, community) or to one competition. A user can hold any number of grants.
- **Endpoints declare what they need** with
  `@Authorize('court.manage', { resource: 'court', param: 'courtId' })`. The
  guard reads the resource's owner from the database, never from the request,
  so changing an id in a payload can't reach another club's data.
- **Account status** (`PENDING | ACTIVE | SUSPENDED | DISABLED | REJECTED`) is
  re-checked on every request. Changing the password ends every other session.
- Every club is an `Organization` of type `CLUB` (`Club.organizationId`).
- Important changes are written to `AuditLog` in the same transaction
  (`AuditService.record`).

### Development accounts

`npm run db:seed` creates one account per role. **All use the password
`Admin@2026!`. Development only: the seed refuses to run with
`NODE_ENV=production`.** Local numbers work at login (`77 000 00 01`).

| Account | Phone | Email | Access |
|---|---|---|---|
| Super Admin | +221770000001 | superadmin@tennis.dev | whole platform |
| Federation Admin | +221770000002 | federation@tennis.dev | Fédération Sénégalaise de Tennis |
| Club Admin | +221770000003 | clubadmin@tennis.dev | two clubs (ASAC, ASTU) |
| Tournament Organizer | +221770000004 | organizer@tennis.dev | may create tournaments; organizer of Dakar Open Amateur |
| Tournament Director | +221770000005 | director@tennis.dev | Teranga Cup |
| Official | +221770000006 | official@tennis.dev | Teranga Cup |
| Coach | +221770000007 | coach@tennis.dev | first club |
| Club Staff | +221770000008 | staff@tennis.dev | third club |
| Pending applicant | +221770000009 | pending@tennis.dev | awaiting validation |

The existing player accounts keep the password `password123`.

### First Super Admin in production

The seed never runs in production. Create the first Super Admin with:

```bash
SUPER_ADMIN_MSISDN=+221… SUPER_ADMIN_EMAIL=… SUPER_ADMIN_PASSWORD='…' \
SUPER_ADMIN_FIRSTNAME=… SUPER_ADMIN_LASTNAME=… npm run admin:create
```

An existing account with that phone number is promoted instead of being
created.

## Implemented endpoints

Everything below is fully implemented (controller + service + Prisma
persistence).

### `POST /auth/register`

Creates a user and returns an access/refresh token pair.

```json
// Request
{
  "email": "player@example.com",
  "password": "supersecret1",
  "firstname": "Ana",
  "lastname": "Ivanovic",
  "msisdn": "+15551234567"
}
```

```json
// Response 201
{
  "accessToken": "eyJhbGciOi...",
  "refreshToken": "cmg1x9f...q1.9f3b1c2a..."
}
```

### `POST /auth/login`

Sign in with a phone number (any common format; local numbers get
`DEFAULT_CALLING_CODE`) or an email as `identifier`. The older `email` field
is still accepted.

```json
// Request
{ "identifier": "77 123 45 67", "password": "supersecret1" }
```

Failures carry a machine `code` next to the localized `message`:
`INVALID_CREDENTIALS` (401), `ACCOUNT_SUSPENDED`, `ACCOUNT_DISABLED` and
`ACCOUNT_REJECTED` (403). `PENDING` accounts may sign in, but every endpoint
except `/auth/me`, `/auth/change-password` and `/auth/logout` answers
`403 ACCOUNT_PENDING`. Auth routes are rate-limited (login: 10/min per IP).

**Browser clients** send `X-Auth-Mode: cookie`. The refresh token is then set
as an httpOnly `SameSite=Strict` cookie and only `{ accessToken }` is
returned; `/auth/refresh-token` and `/auth/logout` read the cookie when the
body has no token.

```json
// Response 200
{ "accessToken": "eyJhbGciOi...", "refreshToken": "cmg1x9f...q1.9f3b1c2a..." }
```

### `POST /auth/refresh-token`

Validates and rotates a refresh token (the old one is revoked).

```json
// Request
{ "refreshToken": "cmg1x9f...q1.9f3b1c2a..." }
```

```json
// Response 200
{ "accessToken": "eyJhbGciOi...", "refreshToken": "cmg2y0g...r2.a4c2d3b1..." }
```

### `POST /auth/logout`

Requires `Authorization: Bearer <accessToken>`. Revokes the presented refresh
token.

```json
// Request
{ "refreshToken": "cmg2y0g...r2.a4c2d3b1..." }
```

Response: `200 OK`, empty body.

### `GET /auth/me`

The signed-in user and every active grant (role, scope, organization or
competition, permissions). The back-office builds its menus from this; the
API still checks each call.

### `POST /auth/change-password`

`{ "currentPassword": "…", "newPassword": "…" }`. The new password needs 10+
characters with upper and lower case letters, a digit and a symbol. It
revokes every refresh token and every older access token (`User.tokenVersion`),
then returns a fresh token pair for the current session.

### Back-office administration API

All under `Authorization: Bearer`, each endpoint checking one permission
(Swagger at `/docs` lists them). Lists take `?page&pageSize&q&sort=field:dir`
and return `{ items, total, page, pageSize }`.

| Area | Endpoints | Permission |
|---|---|---|
| Users | `GET /admin/users`, `GET /admin/users/:id`, `PATCH /admin/users/:id/status`, `POST /admin/users/:id/reset-password` | `user.view`, `user.status.manage`, `user.password.reset` |
| Role grants | `POST /admin/users/:id/roles`, `DELETE /admin/users/:id/roles/:grantId` | `user.roles.assign` *where the grant applies* |
| Roles | `GET/POST /admin/roles`, `PATCH/DELETE /admin/roles/:id`, `PUT /admin/roles/:id/permissions`, `GET /admin/permissions` | `role.view`, `role.manage` |
| Access requests | `GET /admin/access-requests`, `GET …/:id`, `POST …/:id/approve \| reject \| request-info` | `access_request.review` |
| Dashboard | `GET /admin/dashboard` | `dashboard.global.view` |
| Audit log | `GET /admin/audit-logs`, `GET /admin/audit-logs/facets` | `audit.view` (rows limited to the caller's scopes) |
| Pickers | `GET /admin/lookups/organizations`, `GET /admin/lookups/competitions` | `user.roles.assign` |

Rules enforced server-side:

- An administrator can't grant a role carrying permissions they don't hold there.
- They can't act on an account with more rights than their own, or on their own account.
- The platform always keeps one active Super Admin.
- Resetting a password returns a one-time temporary password. The account must change it before doing anything else (`403 PASSWORD_CHANGE_REQUIRED`).

### Organizations, clubs and courts

| Area | Endpoints | Permission |
|---|---|---|
| Organizations (platform) | `GET/POST /admin/organizations`, `GET /admin/organizations/:id`, `PATCH /admin/organizations/:id/status` | `organization.view`, `organization.create`, `organization.manage` |
| Federation space | `GET/PATCH /admin/federations/:id`, `GET/POST /admin/federations/:id/clubs`, `POST /admin/federations/:id/affiliations/:affiliationId/approve \| suspend \| end` | `federation.view`, `federation.update`, `federation.clubs.view`, `federation.clubs.validate` (on that federation) |
| Club space | `GET/PATCH /admin/clubs/:id`, `POST /admin/clubs/:id/affiliations`, `GET/POST /admin/clubs/:id/courts` | `club.view`, `club.update`, `court.view`, `court.manage` (on that club) |
| Courts | `PATCH /admin/courts/:courtId`, `PATCH …/status`, `POST …/archive \| restore`, `PUT …/availability` | `court.manage` (on the court's club) |

- **Suspended or archived organizations** disappear from the player API. Their administrators' grants stop working until the organization is reactivated.
- **Affiliations:** a club asks to join (`PENDING`); the federation approves, suspends or ends it. Every change is recorded in both organizations' audit logs.
- **Opening hours** are stored as `Club.openingHours = { mon: ["07:00-12:00", "14:00-22:00"], …, sun: [] }` (UTC).
  - A court can override them with `CourtAvailability` rows.
  - Without either, a court is open 08:00–22:00.
  - Player availability (`GET /courts/:id/availability`) and bookings follow these hours.
  - Courts under `MAINTENANCE`, `DISABLED` or archived can't be booked.
- **Courts are archived, never deleted.** Bookings reference them with `ON DELETE RESTRICT`, so history is kept.
- **Club descriptions are edited per language:** a French request (`lang: fr`) updates the French translation and leaves the English column unchanged.

### Members, payments and club bookings

| Area | Endpoints | Permission (on the club) |
|---|---|---|
| Plans | `GET/POST /admin/clubs/:id/membership-plans`, `PATCH /admin/membership-plans/:planId` | `member.view`, `membership.plan.manage` |
| Members | `GET /admin/clubs/:id/members` (`?format=csv`), `GET /admin/clubs/:id/member-candidates?q=`, `POST /admin/clubs/:id/members`, `GET/PATCH /admin/members/:memberId`, `PATCH …/status`, `POST …/renew` | `member.view`, `member.manage` |
| Payments | `GET /admin/payments` (scoped; `?organizationId`, `?format=csv`), `GET /admin/payments/methods`, `POST /admin/clubs/:id/payments`, `POST /admin/payments/:paymentId/refund` | `payment.view`, `payment.record`, `payment.refund` |
| Bookings | `GET /admin/clubs/:id/bookings`, `POST /admin/bookings/:bookingId/cancel` | `booking.view`, `booking.manage` |
| Dashboards | `GET /admin/clubs/:id/dashboard`, `GET /admin/federations/:id/players` | `club.dashboard.view`, `federation.players.view` |

- **Members:** a `ClubMember` (one per person per club, with a stable number) has membership periods (`Membership`), one per join or renewal. Each period records the price agreed at the time.
- **Payment status** is derived from the current period:
  - `EXPIRED`: the period has ended
  - `PAID`: fully paid
  - `OVERDUE`: not fully paid, and started more than 30 days ago
  - `PARTIALLY_PAID`: something paid, within the 30 days
  - `PENDING`: nothing paid yet, within the 30 days

  `Membership.amountPaid` and `fullyPaid` are recomputed from PAID payments in the same transaction as each payment or refund, so the member list can filter on them.
- **Payments** belong to an organization and are linked to what they pay for (membership period or booking). The API checks that the target belongs to the club and refuses to take more than what remains due; the period row is locked while it checks. Refunds keep the payment row (`REFUNDED`).
- **Payment methods** live in the `PaymentMethod` table: cash, Wave, Orange Money, Free Money, card, bank transfer. Online providers plug in later through `provider`.
- **Adding a member** needs an existing player account. Club staff search by phone or name and see masked phone numbers.

### Tournaments, tables and entries

| Area | Endpoints | Permission (on the tournament or its host) |
|---|---|---|
| Tournaments | `GET /admin/tournaments` (scoped), `GET /admin/tournaments/host-options`, `POST /admin/tournaments`, `GET/PATCH/DELETE /admin/tournaments/:id` | `tournament.view`, `tournament.create`, `tournament.update`, `tournament.delete` |
| Lifecycle | `POST /admin/tournaments/:id/transitions {to, reason}`, `POST …/interrupt`, `POST …/resume` | `tournament.lifecycle.manage`, `tournament.interrupt` |
| Tables | `POST /admin/tournaments/:id/events`, `PATCH/DELETE /admin/events/:eventId` | `tournament.update` |
| Entries | `GET /admin/events/:eventId/registrations`, `GET …/entry-candidates?q=`, `GET …/qualifier-sources`, `POST …/registrations`, `POST /admin/registrations/:id/{approve,reject,waitlist,withdraw}`, `PATCH …/seed` | `registration.view`, `registration.manage` |
| Team | `GET /admin/tournaments/:id/staff`, `GET …/staff-candidates?q=`, `POST …/staff`, `DELETE …/staff/:grantId` | `tournament.view`, `tournament.staff.manage` |
| Sport profile | `GET /admin/classifications`, `PATCH /admin/players/:userId/sport-profile` | signed in, `player.sport_profile.manage` |

- **Lifecycle** (`src/admin/tournaments/tournament-lifecycle.ts`):
  - `DRAFT → REGISTRATION_OPEN ⇄ REGISTRATION_CLOSED → IN_PROGRESS → COMPLETED`; `CANCELLED` from any open state, reason required.
  - Opening registration needs at least one table and consistent dates. Starting needs every table's draw published (Phase 6). Completing needs every match finished.
  - `INTERRUPTED` is entered and left with interrupt/resume, which keep a history and can notify entrants.
- **Player app compatibility:** drafts and private tournaments are hidden. `status` stays `UPCOMING | ONGOING | COMPLETED`, derived from the lifecycle, with `cancelled` / `interrupted` flags. Registering from the app puts the player in the first singles table they are eligible for, as a `PENDING` entry.
- **Tables (events):** each has its own eligibility (category, age, classification window), places, entry fee and match rules.
  - Successive tables: a table can send `qualifierCount` players into a later table (`qualifiesIntoEventId`). Loops and backward links are refused (`TABLES_INVALID`).
  - Creating a tournament can create its tables at once; tables refer to each other through client `ref`s.
- **Eligibility** is checked by the API against the player's sport profile (classification, gender, birth date).
  - Classification uses the national scale (`Classification`, seeded by the migration); unclassified players count as NC. Age is the age reached during the tournament's year.
  - Qualifiers, lucky losers and wildcards may be below a table's floor.
  - Accepting an ineligible entry needs an override reason, which is stored with the entry and in the audit log.
  - Capacity and seeds are checked under a row lock on the table.
- **Hosting:** creating a tournament for an organization needs both `tournament.create` and `tournament.update` there. An independent organizer (global `tournament.create` only) can't put a club's name on a tournament. The creator gets `COMPETITION_ORGANIZER` on it when they couldn't run it otherwise.

### Draws

| Endpoints (`:id` = table) | Permission |
|---|---|
| `GET /admin/events/:id/draw` | `draw.view` |
| `GET …/draw/candidates`, `POST …/draw/generate`, `POST …/draw/reset`, `POST …/draw/swap {a, b, version}` | `draw.manage` |
| `POST …/draw/publish`, `POST …/draw/lock` | `draw.publish` |
| `POST …/draw/slots/:position/fill`, `POST …/draw/slots/:position/replace` | `draw.manage`, plus `draw.modify_locked` and a reason on a locked draw |
| `GET /competitions/:id/draws` (player app) | signed in; published and locked draws only |

- **Engine** (`src/admin/tournaments/draw-engine.ts`, pure and unit-tested):
  - Single elimination, sizes 2–128 (next power of two, or bigger on request).
  - Seeds go on the standard lines: 1 at the top, 2 at the bottom, 3–4 then 5–8… drawn by lot inside their lines. Byes go opposite the best seeds first.
  - Reserved places are drawn like unseeded players, never opposite a bye.
  - Every generation stores a random `drawSeed`, so the draw can be replayed and checked.
- **Places** (`DrawSlot`): `ENTRY`, `BYE`, `QUALIFIER` (labelled Q1, Q2…, with the lower table they come from) or `EMPTY`. By default a draw reserves one Q place per qualifier the lower tables still have to send.
- **States:**
  - `DRAFT`: draw again, swap places, reset.
  - `PUBLISHED`: players see it (and are notified); swaps still allowed.
  - `LOCKED`: set when the tournament starts (or by hand). Only filling places and replacing players, with `draw.modify_locked` and a reason.
  - Swaps carry the `drawVersion` the screen showed; a stale one gets `409 DRAW_VERSION_CONFLICT`.
- **Filling a place** puts an accepted entry, a pending one (accepted on the way), or a player from a lower table (entered as `QUALIFIER`) on a reserved place. Eligibility and overrides work as for entries.
- **Replacing a player** is allowed until their next match starts. The player leaves as `WITHDRAWN` with the reason, and the player, the newcomer and the opponent are notified. Someone who hasn't played yet is replaced on the draw itself. Someone who already won a match is replaced only in the match they're due to play.
- A placed entry can't be withdrawn or waitlisted from the entries screen (`ENTRY_IN_DRAW`): it leaves through a replacement.

### Matches, results and scheduling

| Endpoints | Permission (on the match's tournament or its host) |
|---|---|
| `GET /admin/matches` (scoped; `?competitionId&eventId&status&resultStatus&courtId&date&mine&q`), `GET /admin/matches/:id` | `match.view` |
| `PATCH/DELETE /admin/matches/:id/schedule {scheduledAt, courtId}`, `PATCH …/official` | `match.schedule` |
| `POST …/start`, `POST …/result {outcome, sets, loserSide, version, reason?}` | `match.result.enter` |
| `POST …/result/validate` | `match.result.validate` |
| `POST …/result/dispute`, `POST …/postpone` | `match.status.manage` |
| `GET /admin/tournaments/:id/schedule?date=`, `GET …/officials`, `GET/PUT …/courts` | `match.view`, `match.schedule`, `tournament.view` / `tournament.update` |

- **Scores** (`src/admin/tournaments/tennis-score.ts`, pure and unit-tested):
  - Sets to `gamesPerSet` by two, 7-5, or 7-6 with the tiebreak points (first to 7, by two).
  - The deciding set follows the table's rule: normal tiebreak, match tiebreak to 10 (stored as a 1-0 set), or advantage set.
  - No set after the match is decided.
  - A retirement keeps the score so far (the last set may be unfinished); a walkover has no score.
- **Workflow:**
  - A result entered by an official waits for validation (`ENTERED`). One entered by someone holding `match.result.validate` is validated at once.
  - Validation completes the match and moves the winner into `nextMatch` (side `nextSlot`); the next match becomes READY or SCHEDULED.
  - Correcting a validated result needs a reason and is refused once the winner's next match has started.
  - A dispute keeps the result (and the winner through) until validated again or corrected.
  - Result forms send the match `version`; a stale one gets `409 MATCH_VERSION_CONFLICT`.
- **Player history:** a validated singles result also writes a linked `Match` (type OFFICIAL, with its sets) for the players' history and season ranking. Walkovers don't.
- **Officials:** grants carrying `match.assigned_only` (the Official role) only see, start and score the matches they are assigned to.
- **Scheduling:**
  - A match can go on one of the tournament's courts (`CompetitionCourt`, else the venue club's courts), inside the court's opening hours, for the table's expected match length.
  - It is refused (`409 SCHEDULE_CONFLICT` with the conflicts) when the court is taken by another match, of any tournament, or by a booking, or when a player is already on court then.
  - Player bookings and court availability, in turn, treat scheduled tournament matches as taken.
- Completing a tournament needs every match finished (postponed ones count as unfinished).

### Access requests (sign-up for administrators and organizers)

- `GET /access-requests/options` (public): profiles offered at sign-up, plus countries and cities.
- `GET /access-requests/organizations?type=CLUB&q=` (public): organizations an applicant can claim.
- `POST /auth/register-applicant`: creates a PENDING account and its request together, and signs it in.
- `POST /access-requests`, `GET /access-requests/mine`, `PATCH /access-requests/:id/respond` and `POST /access-requests/:id/cancel`: for signed-in and pending users.

Approving a request creates the proposed organization if there is one, grants the role and activates the account, all in one transaction.

### API documentation

Swagger UI is served at `/docs` outside production (or with `API_DOCS=true`).

### `GET /users/me`

Requires `Authorization: Bearer <accessToken>`. Returns the authenticated
user (password hash stripped) joined with their `PlayerProfile`, if any.

```json
// Response 200
{
  "id": "cmg1abc...",
  "email": "player@example.com",
  "firstname": "Ana",
  "lastname": "Ivanovic",
  "msisdn": "+15551234567",
  "premiumTier": "FREE",
  "createdAt": "2026-09-17T11:00:00.000Z",
  "updatedAt": "2026-09-17T11:00:00.000Z",
  "playerProfile": null
}
```

### `GET /health`

Unauthenticated liveness check: `{ "status": "ok" }`.

## Roadmap

Player-facing modules (clubs, courts, bookings, matches, competitions,
notifications, marketplace, stories) are implemented; the endpoint list above
covers auth only. The back-office (`/admin/*`) is being built in phases —
see `../tennis-backoffice/docs/ARCHITECTURE.md` (Part 7).

## Scripts

```bash
npm run start:dev   # watch mode
npm run build        # nest build
npm run test          # unit tests (vitest)
npm run test:e2e      # e2e tests (vitest)
npm run lint           # oxlint
npm run db:seed        # dev data + back-office accounts
npm run admin:create   # bootstrap a Super Admin (see above)
```
