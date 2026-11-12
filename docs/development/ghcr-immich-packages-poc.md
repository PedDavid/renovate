# Experimental Immich GHCR Packages lookup (fork-only POC)

Set `RENOVATE_X_GHCR_IMMICH_PACKAGES=true` to try the GitHub REST Packages API for **only** `ghcr.io/immich-app/immich-server` and `ghcr.io/immich-app/immich-machine-learning`. This is off by default. Supply a classic PAT with `read:packages` via the existing `hostRules` entry for `ghcr.io` (`hostType: docker`, `username`, `password`); do not place a token in the environment flag or in a repository config. No PAT is supplied to the image build workflow. The API request uses that password only at `https://api.github.com`. Digest resolution and labels still use GHCR registry manifests.

**Correctness and cost limits:** This short-term, opt-in comparison trial searches at most **50 pages of 100 versions** per Immich image lookup (up to 5,000 versions), plus one latest-release request when it finds the current tag. It stops immediately when it has both the current tag and latest GitHub release tag. If it cannot find either, lacks credentials, or encounters an API error, it falls back to the full registry tag walk; that adds registry cost to the Packages requests already made. At the 2026-11-12 ~23:05 UTC measurement, deployed Immich v3.3.6 appeared on page 25 for immich-server and page 13 for immich-machine-learning (100 per page). Fifty pages roughly doubles the observed server depth but may be exhausted as versions accumulate. Each opted-in image could cost up to 50 GitHub REST Packages requests before registry fallback; monitor the API rate budget and decision logs. GitHub REST rate limits differ from GHCR's registry API. Observed newest-created-first order is **not a guaranteed ordering or completeness proof**: finding both endpoints does not establish that intermediate release tags were seen, nor that the latest release has been published for both containers. Ordering may change, and a current tag may appear on multiple package versions. Do not enable this in production without comparing resulting releases against registry tags.

Every opted-in Immich lookup emits one INFO event named `Immich GHCR Packages lookup decision` with `dockerRepository`, `source` (`packages_api` or `registry_fallback`), `outcome` (`used_api`, `missing_prerequisite`, `missing_current`, `missing_latest`, `api_error`, `page_limit`), `pagesFetched`, `tagsFound`, `currentTagFound`, `latestReleaseChecked`, and `latestReleaseFound`. `registry_fallback` means the datasource **will try** the normal registry tag lookup, not that it succeeded; correlate its outcome with lookup warnings and the separate `Docker registry tags pagination rate limit` logs. No token, URL, release value, headers, or raw HTTP error is logged. Zero such events means the experimental flag is not active or the lookup did not run. These events reveal cost and fallback frequency, **not** whether unseen intermediate versions were skipped; validate correctness by occasionally comparing the resulting release set against a registry walk, outside the hourly job.

For a seven-day count grouped by package and outcome in Loki:

```logql
sum by (dockerRepository, source, outcome) (
  count_over_time(
    {namespace="renovate", pod=~"my-renovate-job-pedrodavid96-media-server-.*"}
      |= "Immich GHCR Packages lookup decision" | json
    [7d]
  )
)
```

This page-limit trial has its **own** fork-only linux/amd64 image on pushes to `fork/ghcr-immich-page-limit-50`: `ghcr.io/peddavid/renovate:ghcr-immich-page-limit-50-<12-char-sha>-full`. It is distinct from the PR #2 image (`ghcr-packages-api-<12-char-sha>-full`) and the separate release-driven trial. The flag is not enabled at build time; if opted in, the helper is scoped to those two Immich images only. Do not deploy without checking the resulting releases against registry tags. The branch is stacked on the auth-probe monitoring and bounded pagination retry trial (PRs #3/#4); it is not a substitute for checking those outcomes separately.
