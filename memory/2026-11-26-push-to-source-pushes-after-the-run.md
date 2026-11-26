# Air's push-to-source runs push only after they end, so a commit can't come before what the run posts
An Air run with the push-to-source output behaviour is told not to push: Air pushes its commits when the run ends.
code-review now adds no note in such a run (section 7), so the advice of `2026-11-26-review-run-cannot-push-its-note.md`
to commit the note and post on `headRefOid` is superseded. address-review in such a run commits its round but cannot
push it before it submits its answers: its `Fixed in <sha>` names a commit that reaches GitHub seconds after them.
**When**: any skill whose step says "push, then post", in an Air run whose output behaviour is push-to-source.
**Evidence**: pull request #67, the review of f7213df, and the address-review round that answered it.
