import { z } from 'zod/v4';
import type { DockerReleaseDiscoveryConfig } from '../../../config/types.ts';
import { logger } from '../../../logger/index.ts';
import { coerceArray } from '../../../util/array.ts';
import { Http, HttpError } from '../../../util/http/index.ts';
import { regEx } from '../../../util/regex.ts';
import { api as dockerVersioning } from '../../versioning/docker/index.ts';
import { getAuthHeaders } from './common.ts';

const github = new Http('github');
const registry = new Http('docker');
const releases = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
  }),
);
const api = 'https://api.github.com';
const maxPages = 20;
const maxCandidates = 100;
const discoveryConfig = z.strictObject({
  source: z.literal('github-releases'),
  repository: z
    .string()
    .regex(regEx(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/))
    .refine((repo) =>
      repo.split('/').every((segment) => segment !== '.' && segment !== '..'),
    ),
  coverage: z.literal('published-releases-only'),
  fallbackOnError: z.literal('registry'),
  movingTags: z
    .array(z.string().regex(regEx(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/)))
    .max(4)
    .refine((tags) => new Set(tags).size === tags.length)
    .optional(),
});

/** Enumerate published releases, verifying all newer image tags before using them. */
export async function getGithubReleaseTags(
  repository: string,
  currentValue: string,
  config: DockerReleaseDiscoveryConfig,
  logEvent = 'Docker GitHub Releases lookup decision',
): Promise<string[] | null> {
  // Never let a configuration value change the GitHub API origin or inject a URL path.
  const discovery = discoveryConfig.parse(config);
  const tags = new Set<string>([currentValue]);
  let pagesFetched = 0;
  let candidatesChecked = 0;
  let outcome = 'used_api';
  try {
    if (!dockerVersioning.isValid(currentValue)) {
      outcome = 'invalid_current';
      return null;
    }

    const candidates = new Set<string>();
    let exhausted = false;
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await github.getJson(
        `${api}/repos/${discovery.repository}/releases?per_page=100&page=${page}`,
        {},
        releases,
      );
      pagesFetched += 1;
      for (const release of response.body) {
        // GitHub releases (including prereleases) are published independently
        // of Docker tags. Drafts and non-Docker version tags are not candidates.
        if (
          !release.draft &&
          dockerVersioning.isValid(release.tag_name) &&
          dockerVersioning.isGreaterThan(release.tag_name, currentValue)
        ) {
          candidates.add(release.tag_name);
        }
      }
      if (
        response.body.length < 100 &&
        !response.headers.link?.includes('rel="next"')
      ) {
        exhausted = true;
        break;
      }
    }
    if (!exhausted) {
      outcome = 'page_limit';
      return null;
    }

    if (candidates.size > maxCandidates) {
      outcome = 'candidate_limit';
      return null;
    }

    const headers = await getAuthHeaders(
      registry,
      'https://ghcr.io',
      repository,
    );
    if (!headers) {
      outcome = 'registry_auth_error';
      return null;
    }
    headers.accept = [
      'application/vnd.oci.image.index.v1+json',
      'application/vnd.oci.image.manifest.v1+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
      'application/vnd.docker.distribution.manifest.v2+json',
    ].join(', ');
    // Sequential requests bound GHCR load and avoid a publication race being
    // mistaken for a complete release set. Never probe historical releases.
    for (const tag of candidates) {
      candidatesChecked += 1;
      try {
        await registry.head(
          `https://ghcr.io/v2/${repository}/manifests/${tag}`,
          {
            headers,
            noAuth: true,
          },
        );
      } catch {
        outcome = 'missing_or_unavailable_manifest';
        return null;
      }
      tags.add(tag);
    }
    // Only explicitly configured moving aliases are checked. Arbitrary
    // non-release tags cannot be discovered from the releases endpoint.
    for (const alias of coerceArray(discovery.movingTags)) {
      try {
        await registry.head(
          `https://ghcr.io/v2/${repository}/manifests/${alias}`,
          {
            headers,
            noAuth: true,
          },
        );
        tags.add(alias);
      } catch (err) {
        if (!(err instanceof HttpError) || err.response?.statusCode !== 404) {
          outcome = 'alias_probe_error';
          return null;
        }
      }
    }
    return [...tags];
  } catch {
    // Never log raw HTTP errors: they may contain request credentials.
    outcome = 'api_or_registry_error';
    return null;
  } finally {
    logger.info(
      {
        dockerRepository: repository,
        releaseRepository: discovery.repository,
        coverage: discovery.coverage,
        source: outcome === 'used_api' ? 'releases_api' : 'registry_fallback',
        outcome,
        pagesFetched,
        candidatesChecked,
        tagsFound: tags.size,
      },
      logEvent,
    );
  }
}

/** Keep the existing Immich trial and its log event unchanged. */
export async function getImmichReleaseTags(
  repository: string,
  currentValue: string,
): Promise<string[] | null> {
  return getGithubReleaseTags(
    repository,
    currentValue,
    {
      source: 'github-releases',
      repository: 'immich-app/immich',
      coverage: 'published-releases-only',
      fallbackOnError: 'registry',
      movingTags: ['release', 'latest'],
    },
    'Immich GHCR Releases lookup decision',
  );
}
