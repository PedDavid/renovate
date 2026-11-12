import { z } from 'zod/v4';
import { logger } from '../../../logger/index.ts';
import { Http, HttpError } from '../../../util/http/index.ts';
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

/** Enumerate published releases, verifying all newer image tags before using them. */
export async function getImmichReleaseTags(
  repository: string,
  currentValue: string,
): Promise<string[] | null> {
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
        `${api}/repos/immich-app/immich/releases?per_page=100&page=${page}`,
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
    // Preserve the two moving Immich aliases when published. Other arbitrary
    // non-release tags cannot be discovered from the releases endpoint.
    for (const alias of ['release', 'latest']) {
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
        if (!(err instanceof HttpError) || err.statusCode !== 404) {
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
        source: outcome === 'used_api' ? 'releases_api' : 'registry_fallback',
        outcome,
        pagesFetched,
        candidatesChecked,
        tagsFound: tags.size,
      },
      'Immich GHCR Releases lookup decision',
    );
  }
}
