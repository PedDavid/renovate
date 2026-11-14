# LSCR MariaDB tag-page 429 retry trial

This fork-only trial extends the existing bounded GHCR Immich tag-pagination
retry to **only** `https://lscr.io/v2/linuxserver/mariadb/tags/list`. It addresses
the observed first-page 429 and the later-cursor 429 separately from `/v2/`
auth probing, HTTP `Retry-After`, and Docker tag discovery for other images.

After HTTP-level retries are exhausted, retry the **same failed tag-list URL**
up to twice with 1s then 2s backoff. The whole tag walk has a six-extra-request
budget. On success, continue pagination without discarding earlier pages. On a
persistent 429, throw the original error; do not silently return partial tags.
Other statuses and other LSCR images retain the original behavior. The
`Docker registry tags pagination rate limit` event records `registryHost`,
`dockerRepository`, extra `retries`, and `outcome` (`recovered` or `exhausted`)
without logging credentials, raw errors or the request URL.

This reduces transient failures, not the registry's rate limit or the size of
the tag walk. The branch builds a separately tagged full-image trial; changing
a deployed RenovateJob's image back to the prior pinned digest reverts it.
