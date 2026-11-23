# Tally XML Ingestion Service

A backend service that ingests Tally XML (voucher exports and Tally operation responses) and exposes normalized vouchers. It keeps every value under the parent that owns it, preserves source order, and never loses money precision.

**Stack:** Node.js 22 · TypeScript · Express 5 · PostgreSQL 16 · `saxes` (streaming SAX parser) · Vitest + Supertest · Docker Compose.

> The original assignment brief is kept unchanged in [`ASSIGNMENT_README.md`](ASSIGNMENT_README.md), [`ASSIGNMENT.md`](ASSIGNMENT.md) and [`NORMALIZED_DATA_CONTRACT.md`](NORMALIZED_DATA_CONTRACT.md).

---

## Quick start

Requirements: Docker with Compose v2.

```bash
docker compose up --build
```

This starts Postgres, runs the migrations and serves the API on **http://localhost:3000**. Migrations run automatically on every start. They are idempotent and protected by an advisory lock.

### Run the tests (one command)

```bash
docker compose run --rm --build test
```

This runs **83 behavioural tests** against a real Postgres database (`tally_test`, created automatically).

### Local development (without containerising the app)

```bash
npm install
docker compose up -d db        # Postgres only, exposed on localhost:5433
npm test                       # unit + integration tests (uses tally_test)
npm run dev                    # migrate + start with reload on :3000
```

| Script | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run migrate` | Apply pending SQL migrations (`DATABASE_URL`) |
| `npm start` | Migrate, then run the compiled server |
| `npm test` | Full test suite (refuses to run against a database whose name lacks `test`) |
| `npm run typecheck` | Type-check sources and tests |

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `postgres://tally:tally@localhost:5433/tally` | Postgres connection |
| `MAX_UPLOAD_BYTES` | `10485760` (10 MiB) | Upload limit; larger requests get `413` |
| `MAX_XML_DEPTH` | `64` | Maximum element nesting depth |
| `REQUEST_TIMEOUT_MS` | `30000` | Node HTTP request timeout |
| `LOG_LEVEL` | `info` | pino log level |

---

## API

### Examples

```bash
# Health (liveness) and readiness (also checks the database)
curl -s localhost:3000/health          # {"status":"ok"}
curl -s localhost:3000/ready           # {"status":"ok","database":"ok"}

# Import a file (multipart field must be named "file")
curl -s -F "file=@fixtures/01_receipt_with_allocations.xml" localhost:3000/api/tally/imports
# 201 {"importId":"84d4…","documentType":"voucherExport","status":"completed","duplicate":false,
#      "summary":{"vouchers":1,"ledgerEntries":2,"inventoryEntries":0,"warnings":0,"errors":0}}

# Same bytes under another name: 200, the original import, duplicate=true
curl -s -F "file=@fixtures/06_duplicate_receipt.xml" localhost:3000/api/tally/imports

# Import details and normalized vouchers
curl -s localhost:3000/api/tally/imports/<importId>
curl -s localhost:3000/api/tally/imports/<importId>/vouchers

# A Tally error response: accepted (201) and processed (completed), but businessStatus=failed
curl -s -F "file=@fixtures/03_tally_error_response.xml" localhost:3000/api/tally/imports
```

### Status codes: three separate facts

| Fact | Where it is reported |
| --- | --- |
| Transport: was the upload accepted? | HTTP status: `201` new content, `200` exact bytes seen before |
| Processing: were the bytes decoded, parsed and persisted? | `status`: `completed`, `partial` (some vouchers rejected) or `failed` |
| Tally business outcome | `tallyResponse.businessStatus`: `succeeded` or `failed` |

