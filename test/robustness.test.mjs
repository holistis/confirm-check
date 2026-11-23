// robustness.test.mjs -- adversarial edge cases beyond scan.test.mjs's
// existing self-referential-symlink and huge-repetitive-file coverage.
// Added after a dedicated adversarial pass (king's request: "waterdicht").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { scanRepo } from '../src/scan.mjs'

function mkTmpDir(name) {
  const dir = path.join(os.tmpdir(), `confirm-check-robustness-${name}-${process.pid}-${Date.now()}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test('scanRepo: a symlink/junction pointing at a PARENT directory (not itself) does not recurse or hang', () => {
  // Different shape from scan.test.mjs's self-referential case: src/loop ->
  // src/.. (the grandparent), a loop that only shows up a level deeper.
  const dir = mkTmpDir('parent-loop')
  const sub = path.join(dir, 'a', 'b')
  fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(sub, 'real.go'), 'package main\nfunc x() {\n  fmt.Println("hi")\n}\n')

  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  fs.symlinkSync(dir, path.join(sub, 'loop-to-grandparent'), linkType)

  let result
  const start = Date.now()
  assert.doesNotThrow(() => {
    result = scanRepo(dir, new Set(['go']))
  })
  const elapsedMs = Date.now() - start

  assert.ok(elapsedMs < 5_000, `expected the parent-pointing link to be skipped (took ${elapsedMs}ms)`)
  assert.equal(result.filesScanned, 1)
})

test('scanRepo: binary content with frequent 0x0a bytes (defeats the looksBundled filter) does not crash', () => {
  // A deliberately-crafted blob where the bundled heuristic (avg line
  // length > 300) does NOT kick in, so this forces raw binary through the
  // real regex/line-split pipeline, not just the pre-filter.
  const dir = mkTmpDir('binary-newlines')
  const bytes = Buffer.alloc(20_000)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 40 === 0 ? 0x0a : (i * 37) % 256
  fs.writeFileSync(path.join(dir, 'noisy.py'), bytes)

  assert.doesNotThrow(() => {
    const result = scanRepo(dir, new Set(['py']))
    assert.equal(result.filesScanned, 1)
  })
})

test('scanRepo: an extremely long single line (no newline) does not hang or crash', () => {
  // NOTE: looksBundled's own `lines.length < 3` guard means a file with
  // ZERO newlines (lines.length === 1) is never caught by the bundled
  // ratio check at all -- it reaches the real regex engine. That's a
  // looksBundled blind spot, not a crash/hang risk by itself: this test
  // exists to prove the engine still handles it fast, not that it gets
  // filtered (it doesn't).
  const dir = mkTmpDir('longline')
  const content = 'print(' + 'x'.repeat(5_000_000) + ')'
  fs.writeFileSync(path.join(dir, 'a.py'), content)

  const start = Date.now()
  const result = scanRepo(dir, new Set(['py']))
  const elapsedMs = Date.now() - start

  assert.equal(result.filesScanned, 1)
  assert.ok(elapsedMs < 2_000, `expected a single huge line to scan fast, took ${elapsedMs}ms`)
})

test('scanRepo: thousands of matches packed onto a single line (no newlines) still finishes fast', () => {
  // Combines two axes at once: looksBundled's lines.length<3 blind spot
  // (so this isn't pre-filtered) AND a high match count on ONE line,
  // which is the shape most likely to expose any remaining per-match
  // rescan cost in makeLineTracker.
  const dir = mkTmpDir('combo')
  let content = ''
  for (let i = 0; i < 50_000; i++) content += `print(message${i}); `
  fs.writeFileSync(path.join(dir, 'a.py'), content)

  const start = Date.now()
  const result = scanRepo(dir, new Set(['py']))
  const elapsedMs = Date.now() - start

  assert.equal(result.filesScanned, 1)
  assert.ok(elapsedMs < 5_000, `expected 50k matches on one line to finish fast, took ${elapsedMs}ms`)
})

test('source: no exec/spawn/child_process/eval anywhere in src/ or bin/ -- the repo-path argument can never reach a shell', () => {
  const files = [
    new URL('../src/scan.mjs', import.meta.url),
    new URL('../src/detector.mjs', import.meta.url),
    new URL('../bin/confirm-check.mjs', import.meta.url),
  ]
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    // Negative lookbehind on "exec" only: RegExp.prototype.exec() (e.g.
    // `re.exec(content)`) is used throughout this codebase and is NOT a
    // shell call -- only a dotted "exec(" is that method; a bare,
    // non-dotted "exec(" would still be child_process.exec destructured.
    assert.doesNotMatch(text, /(?<!\.)\bexec\s*\(/, `${f}: a non-method exec( call -- verify it is not child_process.exec`)
    assert.doesNotMatch(text, /\b(execSync|execFile|execFileSync|spawn|spawnSync|eval)\s*\(/, `${f} must not shell out or eval`)
  }
})

test('CLI: a shell-metacharacter repo-path is treated as a literal (nonexistent) path, never interpreted', () => {
  const binPath = new URL('../bin/confirm-check.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
  const canary = path.join(os.tmpdir(), `confirm-check-canary-${process.pid}.txt`)
  fs.rmSync(canary, { force: true })

  const payload = `$(node -e "require('fs').writeFileSync('${canary.replace(/\\/g, '\\\\')}','pwned')")`
  // Since the invalid-path fix, a nonexistent path is a scan error (exit 2),
  // not a silent "Scanned 0 file(s)" -- execFileSync throws on a nonzero
  // exit, so the result is read off the thrown error's own fields instead
  // of a plain return value.
  let err
  try {
    execFileSync(process.execPath, [binPath, payload], { encoding: 'utf8' })
  } catch (e) {
    err = e
  }

  assert.ok(err, 'a nonexistent path must exit non-zero (a scan error), not silently succeed')
  assert.equal(err.status, 2, 'a nonexistent path is a scan error (exit 2), not a clean scan (exit 0)')
  assert.match(err.stderr, /Path not found/, 'the error must say the path was not found, not look like a clean scan')
  assert.equal(fs.existsSync(canary), false, 'the payload must never execute -- the canary file must not appear')
})

test('CLI: --help and -h print help text and exit 0, without touching any path', () => {
  const binPath = new URL('../bin/confirm-check.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
  for (const flag of ['--help', '-h']) {
    const out = execFileSync(process.execPath, [binPath, flag], { encoding: 'utf8' })
    assert.match(out, /Usage:/, `${flag} must print usage text`)
    assert.match(out, /Exit codes:/, `${flag} must document the exit codes`)
  }
})

test('CLI: exit codes are meaningful (0 clean, 1 risk found, 2 scan error) -- not always 0', () => {
  const binPath = new URL('../bin/confirm-check.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')

  const cleanDir = mkTmpDir('exitcode-clean')
  fs.writeFileSync(path.join(cleanDir, 'a.py'), 'print("hello")\n')
  const cleanOut = execFileSync(process.execPath, [binPath, cleanDir], { encoding: 'utf8' })
  assert.match(cleanOut, /No risk found/, 'sanity: this fixture is expected to be clean')
  // execFileSync would have thrown on a nonzero exit, so reaching here at
  // all already proves exit 0 for the clean case.

  const riskyDir = mkTmpDir('exitcode-risky')
  fs.writeFileSync(
    path.join(riskyDir, 'a.py'),
    'def confirm_delete(filename):\n    message = f"Delete {filename}?"\n    print(message)\n'
  )
  let riskyErr
  try {
    execFileSync(process.execPath, [binPath, riskyDir], { encoding: 'utf8' })
  } catch (e) {
    riskyErr = e
  }
  assert.ok(riskyErr, 'a repo with a real standalone risk must exit non-zero')
  assert.equal(riskyErr.status, 1, 'a found risk is exit 1, distinct from a scan error (2)')
  assert.match(riskyErr.stdout, /STANDALONE risk/, 'sanity: this fixture is expected to flag')
})

test('CLI: a file with a permission error is reported as skipped, not silently dropped', { skip: process.platform !== 'win32' ? 'icacls-based test is Windows-only' : false }, () => {
  const dir = mkTmpDir('perm-denied')
  const blocked = path.join(dir, 'blocked.py')
  fs.writeFileSync(blocked, 'print(message)\n')
  const other = path.join(dir, 'other.py')
  fs.writeFileSync(other, 'print("fine")\n')

  execFileSync('icacls', [blocked, '/deny', `${process.env.USERNAME}:R`])
  try {
    const binPath = new URL('../bin/confirm-check.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
    const out = execFileSync(process.execPath, [binPath, dir], { encoding: 'utf8' })
    assert.match(out, /Skipped 1 file/, 'a read-denied file must be reported as skipped, not silently absent from the count')
  } finally {
    execFileSync('icacls', [blocked, '/reset'])
  }
})
