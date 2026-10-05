# Search vector: trigger mode — design

Status: decisions locked 2026-10-01. Product sign-off still needed on the three items in
"Open items".

## Why

Every searchable object (person, company, task, …) in every workspace has a `searchVector`
column. Today it is a Postgres **STORED generated column**: its formula is part of the column
definition, and Postgres recomputes it on every row write.

That works while the formula never changes. In our fork the formula changes every time a
searchable custom field is created, archived or relabelled, and a generated column can only
change its formula by being dropped and added back:

1. **Table lock.** Drop + add rewrites the whole table and rebuilds its indexes under
   `ACCESS EXCLUSIVE`, which blocks reads as well as writes. Measured in prod during the
   GO-660 fix: 27.9s on 1132918f (475k people), 47.7s on df76c87b. A rebuild that cannot get
   its lock within the 8s `lock_timeout` fails and rolls back.
2. **Column slots.** Postgres allows 1,600 columns per table and dropped columns count
   forever (tested: `VACUUM FULL` does not reclaim them). Every rebuild burns one slot. The
   plan is up to 700 custom fields per object, so the current design cannot reach it.
3. **Write cost at scale.** At 700 searchable fields the current formula costs 9.2ms of CPU
   per row save (local benchmark); the only cheaper shape (`concat_ws`) is not allowed in a
   generated column because it is not immutable.

## Decisions

| # | Decision | Evidence / reason |
|---|---|---|
| 1 | `searchVector` becomes a plain column maintained by a `BEFORE INSERT OR UPDATE` trigger. Formula changes replace the trigger function; existing rows are backfilled in batches. | Local benchmark, 1M rows: generated rebuild 30.3s fully locked (45% vector compute, 42% GIN build, 13% rewrite); trigger backfill 60.3s total, 0s table lock, worst batch 0.63s. Building the index concurrently alone only removes the GIN share. |
| 2 | Creating a searchable field is synchronous and needs no backfill (a new field is empty on every row). A default, an option relabel or an archive succeeds immediately and backfills only the affected rows in the background. | Linear §4.1 requires search setup to complete before a field is visible; trigger mode makes that a millisecond function replace. |
| 3 | Users see a 700-field cap per object. Go also refuses creation near ~1,500 of 1,600 column slots (phone = 4 columns, URL = 3, email/money = 2). | Prod slot usage measured 2026-10-01: highest table 63 of 1,600. |
| 4 | Only External ID and unique fields get a dedicated index. | Per-field indexes cap the feature at 20 (25-slot custom index budget). Linear §7 already says ordinary fields get none. |
| 5 | Search covers the 7 text-like types: text, external ID, select, multi-select, email, phone, URL. | Number/date/money are served by filters; boolean is noise; user needs a cross-table lookup. |
| 6 | The trigger uses the **lean formula**: the same projections in the same order, joined once with `concat_ws` (chunks of 99 arguments), one `unaccent` at the end. | Verified identical to stored prod vectors on every Alchemer row: 1,000,854 people, 164,554 companies. So conversion needs no backfill. |
| 7 | Rollout is per workspace via an explicit conversion command (dev → stage → prod small to large). A workspace's 700 cap unlocks only after it is converted. | GO-660 showed fleet-wide upgrade steps can be skipped silently. |
| 8 | In a converted workspace the fork never drops and re-adds `searchVector`; a test fails if it becomes generated again; upstream merges get a checklist item. | Upstream's 2-18 recompute pattern would otherwise silently revert the design. |

Refinements agreed after the decisions:

- **No per-row version column.** The trigger computes every value, so the backfill can never
  write a stale vector. Coverage is proven by walking an `id` cursor to the end, bounded by
  `createdAt <= cutoff`. The function is always replaced before the job is created, so rows
  created after the cutoff already carry the new formula.
