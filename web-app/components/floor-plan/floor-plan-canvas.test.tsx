import type { AdminPropertyArea } from '@texasrenters/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FloorPlanCanvas } from './FloorPlanCanvas';
import { FloorPlanChecklist } from './FloorPlanChecklist';

// pdf.js is not runnable under jsdom; stub a 2-page document whose page has the
// same 2000×1000 aspect as the image fixture so the geometry assertions match.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 2,
      getPage: () =>
        Promise.resolve({
          getViewport: ({ scale }: { scale: number }) => ({
            width: 2000 * scale,
            height: 1000 * scale,
          }),
          render: () => ({ promise: Promise.resolve() }),
        }),
    }),
  }),
}));

// A 2000×1000 image in an 800×800 stage → contain 800×400, letterboxed 200px.
beforeAll(() => {
  // jsdom implements neither 2D canvas rendering nor toBlob.
  HTMLCanvasElement.prototype.getContext = (() => ({
    fillStyle: '',
    fillRect: () => {},
  })) as unknown as HTMLCanvasElement['getContext'];
  HTMLCanvasElement.prototype.toBlob = ((callback: BlobCallback) =>
    callback(new Blob([''], { type: 'image/png' }))) as HTMLCanvasElement['toBlob'];
  URL.createObjectURL = () => 'blob:rendered-page';
  URL.revokeObjectURL = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 2000 });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 1000 });
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 800, right: 800, bottom: 800, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterAll(() => {
  vi.restoreAllMocks();
});

function area(id: string, name: string, order: number, marker: { x: number; y: number } | null): AdminPropertyArea {
  return {
    id,
    propertyId: 'building-1',
    name,
    inspectionOrder: order,
    isRequired: true,
    status: 'DRAFT',
    source: 'AI_FLOOR_PLAN',
    sourceFloorPlanId: 'plan-1',
    marker: marker ? { available: true, x: marker.x, y: marker.y } : null,
  } as unknown as AdminPropertyArea;
}

const kitchen = area('kitchen', 'Kitchen', 1, { x: 0.5, y: 0.5 });
const living = area('living', 'Living Room', 2, { x: 0.25, y: 0.75 });
const garage = area('garage', 'Garage', 3, null);

function renderCanvas(overrides: Partial<Parameters<typeof FloorPlanCanvas>[0]> = {}) {
  const onSelectArea = vi.fn();
  const onDraftChange = vi.fn();
  const utils = render(
    createElement(FloorPlanCanvas, {
      previewUrl: 'blob:plan',
      fileName: 'plan.png',
      mimeType: 'image/png',
      planId: 'plan-1',
      areas: [kitchen, living],
      selectedAreaId: 'kitchen',
      showAllMarkers: false,
      editingAreaId: null,
      draftMarker: null,
      focusNonce: 0,
      onSelectArea,
      onDraftChange,
      ...overrides,
    }),
  );
  return { onSelectArea, onDraftChange, ...utils };
}

