import { isOidcErrorCode, type OidcErrorCode } from './oidc-api.js';

const messages: Record<OidcErrorCode, string> = {
  invalid_flow: 'This sign-in attempt expired or is invalid. Start again.',
  authentication_required: 'Sign in to manage your OIDC identity.',
  provider_unavailable: 'OIDC sign-in is unavailable. Try again later.',
  identity_not_linked:
    'This OIDC identity is not linked to an account. Sign in with your password and link it in Security settings, or use a workspace invitation.',
  identity_conflict:
    'This OIDC identity cannot be linked to this account. Use a different identity or contact your administrator.',
  last_credential:
    'Keep at least one sign-in method. This OIDC identity is your only sign-in method.',
  invitation_unavailable:
    'This invitation is unavailable for this identity. Reopen the original invitation link or ask your administrator for a new one.',
};
export function oidcErrorMessage(code: unknown): string | null {
  return isOidcErrorCode(code) ? messages[code] : null;
}