| HTTP | When | Persisted? |
| --- | --- | --- |
| `201` | New content processed (`completed` or `partial`) | yes |
| `200` | Exact bytes imported before. Returns the original import with `duplicate: true` | upload attempt audited |
| `422` | Bytes cannot be safely processed: invalid encoding, malformed XML, DTD, unsupported root, too deep. The body includes `importId`, `status: "failed"` and `error` | yes, as `failed`, with the raw bytes |
| `400` | Missing `file` field, wrong field name, empty file, corrupt multipart | no |
| `413` | Upload larger than `MAX_UPLOAD_BYTES` | no |
| `404` | Unknown or malformed import id, unknown route | n/a |

All errors are structured as `{"error": {"code", "message", "requestId"}}`, with no stack traces, SQL or paths. The `requestId` matches the `x-request-id` response header and the server log line.

### Import details

The response contains the required fields (`importId`, `documentType`, `status`, `contentHash`, `detectedEncoding`, `summary`, `warnings`, `errors`, and `tallyResponse` for response documents). These extra, documented fields are added:

- `byteSize`, `originalFilename` (safe basename of the first upload), `parserVersion`, `createdAt`
- `rawSource: {retained: true, byteSize, sha256}`. Raw bytes are stored but never returned.
- `tallyResponse.sourceElement` (`RESPONSE` or `IMPORTRESULT`) and `tallyResponse.lineErrors` (every `LINEERROR`, in order). `lineError` is the first non-empty one.

Each warning or error is `{code, message, voucherIndex, path, occurrences, details?}`, for example:

```json
{ "code": "ILLEGAL_XML_CHARACTERS_REMOVED", "voucherIndex": 0, "path": "VOUCHER[0]/NARRATION",
  "occurrences": 1, "details": { "removed": ["&#4;"] },
  "message": "Removed 1 character(s) that are illegal in XML 1.0 (&#4;). The original bytes are retained with the import." }
```

`summary.warnings` / `summary.errors` equal the lengths of the `warnings` / `errors` arrays. Each voucher's own `warnings` array contains only the warnings for that voucher.

---

## Design

### Code map

```
src/
  xml/decode.ts       bytes -> text: BOM / UTF-16 sniffing / declaration, fatal decoding
  xml/sanitize.ts     removes XML-1.0-illegal characters (&#4;) using traceable markers
  xml/tree.ts         SAX -> ordered element tree; rejects DTDs; emits one voucher at a time
  xml/normalize.ts    direct-child readers per node type -> normalized contract; RESPONSE rules
  ingest/process.ts   pure pipeline: decode -> sanitize -> parse -> normalize -> validate
  ingest/repository.ts SQL: atomic idempotent insert, bulk tree insert, tree reload
  ingest/service.ts   upload use case: hash -> fast duplicate check -> process -> persist
  http/app.ts         Express routes, multipart limits, structured errors, safe logging
migrations/001_initial_schema.sql
test/                 6 files, 83 tests (unit + HTTP/DB integration)
```

The XML pipeline (`process.ts`) does no I/O, so all parsing rules can be unit-tested. Persistence is a single short transaction that runs after parsing.

### XML ownership: why there is no "flatten to object"

Generic XML-to-JSON libraries collapse repeated tags, turn single occurrences into scalars and search across descendants. Those are exactly the failure modes this exercise warns about. Instead:

1. **`tree.ts`** builds a minimal tree from SAX events. Every element keeps an ordered `children` array and only its *own* direct text. It also records a readable source path such as `VOUCHER[0]/ALLLEDGERENTRIES.LIST[1]/AMOUNT`.
2. **`normalize.ts`** declares, for each node type, which **direct** scalar children, `.LIST` children and attributes it understands. Fields are read with `scalar('AMOUNT')` on the owning node only. There is no descendant search anywhere, so a `BILLALLOCATIONS.LIST/AMOUNT` can never overwrite or leak into its ledger entry's `amount`. A test proves this: a voucher without a direct `DATE` gets `date: null` even though a bank allocation inside it has one.
3. Every `.LIST` occurrence becomes an array item in source order, even if it is the only one or identical to its sibling. `ALLLEDGERENTRIES.LIST` and `LEDGERENTRIES.LIST` interleaving is preserved, with `sourceTag` recording which tag each entry came from.
4. Values are the **exact source strings**: no trimming, no number parsing, no sign changes from `ISDEEMEDPOSITIVE`. `null` means absent and `""` means present but empty.

