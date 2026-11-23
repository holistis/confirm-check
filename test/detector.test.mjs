import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyExpression, analyzeFile, analyzeDirectory, findStandaloneRisks } from '../src/detector.mjs'

// Based on the REAL file QwenLM/qwen-code pull 17346,
// packages/cli/src/ui/components/messages/ToolConfirmationMessage.tsx (sha ecf8b8484):
// line ~400 renders `warning` raw in <Text>, line ~415 sanitizes rootCommand before use.
// Simplified into a testable TSX fixture, same core shape.
const QWEN_REAL_SHAPE = `
function render() {
  warnings.map((warning, idx) => (
    <Text key={idx} color={theme.status.warning}>
      {warning}
    </Text>
  ));
  const sanitizedRoot = sanitizeTerminalLine(executionProps.rootCommand);
  return <Text>{sanitizedRoot}</Text>;
}
`

const SAFE_TSX = `
function render() {
  const label = sanitizeTerminalLine(command);
  return <Text>{label}</Text>;
}
`

test('classifyExpression: a direct sanitize call in the expression counts as sanitized', () => {
  assert.equal(classifyExpression('sanitizeTerminalLine(x)', [], 0), 'sanitized')
})

test('classifyExpression: a plain string literal is safe, not a candidate', () => {
  assert.equal(classifyExpression('"Allow execution?"', [], 0), 'safe_literal')
})

test('classifyExpression: a bare identifier with no prior sanitize assignment is unsanitized', () => {
  const lines = ['const warning = rawInput;', '<Text>{warning}</Text>']
  assert.equal(classifyExpression('warning', lines, 1), 'unsanitized')
})

test('classifyExpression: a bare identifier WITH a prior sanitize assignment is sanitized', () => {
  const lines = ['const label = sanitizeTerminalLine(x);', '<Text>{label}</Text>']
  assert.equal(classifyExpression('label', lines, 1), 'sanitized')
})

test('analyzeFile: catches the real qwen-code asymmetry (warning raw, rootCommand sanitized, same file)', () => {
  const r = analyzeFile(QWEN_REAL_SHAPE, 'tsx')
  assert.equal(r.asymmetry, true)
  assert.ok(r.candidates.some((k) => k.status === 'unsanitized'))
  assert.ok(r.candidates.some((k) => k.status === 'sanitized'))
})

test('analyzeFile: NO asymmetry if the file sanitizes consistently everywhere', () => {
  const r = analyzeFile(SAFE_TSX, 'tsx')
  assert.equal(r.asymmetry, false)
})

test('analyzeFile: NO asymmetry if the file never uses sanitize anywhere (no signal, not necessarily a bug)', () => {
  const content = `function render(plainMessage) {\n  return <Text>{plainMessage}</Text>;\n}\n`
  const r = analyzeFile(content, 'tsx')
  assert.equal(r.asymmetry, false)
})

test('analyzeFile: also catches the Rust shape (println! vs sanitize_user_text), per Codex/Amazon Q', () => {
  const content = `
fn render_command(reason: &str, command: &str) {
    println!("{}", reason);
    let safe = sanitize_user_text(command);
    println!("{}", safe);
}
`
  const r = analyzeFile(content, 'rs')
  assert.equal(r.asymmetry, true)
})

test('planted omission: without the "hasSanitized AND hasUnsanitized" requirement, a file that sanitizes NOTHING would also flag (regression slot)', () => {
  const content = `function render(plainMessage) {\n  return <Text>{plainMessage}</Text>;\n}\n`
  const r = analyzeFile(content, 'tsx')
  assert.notEqual(r.asymmetry, true)
})

// Based on the REAL file cli/cli (gh CLI), pkg/cmd/pr/view/view.go
// (printRawPrPreview): pr.Title and pr.Body (from the PR author, so
// untrusted) rendered raw via fmt.Fprintf/Fprintln, no sanitize call in
// this file at all.
const GH_CLI_VIEW_REAL = `
func printRawPrPreview(io *iostreams.IOStreams, pr *api.PullRequest) error {
	out := io.Out
	fmt.Fprintf(out, "title:\\t%s\\n", pr.Title)
	fmt.Fprintln(out, "--")
	fmt.Fprintln(out, pr.Body)
	return nil
}
`

