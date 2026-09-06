import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export class ProviderError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export interface ProviderNetworkPolicy {
  hosts: string[];
  schemes: string[];
  privateCidrs: string[];
}

type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;

function ranges(cidrs: string[]): BlockList {
  const result = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefix, extra] = cidr.split('/');
    const family = isIP(address ?? '');
    if (!address || !family || extra || !/^\d+$/u.test(prefix ?? '')) {
      throw new ProviderError('invalid_provider_network_policy');
    }
    try {
      result.addSubnet(address, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
    } catch {
      throw new ProviderError('invalid_provider_network_policy');
    }
  }
  return result;
}

const nonPublic = ranges([
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '100::/64',
  '2001::/23',
  '2002::/16',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
]);

export class ProviderUrlPolicy {
  private readonly privateRanges: BlockList;

  constructor(
    private readonly policy: ProviderNetworkPolicy,
    private readonly resolveDns: Resolver = (hostname) => lookup(hostname, { all: true }),
  ) {
    this.privateRanges = ranges(policy.privateCidrs);
    if (
      policy.schemes.some((scheme) => !['https', 'http'].includes(scheme)) ||
      policy.hosts.some((host) => !host || /[\s/*?#@]/u.test(host))
    ) {
      throw new ProviderError('invalid_provider_network_policy');
    }
  }

  validate(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ProviderError('provider_url_not_allowed');
    }
    const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    if (
      !this.policy.schemes.includes(url.protocol.slice(0, -1)) ||
      !this.policy.hosts.map((host) => host.toLowerCase()).includes(hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new ProviderError('provider_url_not_allowed');
    }
    return url;
  }

  async resolve(value: string): Promise<Address & { url: URL }> {
    const url = this.validate(value);
    const hostname = url.hostname.replace(/^\[|\]$/gu, '');
    let addresses: Address[];
    try {
      addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await this.resolveDns(hostname);
    } catch {
      throw new ProviderError('provider_unreachable');
    }
    if (
      !addresses.length ||
      addresses.some(({ address, family }) => {
        const type = family === 4 ? 'ipv4' : 'ipv6';
        return (
          isIP(address) !== family ||
          (family === 6 && address.toLowerCase().includes('ffff:')) ||
          (nonPublic.check(address, type) && !this.privateRanges.check(address, type))
        );
      })
    ) {
      throw new ProviderError('provider_url_not_allowed');
    }
    return { ...addresses[0]!, url };
  }
}
