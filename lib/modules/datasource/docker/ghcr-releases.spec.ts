import * as httpMock from '~test/http-mock.ts';
import { logger } from '~test/util.ts';
import { getGithubReleaseTags, getImmichReleaseTags } from './ghcr-releases.ts';

const repository = 'immich-app/immich-server';
const github = 'https://api.github.com';
const ghcr = 'https://ghcr.io/v2';

function releases(page: number, body: unknown[], status = 200): void {
  httpMock
    .scope(github)
    .get(`/repos/immich-app/immich/releases?per_page=100&page=${page}`)
    .reply(status, body);
}

function manifest(tag: string, status = 200): void {
  httpMock.scope(ghcr).head(`/${repository}/manifests/${tag}`).reply(status);
}

function registry(): void {
  httpMock.scope(ghcr).get('/').reply(200, {});
}

function aliases(): void {
  manifest('release');
  manifest('latest', 404);
}

function release(tag_name: string, prerelease = false, draft = false): object {
  return { tag_name, prerelease, draft };
}

describe('modules/datasource/docker/ghcr-releases', () => {
  it('enumerates all pages regardless of order and verifies each newer release, including prereleases', async () => {
    releases(1, [
      release('v3.3.0'),
      ...Array.from({ length: 99 }, () => release('v2.0.0')),
    ]);
    releases(2, [
      release('v3.1.0'),
      release('v3.2.0'),
      release('v3.2.1-rc1', true),
      release('not-a-version'),
      release('v3.4.0', false, true),
    ]);
    registry();
    manifest('v3.3.0');
    manifest('v3.2.0');
    manifest('v3.2.1-rc1');
    aliases();

    const tags = await getImmichReleaseTags(repository, 'v3.1.0');

    expect(tags).toEqual([
      'v3.1.0',
      'v3.3.0',
      'v3.2.0',
      'v3.2.1-rc1',
      'release',
    ]);
    expect(logger.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'releases_api',
        pagesFetched: 2,
        candidatesChecked: 3,
      }),
      'Immich GHCR Releases lookup decision',
    );
  });

  it('falls back if a published release is not yet an image', async () => {
    releases(1, [release('v3.2.0'), release('v3.3.0')]);
    registry();
    manifest('v3.2.0');
    manifest('v3.3.0', 404);

    await expect(
      getImmichReleaseTags(repository, 'v3.1.0'),
    ).resolves.toBeNull();
    expect(logger.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'registry_fallback',
        outcome: 'missing_or_unavailable_manifest',
        candidatesChecked: 2,
      }),
      'Immich GHCR Releases lookup decision',
    );
  });

  it('falls back on partial pagination errors', async () => {
    releases(
      1,
      Array.from({ length: 100 }, () => release('v2.0.0')),
    );
    releases(2, [], 403);

    await expect(
      getImmichReleaseTags(repository, 'v3.1.0'),
    ).resolves.toBeNull();
    expect(logger.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'api_or_registry_error',
        pagesFetched: 1,
      }),
      'Immich GHCR Releases lookup decision',
    );
  });

  it('continues on a short page with a next link', async () => {
    httpMock
      .scope(github)
      .get('/repos/immich-app/immich/releases?per_page=100&page=1')
      .reply(200, [release('v3.2.0')], {
        link: '<https://api.github.com/repos/immich-app/immich/releases?page=2>; rel="next"',
      });
    releases(2, [release('v3.3.0')]);
    registry();
    manifest('v3.2.0');
    manifest('v3.3.0');
    aliases();

    await expect(getImmichReleaseTags(repository, 'v3.1.0')).resolves.toContain(
      'v3.3.0',
    );
  });

  it('falls back when too many candidates require manifest probes', async () => {
    releases(
      1,
      Array.from({ length: 100 }, (_, i) => release(`v3.${i + 2}.0`)),
    );
    releases(2, [release('v3.102.0')]);

    await expect(
      getImmichReleaseTags(repository, 'v3.1.0'),
    ).resolves.toBeNull();
    expect(logger.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'candidate_limit',
        pagesFetched: 2,
        candidatesChecked: 0,
      }),
      'Immich GHCR Releases lookup decision',
    );
  });

  it('falls back when pagination reaches the safety cap', async () => {
    for (let page = 1; page <= 20; page += 1) {
      releases(
        page,
        Array.from({ length: 100 }, () => release('v2.0.0')),
      );
    }

    await expect(
      getImmichReleaseTags(repository, 'v3.1.0'),
    ).resolves.toBeNull();
    expect(logger.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'page_limit', pagesFetched: 20 }),
      'Immich GHCR Releases lookup decision',
    );
  });

  it('falls back for a non-version current tag', async () => {
    await expect(
      getImmichReleaseTags(repository, 'release'),
    ).resolves.toBeNull();
    expect(logger.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'invalid_current' }),
      'Immich GHCR Releases lookup decision',
    );
  });

  it('uses scoped GHCR bearer auth for manifest checks without logging credentials', async () => {
    releases(1, [release('v3.2.0')]);
    httpMock.scope(ghcr).get('/').reply(
      401,
      {},
      {
        'www-authenticate':
          'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:immich-app/immich-server:pull"',
      },
    );
    httpMock
      .scope('https://ghcr.io')
      .get(
        '/token?scope=repository%3Aimmich-app%2Fimmich-server%3Apull&service=ghcr.io',
      )
      .reply(200, { token: 'secret-bearer' });
    httpMock
      .scope(ghcr, { reqheaders: { authorization: 'Bearer secret-bearer' } })
      .head(`/${repository}/manifests/v3.2.0`)
      .reply(200)
      .head(`/${repository}/manifests/release`)
      .reply(404)
      .head(`/${repository}/manifests/latest`)
      .reply(404);

    await expect(getImmichReleaseTags(repository, 'v3.1.0')).resolves.toContain(
      'v3.2.0',
    );
    expect(JSON.stringify(logger.logger.info.mock.calls)).not.toContain(
      'secret-bearer',
    );
  });

  it('falls back on registry auth failure', async () => {
    releases(1, []);
    httpMock.scope(ghcr).get('/').reply(403);

    await expect(
      getImmichReleaseTags(repository, 'v3.1.0'),
    ).resolves.toBeNull();
    expect(logger.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'registry_fallback' }),
      'Immich GHCR Releases lookup decision',
    );
  });

  it('falls back if optional alias probing fails for a reason other than absence', async () => {
    releases(1, []);
    registry();
    manifest('release', 429);

    await expect(
      getImmichReleaseTags(repository, 'v3.1.0'),
    ).resolves.toBeNull();
    expect(logger.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'alias_probe_error' }),
      'Immich GHCR Releases lookup decision',
    );
  });

  describe('configured release discovery', () => {
    const config = {
      source: 'github-releases' as const,
      repository: 'acme/product',
      coverage: 'published-releases-only' as const,
      fallbackOnError: 'registry' as const,
    };

    it('maps an unrelated image to its configured release repository without probing aliases', async () => {
      httpMock
        .scope(github)
        .get('/repos/acme/product/releases?per_page=100&page=1')
        .reply(200, [release('v1.2.0')]);
      httpMock
        .scope(ghcr)
        .get('/')
        .reply(200, {})
        .head('/acme/widget/manifests/v1.2.0')
        .reply(200);

      const tags = await getGithubReleaseTags('acme/widget', 'v1.1.0', config);

      expect(tags).toEqual(['v1.1.0', 'v1.2.0']);
      expect(logger.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'releases_api',
          releaseRepository: 'acme/product',
          dockerRepository: 'acme/widget',
          candidatesChecked: 1,
        }),
        'Docker GitHub Releases lookup decision',
      );
    });

    it('checks only configured moving tags and preserves missing aliases', async () => {
      httpMock
        .scope(github)
        .get('/repos/acme/product/releases?per_page=100&page=1')
        .reply(200, []);
      httpMock
        .scope(ghcr)
        .get('/')
        .reply(200, {})
        .head('/acme/widget/manifests/stable')
        .reply(404)
        .head('/acme/widget/manifests/edge')
        .reply(200);

      const tags = await getGithubReleaseTags('acme/widget', 'v1.1.0', {
        ...config,
        movingTags: ['stable', 'edge'],
      });

      expect(tags).toEqual(['v1.1.0', 'edge']);
    });

    it('rejects malformed repository paths instead of making a request', async () => {
      await expect(
        getGithubReleaseTags('acme/widget', 'v1.1.0', {
          ...config,
          repository: '../another-repo',
        }),
      ).rejects.toThrow('Invalid input');
    });

    it('falls back visibly on an API error without logging raw HTTP details', async () => {
      httpMock
        .scope(github)
        .get('/repos/acme/product/releases?per_page=100&page=1')
        .reply(403, { secret: 'do-not-log' });

      await expect(
        getGithubReleaseTags('acme/widget', 'v1.1.0', config),
      ).resolves.toBeNull();
      expect(logger.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'registry_fallback',
          outcome: 'api_or_registry_error',
        }),
        'Docker GitHub Releases lookup decision',
      );
      expect(JSON.stringify(logger.logger.info.mock.calls)).not.toContain(
        'do-not-log',
      );
    });
  });
});
