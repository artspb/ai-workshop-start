# Requests

**Covers**: how many GitHub requests a scan made, by kind, and the quota left, under the box: a fresh scan, a stored scan
opened as stored, before any scan, an organization's scan as it goes. See [web.md](../spec/web.md#requests-and-quota).

## Setup
- The server, as in [the README](README.md#running-a-script): an empty store, with `GITHUB_TOKEN`
- Data: `JetBrains/koog` at commit `709079e4a34d6c9234583352550e6a2b88a0bb85`, live GitHub; the owner `octocat`

## Steps
1. Open the server's URL.
   - See: nothing under the box: the server has seen no quota yet, and asks GitHub for none to show it.
2. Type `https://github.com/JetBrains/koog/tree/709079e4a34d6c9234583352550e6a2b88a0bb85` in the box, then press **Scan**.
   - See: "JetBrains/koog · 2 skills". Under the box, "3 REST requests, 0 GraphQL queries, 2 file reads · ", then how many
     are left, "of", the hour's limit GitHub gives the token (5,000 for a person's, more or fewer for others), "left, resets at", and a time,
     the viewer's clock, within the hour.
3. Press the row "JetBrains/koog" in **Scanned before**.
   - See: "JetBrains/koog · 2 skills"; under the box, "0 requests, from the store · ", then the same quota as in step 2.
4. Open the server's URL again, with nothing after it.
   - See: no result; under the box, "GitHub quota: ", then the same quota as in step 2.
5. Replace the box with `https://github.com/octocat`, then press **Scan**.
   - See: while it scans, the line under the box counts up with the repositories scanned, the quota left going down.
     Then "octocat · 8 repositories · 0 skills"; under the box, the REST requests, two more than the repositories,
     "1 GraphQL query, 0 file reads", the REST quota left, then "GraphQL:", how many points are left, "points left, resets at", and a time.
