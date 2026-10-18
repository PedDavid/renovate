import { z } from 'zod/v4';
import { logger } from '../../../logger/index.ts';
import * as hostRules from '../../../util/host-rules.ts';
import { Http } from '../../../util/http/index.ts';

const packageVersion = z.object({
  metadata: z.object({ container: z.object({ tags: z.array(z.string()) }) }),
});
const packageVersions = z.array(packageVersion);
const latestRelease = z.object({ tag_name: z.string() });
const http = new Http('github');
const api = 'https://api.github.com';

/** Experimental, bounded newest-first lookup for the two Immich GHCR packages. */
export async function getImmichPackageTags(
  repository: string,
  currentValue: string,
): Promise<string[] | null> {
  if (
    repository !== 'immich-app/immich-server' &&
    repository !== 'immich-app/immich-machine-learning'
  ) {
    return null;
  }

  // Reuse the operator's read:packages classic PAT, not the registry's short-lived
  // bearer token. Only send it to the fixed GitHub API origin.
  const credential = hostRules.find({
    hostType: 'docker',
    url: 'https://ghcr.io/v2/',
  }).password;
  const tags = new Set<string>();
  let pagesFetched = 0;
  let latestReleaseChecked = false;
  let latestReleaseFound = false;
  function logDecision(outcome: string): void {
    // Emit one event per lookup, not per page. Never log URLs, raw errors, or
    // response headers: the request's authorization header contains the PAT.
    logger.info(
      {
        dockerRepository: repository,
        source: outcome === 'used_api' ? 'packages_api' : 'registry_fallback',
        outcome,
        pagesFetched,
        tagsFound: tags.size,
        currentTagFound: tags.has(currentValue),
        latestReleaseChecked,
        latestReleaseFound,
      },
      'Immich GHCR Packages lookup decision',
    );
  }
  if (!credential || !currentValue) {
    logDecision('missing_prerequisite');
    return null;
  }

  const headers = {
    authorization: `token ${credential}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  try {
    // This is an observed order, NOT a documented API contract. Bound the
    // experiment; if we cannot establish a stopping point, use registry v2.
    for (let page = 1; page <= 10; page += 1) {
      const url = `${api}/orgs/immich-app/packages/container/${repository.split('/')[1]}/versions?per_page=100&page=${page}`;
      const response = await http.getJson(
        url,
        { headers, noAuth: true },
        packageVersions,
      );
      pagesFetched += 1;
      const versions = response.body;
      for (const version of versions) {
        for (const tag of version.metadata.container.tags) {
          tags.add(tag);
        }
      }
      if (tags.has(currentValue)) {
        // Check the authoritative latest release, so an out-of-order page
        // cannot silently hide the newest published release tag.
        const release = await http.getJson(
          `${api}/repos/immich-app/immich/releases/latest`,
          { headers, noAuth: true },
          latestRelease,
        );
        latestReleaseChecked = true;
        latestReleaseFound = tags.has(release.body.tag_name);
        if (latestReleaseFound) {
          logDecision('used_api');
          return [...tags];
        }
        logDecision('missing_latest');
        return null;
      }
      if (versions.length < 100) {
        logDecision('missing_current');
        return null;
      }
    }
  } catch {
    // Avoid logging HTTP errors: they may contain request headers with the PAT.
    logDecision('api_error');
    return null;
  }
  logDecision('page_limit');
  return null;
}
