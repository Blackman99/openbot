import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';

import AppPage from '../../src/routes/app/+page.svelte';
import SetupPage from '../../src/routes/setup/+page.svelte';
import SignInPage from '../../src/routes/sign-in/+page.svelte';

describe('authentication pages', () => {
  it('renders an accessible first-owner setup form with safe password semantics', () => {
    const rendered = render(SetupPage, {
      props: {
        form: { displayName: 'Ada', email: 'ada@example.com', error: 'Try again.' },
      },
    });

    expect(rendered.body).toContain('Set up OpenBot');
    expect(rendered.body).toContain('name="displayName"');
    expect(rendered.body).toContain('autocomplete="name"');
    expect(rendered.body).toContain('name="email"');
    expect(rendered.body).toContain('autocomplete="email"');
    expect(rendered.body).toContain('name="password"');
    expect(rendered.body).toContain('autocomplete="new-password"');
    expect(rendered.body).toContain('minlength="12"');
    expect(rendered.body).toContain('name="setupToken"');
    expect(rendered.body).toContain('role="alert"');
    expect(rendered.body).not.toContain('value="Try again."');
  });

  it('renders sign-in without ever repopulating a submitted password', () => {
    const rendered = render(SignInPage, {
      props: { form: { email: 'ada@example.com', error: 'Email or password is incorrect.' } },
    });

    expect(rendered.body).toContain('Sign in to OpenBot');
    expect(rendered.body).toContain('value="ada@example.com"');
    expect(rendered.body).toContain('autocomplete="current-password"');
    expect(rendered.body).not.toContain('wrong password value');
  });

  it('renders a retry hint after sign-in is rate limited', () => {
    const rendered = render(SignInPage, {
      props: {
        form: {
          email: 'ada@example.com',
          error: 'Too many sign-in attempts. Try again in 60 seconds.',
        },
      },
    });

    expect(rendered.body).toContain('Too many sign-in attempts. Try again in 60 seconds.');
    expect(rendered.body).toContain('role="alert"');
  });

  it('renders the authenticated owner and a POST sign-out control', () => {
    const rendered = render(AppPage, {
      props: {
        data: {
          user: { displayName: 'Ada Lovelace', email: 'ada@example.com', id: 'user-id' },
          workspace: { id: 'workspace-id', name: 'My Workspace', description: '', role: 'owner' },
          workspaces: [
            { id: 'workspace-id', name: 'My Workspace', description: '', role: 'owner' },
          ],
        },
      },
    });

    expect(rendered.body).toContain('My Workspace');
    expect(rendered.body).toContain('Ada Lovelace');
    expect(rendered.body).toContain('method="POST"');
    expect(rendered.body).toContain('action="?/signOut"');
    expect(rendered.body).toContain('Sign out');
    expect(rendered.body).toContain('action="?/createWorkspace"');
    expect(rendered.body).toContain('/app/workspaces/workspace-id');
    expect(rendered.body).toContain('action="?/updateWorkspace"');
  });
});
