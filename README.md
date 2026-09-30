# BrokenVault - AllCaps

BrokenVault backs up a folder to a server, sending only the data the server does
not already have, continuing after an interruption, and restoring every finished
version exactly.

## Team

- Member 1: Adapa Srivatsav
- Member 2: Ramanuja Tiwari
- Member 3: Mohammed Shaibaan Khan
- Member 4: Ajay Teja

## Supported setup

- Operating system or Docker version: Windows 10/11 with PowerShell (developed and tested here). Linux and macOS should work but have not been tested. An optional Docker Compose setup is included for PostgreSQL only (see below); the backend and CLI are not containerised.
- Programming language and version: TypeScript on Node.js 20.3 or newer
- Required tools: Node.js with npm, and a PostgreSQL database reachable through `DATABASE_URL` (a local PostgreSQL works; during development we used a hosted Neon database)

## Install

From the repository root:

```text
cd backend
npm install
copy .env.example .env
npx prisma generate --config prisma7.config.ts
npx prisma migrate deploy --config prisma7.config.ts
cd ..

cd client
npm install
npm run build
npm link
cd ..

npm install
```

Edit `backend/.env` and set `DATABASE_URL` to your PostgreSQL database before the
`prisma` commands (use `cp` instead of `copy` on Linux/macOS). `npm link` makes the
`brokenvault` command available; the last `npm install` is for the test suite.

These exact steps have not yet been run from a fresh clone on a second machine.

### Optional: local PostgreSQL with Docker

To run PostgreSQL locally instead of a hosted database, start it from the repository
root (the compose file contains only PostgreSQL):

```text
docker compose up -d postgres
```

Then set this in `backend/.env`:

```text
DATABASE_URL="postgresql://brokenvault:brokenvault@localhost:5432/brokenvault"
```

Stop it with `docker compose down`. Data is kept in a named volume and survives this;
use `docker compose down -v` to delete it. Defaults can be overridden with a root `.env`
(see `.env.docker.example`).

## Start the complete system

The server is the only long-running program. The CLI runs per command.

```text
cd backend
npm run dev
```

It prints `Server is running on port 8000`. Use `PORT=<number>` to change the port.

## Commands

The server address defaults to `http://localhost:8000`. Use `-r <url>` to change it,
or run `brokenvault -r <url> init` once to save it.

### Back up a folder

```text
brokenvault backup C:\path\to\folder
```

Prints the number of folders and files, total folder bytes, chunks already on the
server, uploaded bytes, reused bytes and the snapshot (version) ID. Press Ctrl+C to
interrupt; run the same command again to continue the same upload.

### List completed versions

```text
brokenvault snapshots
```

### Restore a version

```text
brokenvault restore <snapshot-id> C:\path\to\empty-or-new-folder
```

A unique prefix of at least 4 characters of the ID is accepted. Restore only works
when the server runs on the same machine (see known limits).

### Verify stored data

```text
brokenvault verify
```

Checks every chunk used by completed versions and lists each missing or corrupted
chunk with every affected version and file path. It never repairs anything.

## Run tests

```text
npm test
```

This is the integration suite in `tests/`. It starts the real backend itself on a free
port and needs a working `backend/.env`. It adds snapshots to that database and never
deletes anything. It generates its own random data each run. It also runs the challenge
sample folders `brokenvault_sample_v1` and `brokenvault_sample_v2` when they sit in the
repository root (they are not committed). Client unit tests that use an in-memory mock
server run with `npm run test:client`.

## Demo steps

1. Back up version 1: `brokenvault backup <v1-folder>`
2. Back up version 2 and show reused and uploaded bytes: `brokenvault backup <v2-folder>`
3. Interrupt another upload with Ctrl+C, check that `brokenvault snapshots` does not list it, then stop and restart the server.
4. Continue with the same `brokenvault backup <folder>` command (it prints `Resuming unfinished upload`), then restore it with `brokenvault restore <id> <new-folder>`.
5. Change or remove one file in `backend/storage/chunks`, then run `brokenvault verify` and try `brokenvault restore` on an affected version.

## Known limits

- Restore only works when the CLI and the server run on the same machine. The server writes the restored files itself, so the CLI refuses non-local servers.
- If restore hits a missing or corrupted chunk it stops there. Files earlier in path order may already have been written. Damaged data is never written and nothing is repaired.
- Files are split into fixed 256 KiB chunks. An edit in place reuses almost everything, but inserting bytes near the start of a file changes every later chunk.
- A single file must be smaller than 2 GiB because the database stores sizes as 32-bit integers. The server also builds each restored file in memory.
- Names containing a backslash are rejected. Symbolic links and special files are skipped and reported.
- If a backup is interrupted after the manifest is uploaded but before it is committed, the client starts a new upload on the next run. Chunks already stored are not sent again.
- One backup at a time per folder. There is no login, and the restore endpoint writes to any path given by the caller, so run the server only on a trusted machine.
- The database is hosted PostgreSQL in our development setup. A judge needs their own PostgreSQL and a `DATABASE_URL`; `docker-compose.yml` (PostgreSQL 16 only) can provide one locally.
- The server does two database queries per uploaded chunk, so large backups are slow against a remote database. `verify` reads all stored chunk data.

## External and AI-assisted work

- Libraries and services used: Express, Prisma with `@prisma/adapter-pg`, `pg`, `dotenv`, TypeScript, tsx, `@types/node`, and PostgreSQL. The CLI and tests use only Node.js built-in modules (fs, crypto, http, fetch, node:test).
- AI tools used and what they helped with: Claude (Anthropic) helped write and review the CLI client, the manifest validation, the restore hash checks, the `/verify` endpoint, the batched manifest insert, the automated tests and these documents. The team ran and checked the results against the real backend.
