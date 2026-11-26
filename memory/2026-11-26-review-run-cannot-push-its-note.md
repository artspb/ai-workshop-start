# A Code Review run with Air's "push-to-source" output cannot push its note before it posts
Such a run is told not to push: Air pushes the run's commits to the pull request's branch when the run ends, so after
the review is posted. The review is then on the head without the note, and the note's commit arrives seconds later.
Post on the pushed head (`headRefOid`), never on the local note commit: GitHub does not have it yet.
**When**: code-review, sections 6 and 7, in an Air run whose output behaviour is push-to-source.
**Evidence**: the first review of pull request #67, posted on f7213df; this note was committed locally before it and left for Air to push after it.