### Unknown nodes

Unknown children (UDFs such as `UDF:XYZ`, `PERSISTEDVIEW`, out-of-scope lists such as `INVENTORYENTRIES.LIST`), unknown attributes, stray text and duplicated scalars never crash the import. They are **not** included in the normalized output. Each one produces a warning with its source path, stating that it was retained in the raw upload but not normalized. Repeats of the same unknown node within a voucher are aggregated (`occurrences: 2`). This keeps a real export, where every voucher carries the same custom fields, at one warning per field per voucher instead of thousands.

### Encodings and illegal characters

- **Detection**, following XML 1.0 Appendix F: a BOM (UTF-8, UTF-16LE/BE) first; then BOM-less UTF-16 recognised from the bytes of `<?`; then the `encoding=` declaration; otherwise UTF-8. UTF-32 is rejected explicitly. A declaration that contradicts the bytes produces a warning (`ENCODING_DECLARATION_MISMATCH`), and the bytes win.
- **Decoding is fatal.** Invalid byte sequences fail the import (`422 INVALID_ENCODING`) rather than silently writing U+FFFD into accounting data.
- **Illegal characters.** References such as `&#4;`, and raw control characters, are removed before parsing. Each one is first replaced with a Private Use Area marker that is guaranteed not to occur in the document. The tree builder strips each marker as it finds it, so the warning names the exact field (`VOUCHER[0]/NARRATION`) and the exact reference (`&#4;`). Legal references (`&#9;`, `&#10;`, `&#x20AC;`) are left alone. The original bytes are always retained.

### Persistence design: relational rows, with JSON only where it is justified

| Data | Storage | Why |
| --- | --- | --- |
| Voucher tree (voucher, ledger entries, bill/bank allocations, inventory entries, batch/accounting allocations, rate details) | **Relational tables**, each with a foreign key to its direct parent and an `ordinal` | Ownership becomes a schema constraint, not a convention. The rows can be queried for reconciliation ("all bill allocations against INV-001"), and `UNIQUE(parent, ordinal)` makes order explicit and unique. |
| `rate_detail` (three possible owners) | One table with three nullable foreign keys and `CHECK (num_nonnulls(...) = 1)` | Each owner is a real foreign key with cascade, and exactly one owner is guaranteed. This is better than a polymorphic `owner_type/owner_id` pair, which cannot be a foreign key. |
| Money, quantity, rate, dates, Yes/No | **`TEXT`, exact source string** | Lossless by construction, matching the contract. `NUMERIC` would normalise `007.50` to `7.50` and reject `50.00/PCS` or `2 PCS`. Reporting can cast validated values in a view. |
| Warnings and errors | `import_issue` rows (code, path, voucher index, occurrences) plus a `details jsonb` column | The core fields are queryable ("every import with `ILLEGAL_XML_CHARACTERS_REMOVED`"). `details` varies by issue code, so JSONB fits it. |
| Tally response | `tally_response_result` (one row per import) | Counters are source strings, plus `business_status`. |
| Raw upload | `tally_import_raw.content bytea`, separate from `tally_import` | Meets the traceability requirement. It is kept in its own table so detail and voucher reads never load the bytes. In production this would move to object storage (see the large-file design). |
| Upload attempts | `tally_import_upload` (filename, outcome, time) | Audit trail: duplicates are recorded too. Filenames are metadata, never identity. |

Relationships you can inspect: import → vouchers → ledger entries → bill/bank allocations and rate details. Voucher → inventory entries → batch/accounting allocations → rate details. `test/persistence.test.ts` checks these with direct SQL.

### Idempotency, made atomic by the database

