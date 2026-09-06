import { describe, expect, it, vi } from 'vitest';

import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';

describe('provider URL policy', () => {
  it('rejects unlisted destinations before DNS and pins allowed public DNS answers', async () => {
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    const policy = new ProviderUrlPolicy(
      { hosts: ['models.example'], schemes: ['https'], privateCidrs: [] },
      lookup,
    );
    await expect(policy.resolve('https://evil.example/v1')).rejects.toThrow(
      'provider_url_not_allowed',
    );
    expect(lookup).not.toHaveBeenCalled();
    await expect(policy.resolve('https://models.example/v1')).resolves.toMatchObject({
      address: '93.184.216.34',
      family: 4,
    });
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(policy.resolve('https://models.example/v1')).rejects.toThrow(
      'provider_url_not_allowed',
    );
  });
  it('rejects mixed DNS, URL credentials and unsafe schemes; permits explicitly allowlisted local endpoints', async () => {
    const resolve = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    const publicPolicy = new ProviderUrlPolicy(
      { hosts: ['models.example'], schemes: ['https'], privateCidrs: [] },
      resolve,
    );
    for (const url of [
      'http://models.example/v1',
      'https://key@models.example/v1',
      'https://models.example/v1?key=secret',
      'https://models.example/v1#secret',
    ]) {
      await expect(publicPolicy.resolve(url)).rejects.toThrow('provider_url_not_allowed');
    }
    expect(resolve).not.toHaveBeenCalled();
    await expect(publicPolicy.resolve('https://models.example/v1')).rejects.toThrow(
      'provider_url_not_allowed',
    );
    const local = new ProviderUrlPolicy({
      hosts: ['127.0.0.1'],
      schemes: ['http'],
      privateCidrs: ['127.0.0.0/8'],
    });
    await expect(local.resolve('http://127.0.0.1:8080/v1')).resolves.toMatchObject({
      address: '127.0.0.1',
    });
  });
});
