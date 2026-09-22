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

## Implemented endpoints

Everything below is fully implemented (controller + service + Prisma
persistence). Everything in [Domain modules still to build](#domain-modules-still-to-build)
is schema-only for now.

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

```json
// Request
{ "email": "player@example.com", "password": "supersecret1" }
```

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
  "role": "PLAYER",
  "premiumTier": "FREE",
  "createdAt": "2026-09-17T11:00:00.000Z",
  "updatedAt": "2026-09-17T11:00:00.000Z",
  "playerProfile": null
}
```

### `GET /health`

Unauthenticated liveness check: `{ "status": "ok" }`.

## Domain modules still to build

The Prisma schema (`prisma/schema.prisma`) already models the full domain,
but only Auth/Users have NestJS modules wired up so far. Next work session
should pick up from here, one feature module at a time:

- **Clubs** — `Club`, `Court` (listing, search by location/amenities)
- **Bookings** — `Booking` (court booking; overlap-prevention must be
  enforced in the service layer — Prisma has no exclusion-constraint support)
- **Partner requests** — `PartnerRequest`, `PartnerMatchCandidate`
- **Matches** — `Match`, `MatchSet` (recording/scoring)
- **Competitions** — `Competition`, `CompetitionParticipant`,
  `CompetitionRound`, `CompetitionMatch` (bracket progression via
  `CompetitionMatch.nextMatchId`; detailed scores reuse `Match`/`MatchSet`
  via `CompetitionMatch.linkedMatchId`)
- **Favorites** — `Favorite` (polymorphic target, validated in the service
  layer since `targetId` is not a DB-level foreign key)
- **Notifications** — `Notification`

## Scripts

```bash
npm run start:dev   # watch mode
npm run build        # nest build
npm run test          # unit tests (vitest)
npm run test:e2e      # e2e tests (vitest)
npm run lint           # oxlint
```
