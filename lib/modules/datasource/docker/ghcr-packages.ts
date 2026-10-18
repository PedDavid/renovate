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
  if (!credential || !currentValue) {
    logger.debug('GHCR packages POC needs a GHCR password and current tag');
    return null;
  }

  const headers = {
    authorization: `token ${credential}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  const tags = new Set<string>();
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
        const { tag_name: latest } = release.body;
        if (tags.has(latest)) {
          logger.debug(`GHCR packages POC stopped at page ${page}`);
          return [...tags];
        }
        break;
      }
      if (versions.length < 100) {
        break;
      }
    }
  } catch {
    // Avoid logging HTTP errors: they may contain request headers with the PAT.
    logger.debug('GHCR packages POC failed; using registry tags');
    return null;
  }
  logger.debug('GHCR packages POC cannot validate tags; using registry tags');
  return null;
}
