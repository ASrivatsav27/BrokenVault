# Architecture Note

Keep this note short. One or two pages is enough.

## Main parts

- **What does the client do?** The `brokenvault` CLI (TypeScript, Node.js) scans the folder, splits each file into chunks, hashes them, builds a manifest, asks the server which chunks it lacks, uploads only those, then sends the manifest and asks the server to commit. It also runs `snapshots`, `restore` and `verify`, which are thin calls to the server. It keeps two small JSON files in `~/.brokenvault` (or `BROKENVAULT_HOME`): `config.json` (server URL) and `uploads.json` (unfinished-upload state).
- **What does the server do?** An Express app that exposes the HTTP API: create upload, check chunks, store a chunk, store the manifest, commit, list versions, restore and verify. It re-hashes every incoming chunk, validates manifests, decides when a version is complete, and performs restore and verify itself.
- **Where is stored data kept?** Two places. Metadata is in PostgreSQL through Prisma (`Version`, `Upload`, `Chunk`, `ManifestEntry`, `ManifestChunk`). Chunk bytes are plain files at `storage/chunks/<sha256>` on the server's disk, relative to the directory the server is started from (`backend/`).

## File list and chunks

- **What information is recorded for a saved version?** A `Version` row (id, status, creation time) and one `ManifestEntry` per file or directory: relative path (always `/` separators), type, size and modification time. Each file entry has an ordered list of chunk IDs (`ManifestChunk` with a `position`). Empty files have no chunks; empty directories are recorded. Permissions, owners and symbolic links are not recorded (symlinks are skipped and reported).
- **How are files split?** Fixed-size 256 KiB chunks (`CHUNK_SIZE`); the last chunk of a file is shorter. Items are sorted by path before hashing.
- **How are chunk IDs calculated?** The chunk ID is the lowercase hex SHA-256 of the chunk's bytes.
- **How does the server avoid storing the same chunk twice?** `Chunk.id` is the primary key, so one chunk ID exists once. The client first sends all unique hashes to `POST /chunks/check` and uploads only the missing ones. On `PUT /chunks/:hash` the server recomputes the hash (mismatch is a 400), and if the ID already exists it answers `already_exists` without writing. Files and versions that share a chunk simply point to the same `Chunk` row.

## Safe completion

- **How is an unfinished upload represented?** `POST /uploads` creates a `Version` and an `Upload`, both with status `unfinished`. Uploaded chunks are not tied to any version yet; the manifest rows are attached to the version only when the manifest is accepted.
- **What prevents an unfinished version from appearing as complete?** Only `commit` changes the status, and it sets `Upload` and `Version` to `completed` together in one database transaction. Before that it checks that every chunk referenced by the manifest exists in the `Chunk` table; otherwise it answers 409 and nothing changes. `snapshots`, `restore` and `verify` only look at `completed` versions. The manifest itself is inserted in one transaction, after checking paths, sizes, chunk ID format, that every referenced chunk exists, and that chunk sizes add up to the file size.

## Continue after a stop

- **How does the client identify the same unfinished upload?** The server keeps no per-client lookup. The client stores `uploadId`, `versionId`, a manifest fingerprint and a "manifest uploaded" flag in `uploads.json`, keyed by server URL plus the resolved source folder path. On the next run it reuses that upload unless the manifest was already uploaded and the new fingerprint (SHA-256 of the manifest entries) differs, meaning the folder changed; then it starts a new upload.
- **How does it learn which chunks are still missing?** It rescans and rehashes the folder every run and calls `POST /chunks/check` with all unique hashes. The server returns `existing` and `missing`, and the client uploads only `missing`.
- **What happens when a request is repeated?** Chunk check is read-only. Repeating a chunk PUT returns `already_exists`. Repeating commit on a completed upload returns success. Network errors and 5xx responses are retried up to 3 times with backoff for check, chunk PUT, commit and list. If a resumed upload can no longer be finished (400/404/409/500), the client starts a fresh upload and reuses the stored chunks. If the server reports the version is already completed, the client accepts it as done. Creating an upload is not idempotent: each call makes a new one.

## Restore and verification

- **How are files rebuilt in the correct order?** The server loads the version's entries ordered by path and each file's chunks ordered by `position`, reads the chunk files in that order, concatenates them, checks the total against the recorded size, writes the file and sets its modification time. Directories are created and their times set. Entry paths are checked to stay inside the output folder.
- **When are hashes checked?** Client: each chunk is re-read and re-hashed just before upload. Server: on every chunk upload, on every chunk read during restore, and on every stored chunk during `verify`. Commit and manifest upload check that chunk records exist, not the bytes on disk. There is no whole-file hash; file integrity comes from the chunk hashes plus the size check.
- **How are affected versions and paths reported after damage?** `verify` reads every chunk used by completed versions and reports each missing or corrupted chunk with the affected versions and sorted file paths; the CLI groups this by snapshot and file, exits with an error, and repairs nothing. `restore` stops at the first bad chunk with a 409 naming the code (`chunk_missing` or `chunk_corrupted`), version, file path and chunk ID (plus expected and actual hash when corrupted). Damaged data is never written.

## Important choices and limits

- **Chunking:** fixed-size chunks are simple and reuse in-place edits well, but inserting bytes near the start of a file changes every later chunk. Changing `CHUNK_SIZE` would stop matching older chunks.
- **Storage split:** metadata in PostgreSQL, bytes in local files. Simple and inspectable, but the server disk is a single copy with no redundancy, and nothing deletes unused chunks or abandoned unfinished versions.
- **Resume state is client-side:** losing `uploads.json` means a new upload session (chunks are still reused). The client rehashes the whole folder on each run.
- **Restore** is done by the server, so the CLI only allows a local server; restore stops at the first damaged chunk, and earlier files may already be written. Each file is built in memory. Directory modification times are set before their files are written, so they likely do not survive restore.
- **Size limits:** a file must be under 2 GiB (32-bit size column), a chunk request under 2 MB, and the whole manifest is one JSON request limited to 50 MB.
- **Weak spots:** commit does not require a manifest to exist. A chunk file is written before its database row, and two simultaneous uploads of the same new chunk can make the second fail with a 500 (a retry then gets `already_exists`). There is no authentication, and the restore endpoint writes to any path the caller gives, so run the server only on a trusted machine.
