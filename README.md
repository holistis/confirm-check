# confirm-check (MVP, not yet published)

Scans an AI coding agent / terminal-UI codebase for a specific bug class:
untrusted text (an MCP tool name, a proposed shell command, a warning, an
elicitation message) rendered straight to the terminal right before a human
makes an Allow/Deny confirmation decision, without the ANSI-escape /
control-character stripping step a sibling render call in the same codebase
already uses elsewhere.

This bug class ("Terminal DiLLMa") was first documented by
[Johann Rehberger (wunderwuzzi), embracethered.com](https://embracethered.com/),
whose [terminal-dillma](https://github.com/wunderwuzzi23/terminal-dillma) repo
is a demo of the technique, not a scanner. This tool is a scanner: it checks
whether a given codebase's own confirmation-rendering code is internally
consistent about sanitizing this kind of input.

## How it works

The signal is not "no sanitize call seen anywhere" -- most files sanitize
nothing, and that's usually fine. The signal is an **asymmetry**: the same
file, or a sibling file in the same (or a neighboring) directory, has a
sanitize/strip-ansi-like call on one piece of untrusted render text, but a
different render call on similarly untrusted text skips it.

```bash
npx confirm-check <repo-path> [--ext tsx,jsx,rs,py,go,ts,js,mjs,cjs]
npx confirm-check --help
```

Exit codes (so a CI pipeline can branch on this): `0` clean scan, `1` risk
found, `2` the scan itself could not run (bad or missing path argument) --
a mistyped path never reads the same as a real clean scan. A file that
could not be read (e.g. permission denied) is reported as skipped, not
silently dropped from the count.

## Known limitations (measured, not assumed)

**Correction, 2026-11-23: re-checked every case's live GitHub state before
writing this section, instead of repeating an earlier, inaccurate "6
independently confirmed cases" claim that had circulated internally.**
Checked via `gh pr view .../json state,mergedAt` and
`gh api .../security-advisories/...` directly, not assumed from memory:

- **modelcontextprotocol/inspector #2984 is the one genuinely
  maintainer-confirmed case**: closed, `stateReason: COMPLETED`, maintainer
  comment "Shipped in #3015 (merged to `v2/main`)."
- Every other case this pattern is based on -- Aider PR #5981, qwen-code
  PR #17346, qwen-code issues #17386/#17389, goose GHSA-9jpx-h78x-968h
  (still `state: triage`, not published), ManusClaw PR #2, nebula-tools
  PR #2, polyclaw PR #15 -- is a real report we found and tested
  ourselves and submitted, but as of 2026-11-23 **none of these PRs are
  merged** (`mergedAt: null`, `state: OPEN` on every one checked) and the
  goose advisory is not yet accepted. Treat these as "the pattern we
  tested the detector against," not as "accepted by the maintainer" --
  that distinction matters and was wrong in an earlier draft of this
  README.

Benchmarked (detector logic, not maintainer acceptance) against 3 of
these cases: Aider PR #5981, qwen-code PR #17346, goose
GHSA-9jpx-h78x-968h. The other candidates (polyclaw, nebula-tools,
ManusClaw) could not be re-identified from a repo-name search alone
within this pass -- each name matches several unrelated repos -- so they
are untested, not confirmed caught.

**Repair round (this pass): 3 of 3 re-checked cases now caught.**

- **qwen-code (PR #17346):** caught since the first pass -- the exact
  within-file asymmetry shape the detector was built from.
- **Aider (PR #5981), now caught:** the pre-fix file had zero sanitize
  calls anywhere, so the asymmetry rule (which needs a sibling to compare
  against) still produces no signal on it alone. A second, independent
  rule was added instead: inside a confirm/approve/proceed/elicit/ask-named
  function, flag any output call whose argument is a suggestively-named
  variable (`message`/`subject`/`description`/...) with no sanitize call on
  that line, sibling or not. Verified against the real pre-fix
  `self.tool_output(subject, bold=True)`.
- **goose (GHSA-9jpx-h78x-968h), now caught, two independent ways:** the
  sibling sanitizer did exist in a neighboring file, but the vulnerable
  call was wrapped in a chained method call
  (`println!("\n{}", style(message).cyan())`). Two bugs compounded: (1) the
  Rust capture stopped at the first `)`, producing the malformed
  `style(message`, and (2) even with full text, a one-hop reader would
  follow the wrapper name `style` (a function) instead of its argument
  `message`. Fixed with a balanced-paren extractor plus an identifier
  reader that knows a name directly followed by `(` is a function being
  called, not data, and a name directly after `.` is a method, not data.
  Still needed a third fix: `message` is a parameter in a *multi-line*
  `fn` signature (one parameter per line), which the existing one-hop
  tracer never recognized as a binding at all (its only two forms are a
  `const/let/var` assignment and a single-line arrow/closure parameter).
  Verified against the real pre-fix `crates/goose-cli/src/session/elicitation.rs`
  and its real sibling `output.rs` (`sanitize_terminal_line`, line 735).

**Precision fix (this pass, found by an independent re-check, not
self-reported): the standalone rule only checked the sanitize pattern on
the OUTPUT call's own line, not a few lines earlier.** The real, current
(post-fix) `aider/io.py` sanitizes `subject` two lines before
`self.tool_output(subject, bold=True)` (`subject = strip_ansi_and_control_chars(subject)`),
and the standalone rule re-flagged that already-fixed code as a false
positive -- it never checked whether the variable itself had been
sanitized earlier, only whether the call's own line had. Fixed by reusing
the same one-hop backward tracer (`traceAssignmentBack`) the asymmetry
rule already used, so both rules now agree on what "sanitized" means.
Verified against the real post-fix `aider/io.py` (commit `88cd6ef`): no
longer flagged, while the real pre-fix case and the planted "no sanitize
call anywhere" case both still are (regression-tested together).

This is still a first-pass detector, not a complete one -- the standalone
rule's function-name and variable-name lists are hand-picked, not learned,
and can miss a differently-named case the same way the very first MVP
missed these three. Treat every hit as a lead to verify by hand, and treat
a clean scan as "no signal found", never as "confirmed safe".

**Scope, stated plainly: this tool flags a CODE PATTERN often associated
with this bug class, not a verified AI-agent-specific instance of it.**
`findStandaloneRisks` matches on function names (confirm/approve/elicit/...)
and variable names (message/subject/description/...) -- it does not verify
that the surrounding code is actually an AI-coding-agent confirmation path,
an MCP tool, or LLM-sourced text at all. A plain, ordinary CLI with its own
human-facing "are you sure?" prompt and a variable named `message` can and
will trigger a hit with nothing AI-related about it. Every hit needs a
human to confirm the context is actually relevant, not just that the
pattern matched.

**Language coverage, as of this pass:** `tsx`/`jsx`/`rs`/`py`/`go` plus
plain `ts`/`js`/`mjs`/`cjs` (added this pass -- `pickLanguage` previously
returned `null` for plain TypeScript/JavaScript, so a non-JSX AI-coding-CLI
written in plain TS was never scanned at all, even with `--ext ts`; the
qwen-code benchmark case happened to be `.tsx`, which is why this gap went
unnoticed until an independent review found it). The new `js` pattern uses
the same simple "stop at the first closing paren" capture as the
python/go patterns, not the Rust balanced-paren extractor -- a nested call
in plain JS/TS can still be missed the way the Rust case was before that
specific fix.

## Hardening (hostile-input pass, 2026-11-23)

The tool reads an arbitrary repo path handed to it on the command line --
treated as untrusted input, not a trusted fixture:

- **Fixed:** a large, highly repetitive file (measured: 44MB / ~800k
  matches, hung past 60s) made per-match line-number lookup re-scan the
  whole file from byte 0 every time (`content.slice(0, m.index).split('\n')`),
  which is O(matches x fileLength). Replaced with an incremental line
  tracker, O(fileLength) total. A 6MB/120k-match regression test now
  asserts this stays under 10s.
- **Fixed:** a self-referential symlink/junction (a directory that links
  back to itself or an ancestor) is now skipped outright
  (`isSymbolicLink()` checked before `isDirectory()`/`isFile()`), rather
  than relying on a Dirent-type quirk that is platform-dependent. Verified
  with a real junction, not just reasoned about.
- **Verified, no fix needed:** a binary file given a tracked extension
  (e.g. `weird.go`) is silently skipped by the existing bundled-file
  heuristic (few real newlines -> very long average "line" -> treated as
  bundled/binary), confirmed with a 2KB random-bytes fixture: 0 files
  scanned, no crash, no garbage output.
- The tool never writes to disk (no cache, no report file -- grep-clean:
  no `writeFile`/`createWriteStream` anywhere) and never shells out or
  evals (`exec`/`spawn`/`eval` grep-clean; the only `.exec(` hits are
  regex `RegExp.prototype.exec`). Both confirmed by source grep, not
  assumed.

## Status

Pre-release. Not yet published: no `npm publish`, no public repo yet --
`package.json` has `"private": true` as a deliberate guard against an
accidental publish while this is still under review.
