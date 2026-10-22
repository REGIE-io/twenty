# Internal workspace member profiles

CRM user-directory workers use
`PATCH /internal/workspaces/:workspaceId/members/:workspaceMemberId` to refresh an
existing workspace member. The member ID is the identity used by CRM owner links.
It must remain stable when a provider changes a name or email.

The route uses the existing `TWENTY_INTERNAL_METADATA_TOKEN` guard. It accepts the
token through `Authorization: Bearer ...` or `x-internal-token`. No new secret,
authentication mode, schema migration, or worker restart command is required.

## Request and policies

Both path parameters must be UUID v4 values. The body requires these four fields;
unknown fields, including identity and permission changes, are rejected:

```json
{
  "email": "owner@example.test",
  "firstName": "Ada",
  "lastName": "Lovelace",
  "profilePolicy": "provider"
}
```

- `provider` updates this workspace member's email and nonempty names. Blank source
  names preserve existing names.
- `fill_missing` preserves a Go member's email and nonempty names. It fills blank
  names only when the normalized incoming email matches the member's email. An
  email mismatch leaves the profile unchanged.

The response contains `workspaceMemberId` and `workspaceId`, including for unchanged
profiles. The endpoint never creates a member, changes its ID, changes its core
user ID, or writes global core-user credentials, memberships, roles, or seats.

A missing workspace/member returns 404. Another member with the same normalized
email, including a soft-deleted member, returns 409 before any fields change.
The existing POST endpoint remains responsible for initial creation/reuse; it
does not refresh already-linked profiles.

## Transactions and retries

The lookup, collision check, and update run in one workspace transaction on both
ORM paths. A short `SHARE ROW EXCLUSIVE` lock protects only that workspace's member
table, so concurrent profile changes and other member writers cannot race the
case-insensitive email check. This briefly serializes member writes, not ordinary
CRM-record writes. A five-second lock timeout fails the request for safe retry.
The V1 query-builder override must retain its transaction's query runner for the
update as well as the reads.

## Verification and deployment

Unit tests cover both policies and existing POST behavior. The HTTP contract suite
uses the real controller, service, validation, token guard, and CSRF middleware,
with database/config boundaries replaced by fixtures. The PostgreSQL suite uses
real transactions and locks for both ORM transaction branches; it does not boot
the full Twenty metadata/event system. The full application integration suite
also verifies persisted profiles through real AppModule metadata/repositories on
both ORM paths. Server integration CI runs both layers; the concurrency suite
uses a separate disposable database. For a local concurrency run, explicitly set
`TWENTY_MEMBER_PROFILE_TEST_DATABASE_URL` to a localhost database named
`twenty_member_profile_test` or `twenty_member_profile_test_*`; no normal database
environment variable is used as a fallback.

After merge to `develop`, verify the exact image digest on both Twenty services,
the upgrade/status gates, stable task counts, and startup logs. Then verify that
normal CRM directory retries stop reporting `Cannot PATCH`, complete application,
and retain the same member/owner-link IDs. Read back the expected profile values
and preserved Go-user fields. A successful image rollout or Nango extraction alone
does not prove profile application. Keep the separate unexplained directory HTTP
400 and the held ownership-audit findings distinct from this endpoint fix.
