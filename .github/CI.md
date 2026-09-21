# Pull request CI

CI is request-driven for pull requests targeting `main`, `develop`, or `stage`.

1. Push the commits that should be validated.
2. Attach the `run-ci` label to the pull request.
3. Wait for the five required statuses: Front, Server, Shared, UI, and Twenty Apps.

The workflow removes `run-ci` when the run starts. A later push does not start another
test pass; it cancels any in-flight run for the previous commit. Attach `run-ci` again
when the new pull request head is ready to validate.

Required statuses are published only for a real `run-ci` request. Other labels cannot
satisfy branch protection for an untested commit.

Dependabot requests the same label automatically after its metadata is captured. The
metadata bridge runs on both `main` and `develop`, so the trusted retarget marker gets
an independent, rerunnable CI request. Auto-merge then waits for the required statuses
on that exact head.

## Stage promotion ancestry

Every pull request targeting `stage` automatically runs `Stage ancestry`. The exact
pull request head must already be contained in `develop`; otherwise the check fails
even if the requested CI suites are green. This permits promotion branches built from
integrated commits while blocking changes that bypass develop.

After `.github/workflows/stage-ancestry.yaml` reaches the default branch, add the
`Stage ancestry` context from the GitHub Actions integration to the Stage Protection
ruleset's required status checks.
