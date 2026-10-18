# Experimental Immich GHCR Packages lookup (fork-only POC)

Set `RENOVATE_X_GHCR_IMMICH_PACKAGES=true` to try the GitHub REST Packages API for **only** `ghcr.io/immich-app/immich-server` and `ghcr.io/immich-app/immich-machine-learning`. This is off by default. Supply a classic PAT with `read:packages` via the existing `hostRules` entry for `ghcr.io` (`hostType: docker`, `username`, `password`); do not place a token in the environment flag or in a repository config. No PAT is supplied to the image build workflow. The API request uses that password only at `https://api.github.com`. Digest resolution and labels still use GHCR registry manifests.

**Correctness limitation:** GitHub does not guarantee Packages version ordering. Observed results are newest-created-first; this experiment stops when it has seen the current tag and the latest GitHub release tag, within 10 pages of 100 versions. If either is absent, credentials are missing, or the API fails, it falls back to the existing full registry tag walk. This check does **not** prove that every intermediate release tag was seen, nor that GitHub's latest release has already been published for both containers. The API can change ordering without warning, and a current tag may appear on multiple package versions. Do not enable this in production without checking resulting releases against registry tags. Rate limits for the GitHub REST API differ from GHCR's registry API.

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

The independent fork test image is built on pushes to `fork/ghcr-packages-api` as `ghcr.io/peddavid/renovate:ghcr-packages-api-<12-char-sha>-full` (linux/amd64). The flag is not enabled at build time. The branch is stacked on the auth-probe monitoring and bounded pagination retry trial (PRs #3/#4); it is not a substitute for checking those outcomes separately.