- Content identity is `sha256(exact uploaded bytes)`, as lowercase hex, enforced by `UNIQUE (content_hash)` and a format `CHECK`.
- The import and its whole tree are written in **one transaction** that starts with `INSERT … ON CONFLICT (content_hash) DO NOTHING RETURNING id`. If two uploads of the same bytes race, the second blocks on the unique index until the first commits. It then inserts nothing and returns the winner's id. If the first rolls back, the second succeeds. In no case can two imports for the same bytes both commit.
- A `SELECT` by hash runs before parsing, but only to skip re-parsing obvious re-uploads. Correctness does not depend on it. `test/idempotency.test.ts` runs 10 parallel service calls that all pass that check, and exactly one import results.
- Child-row ids are generated in the application. Each table is bulk-inserted with a single `INSERT … SELECT FROM unnest($1::uuid[], …)`, so a 1,000-voucher import is about 10 statements, not 10,000.

### Security

- **XML:** any `DOCTYPE` is rejected (`422 DTD_NOT_ALLOWED`), which blocks entity expansion ("billion laughs") and XXE. `saxes` never fetches external resources, and undefined entities are errors. Nesting depth is capped. XML content is never executed or evaluated.
- **Limits:** `MAX_UPLOAD_BYTES` is enforced twice: by an early `Content-Length` check and by multer's streaming limit. Multipart allows only 1 file, 10 fields and 20 parts. Request and header timeouts are set on the Node server, and Postgres has `statement_timeout`.
- **Logging:** structured pino logs. Requests are logged only as id, method, URL and status. Imports are logged as id, hash, size and counts. Bodies, headers and XML are never logged, and a `redact` list provides a second line of defence.
- **Errors:** structured JSON only. Unexpected errors return a generic `500 INTERNAL_ERROR` with a `requestId`, and the details stay in the server log. Client filenames are reduced to a safe basename.
- **Database:** parameterised queries only. Table and column names in the bulk insert are constants. The runtime container runs as a non-root user.

**Additional production controls I would add:** authentication with per-tenant isolation (a `tenant_id` on `tally_import` and row-level security); per-tenant rate limits and quotas; TLS termination; raw files in encrypted object storage with a retention policy and access audit; metrics and alerts (import latency, failure rate, warning counts by code, duplicate rate); pagination on `/vouchers`; a reprocess endpoint keyed by `parser_version`; backups with point-in-time recovery; dependency and container scanning in CI.

---

## Large-file design: ingesting a 500 MB export with bounded memory

The current implementation buffers each upload (capped at 10 MiB by default). For 500 MB it would hold the bytes, the decoded string (UTF-16 in JavaScript, about 2× the size) and the sanitized copy, which means several GB per concurrent request. That is why the limit exists. A production version would change four things.

**1. Accept the upload without buffering, and acknowledge it asynchronously.**
- Stream the request body straight to object storage (S3/GCS, or a pre-signed direct upload so the API never sees the bytes). Compute SHA-256 incrementally on the same stream, and count bytes so the size limit is enforced in flight.
- Return `202 Accepted` with an `importId` in status `receiving` → `queued` → `processing` → `completed|partial|failed`. The HTTP timeout then only has to cover the upload. That needs a minimum-throughput rule (to stop slowloris clients), not a fixed 30 s.
- Identity: the hash is only known at the end of the upload, so the upload is staged under a random key, and then `INSERT … ON CONFLICT (content_hash)` decides as it does today. A duplicate deletes the staged object and returns the existing import. Clients that retry before finishing can also send an `Idempotency-Key` header.

**2. Parse incrementally with explicit object boundaries.**
- A worker streams the object: BOM sniffing on the first 4 bytes, then a streaming decoder (`TextDecoderStream`, or iconv for UTF-16), then streaming sanitization, then `saxes.write(chunk)`. Sanitization must keep a small tail buffer (≤ 12 chars) so that a reference like `&#4;` split across two chunks is still recognised.
- The object boundary is `</VOUCHER>`. `tree.ts` already does this: it builds one voucher subtree, hands it to the normaliser and detaches it. Memory is bounded by the largest single voucher plus one batch. A per-voucher element cap guards against one giant voucher.
- Issue aggregation stays bounded: there is a cap on distinct warning keys, and after that a counter only.

