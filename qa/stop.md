# Stop

**Covers**: **Stop** on an organization's scan: the status says how far it got, the address stays, no result;
the repositories scanned are in **Scanned before**, and the scan does not go on. See [web.md](../spec/web.md#the-page).

## Setup
- The server, as in [the README](README.md#running-a-script): an empty store, with `GITHUB_TOKEN`
- Data: the owner `Kotlin`, live GitHub: over a hundred repositories, too many to scan before **Stop**;
  stopped early, it spends a few dozen requests of the rate limit

## Steps
1. Open the server's URL. Type `https://github.com/Kotlin` in the box, then press **Scan**.
   - See: "Scanning https://github.com/Kotlin…", then "<k> of <N> repositories" after it, `N` over 100;
     a bar filling as `k` grows, and **Stop**.
2. Once `k` is 1 or more, press **Stop**.
   - See: "Stopped scanning https://github.com/Kotlin at <k> of <N> repositories; the ones scanned are in Scanned before",
     `k` no less than when you pressed. The bar and **Stop** are gone; no result. The box still holds `https://github.com/Kotlin`,
     and the address still ends with `/?repo=https%3A%2F%2Fgithub.com%2FKotlin`.
3. Look at **Scanned before**.
   - See: rows of `Kotlin/<repository>`, at least `k` of them; none is *marked*.
4. Wait five seconds. Replace the box with `./fixture`, then press **Scan**.
   - See: "fixture · 5 skills". **Scanned before** counts at most `k` + 16 rows of `Kotlin/…`, far fewer than `N`:
     only the repositories started by the time **Stop** reached the server end, 8 at a time; no other is scanned.