// Based on pkg/cmd/pr/diff/diff.go: the sanitize mechanism DOES exist
// here (asciisanitizer), applied before rendering.
const GH_CLI_DIFF_REAL = `
func sanitizedReader(r io.Reader) io.Reader {
	return transform.NewReader(r, &asciisanitizer.Sanitizer{})
}

func colorDiffLines(out io.Writer, diff string) error {
	safe := sanitizeDiff(diff)
	fmt.Fprintln(out, safe)
	return nil
}
`

test('analyzeFile: catches the Go shape (fmt.Fprintln/Fprintf without sanitize)', () => {
  const r = analyzeFile(GH_CLI_VIEW_REAL, 'go')
  assert.ok(r.candidates.some((k) => k.status === 'unsanitized' && k.expr === 'pr.Body'))
})

test('analyzeFile: NO asymmetry within view.go alone (the sanitize mechanism lives in a DIFFERENT file)', () => {
  const r = analyzeFile(GH_CLI_VIEW_REAL, 'go')
  assert.equal(r.asymmetry, false)
})

test('analyzeDirectory: catches the REAL gh CLI asymmetry across two files (view.go vs diff.go, same directory)', () => {
  const r = analyzeDirectory([
    { path: 'pkg/cmd/pr/view/view.go', content: GH_CLI_VIEW_REAL, ext: 'go' },
    { path: 'pkg/cmd/pr/diff/diff.go', content: GH_CLI_DIFF_REAL, ext: 'go' },
  ])
  assert.ok(r.crossFileAsymmetry.includes('pkg/cmd/pr/view/view.go'))
  assert.ok(!r.crossFileAsymmetry.includes('pkg/cmd/pr/diff/diff.go'))
})

test('analyzeDirectory: NO cross-file asymmetry if NOTHING in the directory uses sanitize', () => {
  const r = analyzeDirectory([{ path: 'a.go', content: GH_CLI_VIEW_REAL, ext: 'go' }])
  assert.equal(r.crossFileAsymmetry.length, 0)
})

test('planted omission: without the dirHasSanitized requirement, EVERY file with a raw render would flag (regression slot)', () => {
  const r = analyzeDirectory([{ path: 'a.go', content: GH_CLI_VIEW_REAL, ext: 'go' }])
  assert.notEqual(r.crossFileAsymmetry.length > 0, true)
})

// New fixture, not in the ported original: a safe case that LOOKS risky at
// a glance (hand-rolled ANSI stripping via a character class) to make sure
// classifyExpression still recognizes a sanitize call wrapped a level deep.
test('analyzeFile: a sanitize call nested inside a template-literal-free expression is still recognized', () => {
  const content = `
function render(cmd) {
  const safe = sanitizeTerminalLine(cmd.trim());
  return <Text>{safe}</Text>;
}
`
  const r = analyzeFile(content, 'tsx')
  assert.ok(r.candidates.some((k) => k.status === 'sanitized'))
})

// --- Repair round: the two real cases the first MVP missed ---

// Simplified from the REAL pre-fix aider/io.py, Aider-AI/aider PR #5981
// (confirmed via `gh api repos/Aider-AI/aider/pulls/5981/files`): before
// this PR, io.py had NO sanitize/strip-ansi function anywhere in the file
// -- the PR introduces the first one. `subject` reaches the terminal raw
// via `self.tool_output(subject, bold=True)`.
const AIDER_PREFIX_REAL_SHAPE = `
def confirm_ask(
    self,
    question,
    default="y",
    subject=None,
    explicit_yes_required=False,
):
    if subject:
        self.tool_output()
        if "\\n" in subject:
            lines = subject.splitlines()
            self.tool_output(padded_subject, bold=True)
        else:
            self.tool_output(subject, bold=True)
`

// Simplified from the REAL pre-fix crates/goose-cli/src/session/elicitation.rs
// (confirmed via \`gh api repos/block/goose/contents/...\`, GHSA-9jpx-h78x-968h,
// credited to holistis): a chained method call wraps the untrusted value
// (\`style(message).cyan()\`), and the function signature spans multiple
// lines (one parameter per line).
const GOOSE_PREFIX_REAL_SHAPE = `
fn collect_elicitation_input_inner(
    message: &str,
    schema: &Value,
    cancel_token: &CancellationToken,
) -> io::Result<ElicitationInput> {
    if !message.is_empty() {
        println!("\\n{}", style(message).cyan());
    }
}
`

