// scan.mjs -- walks a repo and runs the asymmetry detector at three layers,
// from highest to lowest confidence: within one file, across files in the
// same directory, and across NEIGHBORING directories (same parent). The
// third layer matters: in a real case (github/cli), pkg/cmd/pr/view/view.go
// never sanitizes pr.Title/pr.Body, but pkg/cmd/pr/diff/diff.go -- a
// NEIGHBOR directory, not the same one -- does use a sanitize mechanism.
// They only share a grandparent directory (pr/).
import fs from 'node:fs'
import path from 'node:path'
import { analyzeDirectory, analyzeFile } from './detector.mjs'

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', 'lib', 'target', 'out', '.next'])
const IGNORE_TEST_FILE = /[\\/](test|tests|__tests__)[\\/]|\.test\.|\.spec\./i
const IGNORE_FILENAME = /\.min\.(js|mjs)$|[.-]bundle\.(js|mjs)$/i
export const DEFAULT_EXT = new Set(['tsx', 'jsx', 'rs', 'py', 'go', 'ts', 'js', 'mjs', 'cjs'])

function looksBundled(content) {
  const lines = content.split('\n')
  if (lines.length < 3) return false
  return content.length / lines.length > 300
}

function* allFiles(dir, extFilter, stats) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    // The top-level call only reaches here if the directory became
    // unreadable between scanRepo's own statSync check and this call (a
    // race) or a permission change -- scanRepo validates the top path
    // exists and is a directory before ever calling this. A deeper call
    // reaching here is a subdirectory that turned unreadable mid-walk
    // (e.g. permission denied). Either way: counted, not silently dropped.
    stats.skipped++
    return
  }
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue
    // Never follow a symlink, file or directory: Node's Dirent type for a
    // symlink is platform-dependent (whether isDirectory()/isFile() reads
    // the link or its target varies), so relying on that implicitly to
    // avoid a symlink loop (a repo with a directory symlinked to itself or
    // an ancestor) isn't something this code can prove safe across
    // platforms. Skipping every symlink outright removes the ambiguity.
    if (e.isSymbolicLink()) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      yield* allFiles(full, extFilter, stats)
    } else if (e.isFile()) {
      const ext = path.extname(e.name).slice(1).toLowerCase()
      if (extFilter.has(ext) && !IGNORE_TEST_FILE.test(full) && !IGNORE_FILENAME.test(e.name)) yield { path: full, ext }
    }
  }
}

function groupBy(files, depthFn) {
  const groups = new Map()
  for (const f of files) {
    const key = depthFn(f.path)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(f)
  }
  return groups
}

/** repoPath: string, extFilter?: Set<string> ->
 *  {withinFile: Map, crossLayer: [{name, hits}], standalone: Map,
 *   filesScanned: number, skippedFiles: number}
 *  Throws if repoPath does not exist or is not a directory -- the caller
 *  (bin/confirm-check.mjs) must not let that collapse into the same "0
 *  files, no risk found" message a real clean scan produces: a mistyped
 *  path and an honest clean scan need to be distinguishable, or a security
 *  tool's silence reads as "safe" when it never actually looked. */
export function scanRepo(repoPath, extFilter = DEFAULT_EXT) {
  let stat
  try {
    stat = fs.statSync(repoPath)
  } catch {
    throw new Error(`Path not found: ${repoPath}`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${repoPath}`)
  }

  const stats = { skipped: 0 }
  const all = []
  for (const f of allFiles(repoPath, extFilter, stats)) {
    let content
    try {
      content = fs.readFileSync(f.path, 'utf8')
    } catch {
      // Permission-denied (or a file removed mid-walk) on an individual
      // file: counted as skipped, not silently dropped -- see
      // skippedFiles below and its use in bin/confirm-check.mjs.
      stats.skipped++
      continue
    }
    if (looksBundled(content)) continue
    all.push({ ...f, content })
  }

  const layers = [
    { name: 'within-directory', depthFn: (p) => path.dirname(p) },
    { name: 'neighboring directories (same parent)', depthFn: (p) => path.dirname(path.dirname(p)) },
  ]

  const withinFile = new Map()
  const crossLayer = []
  const standalone = new Map()
  const analyzedForStandalone = new Set()
  for (const { name, depthFn } of layers) {
    const hits = []
    for (const [, files] of groupBy(all, depthFn)) {
      if (files.length < 2) continue
      const { perFile, crossFileAsymmetry } = analyzeDirectory(files)
      for (const r of perFile) {
        if (r.asymmetry) withinFile.set(r.path, r)
        if (r.standaloneRisks?.length) standalone.set(r.path, r.standaloneRisks)
        analyzedForStandalone.add(r.path)
      }
      for (const p of crossFileAsymmetry) {
        const r = perFile.find((x) => x.path === p)
        if (!r.asymmetry && !withinFile.has(p)) hits.push(r)
      }
    }
    if (hits.length) crossLayer.push({ name, hits })
  }

  // A lone file in a directory (groupBy above skips groups of size 1)
  // still deserves a standalone-risk check -- that rule needs no sibling.
  for (const f of all) {
    if (analyzedForStandalone.has(f.path)) continue
    const { standaloneRisks } = analyzeFile(f.content, f.ext)
    if (standaloneRisks.length) standalone.set(f.path, standaloneRisks)
  }

  return { withinFile, crossLayer, standalone, filesScanned: all.length, skippedFiles: stats.skipped }
}
