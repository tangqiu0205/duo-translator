# Local webpage language filtering

Webpage requests share one skip set: configured excluded languages plus the target language. Chinese script variants remain distinct so Simplified ↔ Traditional conversion is not skipped. Explicit manual paragraph gestures retain their existing bypass.

## Implemented stages

1. **Candidate-only review:** use reliable whole-paragraph evidence first. If that language cannot skip, translate immediately without statistical sentence review. Page-level language identification still requires a homogeneous result.
2. **Bounded evidence reuse:** paragraph and fragment evidence have separate cache keys. Stronger paragraph evidence may serve a fragment, never the reverse. The 512-entry cache is LRU and stores language evidence, not setting-dependent skip verdicts. Identical fragments reuse evidence. Any uncertain or non-skippable fragment stops review. Different sentence languages may all skip if each is in the skip set. Unambiguous ASCII HTTP(S) URL tokens and numeric-only fragments need no natural-language review. Full-width prose punctuation terminates a URL token; raw Unicode inside a candidate is retained rather than guessing its boundary. Paths and short technical words are not exempt. Paired single quotes are recognized without splitting ordinary apostrophes.
3. **Measurement before tuning:** added an offline A/C harness and a hand-labelled synthetic corpus. Existing length/confidence thresholds are unchanged; the available small sample does not justify relaxing them.

The shared 1500ms deadline uses a monotonic clock and includes native-detector queue waiting and fragment review. Cancellation propagates; expired queued work is removed. Timed-out results and late browser replies are not cached. The browser API itself is not cancellable: stopping our wait cannot physically stop an already-running browser operation. Source/config changes are handled by the existing content-script invalidation/re-scheduling guards.

## Reproduce the evaluation

```sh
node scripts/benchmark-language-filter.mjs
```

Requires the Chromium installation already used by the Playwright suite. Uses the project's existing WXT/Vite and Playwright dependencies; no extra model or package is downloaded. A disposable minimal extension exposes only local `chrome.i18n.detectLanguage`; HTTP(S) requests are blocked, there are no translation-provider calls, and the user's extension/profile is not loaded. Temporary files are removed on completion.

Output: `.output/language-filter-benchmark.json`. The pre-optimization A reference is frozen in `main/__tests__/fixtures/localLanguageDetectionA.ts`; it is evaluation-only and must never be imported into production.

### Initial measurement

Chromium 149.0.7827.55, 2026-11-18. Thirty manually labelled **synthetic** paragraphs, five iterations per strategy/mode/cache condition (150 observations per group, not 150 independent paragraphs). Cold clears evidence before each paragraph; warm measures an immediate repeat after an unmeasured priming call.

| Metric | A | C |
| --- | ---: | ---: |
| Cold browser calls per paragraph, mean | 1.13 | 0.83 |
| Cold browser calls per paragraph, P95 | 4 | 3 |
| Cold paragraph detection time, P95 | 0.6ms | 0.5ms |
| Warm browser calls | 0 | 0 |
| Cold francAll calls, 150 observations | 80 | 80 |
| Cold francAll-only synchronous time, total | 59.1ms | 61.0ms |
| Cold franc-mode paragraph time, P95 | 1.1ms | 1.1ms |

The browser-call mean fell about 26.5% in this corpus. These sub-millisecond timings are timer-resolution/noise sensitive; they do not establish a production latency win. The fallback-only results show no meaningful speed improvement. More skipping is not automatically better: inspect labelled false skips rather than just the skip fraction.

### Known accuracy boundary

Both A and C can misclassify a long English sentence followed by an unpunctuated short `Bonjour le monde` tail as entirely English and skip it when English is excluded. C fixes the single-quoted short-tail case in this corpus, but does not solve arbitrary same-script, same-sentence code-switching. Mixed scripts are conservatively translatable; Chinese/Japanese sentence boundaries can be reviewed separately when whole-paragraph evidence creates a skip candidate. Shared Han alone is not proof of Chinese.

The harness reports labelled false-skip IDs and exits unsuccessfully if C introduces a new false-skip ID relative to A in the same mode/cache condition. Passing means **no new case in this corpus**, not zero false skips or real-web accuracy certification.

## Public-web corpus and page replay

```sh
node scripts/collect-language-filter-corpus.mjs
node scripts/benchmark-language-filter.mjs --web
node scripts/benchmark-language-filter-page.mjs
```

The collector reads `benchmarks/language-filter/sources.json` and writes `.output/language-filter-web-corpus.json` with source URLs, licenses and capture hashes. It writes partial results but exits nonzero if any fetch fails or fewer than 2,000 unique paragraphs are available. For exact repeatability, retain the captured JSON; live articles can change. The two benchmark commands use those local snapshots. The page benchmark builds a disposable extension with test-only probes and intercepts all provider requests. No production telemetry was added.

### Paragraph comparison

Chromium 149, 24 of 28 Wikipedia URLs fetched, 2,308 unique paragraphs across nine language settings. Four fetches failed (two Korean and two Simplified Chinese); the sample is skewed toward European languages. The page language is an approximate source label, not a manually assigned label for every paragraph. Neither scenario measures the true false-skip rate.

| Exclusion scenario, Chromium native detector | A | C |
| --- | ---: | ---: |
| Different language: native calls per paragraph | 2.50 | 0.74 |
| Different language: paragraph P95 | 0.9ms | 0.3ms |
| Different language: skipped paragraphs | 0 | 0 |
| Source language excluded: native calls per paragraph | 2.50 | 2.50 |
| Source language excluded: skipped paragraphs | 1,372 | 1,366 |

C introduced no new skip decisions in these native or fallback runs. In the source-language/native run, C sent six extra paragraphs; inspection of the changed cases showed short single-quoted terms or names. Fallback-only different-language calls: 2,267 → 1,714. These observations do not establish the absolute accuracy of either strategy. Full results: `.output/language-filter-web-benchmark.json`.

### Replay through the translation pipeline

Nine local pages rebuilt from public article text with one foreign control and 24 source-language paragraphs each. Two passes per page and mode, each on a fresh document followed by restore/retranslate on the same document. Renderer CPU is Chromium thread-tick task time for the measured page pipeline, not browser-process detector CPU. The first-render timestamp records the first translation DOM insertion. Original site scripts, styling, and live provider latency are not included.

| Mode | First result cold P50/P95 | First result warm P50/P95 | Renderer CPU P50 cold/warm | Long tasks cold/warm | Mock HTTP requests per condition | Paragraphs sent per condition |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| No language filtering | 74.8/90.0ms | 87.2/115.5ms | 58.6/30.2ms | 0/0 | 130 | 450 |
| A | 82.2/130.3ms | 84.9/124.2ms | 69.0/25.8ms | 1/0 | 106 | 238 |
| C | 81.4/117.7ms | 89.6/175.0ms | 75.9/27.2ms | 1/0 | 106 | 238 |

Both filters removed 47% of submitted paragraphs but only 18% of HTTP requests because requests are batched. Cold cache had no hits on these unique snapshots. Immediate replay reused all measured lookups (A: 450/450 paragraph verdict lookups; C: 1,088/1,088 evidence lookups). These are different lookup types and not production cache-hit rates. There is no stable first-render or total CPU improvement in this small end-to-end experiment. Full results: `.output/language-filter-page-benchmark.json`.

**Threshold decision:** unchanged. The evidence supports candidate-only review for reducing detector calls, not more aggressive filtering. A multilingual per-paragraph gold set with more short, mixed-language and non-Wikipedia text is still needed before loosening any thresholds.