// The REAL sibling file, crates/goose-cli/src/session/output.rs (line 735):
// \`sanitize_terminal_line\` exists and IS used, just never called from
// elicitation.rs -- this is what makes it a cross-file asymmetry, not a
// "nothing sanitizes anywhere" case like Aider.
const GOOSE_OUTPUT_RS_REAL_SHAPE = `
pub(super) fn sanitize_terminal_line(line: &str) -> String {
    line.to_string()
}

fn print_line(line: &str) {
    println!("    {}", style(sanitize_terminal_line(line)).dim());
}
`

test('findStandaloneRisks: catches the real Aider pre-fix case (confirm_ask -> self.tool_output(subject, ...), zero sanitize calls anywhere in the file)', () => {
  const risks = findStandaloneRisks(AIDER_PREFIX_REAL_SHAPE)
  assert.ok(risks.some((r) => r.text.includes('self.tool_output(subject')))
})

test('findStandaloneRisks: catches the real goose pre-fix case (println! with the chained style(message).cyan() wrapper)', () => {
  const risks = findStandaloneRisks(GOOSE_PREFIX_REAL_SHAPE)
  assert.ok(risks.some((r) => r.text.includes('style(message)')))
})

test('findStandaloneRisks: does NOT flag a confirm-ish function that already sanitizes the same call (no false positive)', () => {
  const content = `
def confirm_ask(self, subject=None):
    if subject:
        self.tool_output(sanitize_terminal_line(subject), bold=True)
`
  const risks = findStandaloneRisks(content)
  assert.equal(risks.length, 0)
})

test('findStandaloneRisks: does NOT flag an unsanitized suggestive-name output in a function that is NOT confirm/approve/elicit-named (stays scoped)', () => {
  const content = `
def render_status(self, subject=None):
    self.tool_output(subject, bold=True)
`
  const risks = findStandaloneRisks(content)
  assert.equal(risks.length, 0)
})

test('planted omission: without the UNTRUSTED_PARAM_NAME filter, EVERY output call in a confirm-ish function would flag, including harmless ones (regression slot)', () => {
  const content = `
def confirm_ask(self, default="y"):
    self.tool_output("Proceed?", bold=True)
`
  const risks = findStandaloneRisks(content)
  assert.equal(risks.length, 0)
})

// The REAL current (post-fix) aider/io.py, commit 88cd6ef (confirmed via
// `gh api repos/Aider-AI/aider/contents/aider/io.py?ref=88cd6ef`), lines
// 869-878: `subject` is sanitized TWO lines before the output call, not on
// the same line. Before this fix, findStandaloneRisks only checked
// SANITIZE_PATTERN against the output call's own line, so it re-flagged
// code the maintainers already fixed (found in an independent review).
const AIDER_POSTFIX_REAL_SHAPE = `
def confirm_ask(
    self,
    question,
    default="y",
    subject=None,
    explicit_yes_required=False,
):
    if subject:
        subject = strip_ansi_and_control_chars(subject)
        self.tool_output()
        if "\\n" in subject:
            lines = subject.splitlines()
            padded_subject = "\\n".join(lines)
            self.tool_output(padded_subject, bold=True)
        else:
            self.tool_output(subject, bold=True)
`

test('findStandaloneRisks: does NOT flag the real Aider POST-fix case, where the sanitize call happens a couple of lines earlier, not on the same line (regression for a precision gap found in review)', () => {
  const risks = findStandaloneRisks(AIDER_POSTFIX_REAL_SHAPE)
  assert.equal(risks.length, 0)
})

test('classifyExpression: resolves a wrapped call (style(message).cyan()) to its ARGUMENT, not the wrapper function name', () => {
  const lines = [
    'fn collect_elicitation_input_inner(',
    '    message: &str,',
    ') -> io::Result<ElicitationInput> {',
    '    println!("\\n{}", style(message).cyan());',
    '}',
  ]
  assert.equal(classifyExpression('style(message).cyan()', lines, 3, 'rust'), 'unsanitized')
})

test('planted omission: without extractCandidateIdentifiers, the OLD leading-token reading would classify style(message).cyan() by the wrapper name "style" and find no assignment for it (regression slot -- would be "unknown", not "unsanitized")', () => {
  const lines = ['const style = require("chalk");', '  println!("{}", style(message).cyan());']
  // "style" IS assigned on the line above (a require, not a sanitize call)
  // -- a leading-token reader would stop there and report 'unsanitized'
  // for the WRONG reason (style itself, not the real argument). The fixed
  // reader must still land on 'unsanitized' via the real argument
  // (`message`, untraceable here -> 'unknown' per-ident, but since no
  // ident resolves to 'unsanitized' here and 'style' is correctly
  // excluded as a function name, not misread as the candidate).
  const result = classifyExpression('style(message).cyan()', lines, 1, 'rust')
  assert.notEqual(result, 'sanitized')
})