- **Input cap: 131,072 characters.** The trigger truncates the joined text before
  `to_tsvector`. Postgres errors above 1,048,575 *bytes* per tsvector and fails the whole save
  (true of today's generated column too). `left()` counts characters, so the cap is sized for
  the worst case: distinct 4-byte-UTF-8 words measured ~699KB at 131,072 characters, while
  262,144 characters overflowed (1,048,580 bytes). Alchemer's longest record is 1,599 characters.
- **Search-list guard.** Refuse to generate a function when a standard field that exists in
  this workspace has no `searchFieldMetadata` row. Covers both GO-660 shapes: an empty list
  (56 workspaces) and a custom-only list (df76c87b).

## How it works

### The trigger function

One function per searchable object per workspace, in the workspace schema:

```sql
CREATE OR REPLACE FUNCTION "<schema>"."<table>_search_vector"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple',
    public.unaccent_immutable(left(concat_ws(' ', <projections over NEW."…">), 131072)));
  RETURN NEW;
END $$;

CREATE TRIGGER "<table>_search_vector"
BEFORE INSERT OR UPDATE ON "<schema>"."<table>"
FOR EACH ROW EXECUTE FUNCTION "<schema>"."<table>_search_vector"();
```

It is generated from `searchFieldMetadata` by the same builder that produces today's formula,
regenerated only when the search list changes, and run by Postgres on every row write. No
exception handling inside it: a PL/pgSQL `EXCEPTION` block adds a subtransaction to every save.

### Converting a workspace

An explicit command, not part of the `upgrade` sequence and not triggered by field creation:

```
yarn command:prod workspace:convert-search-vector-to-trigger -w <workspaceId> [-w …] [--dry-run]
```

At least one `-w` is required; without it the command refuses and converts nothing.

Run through the `twenty-upgrade-runner` ECS task. Per searchable object:

1. Read-only check: stored `searchVector` equals the lean formula on every row. Any difference
   stops that workspace and reports the count.
2. Create the function.
3. One transaction with an 8s `lock_timeout`: `ALTER COLUMN "searchVector" DROP EXPRESSION`
   (measured 1.09ms on 1M rows: same data file, values and GIN index kept) and `CREATE
   TRIGGER`. Both must be in the same transaction: after `DROP EXPRESSION` the column accepts
   direct writes.
4. Record the workspace as converted (the `IS_SEARCH_VECTOR_TRIGGER_ENABLED` feature flag, added in PR 2).

`--dry-run` runs step 1 only. Later, provisioning creates new workspaces in trigger mode.

### Backfill jobs

A `core` table holds one row per job (not per workspace or record): workspace id, object
metadata id, reason, filter (by field metadata id, resolved to column names at run time),
cutoff time, `id` cursor, status (PENDING / RUNNING / RETRYABLE / COMPLETED / FAILED), lease,
attempts, last error, timestamps.

- Rows exist only while there is work: one per default/relabel/archive, or one per
  workspace×object when we change the formula fleet-wide.
- A queue job runs one batch per message, `concurrency: 1`: a no-op `UPDATE … SET id = id`
  over the next ~1,000 ids `WHERE id > cursor AND "createdAt" <= cutoff AND <filter>`, so the
  trigger recomputes them; then saves the cursor and commits.
- Done when a batch finds no rows. A cron every minute re-queues PENDING, RETRYABLE and
  lease-expired jobs. An alert fires when a job has not moved in N minutes.
- If the workspace, object or field no longer exists, the job is FAILED with the reason.
- A daily cleanup deletes COMPLETED rows older than 30 days. FAILED rows are never deleted
  automatically. Index on `(status, "completedAt")`.

## Delivery

| PR | Repo | Contents | Gate |
|---|---|---|---|
| 1 — Trigger mode foundation | Twenty | lean builder (plain or `NEW.`-qualified columns), trigger SQL generator with 131,072-character cap, search-list guard, trigger installer, conversion command (`--dry-run` works; real conversion refused until PR 2) | inert: nothing can be converted |
| 2 — Trigger mode in the migration runner + backfills | Twenty | `IS_SEARCH_VECTOR_TRIGGER_ENABLED` feature flag as the converted state, set by the conversion; converted workspaces: regenerate the function instead of drop/add; no `searchVector` drop on enum option changes; regenerate in the same migration on field delete/rename; new objects get a plain column + trigger; backfill table, queue job, reconciler cron, 30-day cleanup; regression test that the column never becomes generated again; enables real conversion | conversion state |
| 3 — 700 fields | Go | index policy (External ID + unique only), cap 20 → 700, column-slot check, usage reporting, "only if converted" rule, optional search-updating indicator | `crm-custom-fields-700` WorkOS flag **and** converted |
| Cleanup | Go | remove `crm-custom-fields-700` and `crm-search-vector` | after full rollout |

No workspace — not even dev — may be converted before PR 2: today's runner drops
`searchVector` on enum option changes and relies on CASCADE on field delete, both of which
break a trigger-mode workspace (the column comes back generated, or every save fails with
"record new has no field").

PR 2 must also decide per table from the column's real state (`attgenerated`), not only the
flag: a conversion that stops partway (lock timeout, failure) leaves some tables in trigger
mode while the flag is still off. A generated rebuild on such a table must drop the trigger.
The admin panel can also set the flag by hand, so `attgenerated` is the truth, not the flag.

PR 2 must also close these gaps left by PR 1:

- Per-table dry-run report: a guard failure on one object aborts the whole workspace plan, so
  the dry run shows one error instead of which tables are fine.
- Stale plans: the command builds every table plan before phase 2 converts anything, so a
  search field change in between converts a table with an outdated formula. It needs a
  per-workspace lock shared with the migration runner, or plans re-derived inside the locked
  transaction.
- Repair path: tables left plain with no trigger by the 2026-07-21 to 2026-08-25
  batch-create bug are refused today (NULL or stale vectors). They need the trigger installed
  first, then a backfill.
- Create-field path: a TS_VECTOR field created without an expression still gets a plain
  column with no trigger (`generate-column-definitions.util.ts`, around lines 101-112).

## Open items

- **tom sign-off (Linear wins on product behaviour):** 700 vs Linear's 1,000 fields
  (§4.3/§13); 7 searchable types vs "all" (§7/§13); a few minutes of search lag after a
  default/relabel/archive (§4.1). Needed before PR C's flag goes on for a customer.
- **Out of this project:** an upgrade gap check (GO-660's real cause was a manual
  instance-only migration on 27 Jul that moved the upgrade cursor past every 2.16–2.22
  workspace step), and an audit of the other 22 skipped steps for the 56 older workspaces.

## Not doing (v1)

Self-adjusting batch size, backing off on database load, walking tables in physical order,
pause/cancel UI, nightly sampled drift check, formula cleanups (junk `'0'` token, five phone
forms, bare calling-code word). Each waits for a measured need.
