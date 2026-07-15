import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let handleClick;
const createTab = vi.fn();

beforeAll(async () => {
  vi.stubGlobal('chrome', {
    action: {
      onClicked: {
        addListener(listener) {
          handleClick = listener;
        },
      },
    },
    tabs: { create: createTab },
  });

  await import('./background.js');
});

beforeEach(() => {
  createTab.mockClear();
});

describe('LegalViz extension launcher', () => {
  it('requests only temporary access to the clicked tab', async () => {
    const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));

    expect(manifest.permissions).toEqual(['activeTab']);
    expect(manifest).not.toHaveProperty('host_permissions');
    expect(manifest).not.toHaveProperty('content_scripts');
  });

  it('passes the current EUR-Lex URL to the general import flow', () => {
    const sourceUrl = 'https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng?locale=en';

    handleClick({ url: sourceUrl });

    const targetUrl = new URL(createTab.mock.calls[0][0].url);
    expect(targetUrl.origin).toBe('https://legalviz.eu');
    expect(targetUrl.pathname).toBe('/import');
    expect(targetUrl.searchParams.get('sourceUrl')).toBe(sourceUrl);
  });

  it('opens the homepage from other websites', () => {
    handleClick({ url: 'https://example.com/' });

    expect(createTab).toHaveBeenCalledWith({ url: 'https://legalviz.eu/' });
  });

  it('opens the homepage when the active tab has no readable URL', () => {
    handleClick({});

    expect(createTab).toHaveBeenCalledWith({ url: 'https://legalviz.eu/' });
  });
});