test('classifyExpression: a Rust multi-line fn-signature parameter (one param per line) is traced as unsanitized', () => {
  const lines = ['fn f(', '    message: &str,', ') {', '    println!("{}", message);', '}']
  assert.equal(classifyExpression('message', lines, 3, 'rust'), 'unsanitized')
})

test('planted omission: without rustParamLine, a multi-line Rust signature parameter is untraceable and falls back to "unknown" (regression slot -- this is the exact goose-shape gap)', () => {
  const lines = ['fn f(', '    message: &str,', ') {', '    println!("{}", message);', '}']
  // lang omitted -> rustParamLine path disabled -> no assignment/paramBinding
  // match anywhere in this fixture -> must fall back to 'unknown', proving
  // the lang==="rust" gate is what makes the difference, not a general fix.
  assert.equal(classifyExpression('message', lines, 3, undefined), 'unknown')
})

test('analyzeFile: Rust balanced-paren extraction captures the FULL println! arg list, not just up to the first ")" (fixes the goose capture shape)', () => {
  const r = analyzeFile(GOOSE_PREFIX_REAL_SHAPE, 'rs')
  const hit = r.candidates.find((k) => k.expr.includes('message'))
  assert.ok(hit, 'expected a candidate referencing message')
  assert.equal(hit.expr, 'style(message).cyan()')
  assert.equal(hit.status, 'unsanitized')
})

test('analyzeDirectory: catches the REAL goose cross-file asymmetry (elicitation.rs unsanitized, sibling output.rs sanitized, same directory)', () => {
  const r = analyzeDirectory([
    { path: 'crates/goose-cli/src/session/elicitation.rs', content: GOOSE_PREFIX_REAL_SHAPE, ext: 'rs' },
    { path: 'crates/goose-cli/src/session/output.rs', content: GOOSE_OUTPUT_RS_REAL_SHAPE, ext: 'rs' },
  ])
  assert.ok(r.crossFileAsymmetry.includes('crates/goose-cli/src/session/elicitation.rs'))
  assert.ok(!r.crossFileAsymmetry.includes('crates/goose-cli/src/session/output.rs'))
})

test('analyzeFile: the Aider shape produces NO within-file asymmetry on its own (zero sanitize calls anywhere -- this is exactly why the standalone rule, not the asymmetry rule, is what catches it)', () => {
  const r = analyzeFile(AIDER_PREFIX_REAL_SHAPE, 'py')
  assert.equal(r.asymmetry, false)
  assert.equal(r.standaloneRisks.length > 0, true)
})

// Plain .ts/.js (no JSX) was previously unscanned entirely: pickLanguage()
// returned null for 'ts'/'js', so a codebase like this -- same shape as the
// qwen-code case, but without React/Text -- produced zero candidates no
// matter what, even with --ext ts. Found by an independent adversarial review.
const PLAIN_JS_SHAPE = `
function render(warnings, rootCommand) {
  warnings.forEach((warning) => {
    console.log(warning);
  });
  const sanitizedRoot = sanitizeTerminalLine(rootCommand);
  console.log(sanitizedRoot);
}
`

test('analyzeFile: plain JS/TS (no JSX) is now scanned -- within-file asymmetry on a console.log shape', () => {
  for (const ext of ['js', 'ts', 'mjs', 'cjs']) {
    const r = analyzeFile(PLAIN_JS_SHAPE, ext)
    assert.equal(r.asymmetry, true, `expected an asymmetry for ext=${ext}`)
    assert.ok(r.candidates.some((k) => k.status === 'unsanitized'), `expected an unsanitized candidate for ext=${ext}`)
  }
})

test('planted omission: before the js RENDER_PATTERNS entry and pickLanguage mapping existed, every .ts/.js file produced zero candidates regardless of content (regression slot)', () => {
  // Documents the fix rather than reverting it live: a .ts/.js file with an
  // unmistakable asymmetry (PLAIN_JS_SHAPE above) must produce a non-null
  // language and at least one candidate -- if pickLanguage('js') ever goes
  // back to returning null, this is the test that should catch it.
  const r = analyzeFile(PLAIN_JS_SHAPE, 'js')
  assert.notEqual(r.candidates.length, 0, 'a .js file must be classified into a language, not silently skipped')
})
