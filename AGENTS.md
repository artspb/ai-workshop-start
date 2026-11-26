# AGENTS.md
## Specs
Read [./spec](spec/) first. Update it with the code.
## Tests
Integration tests for every case in the spec.
## Skills
Each skill is in `.agents/skills/<name>/SKILL.md` and `.claude/skills/<name>/SKILL.md`, byte-identical: [tests/skills.test.ts](tests/skills.test.ts).
## Owner
`@artspb`: a skill that leaves a decision for a person mentions them, as its "Handing over to a person" section says.
Written here only, never in a skill: [tests/handover.test.ts](tests/handover.test.ts).
## Definition of done
- All tests pass locally: `npm test` and `npm run e2e`
- The CI build ([.github/workflows/ci.yml](.github/workflows/ci.yml)) is green

## Commands
- `npm ci`: first, in a fresh checkout
- `npm test`: the tests
- `npm run e2e`: the end-to-end tests, on live GitHub; `UPDATE=1` rewrites `tests/e2e/*.txt`. Set `GITHUB_TOKEN`
