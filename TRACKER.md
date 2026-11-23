# Terminal confirmation-spoofing tracker

A small, honest log of AI-coding-agent cases checked against the "Terminal
DiLLMa" pattern (untrusted text rendered straight into a human
Allow/Deny confirmation prompt, without stripping ANSI-escape / terminal
control characters). Two separate things are tracked per row and must
not be blurred together:

1. **Scanner-tested** -- did the `confirm-check` static detector in this
   repo actually catch the pre-fix code, run by us, this pass?
2. **Maintainer status** -- is this accepted/shipped by the project's own
   maintainers, independent of anything we built? Checked live via
   `gh pr view`/`gh api` on 2026-11-23, not assumed from memory -- an
   earlier internal draft wrongly described all of these as "confirmed,"
   which this file corrects.

| Project | Report | Scanner-tested | Maintainer status (live-checked 2026-11-23) |
|---|---|---|---|
| modelcontextprotocol/inspector | [#2984](https://github.com/modelcontextprotocol/inspector/issues/2984) | No (found by hand, before this scanner existed) | **Shipped.** Closed, `stateReason: COMPLETED`, maintainer: "Shipped in #3015 (merged to v2/main)." |
| qwen-code | [PR #17346](https://github.com/QwenLM/qwen-code/pull/17346) | Yes -- caught (within-file asymmetry, the shape the detector was first built from) | Open, not merged (`mergedAt: null`) |
| qwen-code | [#17386](https://github.com/QwenLM/qwen-code/issues/17386) / [#17389](https://github.com/QwenLM/qwen-code/issues/17389) | No | Both open, unresolved |
| Aider-AI/aider | [PR #5981](https://github.com/Aider-AI/aider/pull/5981) | Yes -- caught (standalone rule, no sibling sanitize call existed to compare against) | Open, not merged |
| aaif-goose/goose | [GHSA-9jpx-h78x-968h](https://github.com/aaif-goose/goose/security/advisories/GHSA-9jpx-h78x-968h) | Yes -- caught two independent ways (standalone + cross-file asymmetry) | `state: triage`, not published/accepted |
| ManusAgents/ManusClaw | [PR #2](https://github.com/ManusAgents/ManusClaw/pull/2) | No -- repo-name search couldn't disambiguate this pass | Open, not merged |
| jzthree/nebula-tools | [PR #2](https://github.com/jzthree/nebula-tools/pull/2) | No -- same reason | Open, not merged |
| aymenfurter/polyclaw | [PR #15](https://github.com/aymenfurter/polyclaw/pull/15) | No -- same reason | Open, not merged |

**Reading this table correctly:** "scanner-tested: yes" means our detector
logic independently reproduces the finding against the real pre-fix code
-- it says nothing about whether the maintainer has acted on it.
"Maintainer status: open" is not a failure on our part and not evidence
the report is wrong; maintainer review takes however long it takes. Only
one row here is a maintainer-confirmed fix today. This table will be
updated as the open items resolve, not left to quietly go stale.
