// detector.mjs -- core detection logic for confirm-check.
//
// Finds the ASYMMETRY behind the "terminal confirmation spoofing" bug class
// (aka "Terminal DiLLMa", documented by Johann Rehberger / embracethered.com):
// an AI coding agent renders untrusted text (a proposed shell command, an
// MCP tool name, a warning, a display name) straight to the terminal right
// before a human makes an Allow/Deny decision. The signal is not "no
// sanitize call seen" (most files sanitize nothing, and that's usually
// fine) -- it's that the SAME file (or a sibling file in the same
// directory) has a sanitize/strip-ansi-like call on SOME similarly
// untrusted render, but a DIFFERENT render call on equally untrusted text
// skips it. That asymmetry is the strongest signal we've found.
//
// This logic is deliberately pattern-based, not a hand-enumerated
// "dangerous character" list: across the seven real-world cases this
// pattern came from (Aider PR #5981, goose GHSA, modelcontextprotocol/
// inspector #2984 -- confirmed/shipped -- qwen-code PR #17346/#17386/
// #17389, ManusClaw #2, nebula-tools #2, polyclaw #15), no single
// hand-enumerated character list would have covered all of them. Checking
// only "was a sanitize-like function called at all" avoids that trap.
export const SANITIZE_PATTERN = /\b(saniti[sz]\w*|strip_?ansi\w*|escape_?command\w*|strip_bash_lc\w*)\s*\(/i

const GO_PATTERN = /\bfmt\.(?:Fprintf|Fprintln|Fprint|Printf|Println|Print)\s*\(\s*(?:[\w.]+\s*,\s*)?(?:"[^"]*"\s*,?\s*)?([^)]*)\)/g

// Rust is handled separately (extractRustCandidates below), not via this
// table: a capture group that stops at the first ")" mis-parses any nested
// call like `println!("\n{}", style(message).cyan())` (captures the
// malformed `style(message`, so the one-hop tracer follows the wrapper
// function name `style` instead of the real untrusted variable `message`).
// Real case this missed: goose GHSA-9jpx-h78x-968h.
const RENDER_PATTERNS = {
  tsx: [/<Text\b[^>]*>\s*\{([^}]*)\}/g],
  python: [/\b(?:print|click\.echo|rich\.print|console\.print|self\.\w*(?:output|echo|print|write)\w*)\s*\(([^)]*)\)/g],
  go: [GO_PATTERN],
  // Plain TS/JS (no JSX): console.log/error/warn and direct stdout/stderr
  // writes. Same simple "stop at first )" capture as the python/go patterns
  // above, not the Rust balanced-paren extractor -- a nested call here can
  // still be missed the way the Rust case was before that fix. Added so a
  // plain .ts/.js agent CLI (not everyone renders confirmations with JSX)
  // isn't silently unscanned -- see README "Known limitations".
  js: [/\b(?:console\.(?:log|error|warn)|process\.std(?:out|err)\.write)\s*\(([^)]*)\)/g],
}

/** Walks forward from just after an opening "(" to its matching ")",
 * respecting string literals (so a ")" inside a string doesn't end the
 * scan early) and nested parens. Returns the balanced inner text and the
 * index right after the matching close paren. */
function extractBalancedArgs(content, startIdx) {
  let depth = 1
  let i = startIdx
  let inString = null
  while (i < content.length && depth > 0) {
    const c = content[i]
    if (inString) {
      if (c === '\\') { i += 2; continue }
      if (c === inString) inString = null
    } else if (c === '"' || c === "'") {
      inString = c
    } else if (c === '(') {
      depth++
    } else if (c === ')') {
      depth--
      if (depth === 0) break
    }
    i++
  }
  return { text: content.slice(startIdx, i), endIndex: i }
}

/** Splits a balanced-args string on top-level commas only, so
 * `style(message).cyan()` is not sliced up at a comma that is actually
 * inside its own nested call. */
