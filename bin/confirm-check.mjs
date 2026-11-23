#!/usr/bin/env node
// confirm-check -- scans an AI coding agent / terminal-UI repo for the
// "terminal confirmation spoofing" asymmetry: a render call on untrusted
// text that skips the sanitize step a sibling render call in the same
// codebase already uses. See README.md for the full background and the
// seven real cases this pattern came from (one confirmed/shipped so far,
// six reported and still pending review as of 2026-11-23).
import { scanRepo } from '../src/scan.mjs'

// Exit codes, so a CI pipeline can branch on this instead of parsing text:
//   0 = clean scan (no risk found)
//   1 = risk found (see the report)
//   2 = the scan itself could not run (bad/missing argument, path does not
//       exist or is not a directory) -- never conflated with 0, which would
//       make a mistyped path look like an honest clean result.
const EXIT_CLEAN = 0
const EXIT_RISK_FOUND = 1
const EXIT_SCAN_ERROR = 2

function helpText() {
  return [
    'confirm-check -- static scanner for terminal confirmation-prompt spoofing',
    '("Terminal DiLLMa": untrusted text rendered into a human Allow/Deny',
    'confirmation prompt without ANSI-escape / control-character stripping).',
    '',
    'Usage:',
    '  confirm-check <repo-path> [--ext tsx,jsx,rs,py,go,ts,js,mjs,cjs]',
    '',
    'Arguments:',
    '  <repo-path>   Path to the repository (directory) to scan.',
    '',
    'Options:',
    '  --ext <list>  Comma-separated file extensions to scan.',
    '                Default: tsx,jsx,rs,py,go,ts,js,mjs,cjs',
    '  --help, -h    Show this help text and exit.',
    '',
    'Exit codes:',
    '  0  Clean scan: no risk found.',
    '  1  Risk found: see the report above for details.',
    '  2  The scan could not run (missing/invalid path argument).',
    '',
    'A hit is a candidate to verify by hand, not a confirmed finding -- see',
    'README.md, "Known limitations".',
  ].join('\n')
}

function usage() {
  console.error('Usage: confirm-check <repo-path> [--ext tsx,rs,py,go]')
  console.error('Run confirm-check --help for details.')
  process.exit(EXIT_SCAN_ERROR)
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(helpText())
    process.exit(EXIT_CLEAN)
  }

  const repoPath = argv[0]
  if (!repoPath) usage()

  const extIdx = argv.indexOf('--ext')
  const extFilter =
    extIdx >= 0 && argv[extIdx + 1] ? new Set(argv[extIdx + 1].split(',').map((e) => e.trim().toLowerCase())) : undefined

  let result
  try {
    result = scanRepo(repoPath, extFilter)
  } catch (err) {
    // A bad path must never read the same as a real clean scan: the
    // previous version let scanRepo silently return 0 files here, which
    // made "you typed the path wrong" and "this repo is genuinely clean"
    // print the identical "No risk found" message -- the worst failure
    // mode for a security tool (false confidence, not a crash).
    console.error(`Error: ${err.message}`)
    process.exit(EXIT_SCAN_ERROR)
  }
  const { withinFile, crossLayer, standalone, filesScanned, skippedFiles } = result

  console.log(`Scanned ${filesScanned} file(s) in ${repoPath}.\n`)
  if (skippedFiles > 0) {
    console.log(
      `Skipped ${skippedFiles} file(s)/director${skippedFiles === 1 ? 'y' : 'ies'} due to read errors` +
        ' (e.g. a permission denied) -- this scan is not complete; a hit below is still valid, but a' +
        ' clean result is weaker than usual.\n'
    )
  }

  if (standalone.size) {
    console.log(`${standalone.size} file(s) with a STANDALONE risk (confirm/approve/elicit-named function, no sibling needed):\n`)
    for (const [filePath, risks] of standalone) {
      console.log(`[standalone] ${filePath}`)
      for (const r of risks) console.log(`    line ${r.line}: ${r.text}`)
    }
    console.log()
  }

  if (withinFile.size === 0 && crossLayer.length === 0 && standalone.size === 0) {
    console.log('No risk found, at any layer.')
  } else if (withinFile.size === 0 && crossLayer.length === 0) {
    // standalone-only result already printed above
  } else {
    if (withinFile.size) {
      console.log(`${withinFile.size} file(s) with a WITHIN-FILE asymmetry (high confidence):\n`)
      for (const r of withinFile.values()) {
        console.log(`[within-file] ${r.path}`)
        for (const k of r.candidates) console.log(`    line ${k.line} [${k.status}] ${k.expr}`)
      }
    }
    for (const { name, hits } of crossLayer) {
      console.log(`\n${hits.length} file(s) with an asymmetry across ${name} (lower confidence, could be a deliberate design choice):\n`)
      for (const r of hits) {
        console.log(`[${name}] ${r.path}`)
        for (const k of r.candidates.filter((k) => k.status === 'unsanitized')) console.log(`    line ${k.line} [unsanitized] ${k.expr}`)
      }
    }
  }

  console.log(
    '\nThis is a candidate list, not a confirmed finding. LIMITATION: origin tracing only looks' +
      ' one step back (a direct assignment or a callback/function parameter) -- a value sanitized' +
      ' several steps away through a .map()/.filter() chain can be missed (false negative).' +
      ' Confirm every hit by hand: read the actual dataflow before reporting it.'
  )

  const riskFound = standalone.size > 0 || withinFile.size > 0 || crossLayer.length > 0
  process.exit(riskFound ? EXIT_RISK_FOUND : EXIT_CLEAN)
}

main()
