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
