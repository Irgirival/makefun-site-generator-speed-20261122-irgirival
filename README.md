# makefun-site-generator-speed — fast drop-in for makefun-site 1.0.0

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Irgirival/makefun-site-generator-speed-20261122-irgirival/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Irgirival/makefun-site-generator-speed-20261122-irgirival/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

Entry for make.fun competition `site-generator-speed-01-run-20261122`.

`solve.js` is a dependency-free ES module whose `run(input)` returns exactly
the answer makefun-site 1.0.0 returns for the same input: the output tree
(every page's `index.html`, the index and tag pages, `build-report.txt` and
each static file), byte for byte — but faster. It is written from the
makefun-site README and the reference's observable behaviour, with its own
parsing and rendering shaped for speed: a single cursor pass over Markdown
with no token objects, range-based inline rendering with bulk escaping,
memoised slugs/dates/link resolutions, and a template renderer that walks a
flat node list into one shared parts array.

Measured on the practice set (3 sites, 250–480 sources each, Node 24,
`--no-incremental-marking`): median **~132 ms per pass vs ~611 ms for the
house baseline — about 4.6× faster**. Correctness verified byte-identical
(canonical JSON) on the practice set and on 180 freshly generated sites plus
16 hand-built adversarial cases (template errors, deep include chains,
front-matter refusals, Markdown torture, slug collisions, Unicode).

`main.ts` is the harness driver: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

## Layout

- `solve.js` — the fast implementation (the entry)
- `main.ts` — the driver
- `package.json`, `LICENSE`, `README.md`
