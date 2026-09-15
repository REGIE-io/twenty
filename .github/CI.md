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
