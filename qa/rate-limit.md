# Rate limit

**Covers**: GitHub's rate limit, as a user without `GITHUB_TOKEN` meets it: on an organization and on a repository,
the error in place of the result; a local directory still scans. See [analysis.md](../spec/analysis.md#organization).

## Setup
- The server, as in [the README](README.md#running-a-script): an empty store, **without `GITHUB_TOKEN`**
- **Last** of a run: it spends this machine's rate limit without a token, 60 requests an hour; the scripts before it
  have the token, a limit of their own
- Data: the owner `Kotlin`, live GitHub: over a hundred repositories, more than 60 requests;
  `JetBrains/koog` at commit `709079e4a34d6c9234583352550e6a2b88a0bb85`; `./fixture`

## Steps
1. Open the server's URL. Type `https://github.com/Kotlin` in the box, then press **Scan**.
   - See: maybe "Scanning https://github.com/Kotlin… <k> of <N> repositories" for a while; then, in the error colour,
     a message starting with "GitHub rate limit reached; set GITHUB_TOKEN", in place of the result.
     The bar and **Stop** are gone; no result.
2. Replace the box with `https://github.com/JetBrains/koog/tree/709079e4a34d6c9234583352550e6a2b88a0bb85`, then press **Scan**.
   - See: the same message, starting with "GitHub rate limit reached; set GITHUB_TOKEN"; no result.
3. Replace the box with `./fixture`, then press **Scan**.
   - See: "fixture · 5 skills": a local directory needs no GitHub.
