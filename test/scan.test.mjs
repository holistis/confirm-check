// scan.test.mjs -- hostile-input handling for scanRepo: a scanned repo is
// untrusted input (someone else's codebase), so scanRepo must not hang or
// crash on a large/repetitive file or a self-referential symlink loop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { scanRepo } from '../src/scan.mjs'

function mkTmpDir(name) {
  const dir = path.join(os.tmpdir(), `confirm-check-test-${name}-${process.pid}-${Date.now()}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test('scanRepo: a large, highly repetitive file finishes fast (regression guard for the O(matches * fileLength) line-counting bug)', () => {
  const dir = mkTmpDir('huge')
  // ~6MB, ~120,000 matching fmt.Println calls -- the original
  // content.slice(0, m.index).split('\n').length re-scan-from-zero
  // approach is O(matches * fileLength); at this size that was already
  // many seconds, and the real 44MB/800k-match case measured >60s (moved
  // to background, killed manually). The fixed incremental line tracker
  // is O(fileLength) total regardless of match count.
  const line = '    fmt.Println("filler line padding padding padding")\n'
  const content = 'package main\nfunc x() {\n' + line.repeat(120_000) + '}\n'
  fs.writeFileSync(path.join(dir, 'huge.go'), content)

  const start = Date.now()
  const result = scanRepo(dir, new Set(['go']))
  const elapsedMs = Date.now() - start

  assert.equal(result.filesScanned, 1)
  // Generous bound (the real fix runs this in well under 1s) -- this is a
  // regression guard, not a tight perf benchmark: it exists to fail loudly
  // if someone reintroduces the per-match full-content rescan.
  assert.ok(elapsedMs < 10_000, `expected under 10s, took ${elapsedMs}ms (did the O(n) line tracker get reverted?)`)
})

test('scanRepo: a self-referential symlink/junction does not cause infinite recursion or get traversed', () => {
  const dir = mkTmpDir('symlink-loop')
  const subdir = path.join(dir, 'src')
  fs.mkdirSync(subdir)
  fs.writeFileSync(path.join(subdir, 'real.go'), 'package main\nfunc x() {\n  fmt.Println("hi")\n}\n')

  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  // self-referential: src/loop -> src (its own parent), so naive recursion
  // into every directory entry would never terminate.
  fs.symlinkSync(subdir, path.join(subdir, 'loop'), linkType)

  let result
  const start = Date.now()
  assert.doesNotThrow(() => {
    result = scanRepo(dir, new Set(['go']))
  })
  const elapsedMs = Date.now() - start

  assert.ok(elapsedMs < 5_000, `expected the symlink loop to be skipped, not traversed (took ${elapsedMs}ms)`)
  // Only the one real file, reached once -- the symlink back into the same
  // directory must not cause real.go to be re-counted or hang the walk.
  assert.equal(result.filesScanned, 1)
})

test('planted omission: without the isSymbolicLink() skip, a self-referential symlink would recurse forever (documents WHY the guard exists, not a live revert)', () => {
  // This can't safely "undo the fix and assert it hangs" without actually
  // hanging the test run. Documented instead: allFiles() in scan.mjs must
  // check e.isSymbolicLink() before e.isDirectory() -- Node's Dirent type
  // for a symlink is platform-dependent (this machine's junction already
  // reports isDirectory():false, but that is not guaranteed on every
  // platform/symlink type), so the explicit skip is what the previous two
  // tests are actually exercising.
  const srcText = fs.readFileSync(new URL('../src/scan.mjs', import.meta.url), 'utf8')
  assert.match(srcText, /isSymbolicLink\(\)/, 'allFiles() must explicitly skip symlinks, not rely on isDirectory()/isFile() alone')
})
