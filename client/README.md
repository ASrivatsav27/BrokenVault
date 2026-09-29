# BrokenVault CLI

Command-line client for the BrokenVault backup server. It scans a local folder,
splits files into chunks, hashes them with SHA-256, uploads only the chunks the
server does not already have, and commits the snapshot once everything is there.

Requires Node.js 20.3 or newer.

## Setup

```text
cd client
npm install
npm run build
npm link          # makes the `brokenvault` command available
```

Without linking: `npx tsx src/index.ts <command>` from the `client` folder
(relative paths then resolve against `client/`).

## Commands

```text
brokenvault [-r <server-url>] init
brokenvault [-r <server-url>] backup <folder>
brokenvault [-r <server-url>] snapshots
brokenvault [-r <server-url>] restore <snapshot-id> <output-folder>
brokenvault [-r <server-url>] verify
```

The server URL comes from `-r`, then `BROKENVAULT_REPOSITORY`, then the URL saved
by `init`, then `http://localhost:8000`.

- **init** checks the server responds like a BrokenVault server and saves the URL.
- **backup** scans, hashes, asks the server which chunks are missing, uploads
  only those (6 in parallel), then sends the manifest and commits.
- **snapshots** lists completed snapshots only. Unfinished uploads are hidden.
- **restore** asks the server to rebuild a snapshot into an empty or new folder.
  A unique prefix of at least 4 characters of the snapshot ID is accepted.
- **verify** asks the server to re-hash every chunk used by completed snapshots
  and lists every affected snapshot and file. Nothing is repaired.

## How it works

- Files are split into fixed 256 KiB chunks. Each chunk ID is the lowercase
  SHA-256 of its bytes. Empty files have no chunks.
- Memory use is bounded: one chunk buffer at a time, and only hashes and
  offsets are kept in memory.
- Symbolic links and special files are skipped and reported. Hidden files and
  `node_modules` are backed up. Unreadable files stop the backup with an error.
- "uploaded" counts bytes of chunks the server newly accepted. "reused" is
  total size minus uploaded, so it includes chunks stored by an earlier or
  interrupted run and duplicates inside the same backup.

## Interrupting and resuming

Press Ctrl+C during a backup. The snapshot stays unfinished and hidden. Run the
same `backup` command again: the client finds the saved upload session for that
folder and server, asks the server what is missing, and uploads only that.

The session is remembered in `~/.brokenvault/uploads.json` (override the folder
with `BROKENVAULT_HOME`). If the server no longer knows the upload, the client
starts a new one; chunks already stored are kept and not sent again.

## Tests

```text
npm test
npm run typecheck
```

The tests run the real client against an in-memory mock of the server API
(`test/helpers/mockServer.ts`). They check client behaviour, not the real
backend, so also run the manual steps against a real server.

## Known limits

- **restore only works when the server runs on the same machine.** The server
  writes the restored files itself, and the CLI refuses non-local servers.
- A restore that hits damaged data stops at the first bad chunk; files before it
  in path order may already be written.
- Files larger than 2,147,483,647 bytes are rejected (server size column).
- Names containing a backslash are rejected.
- One backup per folder at a time; no locking between concurrent runs.
- Fixed-size chunking: an insertion near the start of a file changes every
  later chunk.
