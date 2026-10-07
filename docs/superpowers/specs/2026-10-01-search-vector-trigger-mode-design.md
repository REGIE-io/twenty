# Search vector: trigger mode — design

Status: decisions locked 2026-10-01; PR 2 split and rollout agreed 2026-10-05.

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
- The reconcile cron also deletes COMPLETED rows older than 30 days. FAILED rows are never deleted
  automatically. Index on `(status, "completedAt")`.

## Delivery

| PR | Repo | Contents | Gate |
|---|---|---|---|
| 1 — Trigger mode foundation (#173) | Twenty | lean builder, trigger SQL generator with 131,072-character cap, search-list guard, trigger installer, conversion command (`--dry-run` only) | inert: nothing can be converted |
| 2a — Keep converted tables working on field changes | Twenty | migration runner decides per table from the column (plain + our trigger = converted): replaces the function instead of drop/add on search-list changes; disables the trigger around enum swaps; refreshes it on field rename/delete; renames it on object rename; drops it on object delete; workspace export writes the trigger. Regression test on a self-converted custom object | inert: no table is converted |
| 2b — Backfill and switching conversion on | Twenty | backfill job table, worker job, reconcile cron, 30-day cleanup; `IS_SEARCH_VECTOR_TRIGGER_ENABLED` flag set by the conversion; real conversion enabled; `--repair` for broken plain tables; per-workspace lock shared with the runner; per-table dry-run report; new objects start in trigger mode when the flag is on | merged with the flag off everywhere: no change until we run the command |
| 3 — 700 fields | Go | index policy (External ID + unique only), cap 20 → 700, column-slot check, usage reporting, optional search-updating indicator | `crm-custom-fields-700` WorkOS flag **and** converted |
| Cleanup | Go | remove `crm-custom-fields-700` and `crm-search-vector` | after full rollout |
| Separate fix | Twenty | a standalone TS_VECTOR field gets a plain column nothing fills (`create-field-action-handler`); pulled out of 2a because the fix rewrites the table under a lock | own PR |

### PR 2b decisions

- **One flag, `IS_SEARCH_VECTOR_TRIGGER_ENABLED`, per workspace.** Off by default. Only the
  conversion command turns it on, once every table is done; never the admin panel (runbook
  rule). Inside Twenty each table still decides from its own column. Go reads the flag.
- **New objects** start in trigger mode when the flag is on. **New workspaces** start
  converted only after the fleet conversion, by adding the flag to `DEFAULT_FEATURE_FLAGS`.
- **No off switch.** Turning the flag off does not revert tables. Problems are fixed forward:
  replace the function, then backfill. The runbook holds the emergency SQL (drop the trigger,
  replace the function, check a table's state).
- **Backfill** as designed above: one `core` entity row per job, `id` cursor plus
  `createdAt <= cutoff`, ~1,000 rows per batch, retries then FAILED, reconcile cron every
  minute, which also cleans up. Only changes that alter existing rows' words create a job (default
  value, option relabel or removal, archive or restore, searched-field delete, repair), limited
  to affected rows where possible. The single hook is `refreshSearchVectorTriggerIfConverted`
  from 2a.
- **Repair** of broken plain tables needs an explicit `--repair`, because it rewrites every row.
- **The workspace lock is held only for the switch.** Check every table without it, then take
  it, rebuild the plans and compare them with the checked ones (a difference reports `changed`,
  rerun), run only the quick DDL and set the flag. After release, rescan each switched table
  once; rows that differ get a whole-table REPAIR backfill.
- **Migrations read the flag from the database,** inside their transaction after the shared
  lock, never from the cache, so every process sees the same value.
- **Flag-on workspaces self-heal, and never take the legacy drop-and-recreate path.** On its next
  search list change, a table still generated (skipped by the conversion, or a flag set by hand)
  is switched in place, and a plain column whose trigger is gone (the runbook's emergency drop, a
  restore without triggers) gets its trigger back. Both queue a whole-table REPAIR backfill. A
  missing column refuses the change with an error naming `--repair`; a column is never added
  inside a user's save. (tom's review, 2026-10-06)
- **The GIN is checked on its own.** Without a usable index search does not fail, it scans the
  whole table. A search list change only logs a warning when the index is missing, invalid or
  wrongly defined. The conversion command reports index health per table on every run, dry runs
  included; with `--repair` it rebuilds the index after the workspace lock is released, outside
  any transaction (`CREATE INDEX CONCURRENTLY` / `REINDEX INDEX CONCURRENTLY`), under its
  index-metadata name. `--repair` also restores a missing column. Bloat stays an ops task.
  Integration tests assert the GIN's `oid` and `relfilenode` survive conversion, self-heal and
  an empty-field addition.

### Blockers to check before rollout

1. ~~Twenty crons are registered in our deploy.~~ Checked 2026-10-05: `entrypoint.sh` runs
   `cron:register:all` on every server start (unless `DISABLE_CRON_JOBS_REGISTRATION=true`; a
   failure only warns). Add the new cron to that list and confirm it at rollout stage 0.
2. ~~Touching a row must not look like an edit.~~ Checked 2026-10-05: a raw `SET "id" = "id"`
   leaves `updatedAt` alone (only TypeORM sets it), emits no Twenty events, webhooks or timeline
   rows (all hang off the ORM), and Go never sees it (message webhooks only; its own dirty queue).
   Person's phone-lookup trigger runs but writes nothing. Batch SQL must be
   `WHERE "id" IN (SELECT ... ORDER BY "id" LIMIT n) RETURNING "id"`; UPDATE has no LIMIT.
3. Backfill load on large tables (row rewrites, autovacuum); may need a pause between batches.
4. The 56 GO-660 workspaces may fail the guard and need fixing before they convert.
5. The fleet dry-run results.

## Rollout

Convert every workspace first, then give customers the feature. Conversion is invisible to
customers (the lean formula matched every stored row), so it is ours to do, gradually; the
700-field feature is switched on per customer only afterwards, on converted workspaces.

| Stage | What | Move on when |
|---|---|---|
| 0 | Merge 2b, flag off everywhere | job table exists, crons registered, nothing changed |
| 1 | Dry run across the fleet | every workspace sorted: clean, needs repair, needs fixing |
| 2 | Convert our private workspace; use it for a few days | backfills finish, search correct, saves no slower |
| 3 | Dev, then stage | same checks |
| 4 | Prod: a few small workspaces, then medium, then large (Alchemer) at a quiet hour | no failed jobs, no save errors, sampled search checks match |
| 5 | Repair broken tables (Anders, `_regie*`) with `--repair` | their search works |
| 6 | New workspaces start converted (flag in `DEFAULT_FEATURE_FLAGS`) | stages 2 to 5 stable |
| 7 | Go PR 3: 700 fields per customer, converted workspaces only | |

Stop rule at every stage: a failed save, wrong search results or a failed job stops the
rollout until fixed forward.

## Open items

- tom signed off on 700 fields, the 7 searchable types and the short search lag after a
  default, relabel or archive.
- **Out of this project:** an upgrade gap check (GO-660's real cause was a manual
  instance-only migration on 27 Jul that moved the upgrade cursor past every 2.16–2.22
  workspace step), and an audit of the other 22 skipped steps for the 56 older workspaces.

## Not doing (v1)

Self-adjusting batch size, backing off on database load, walking tables in physical order,
pause/cancel UI, nightly sampled drift check, formula cleanups (junk `'0'` token, five phone
forms, bare calling-code word). Each waits for a measured need.
