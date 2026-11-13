/**
 * Shared error types.
 *
 * UsageError is a usage error (exit 2): a bad argument, a missing
 * value, a repo name that does not parse. ApiError is a GitHub API
 * failure (exit 2 as well — the triage could not run at all, which is
 * not the same as "the triage ran and found failures", exit 1).
 */

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export class ApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}