function splitTopLevelArgs(text) {
  const args = []
  let depth = 0
  let inString = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') { i++; continue }
      if (c === inString) inString = null
      continue
    }
    if (c === '"' || c === "'") { inString = c; continue }
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      args.push(text.slice(start, i))
      start = i + 1
    }
  }
  args.push(text.slice(start))
  return args.map((a) => a.trim()).filter((a) => a.length)
}

/** `println!("\n{}", style(message).cyan());` -> one candidate call with
 * full, correctly-balanced inner text `"\n{}", style(message).cyan()`,
 * ready for splitTopLevelArgs. Scans the whole file content directly
 * (not line-by-line) so paren/string matching can't be fooled by a macro
 * call that wraps onto a second line. */
function extractRustCandidates(content) {
  const macroStart = /\b(?:println|print|write|queue|eprintln|eprint)!\s*\(/g
  const calls = []
  let m
  while ((m = macroStart.exec(content))) {
    const openIdx = m.index + m[0].length
    const { text, endIndex } = extractBalancedArgs(content, openIdx)
    calls.push({ matchIndex: m.index, text })
    macroStart.lastIndex = endIndex
  }
  return calls
}

/** Turns a stream of non-decreasing char indices into line numbers in O(n)
 * total instead of O(n) per lookup. `content.slice(0, i).split('\n').length`
 * re-scans from index 0 on every call -- fine for a handful of matches, but
 * a file with hundreds of thousands of matches (an adversarial or just
 * very repetitive large file) turns that into O(matches * fileLength),
 * which hangs the process. Each loop that calls this must feed indices in
 * increasing order (regex .exec() scans forward, so this always holds
 * within one pattern's match loop) -- a tracker is built fresh per loop,
 * never shared across two independent match streams. */
function makeLineTracker(content) {
  let pos = 0
  let line = 0
  return function lineAt(charIndex) {
    while (pos < charIndex) {
      if (content.charCodeAt(pos) === 10) line++
      pos++
    }
    return line
  }
}

function pickLanguage(ext) {
  if (['tsx', 'jsx'].includes(ext)) return 'tsx'
  if (ext === 'rs') return 'rust'
  if (ext === 'py') return 'python'
  if (ext === 'go') return 'go'
  if (['ts', 'js', 'mjs', 'cjs'].includes(ext)) return 'js'
  return null
}

const SAFE_LITERAL = /^\s*(['"`])(?:(?!\1).)*\1\s*$/ // a plain string literal
const TRANSLATION_CALL = /^\s*t\(/ // i18n translation functions, not untrusted data

/** Looks at the lines BEFORE lineIdx for where `name` comes from, and says
 * whether a sanitize call sits there. One hop back, not a full dataflow
 * analysis. Three forms: (1) a plain assignment (const/let/var name = ...),
 * (2) a callback/arrow parameter (e.g. `warnings.map((warning, idx) => ...)`)
 * -- most "render inside a list" code binds its variable this way, never
 * via const/let/var; (3) rust-only: a parameter line in a MULTI-line `fn`
 * signature (`    message: &str,`). Single-line Rust signatures already
 * happen to satisfy form (2) by accident (the trailing "{" looks enough
 * like an arrow-function body to match); a signature split across several
 * lines does not, since form (2) only ever looks at one line at a time.
 * Real case this missed before form (3) existed: goose GHSA-9jpx-h78x-968h
 * (`collect_elicitation_input_inner`, a 3-parameter multi-line signature). */
function traceAssignmentBack(lines, lineIdx, name, lang) {
  const assignment = new RegExp(`\\b(?:const|let|var)?\\s*${name}\\s*:?=[^=]`)
  const paramBinding = new RegExp(`\\(([^()]*\\b${name}\\b[^()]*)\\)[^{]*(?:=>|\\{|:)`)
  const rustParamLine = lang === 'rust' ? new RegExp(`^\\s*${name}\\s*:\\s*&?\\w`) : null
  for (let i = lineIdx - 1; i >= 0 && i >= lineIdx - 60; i--) {
    if (assignment.test(lines[i])) {
      return SANITIZE_PATTERN.test(lines[i]) ? 'sanitized' : 'unsanitized'
    }
    const pm = lines[i].match(paramBinding)
    if (pm) {
      const afterArrow = lines[i].slice(lines[i].indexOf(pm[0]) + pm[0].length)
      return SANITIZE_PATTERN.test(afterArrow) ? 'sanitized' : 'unsanitized'
    }
    if (rustParamLine && rustParamLine.test(lines[i])) {
      // a bare `name: Type,` parameter line in a multi-line fn signature:
      // it's an external argument by definition, never itself a sanitize
      // call, so this scope has no sanitize step for it.
      return 'unsanitized'
    }
  }
  return 'unknown'
}

/** Pulls out identifiers that are actual DATA references in `expr` --
 * skipping names used as a function/method being called (`style(` ->
 * skip "style") and names used as a method/property after a dot
 * (`.cyan()` -> skip "cyan"). Needed once an expression is a wrapped call
 * like `style(message).cyan()`: the untrusted value is the ARGUMENT
 * (`message`), not the wrapper function's own name. */
function extractCandidateIdentifiers(expr) {
  const idents = []
  const re = /[a-zA-Z_$][\w$]*/g
  let m
  while ((m = re.exec(expr))) {
    const name = m[0]
    const before = expr.slice(0, m.index)
    const after = expr.slice(m.index + name.length)
    if (/^\s*\(/.test(after)) continue // immediately called -> a function name, not data
    if (/\.\s*$/.test(before)) continue // immediately after "." -> a method/property name
    idents.push(name)
  }
  return idents
}

/** Classifies one render-argument expression. `lang` is optional (only
 * rust uses it, for the multi-line-signature parameter check). */
export function classifyExpression(expr, lines, lineIdx, lang) {
  const e = expr.trim()
  if (!e) return 'safe_literal'
  if (SAFE_LITERAL.test(e) || TRANSLATION_CALL.test(e)) return 'safe_literal'
  if (SANITIZE_PATTERN.test(e)) return 'sanitized'
  const idents = extractCandidateIdentifiers(e)
  if (!idents.length) return 'unknown'
  let sawUnknown = false
  for (const name of idents) {
    const status = traceAssignmentBack(lines, lineIdx, name, lang)
    if (status === 'unsanitized') return 'unsanitized'
    if (status === 'unknown') sawUnknown = true
  }
  return sawUnknown ? 'unknown' : 'sanitized'
}

// Fix for the OTHER gap (Aider PR #5981): the asymmetry heuristic above
// needs a SIBLING example to compare against, so a codebase with literally
// zero prior sanitize calls produces zero signal -- this was the pre-fix
// aider/io.py exactly (this PR introduced the first sanitize function the
// file had ever had). This second, independent rule doesn't need a
// sibling: it looks for a confirm/approve/proceed/elicit/ask-named
// function, and inside it, an output call whose argument is a
// suggestively-named variable (message/description/text/subject/...)
// with no sanitize call on that specific line.
const CONFIRM_FN_NAME = /\b(?:fn|def|function|pub\s+fn)\s+\w*(?:confirm|approve|proceed|elicit|prompt_single|ask_)\w*/i
const UNTRUSTED_PARAM_NAME = /^(?:message|description|text|content|output|response|warning|subject|name|reason|label)$/i
const OUTPUT_CALL = /\b(?:println|print|write|queue|eprintln|eprint|console\.log|process\.stdout\.write|click\.echo|rich\.print|console\.print|self\.\w*(?:output|echo|print|write)\w*)\s*!?\s*\(/i
const STANDALONE_WINDOW = 80 // lines scanned forward from a matched function header

/** One file's content -> [{line, text}], independent of analyzeFile's
 * sibling-asymmetry candidates. Deliberately NOT gated on "does this file
 * sanitize anything elsewhere" -- that's the exact condition this rule
 * exists to cover. `lang` is optional (only matters for the Rust
 * multi-line-signature case in traceAssignmentBack). */
export function findStandaloneRisks(content, lang) {
  const lines = content.split('\n')
  const risks = []
  const starts = []
  lines.forEach((line, i) => { if (CONFIRM_FN_NAME.test(line)) starts.push(i) })
  for (const start of starts) {
    const end = Math.min(lines.length, start + STANDALONE_WINDOW)
    for (let i = start; i < end; i++) {
      if (!OUTPUT_CALL.test(lines[i])) continue
      if (SANITIZE_PATTERN.test(lines[i])) continue // this call already sanitizes
      const idents = extractCandidateIdentifiers(lines[i])
      const suspects = idents.filter((n) => UNTRUSTED_PARAM_NAME.test(n))
      if (!suspects.length) continue
      // Before flagging: the variable may have been sanitized a few lines
      // EARLIER (e.g. `subject = strip_ansi_and_control_chars(subject)`,
      // then two lines later `self.tool_output(subject, bold=True)`), not
      // on this same line. Real case this fixes: the post-fix aider/io.py
      // (PR #5981) -- without this check, the standalone rule re-flagged
      // code the maintainers had already fixed.
      const alreadySanitized = suspects.some(
        (n) => traceAssignmentBack(lines, i, n, lang) === 'sanitized'
      )
      if (alreadySanitized) continue
      risks.push({ line: i + 1, text: lines[i].trim() })
    }
  }
  return risks
}

/** One file -> {candidates: [{line, expr, status}], asymmetry: bool,
 * standaloneRisks: [{line, text}]}. */
export function analyzeFile(content, ext) {
  const lang = pickLanguage(ext)
  const standaloneRisks = findStandaloneRisks(content, lang)
  if (!lang) return { candidates: [], asymmetry: false, standaloneRisks }
  const lines = content.split('\n')
  const candidates = []
  if (lang === 'rust') {
    const lineAt = makeLineTracker(content)
    for (const { matchIndex, text } of extractRustCandidates(content)) {
      const lineIdx = lineAt(matchIndex)
      if (/^\s*(\/\/|\*|#)/.test(lines[lineIdx])) continue
      for (const arg of splitTopLevelArgs(text)) {
        const status = classifyExpression(arg, lines, lineIdx, lang)
        if (status !== 'safe_literal') candidates.push({ line: lineIdx + 1, expr: arg, status })
      }
    }
  } else {
    for (const pattern of RENDER_PATTERNS[lang]) {
      const re = new RegExp(pattern)
      const lineAt = makeLineTracker(content)
      let m
      while ((m = re.exec(content))) {
        const lineIdx = lineAt(m.index)
        if (/^\s*(\/\/|\*|#)/.test(lines[lineIdx])) continue
        const status = classifyExpression(m[1], lines, lineIdx, lang)
        if (status !== 'safe_literal') candidates.push({ line: lineIdx + 1, expr: m[1].trim(), status })
      }
    }
  }
  const hasSanitized = candidates.some((k) => k.status === 'sanitized')
  const hasUnsanitized = candidates.some((k) => k.status === 'unsanitized')
  return { candidates, asymmetry: hasSanitized && hasUnsanitized, standaloneRisks }
}

/** files: [{path, content, ext}] from ONE directory (no subdirs) ->
 * per-file result plus whether there's a directory-wide (cross-file)
 * asymmetry: a file with no sanitize call of its own, while ANOTHER file
 * in the same directory does use one. Lower confidence than a
 * within-one-file asymmetry (could be a deliberate, different design
 * choice), so always reported separately, never merged. */
export function analyzeDirectory(files) {
  const perFile = files.map((f) => ({ path: f.path, ...analyzeFile(f.content, f.ext) }))
  const dirHasSanitized = perFile.some((r) => r.candidates.some((k) => k.status === 'sanitized'))
  const crossFileAsymmetry = dirHasSanitized
    ? perFile
        .filter((r) => !r.asymmetry && r.candidates.some((k) => k.status === 'unsanitized'))
        .map((r) => r.path)
    : []
  return { perFile, crossFileAsymmetry }
}
