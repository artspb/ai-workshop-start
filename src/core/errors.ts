/** A failure explained to the user: the CLI prints the message and exits with code 1. */
export class AtlasError extends Error {}

/** GitHub answers no more requests: the rate limit, a rejected token, or GitHub unreachable. */
export class GitHubUnavailable extends AtlasError {}

/**
 * GitHub refused a request for the rate limit. `resetsAt`: when the limit resets, if GitHub said so;
 * the message has no time in it, each client words the time for its user. See spec/analysis.md#rate-limit.
 */
export class RateLimited extends GitHubUnavailable {
  readonly resetsAt: Date | undefined;
  /** Whether the requests carried `GITHUB_TOKEN`: without it, the message points at it. */
  readonly token: boolean;
  constructor(resetsAt: Date | undefined, token: boolean) {
    super(`GitHub rate limit reached; ${token ? 'try again later' : 'set GITHUB_TOKEN'}`);
    this.resetsAt = resetsAt;
    this.token = token;
  }
}

/**
 * When the limit GitHub refused for resets: `retry-after`, seconds, for a secondary limit; else
 * `x-ratelimit-reset`, Unix seconds, unless `x-ratelimit-remaining` says that limit is not reached.
 */
export function resetTime(headers: Headers, now = Date.now()): Date | undefined {
  const retryAfter = headers.get('retry-after')?.trim();
  if (retryAfter && /^\d+$/.test(retryAfter)) return new Date(now + Number(retryAfter) * 1000);
  const reset = headers.get('x-ratelimit-reset')?.trim();
  const remaining = headers.get('x-ratelimit-remaining')?.trim();
  if (reset && /^\d+$/.test(reset) && (remaining === undefined || remaining === '0')) return new Date(Number(reset) * 1000);
  return undefined;
}
