import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import SecurityPage from '../../src/routes/app/security/+page.svelte';
import SignInPage from '../../src/routes/sign-in/+page.svelte';
import JoinPage from '../../src/routes/join/+page.svelte';

const user = { id: 'user-1', displayName: 'Ada', email: 'ada@example.com' };
describe('OIDC controls', () => {
  it('offers a document POST to link an identity and disables unlink for the only sign-in method', () => {
    const props = {
      params: {},
      form: null,
      data: { user, oidcEnabled: true, linked: false, canUnlink: false, oidcError: null },
    };
    const unlinked = render(SecurityPage, { props }).body;
    expect(unlinked).toContain('Security settings');
    expect(unlinked).toContain('action="/auth/oidc/start"');
    expect(unlinked).toContain('name="purpose" value="link"');
    expect(unlinked).toContain('Link OIDC identity');
    const linked = render(SecurityPage, {
      props: { ...props, data: { ...props.data, linked: true } },
    }).body;
    expect(linked).toContain('OIDC identity linked.');
    expect(linked).toMatch(/<button[^>]*disabled[^>]*>Unlink OIDC identity<\/button>/u);
    expect(linked).toContain('only sign-in method');
    const disabled = render(SecurityPage, {
      props: { ...props, data: { ...props.data, oidcEnabled: false } },
    }).body;
    expect(disabled).not.toContain('Link OIDC identity');
    expect(disabled).not.toContain('Unlink OIDC identity');
  });
  it('shows sign-in and invitation document POSTs only when OIDC is enabled', () => {
    const enabled = render(SignInPage, {
      props: { data: { oidcEnabled: true, oidcError: 'Start again.' } },
    }).body;
    expect(enabled).toContain('Sign in with OIDC');
    expect(enabled).toContain('action="/auth/oidc/start"');
    expect(enabled).toContain('name="purpose" value="signin"');
    expect(enabled).toContain('Start again.');
    expect(
      render(SignInPage, { props: { data: { oidcEnabled: false, oidcError: null } } }).body,
    ).not.toContain('Sign in with OIDC');
    const join = render(JoinPage, {
      props: { params: {}, form: null, data: { user: null, oidcEnabled: true } },
    }).body;
    expect(join).toContain('Join with OIDC');
    expect(join).toContain('name="purpose" value="invite"');
    expect(join).toContain('name="invitationToken" value=""');
    expect(join).toContain('action="/auth/oidc/start"');
    expect(
      render(JoinPage, { props: { params: {}, form: null, data: { user, oidcEnabled: true } } })
        .body,
    ).not.toContain('Join with OIDC');
    expect(
      render(JoinPage, {
        props: { params: {}, form: null, data: { user: null, oidcEnabled: false } },
      }).body,
    ).not.toContain('Join with OIDC');
  });
});
