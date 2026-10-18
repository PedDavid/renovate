import { hostRules } from '~test/host-rules.ts';
import * as httpMock from '~test/http-mock.ts';
import { getImmichPackageTags } from './ghcr-packages.ts';

const api = 'https://api.github.com';
const path = '/orgs/immich-app/packages/container/immich-server/versions';
const auth = { authorization: 'token test-pat' };
const filler = Array.from({ length: 99 }, () => ({
  metadata: { container: { tags: ['commit-build'] } },
}));

function page(n: number, versions: unknown[], status = 200): void {
  httpMock
    .scope(api, { reqheaders: auth })
    .get(`${path}?per_page=100&page=${n}`)
    .reply(status, versions);
}

function release(tag: string): void {
  httpMock
    .scope(api, { reqheaders: auth })
    .get('/repos/immich-app/immich/releases/latest')
    .reply(200, { tag_name: tag });
}

describe('modules/datasource/docker/ghcr-packages', () => {
  beforeEach(() => {
    hostRules.add({
      hostType: 'docker',
      matchHost: 'ghcr.io',
      username: 'renovate',
      password: 'test-pat',
    });
  });

  it('stops when the current tag and latest release have been seen', async () => {
    page(1, [
      ...filler,
      { metadata: { container: { tags: ['v3.2.0', 'release'] } } },
    ]);
    page(2, [{ metadata: { container: { tags: ['v3.1.0'] } } }]);
    release('v3.2.0');

    const tags = await getImmichPackageTags(
      'immich-app/immich-server',
      'v3.1.0',
    );

    expect(tags).toContain('v3.2.0');
    expect(tags).toContain('release');
    expect(tags).toContain('v3.1.0');
  });

  it('falls back when the latest release is absent', async () => {
    page(1, [{ metadata: { container: { tags: ['v3.1.0'] } } }]);
    release('v3.2.0');

    await expect(
      getImmichPackageTags('immich-app/immich-server', 'v3.1.0'),
    ).resolves.toBeNull();
  });

  it('falls back if the current tag is not found', async () => {
    page(1, [{ metadata: { container: { tags: ['v3.2.0'] } } }]);

    await expect(
      getImmichPackageTags('immich-app/immich-server', 'v3.1.0'),
    ).resolves.toBeNull();
  });

  it('falls back on API errors', async () => {
    httpMock
      .scope(api, { reqheaders: auth })
      .get(`${path}?per_page=100&page=1`)
      .reply(403, { message: 'Forbidden' });

    await expect(
      getImmichPackageTags('immich-app/immich-server', 'v3.1.0'),
    ).resolves.toBeNull();
  });

  it('bounds pagination at ten pages before falling back', async () => {
    for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
      page(pageNumber, [
        ...filler,
        { metadata: { container: { tags: [`commit-${pageNumber}`] } } },
      ]);
    }

    await expect(
      getImmichPackageTags('immich-app/immich-server', 'v3.1.0'),
    ).resolves.toBeNull();
  });

  it('maps machine-learning package versions into their tags', async () => {
    httpMock
      .scope(api, { reqheaders: auth })
      .get(
        '/orgs/immich-app/packages/container/immich-machine-learning/versions?per_page=100&page=1',
      )
      .reply(200, [
        { metadata: { container: { tags: ['v3.2.0', 'v3.1.0'] } } },
      ]);
    release('v3.2.0');

    await expect(
      getImmichPackageTags('immich-app/immich-machine-learning', 'v3.1.0'),
    ).resolves.toEqual(['v3.2.0', 'v3.1.0']);
  });

  it('skips unrelated packages and missing current tags', async () => {
    await expect(
      getImmichPackageTags('other/image', 'v3.1.0'),
    ).resolves.toBeNull();
    await expect(
      getImmichPackageTags('immich-app/immich-server', ''),
    ).resolves.toBeNull();
  });
});
