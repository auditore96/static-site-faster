# Static Site Faster

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/auditore96/static-site-faster/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/auditore96/static-site-faster/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0, entered in the make.fun bounty
[Build a static site faster, 22 November 2026](https://make.fun/bounty/site-generator-speed-01-run-20261122).

`solve.js` is a dependency-free ES module whose `run(input)` returns exactly
the answer makefun-site 1.0.0 returns for one case — the output tree (every
page's `index.html`, the index and tag pages, `build-report.txt`, each static
file), byte for byte. `main.ts` is the harness driver: it reads every case
from `/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

## How it is faster

The reference spends ~39% of its CPU calling `escapeHtml` once per character
inside its inline renderer, and materialises a token object for every
Markdown block. This implementation keeps every byte-exact rule of the
reference (front-matter grammar and refusal order, Markdown subset quirks,
template dialect, slug rule, report format) and changes only the mechanics:

- **Inline rendering**: one native regexp scan finds the next interesting
  character; each plain run is appended verbatim (it holds no escapable
  character by construction) instead of escaping character by character.
- **Fused lex + render**: blocks are classified and rendered in a single
  pass over the lines — no token objects, no second pass — with a
  first-character dispatch that skips the per-line regexes for most lines.
- **No repeated work**: `wordsOf` counts with an `exec` loop instead of
  building an array of every word; `trimLine` has a fast path for lines
  with no leading/trailing spaces/tabs; `escapeHtml` returns early for
  strings holding no escapable character.
- **Per-run caches only**: slugify results, long dates and link resolutions
  are cached inside each `run()` call (nothing is cached across cases, as
  the rules require); a post's card — including its reading time — is
  computed once instead of twice.
- **Chunk-array string building**: rendered units accumulate in arrays and
  are joined once, never `out += char`.
- **Templates**: parsed once per case into an AST; rendering walks the tree
  with pre-split paths, reused per-iteration scope objects, and chunk
  arrays. (A `new Function` codegen variant was tried and measured slower
  than the walker — V8 optimises the long-lived walker better than
  freshly compiled functions — so the walker ships.)

## Verification

- Practice set (3 cases): output identical to the house baseline and to
  `practice/reference/expected.json`, on Node 24 and on Node 22.23.4 (the
  grader's version).
- 18 freshly generated cases (the kit's own generator, new seeds, all size
  bands): identical to the baseline.
- Hand-written adversarial cases (every front-matter refusal kind, unclosed
  fence/code/strong/em, `***x*`, deep include chains, `for loop in …`,
  static shadowing, zero posts, missing templates, Unicode slugs): identical.
- Two consecutive driver runs produce byte-identical `answers.json`.

## Speed (local, CPU time per 3-case practice set)

| runtime | house baseline `run()` | this `run()` |
| --- | --- | --- |
| Node 24.22.1 | ~540–600 ms | ~166 ms |
| Node 22.23.4 | ~595–670 ms | ~200 ms |

About **3.3–3.6× faster** on `run()`; the driver overhead (JSON parse /
stringify, startup) is the same for every entry.

## Layout

- `main.ts` — harness driver (unchanged from the house baseline)
- `solve.js` — the faster implementation
- `package.json` — `{"type": "module"}` so `solve.js` loads as ESM

## License

MIT. The reference program this replaces is make.fun's makefun-site 1.0.0
(MIT, derived from metalsmith 2.7.0 and marked 18.2.1); this
implementation was written from scratch from its stated rules and its
reference code's semantics.
