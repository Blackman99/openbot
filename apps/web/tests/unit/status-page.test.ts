import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';

import StatusPage from '../../src/routes/+page.svelte';

describe('status page', () => {
  it('renders an accessible Ready state', () => {
    const rendered = render(StatusPage, {
      props: { data: { status: 'ready' } },
    });

    expect(rendered.body).toContain('role="status"');
    expect(rendered.body).toContain('Ready');
  });

  it('renders an accessible Unavailable state', () => {
    const rendered = render(StatusPage, {
      props: { data: { status: 'unavailable' } },
    });

    expect(rendered.body).toContain('role="status"');
    expect(rendered.body).toContain('Unavailable');
  });

  it('fails closed when no server status is available', () => {
    const rendered = render(StatusPage);

    expect(rendered.body).toContain('data-state="unavailable"');
    expect(rendered.body).toContain('Unavailable');
  });
});