**3. Write to the database in chunks, with restart checkpoints.**
- Batches of about 500 vouchers (or about 5 MB of rows) go through the existing `unnest` bulk insert. Each batch is its own transaction, and that transaction also updates `import_progress(import_id, last_voucher_index, issues_so_far)`. This avoids one giant transaction, which would bloat WAL, hold locks and block vacuum for minutes.
- The batch and its checkpoint commit together, so they are always consistent. On a worker crash, another worker re-claims the job (`SELECT … FOR UPDATE SKIP LOCKED` with a lease or heartbeat). It re-streams the file from the start and skips vouchers with `voucher_index <= last_voucher_index`: it parses them but does not insert them. Re-parsing is much cheaper than writing to the database. Seeking to a byte offset would be faster but is unsafe, because the parser's stack and namespace state would be lost. As a second safety net, `UNIQUE (import_id, voucher_index)` means a replayed batch can never duplicate rows (`ON CONFLICT DO NOTHING`).
- Visibility: chunks commit independently, so "the import is atomic" becomes "the import is visible once its status is `completed`". The voucher endpoint returns `409`/`202` while the import is still processing. The alternative, staging tables followed by a single swap, gives true atomicity but costs about twice the writes.

**4. Raw storage, cleanup and backpressure.**
- Raw objects are stored under content-addressed keys (`sha256/…`), encrypted at rest, with lifecycle rules: staged uploads that never finished are deleted after 24 h, and retained sources are kept for the accounting retention period. The database stores the object key and hash instead of `bytea`, since Postgres values top out at 1 GB and are expensive to read.
- Backpressure comes from Node stream `pipeline()`/async iteration: the parser pauses the read stream while the database batch is being written, so memory stays flat. Worker concurrency and pool size are fixed. When the job queue is longer than a threshold, new uploads get `429/503` with `Retry-After` instead of an unbounded queue.
- Failed jobs keep the raw object and the last checkpoint for investigation, and they can be retried with a newer `parser_version`.

---

## Assumptions and interpretations

- **Exact text.** Values are not trimmed (`<ACTUALQTY> 2 Nos</ACTUALQTY>` keeps its leading space). Missing elements are `null`, and empty elements are `""`. Missing attributes are omitted from `attributes`.
- **Every `.LIST` occurrence is an item**, including an empty placeholder occurrence (all of its fields are `null`). Nothing is dropped or merged.
- **Duplicated scalars** (two `AMOUNT`s under one parent): the first is used, and a `DUPLICATE_SCALAR_ELEMENT` warning records the ignored value.
- **Envelope metadata** (`HEADER`, `BODY/DESC`) is retained raw and not warned about, because it carries no accounting data. Anything else unexpected outside vouchers is warned about.
- **`INVENTORYENTRIES.LIST`** (without `ALL`) is outside the required scope. It is reported as not normalized rather than guessed at.
- **Unprocessable documents** are persisted as `failed` (raw bytes plus an error) and answered with `422`. Re-uploading the same bytes returns the same failed import (`422`, `duplicate: true`). Request-level problems (missing or empty file, too large) are not persisted.
- **Tally counters** are returned as the source strings. `businessStatus` is `failed` if `ERRORS` is greater than 0, if any `LINEERROR` is non-empty after trimming, or (to fail safe) if `ERRORS` is not a non-negative integer.
- **Partial failure.** A voucher with `DATE`, `VOUCHERTYPENAME` or `VOUCHERNUMBER` missing or blank is rejected with an error and has no rows. The import is `partial` even if every voucher was rejected, because the document itself processed fine.
- **`detectedEncoding`** is the WHATWG name actually used for decoding (`UTF-8`, `UTF-16LE`, `UTF-16BE`).
- **Sanitization limitation:** an `&#4;` inside a CDATA section or comment is literal text, not a reference, but it is still removed (with a warning). This is acceptable for Tally data and is documented here.

