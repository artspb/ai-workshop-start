---
name: code-review
description: Review a change or a pull request in this repository. A short summary, then inline comments, each with where and how to reproduce. Use for every code review.
---

# Code review

## The review
- **A short summary**: two or three sentences. The verdict (merge, or what blocks it), then the main risk.
- **Inline comments**: every finding goes on the line it is about, not in the summary.
- No finding without a check: if you cannot reproduce it, leave it out or label it a question.

## Each comment
- **Where**: `path:line`, on the line itself.
- **What**: one sentence, the defect.
- **How to reproduce**: the command or the input, what happens and what should happen:
  ```
  ./skill-atlas scan ./fixture
  prints: fixture · 6 skills
  expected: fixture · 5 skills (spec/analysis.md: copies are one skill)
  ```
  A failing test is better still: name it, or put it in the comment.
- The fix only when it is short and not obvious.

## What to check
- The change matches [spec/](../../../spec/), and the spec was updated with the code.
- Every case in the spec has a test; `npm test`, `npm run typecheck` and `npm run e2e` pass.
- See [AGENTS.md](../../../AGENTS.md) for the definition of done.