describe('FloorPlanCanvas', () => {
  it('renders the selected marker over the correct rendered image location', () => {
    renderCanvas();
    const marker = screen.getByRole('button', { name: /Kitchen marker/ });
    // 0.5,0.5 → offsetX 0 + 0.5*800 = 400; offsetY 200 + 0.5*400 = 400.
    expect(marker).toHaveStyle({ left: '400px', top: '400px' });
    // Only the selected marker shows when "show all" is off.
    expect(screen.queryByRole('button', { name: /Living Room marker/ })).not.toBeInTheDocument();
  });

  it('selects the checklist item when a marker is clicked', () => {
    const { onSelectArea } = renderCanvas();
    fireEvent.click(screen.getByRole('button', { name: /Kitchen marker/ }));
    expect(onSelectArea).toHaveBeenCalledWith('kitchen');
  });

  it('shows all valid markers when show-all is on', () => {
    renderCanvas({ showAllMarkers: true, selectedAreaId: null });
    expect(screen.getAllByRole('button', { name: / marker,/ })).toHaveLength(2);
  });

  it('places a marker at the clicked point (normalized) in edit mode', () => {
    const { onDraftChange, container } = renderCanvas({
      editingAreaId: 'kitchen',
      draftMarker: { x: 0.5, y: 0.5 },
    });
    const stage = container.querySelector('.fp-stage')!;
    fireEvent.pointerDown(stage, { clientX: 200, clientY: 300 });
    fireEvent.pointerUp(stage, { clientX: 200, clientY: 300 });
    // (200-0)/800 = 0.25 ; (300-200)/400 = 0.25
    expect(onDraftChange).toHaveBeenCalledWith({ x: 0.25, y: 0.25 });
  });

  it('nudges the draft marker with the arrow keys', () => {
    const { onDraftChange } = renderCanvas({ editingAreaId: 'kitchen', draftMarker: { x: 0.5, y: 0.5 } });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Kitchen marker, editing' }), { key: 'ArrowRight' });
    // step = 1 / (renderedW * zoom) = 1/800 = 0.00125
    expect(onDraftChange).toHaveBeenCalledWith({ x: 0.50125, y: 0.5 });
  });

  it('shows a rendering state and no markers until a PDF page is rasterized', () => {
    renderCanvas({ mimeType: 'application/pdf' });
    expect(screen.getByText(/Rendering the PDF page/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: / marker$/ })).not.toBeInTheDocument();
  });

  it('renders markers over a rasterized PDF page and offers page navigation', async () => {
    const onPageChange = vi.fn();
    renderCanvas({ mimeType: 'application/pdf', onPageChange });

    // Once the page rasterizes it flows through the same <img> geometry path.
    const img = await screen.findByAltText('plan.png');
    fireEvent.load(img);
    const marker = await screen.findByRole('button', { name: /Kitchen marker/ });
    expect(marker).toHaveStyle({ left: '400px', top: '400px' });

    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('shows only markers belonging to the active PDF page', async () => {
    const page1 = { ...kitchen, sourcePageNumber: 1 };
    const page2 = { ...living, sourcePageNumber: 2 };
    renderCanvas({
      mimeType: 'application/pdf',
      areas: [page1, page2],
      selectedAreaId: null,
      showAllMarkers: true,
      onPageChange: vi.fn(),
    });
    fireEvent.load(await screen.findByAltText('plan.png'));

    expect(await screen.findByRole('button', { name: /Kitchen marker/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Living Room marker/ })).not.toBeInTheDocument();
  });
});

function renderChecklist(overrides: Partial<Parameters<typeof FloorPlanChecklist>[0]> = {}) {
  const spies = {
    onSelectArea: vi.fn(),
    onFocusArea: vi.fn(),
    onStartEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onSaveMarker: vi.fn(),
  };
  const utils = render(
    createElement(FloorPlanChecklist, {
      groups: [{ key: 'g', label: 'Ground Floor', areas: [kitchen, garage] }],
      planId: 'plan-1',
      selectedAreaId: 'kitchen',
      editingAreaId: null,
      hasDraft: false,
      canManage: true,
      supportsMarkers: true,
      saving: false,
      saveError: null,
      saveMessage: null,
      ...spies,
      ...overrides,
    }),
  );
  return { ...spies, ...utils };
}

describe('FloorPlanChecklist', () => {
  it('marks the selected row pressed and selects on click', () => {
    const { onSelectArea } = renderChecklist();
    // Queried by row id, not by accessible name: each row also carries a
    // checklist trigger whose label contains the area name.
    const kitchenRow = document.getElementById('fp-row-kitchen');
    const garageRow = document.getElementById('fp-row-garage');
    expect(kitchenRow).toHaveAttribute('aria-pressed', 'true');
    expect(garageRow).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(garageRow!);
    expect(onSelectArea).toHaveBeenCalledWith('garage');
  });

  it('offers Adjust for a marked area and Place for a missing one', () => {
    renderChecklist();
    expect(screen.getByRole('button', { name: 'Adjust marker' })).toBeInTheDocument();
    renderChecklist({ selectedAreaId: 'garage' });
    expect(screen.getByRole('button', { name: 'Place marker' })).toBeInTheDocument();
  });

  it('saves on explicit Save and discards on Cancel — never touching approval', () => {
    const { onSaveMarker, onCancelEdit } = renderChecklist({
      editingAreaId: 'kitchen',
      hasDraft: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save position' }));
    expect(onSaveMarker).toHaveBeenCalledWith('kitchen');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancelEdit).toHaveBeenCalled();
  });

  it('shows area approval and marker status separately', () => {
    renderChecklist();
    expect(screen.getAllByText('DRAFT').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Needs review').length).toBeGreaterThan(0);
  });

  it('shows a clear missing-marker state without fabricating a marker', () => {
    renderChecklist({ selectedAreaId: 'garage' });
    expect(screen.getAllByText('Marker missing').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Place marker' })).toBeInTheDocument();
  });

  it('retains native button semantics and a pressed state for keyboard selection', () => {
    renderChecklist();
    const garageButton = document.getElementById('fp-row-garage') as HTMLElement;
    garageButton.focus();
    expect(garageButton.tagName).toBe('BUTTON');
    expect(garageButton).toHaveFocus();
    expect(garageButton).toHaveAttribute('aria-pressed', 'false');
  });
});
