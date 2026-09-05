import type { Environment } from '../config.js';
import { ProviderSecretBox } from './secrets.js';
import { ProviderUrlPolicy, type ProviderNetworkPolicy } from './url-policy.js';

export interface ProviderConfig {
  encryptionKey: string;
  network: ProviderNetworkPolicy;
}

export function readProviderConfig(environment: Environment): ProviderConfig | undefined {
  const encryptionKey = environment.OPENBOT_PROVIDER_ENCRYPTION_KEY;
  if (!encryptionKey) return undefined;
  new ProviderSecretBox(encryptionKey);
  const list = (value: string | undefined, fallback: string) =>
    (value ?? fallback)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  const network = {
    hosts: list(environment.OPENBOT_PROVIDER_ALLOWED_HOSTS, 'api.openai.com'),
    schemes: list(environment.OPENBOT_PROVIDER_ALLOWED_SCHEMES, 'https'),
    privateCidrs: list(environment.OPENBOT_PROVIDER_PRIVATE_CIDRS, ''),
  };
  new ProviderUrlPolicy(network);
  return { encryptionKey, network };
}
