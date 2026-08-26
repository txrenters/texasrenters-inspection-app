import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ApiReferencePage from './page';

const useOpenApiDocument = vi.hoisted(() => vi.fn());

vi.mock('@/lib/queries', () => ({ useOpenApiDocument }));
vi.mock('@/lib/api', () => ({ apiRawRequest: vi.fn() }));

function operation(tag: string, summary: string, permission?: string) {
  return {
    operationId: `${tag}_${summary}`,
    summary,
    tags: [tag],
    'x-authentication': ['BEARER'],
    'x-machine-accessible': false,
    ...(permission ? { 'x-required-permissions': [permission] } : {}),
  };
}

const document = {
  openapi: '3.0.0',
  info: { title: 'Test API', version: '1.0' },
  paths: {
    '/api/v1/admin/access/roles': {
      get: operation('Access management', 'roles', 'roles:read'),
      post: operation('Access management', 'createRole', 'roles:manage'),
    },
    '/api/v1/admin/properties': {
      get: operation('Administrator application', 'properties', 'properties:read'),
    },
    '/api/v1/gateway/inspections': {
      get: operation('Third-party gateway', 'inspections', 'inspections:read'),
    },
    '/api/v1/admin/property-locations': {
      // Two tags, as Swagger emits them for a handler that carries its own
      // `@ApiTags` on top of its controller's.
      get: {
        ...operation('Administrator application', 'propertyLocations', 'properties:read'),
        tags: ['Administrator application', 'Console map'],
      },
    },
  },
};

function renderPage() {
  useOpenApiDocument.mockReturnValue({
    data: document,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  });
  return render(<ApiReferencePage />);
}

const tagButton = (name: RegExp) => screen.getByRole('button', { name });

describe('API reference endpoint list', () => {
  it('shows every tag and no endpoints until one is opened', () => {
    renderPage();

    // The whole point of the section list: with ~200 endpoints across ten tags,
    // the tag names are the map, and they have to be readable at once.
    expect(tagButton(/access management/i)).toHaveAttribute('aria-expanded', 'false');
    expect(tagButton(/administrator application/i)).toBeInTheDocument();
    expect(tagButton(/third-party gateway/i)).toBeInTheDocument();
    expect(screen.queryByText('/admin/access/roles')).toBeNull();
  });

  it('reports how many endpoints each tag holds, so a section can be judged before opening it', () => {
    renderPage();

    expect(tagButton(/access management/i)).toHaveTextContent('2');
    expect(tagButton(/third-party gateway/i)).toHaveTextContent('1');
  });

  it('opens and closes one tag without disturbing the others', () => {
    renderPage();

    fireEvent.click(tagButton(/access management/i));
    expect(tagButton(/access management/i)).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByText('/admin/access/roles')).toHaveLength(2);
    // Opening one section must not open the rest — that would put us back to the
    // flat list this replaced.
    expect(tagButton(/administrator application/i)).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(tagButton(/access management/i));
    expect(screen.queryByText('/admin/access/roles')).toBeNull();
  });

  it('reveals matches while searching, without the reader opening anything', () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(/search endpoints/i), {
      target: { value: 'gateway' },
    });

    // A search whose results stay hidden behind collapsed headers is a search
    // that does not work.
    expect(screen.getByText('/gateway/inspections')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /access management/i })).toBeNull();
  });

  it('returns to what the reader had opened once the search is cleared', () => {
    renderPage();

    const search = screen.getByLabelText(/search endpoints/i);
    fireEvent.change(search, { target: { value: 'gateway' } });
    fireEvent.change(search, { target: { value: '' } });

    // Searching expands matching groups for the duration of the search; it must
    // not silently leave every section open afterwards.
    expect(tagButton(/access management/i)).toHaveAttribute('aria-expanded', 'false');
    expect(tagButton(/third-party gateway/i)).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the open endpoint on screen while the search narrows past it', () => {
    renderPage();

    fireEvent.click(tagButton(/access management/i));
    fireEvent.click(screen.getByRole('button', { name: /GET \/admin\/access\/roles/i }));
    expect(screen.getByRole('tab', { name: /try it/i })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/search endpoints/i), {
      target: { value: 'gateway' },
    });

    // The selection is resolved against every endpoint, not the filtered set —
    // looking something else up must not blank the contract you were reading.
    expect(screen.getByRole('tab', { name: /try it/i })).toBeInTheDocument();
  });

  it('files a handler under its most specific tag, not its controller', () => {
    renderPage();

    // The map's feeds live on AdminController with ninety-odd other routes, and
    // a reader looking for "where do the map pins come from" should not have to
    // know that. Grouping on the last tag is what lets a handler have its own
    // heading without moving to a new controller.
    expect(tagButton(/console map/i)).toBeInTheDocument();
    expect(tagButton(/console map/i)).toHaveTextContent('1');
    // And it is filed there *instead of*, not as well as, its controller.
    expect(tagButton(/administrator application/i)).toHaveTextContent('1');
  });

  it('marks the collapsed section that holds the open endpoint', () => {
    renderPage();

    fireEvent.click(tagButton(/access management/i));
    fireEvent.click(screen.getByRole('button', { name: /GET \/admin\/access\/roles/i }));
    fireEvent.click(tagButton(/access management/i));

    // Collapsing the group you are reading otherwise loses the only cue for
    // where in the list you are.
    expect(screen.getByLabelText(/contains the open endpoint/i)).toBeInTheDocument();
  });
});
