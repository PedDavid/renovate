# Experimental GHCR discovery from GitHub releases

`dockerTagDiscovery` is an **opt-in** alternative to registry tag enumeration for a
GHCR image whose published GitHub releases use the **same version tags** as its
container images. The default Docker datasource is unchanged. This is not a
complete registry tag list: unpublished container tags are intentionally
invisible, and a successful release API response does **not** trigger a fallback
just because an unpublished tag might exist.

Configure per image using a package rule (the example syntax is implemented by
this fork, not upstream Renovate):

```json
{
  "packageRules": [
    {
      "matchDatasources": ["docker"],
      "matchPackageNames": [
        "ghcr.io/immich-app/immich-server",
        "ghcr.io/immich-app/immich-machine-learning"
      ],
      "dockerTagDiscovery": {
        "source": "github-releases",
        "repository": "immich-app/immich",
        "coverage": "published-releases-only",
        "fallbackOnError": "registry",
        "movingTags": ["release", "latest"]
      }
    }
  ]
}
```

The source GitHub repository must be explicitly configured; it is never
inferred from a GHCR image path. `movingTags` is optional and defaults to no
aliases. Only GHCR images are supported by this trial. The input must be a
version recognized by the Docker versioning module; otherwise discovery falls
back to the registry. This does not implement templated release-to-image tag
mapping: release and image version tags must match exactly.

The bounded lookup (20 release pages, 100 newer candidates) enumerates all
published releases, including prereleases, excluding drafts and invalid
version tags. It obtains GHCR bearer auth and checks each newer candidate
with `HEAD /v2/<image>/manifests/<tag>`; configured moving tags are checked
separately. A failed release request, incomplete pagination, exceeded bound,
failed manifest probe, or failed alias probe requests the **registry tag walk**
directly. A 404 on an alias only means that alias is absent. Registry manifest
and architecture-specific digest resolution remain in the existing Docker
datasource. A release API success is not evidence of completeness relative to
the registry; compare results periodically outside the scheduled job.

This policy has precedence over the existing experimental Immich-only
environment flags when configured for an image. Its fallback goes directly to
registry `tags/list`, not through the Immich Packages API experiment. With no
`dockerTagDiscovery` setting, the existing Immich trials and default Docker
behaviour remain unchanged. No infrastructure configuration or image is
switched by this code alone.

Each opted-in lookup logs one `Docker GitHub Releases lookup decision` event
with `dockerRepository`, `releaseRepository`, `coverage`, `source`, `outcome`,
`pagesFetched`, and `candidatesChecked`. `source=registry_fallback` means a
registry lookup was **requested**, not that it succeeded. Raw HTTP errors,
response headers, credentials and tokens are not logged. The old Immich flag
continues to emit `Immich GHCR Releases lookup decision` for compatibility.

[Implementation](../../lib/modules/datasource/docker/ghcr-releases.ts) ·
[Docker dispatch](../../lib/modules/datasource/docker/index.ts) ·
[prior Immich trial](https://github.com/PedDavid/renovate/pull/6)
