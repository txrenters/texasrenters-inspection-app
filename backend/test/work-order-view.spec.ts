import type { WorkOrderHandoff } from '../src/work-orders/work-order-handoff.schema';
import { workOrderView } from '../src/work-orders/work-order-view';

/**
 * The console's work order dialog reads the work order as the maintenance app
 * last sent it, laid out as that app's own modal (the office, 2026-11-21).
 */

function envelope(
  overrides: Partial<WorkOrderHandoff['work_order']> = {},
  rest: Partial<WorkOrderHandoff> = {},
): WorkOrderHandoff {
  return {
    idempotency_key: 'tx-maintenance:work-order:2864',
    source_system: 'tx-maintenance',
    work_order: {
      id: 2864,
      number: 43761,
      propertyware_id: '4377411585',
      source: null,
      is_crystal_creek: false,
      status: 'Open',
      service_status: 'Assigned - Waiting on Scheduling',
      local_status: 'Updated',
      priority: 'Medium',
      is_emergency: false,
      category: 'HVAC',
      type: 'Repair',
      description: 'AC not cooling since Monday',
      specific_location: 'Upstairs unit',
      authorized_to_enter: 'Yes',
      zone: '2',
      created_date: '2026-11-11T14:02:00+00:00',
      approved_date: null,
      date_to_enter: null,
      scheduled_end_date: null,
      completed_date: null,
      jobber: {
        job_gid: 'Z2lkOi8vSm9iYmVyL0pvYi8x',
        web_uri: 'https://secure.getjobber.com/jobs/1',
      },
      url: 'https://maintenance.example.test/work_orders/2864/details',
      ...overrides,
    },
    property: {
      propertyware_building_id: '465764359',
      propertyware_unit_id: null,
      propertyware_lease_id: null,
      portfolio_id: '1102',
      name: '123 Demo St',
      address: '123 Demo St',
      address_cont: null,
      city: 'Houston',
      state: 'TX',
      postal_code: '77001',
      latitude: 29.76,
      longitude: -95.36,
      location: 'DEMO | 123DEMOST',
    },
    outside_customer: null,
    occupied: true,
    tenants: [{ name: 'Pat Tenant', phone: '+15125550100', email: 'pat@example.com' }],
    vendors: [
      { propertyware_id: '246120584', name: 'Texas Home Maintenance Pros', in_house: true },
      { propertyware_id: '111', name: 'Southwinds Electric LLC', in_house: false },
    ],
    ...rest,
  };
}

const received = new Date('2026-11-20T18:00:00.000Z');

describe('workOrderView', () => {
  it('gives the dialog the fields the maintenance app shows on its modal', () => {
    const view = workOrderView(envelope(), received);

    expect(view).toMatchObject({
      number: 43761,
      status: 'Open',
      serviceStatus: 'Assigned - Waiting on Scheduling',
      priority: 'Medium',
      isEmergency: false,
      category: 'HVAC',
      type: 'Repair',
      description: 'AC not cooling since Monday',
      specificLocation: 'Upstairs unit',
      authorizedToEnter: 'Yes',
      zone: '2',
      occupied: true,
      address: '123 Demo St, Houston, TX 77001',
      tenants: [{ name: 'Pat Tenant', phone: '+15125550100', email: 'pat@example.com' }],
      vendors: [
        { name: 'Texas Home Maintenance Pros', inHouse: true },
        { name: 'Southwinds Electric LLC', inHouse: false },
      ],
      approval: null,
      receivedAt: '2026-11-20T18:00:00.000Z',
    });
  });

  it('carries the crew estimate and who approved it', () => {
    const view = workOrderView(
      envelope(
        { cost_estimate: 450, approved_date: '2026-11-20T10:00:00+00:00' },
        {
          approval: {
            rule: 'owner_approved_recorded',
            threshold: 300,
            estimate: 450,
            recorded_by: 'J. Owner',
            recorded_at: null,
            ai_confidence: null,
            ai_read_at: null,
            summary: null,
            problems: [],
          },
        },
      ),
      received,
    );

    expect(view?.costEstimate).toBe(450);
    expect(view?.approvedDate).not.toBeNull();
    expect(view?.approval).toEqual({ rule: 'owner_approved_recorded', recordedBy: 'J. Owner', summary: null });
  });

  it('is null for a payload that no longer parses', () => {
    expect(workOrderView({ work_order: {} }, received)).toBeNull();
  });
});
