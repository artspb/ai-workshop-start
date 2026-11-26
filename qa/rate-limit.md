# Rate limit

**Covers**: GitHub's rate limit, as a user without `GITHUB_TOKEN` meets it: on an organization and on a repository,
the error in place of the result; a local directory still scans. See [analysis.md](../spec/analysis.md#organization).

## Setup
- The server, as in [the README](README.md#running-a-script): an empty store, **without `GITHUB_TOKEN`**
- **Last** of a run: it spends the rate limit without a token, 60 requests an hour, and that limit is the IP address's,
  not the machine's: a second run within the hour, or another environment behind the same address, starts with it
  spent, or partly spent. The scripts before it have the token, a limit of their own
- Data: the owner `Kotlin`, live GitHub: over a hundred repositories, more than 60 requests;
  `JetBrains/koog` at commit `709079e4a34d6c9234583352550e6a2b88a0bb85`; `./fixture`

## Steps
1. Open the server's URL. Type `https://github.com/Kotlin` in the box, then press **Scan**.
   - See: one of two, and the report says which: with requests left, "Scanning https://github.com/Kotlin… <k> of <N> repositories"
     for a while, the error coming on the way; with the limit already spent, only "Scanning https://github.com/Kotlin…",
     the error before the list of repositories. Then, in the error colour, in place of the result, the rate limit
     with its reset time: "GitHub rate limit reached; set GITHUB_TOKEN, or wait: it resets at", a time, the viewer's
     clock, then "(in", how many minutes, and "minutes)", or "minute)" for one. The bar and **Stop** are gone; no result.
2. Replace the box with `https://github.com/JetBrains/koog/tree/709079e4a34d6c9234583352550e6a2b88a0bb85`, then press **Scan**.
   - See: the same message, "GitHub rate limit reached; set GITHUB_TOKEN, or wait: it resets at", a time, then how many
     minutes; no result.
3. Replace the box with `./fixture`, then press **Scan**.
   - See: "fixture · 5 skills": a local directory needs no GitHub.
