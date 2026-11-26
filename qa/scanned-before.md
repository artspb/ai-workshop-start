# Scanned before

**Covers**: **Scanned before**: a stored scan opened *as stored*, from its row; the row marked; the address and *back*;
collapsing it, across scans. See [web.md](../spec/web.md#the-page).

## Setup
- The server, as in [the README](README.md#running-a-script): an empty store, with `GITHUB_TOKEN`
- Data: `JetBrains/koog` at commit `709079e4a34d6c9234583352550e6a2b88a0bb85`, live GitHub, once; then `./fixture`

## Steps
1. Open the server's URL.
   - See: no **Scanned before**: nothing is stored yet.
2. Type `https://github.com/JetBrains/koog/tree/709079e4a34d6c9234583352550e6a2b88a0bb85` in the box, then press **Scan**.
   - See: "JetBrains/koog · 2 skills". **Scanned before**, under the box and above the result, open, with one row,
     "JetBrains/koog at 709079e4a34d", *marked*: the scan on the page.
3. Replace the box with `./fixture`, then press **Scan**.
   - See: "fixture · 5 skills". **Scanned before** still has its one row, "JetBrains/koog", not *marked* now: it is not the scan on the page.
4. Press the row's link, "JetBrains/koog".
   - See: "JetBrains/koog · 2 skills" at "709079e4a34d", the same two skills as in step 2, at once.
     The box holds `https://github.com/JetBrains/koog/tree/709079e4a34d6c9234583352550e6a2b88a0bb85`;
     the address ends with `/?scan=` and the scan's id. The row is *marked* again.
5. Go *back* in the browser.
   - See: "fixture · 5 skills" again; the box holds `./fixture`.
6. Press the title **Scanned before**.
   - See: it closes: its title stays, its row and its search box are hidden.
7. Press **Scan**, the box unchanged.
   - See: "fixture · 5 skills"; **Scanned before** stays closed.
8. Press the title **Scanned before** again.
   - See: it opens, with its one row, "JetBrains/koog".
