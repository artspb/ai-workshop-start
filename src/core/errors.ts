/** A failure explained to the user: the CLI prints the message and exits with code 1. */
export class AtlasError extends Error {}

/** GitHub answers no more requests: the rate limit, a rejected token, or GitHub unreachable. */
export class GitHubUnavailable extends AtlasError {}
