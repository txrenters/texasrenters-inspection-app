import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AddAreasDialog } from './inspection-workflow';

/**
 * Which areas can be added to an inspection that is short of one.
 *
 * The same rule as the create form, missed when that was fixed — and it fails
 * worse here. There the ids only went up once somebody cleared a box, so the
 * disagreement stayed hidden until then; this dialog sends exactly what was
 * ticked, so an area it offers and the server refuses produces "Select only
 * approved areas belonging to this property" on a dialog where every area
 * shown does belong to the property.
 *
 * Found while giving nine scheduled inspections the areas they were created
 * without. One of them is at 4207 Hardy St, which carries four `SYSTEM` areas
 * beside its fifteen rooms — so it is exactly where the office would have met
 * this first.
 */

const queries = vi.hoisted(() => ({ usePropertyAreas: vi.fn(), useAdminMutations: vi.fn() }));
vi.mock('@/lib/queries', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ...queries };
});

/** 4207 Hardy St, trimmed: rooms, an HVAC visit's subjects, and a draft. */
const AREAS = [
  { id: 'a1', name: 'Kitchen', status: 'APPROVED', source: 'STANDARD_TEMPLATE', unitId: null, inspectionOrder: 1 },
  { id: 'a2', name: 'Main Bedroom', status: 'APPROVED', source: 'STANDARD_TEMPLATE', unitId: null, inspectionOrder: 2 },
  { id: 'a3', name: 'A/C unit', status: 'APPROVED', source: 'SYSTEM', unitId: null, inspectionOrder: 3 },
  { id: 'a4', name: 'Filters', status: 'APPROVED', source: 'SYSTEM', unitId: null, inspectionOrder: 4 },
  { id: 'a5', name: 'Thermostat', status: 'APPROVED', source: 'SYSTEM', unitId: null, inspectionOrder: 5 },
  { id: 'a6', name: 'Attic', status: 'APPROVED', source: 'SYSTEM', unitId: null, inspectionOrder: 6 },
  { id: 'a7', name: 'Shed', status: 'DRAFT', source: 'MANUAL', unitId: null, inspectionOrder: 7 },
];

function mount(existingPropertyAreaIds: string[] = []) {
  return render(
    <AddAreasDialog
      existingPropertyAreaIds={existingPropertyAreaIds}
      inspectionId="insp-1"
      inspectionType="MOVE_IN"
      onClose={() => {}}
      propertyId="prop-1"
      unitId={null}
    />,
  );
}

const offered = (name: string) => screen.queryByRole('checkbox', { name });

beforeEach(() => {
  vi.clearAllMocks();
  queries.usePropertyAreas.mockReturnValue({ data: AREAS, isLoading: false, isError: false });
  queries.useAdminMutations.mockReturnValue({
    addInspectionAreas: { mutateAsync: vi.fn(), isPending: false, error: null },
  });
});

describe('adding areas to an inspection', () => {
  it('offers the rooms', () => {
    mount();

    expect(offered('Kitchen')).toBeInTheDocument();
    expect(offered('Main Bedroom')).toBeInTheDocument();
  });

  /** The server refuses these outright, so offering them is offering an error. */
  it('does not offer an HVAC visit’s subjects', () => {
    mount();

    for (const name of ['A/C unit', 'Filters', 'Thermostat', 'Attic'])
      expect(offered(name)).not.toBeInTheDocument();
  });

  it('never offers one nobody has approved', () => {
    mount();

    expect(offered('Shed')).not.toBeInTheDocument();
  });

  /** Adding an area twice is not a thing to offer; the inspection has it. */
  it('leaves out what the inspection already has', () => {
    mount(['a1']);

    expect(offered('Kitchen')).not.toBeInTheDocument();
    expect(offered('Main Bedroom')).toBeInTheDocument();
  });
});