## Optional extensions

| # | Extension | Status |
| --- | --- | --- |
| 1 | Per-voucher partial failure | **Implemented.** Tested with valid and invalid vouchers in one document, in both unit and API tests. |
| 2 | Streaming implementation | **Not implemented.** Designed above. The parser already works per voucher, but uploads are still buffered. |
| 3 | Concurrency proof | **Implemented.** 8 parallel HTTP uploads, plus 10 racing service calls that bypass the fast-path check. |
| 4 | Richer unknown-node preservation | **Not claimed.** Source paths of unknown nodes are persisted in `import_issue`, but unknown subtrees themselves are not stored (only in the raw upload). |
| 5 | Alternate response envelope (`IMPORTRESULT`) | **Implemented.** Normalised into the same `tallyResponse` shape, with `sourceElement: "IMPORTRESULT"`. |

## Tests

`docker compose run --rm --build test` (or `npm test` with the db container running) runs 83 tests:

| Required behaviour | Where |
| --- | --- |
| 1. Repeated ledger entries stay separate and ordered | `normalization.test.ts`: "repeated ledger entries"; `api.test.ts` fixture 01 |
| 2. Ledger / bill / inventory / batch / accounting `AMOUNT`s are not overwritten | `normalization.test.ts`: "AMOUNT ownership" (a distinct value per level); `persistence.test.ts` |
| 3. Duplicate bytes under a different filename return the original import | `idempotency.test.ts` (fixture 06, row counts, upload audit) |
| 4. UTF-16 and illegal-control-reference recovery records a warning | `decoding.test.ts`, `api.test.ts` "encodings" |
| 5. `ERRORS=1` gives `businessStatus: failed` while the upload is accepted | `api.test.ts` "Tally response" (HTTP 201 + failed); table-driven rules in `normalization.test.ts` |
| 6. Empty collection and unknown children do not crash or invent vouchers | `normalization.test.ts` and `api.test.ts` |

There are also tests for: the exact normalized contract (deep equality on fixtures 01 and 02), descendant-leak prevention, lossless values, interleaved source tags, BOM-less and big-endian UTF-16, invalid UTF-8, DTD/XXE/billion-laughs rejection, depth limit, size limit (413), multipart validation, safe error bodies, and direct-SQL inspection of every relationship and of the `rate_detail` single-owner constraint.

---

## Status

### Complete
All of the required core: the four endpoints, both document shapes, ownership-preserving normalization, lossless values, encodings and sanitization, unknown-node warnings, persisted warnings and errors, raw-source retention, atomic idempotency, the security baseline, one-command startup and tests, and the large-file design. Optional extensions 1, 3 and 5 are also done.

### Incomplete / next steps
1. **Streaming ingestion** (extension 2), as designed above. *Risk today:* memory per request grows with upload size, so raising `MAX_UPLOAD_BYTES` toward 500 MB without this would risk running out of memory under concurrent uploads.
2. **Pagination on `/vouchers`.** *Risk:* a very large import produces a very large response.
3. **Raw bytes in object storage instead of `bytea`.** *Risk:* database growth and backup size grow with upload volume.
4. **Authentication and tenancy.** Explicitly out of scope, but required before any real deployment.
5. **Reprocess endpoint** that re-runs stored raw bytes through a newer `parser_version`.

## Time spent

<!-- TODO(candidate): replace with your real active time, e.g. "≈ 5.5 hours active". -->
**Approximate active time:** _fill in before submitting_

## AI usage disclosure

<!-- TODO(candidate): write this in your own words and keep it accurate. Suggested structure: -->
- **Tools used:** _e.g. Claude Code (Anthropic) as a pair programmer in the terminal._
- **What it helped with:** _e.g. scaffolding, drafting the parser/schema/tests, the README._
- **What I personally verified or changed:** _e.g. reviewed every design decision, ran the test suite and the curl examples, checked fixture outputs against the contract, adjusted …_
