/**
 * The office's Technicians' Scope of Work sheet ("Technicians' Scope of Work 4.xlsx",
 * tab Skill Parameters), as received 2026-11-24: per job type, each technician's
 * Y or N and the remark beside it. Read by `readScopeSheet`.
 */
import type { ScopeSheet } from './technician-scope-sheet';

export const TECHNICIAN_SCOPE_SHEET: ScopeSheet = {
  technicians: [
    'Moses Rodriguez',
    'Amy Wilson',
    'Kevin Granados',
    'Thomas Allen Kivi',
    'Emanuel Hall',
  ],
  rows: [
    {
      job: 'AC Filter Delivery',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Appliances',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'LIMITED ONLY/ MINOR REPAIRS ONLY',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'LIMITED ONLY/ MINOR REPAIRS ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'LIMITED ONLY/ MINOR REPAIRS ONLY',
        },
      },
    },
    {
      job: 'Appraiser Inspection',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Attic Door',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Back Steps',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Back to Market Inspection',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Blinds',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Broken Deck',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Broken Window',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Cabinetry',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Carpet Fitting',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Carpet Replacement',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Carpet Steam Cleaning',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Central Heating',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'City Violation',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Cleaning',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: 'SPOT CLEANING ONLY',
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'SPOT CLEANING ONLY',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'SPOT CLEANING ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'SPOT CLEANING ONLY',
        },
      },
    },
    {
      job: 'Clogged Sink',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Code Work',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: 'JUST BASIC (SELECTED, BATTERY REPLACEMENT, C-RING INSTALLATION)',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Connect Ice Machine',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'De-Winterization',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Dishwasher',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'MINOR REPAIR ONLY',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'MINOR REPAIR ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'MINOR REPAIR ONLY',
        },
      },
    },
    {
      job: 'Door Bell',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Door',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Drainage',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Electrical',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'MINOR REPAIR ONLY',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'MINOR REPAIR ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'MINOR REPAIR ONLY',
        },
      },
    },
    {
      job: 'Eviction',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Exterior Paint',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Exterior repairs',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Fan',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'MINOR REPAIR ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'MINOR REPAIR ONLY',
        },
      },
    },
    {
      job: 'Faucet',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Faucet Leak',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Fence',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Fireplace Inspection',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Flood',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Flooring',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Foundation',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Framing',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'MINOR REPAIR ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'MINOR REPAIR ONLY',
        },
      },
    },
    {
      job: 'Front door',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Front Door Replacement',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Garage door',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Garbage Disposal',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Gas Inspection',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Gas Leak',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Gate Lock',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Gate repair',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Glass repair',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Glass Window',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Heater',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'MINOR ONLY',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'CAN REPLACE/INSTALL WATER HEATER',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'CAN REPLACE/INSTALL WATER HEATER',
        },
      },
    },
    {
      job: 'HOA Violation',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: 'IT DEPENDS ON THE VIOLATION',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'IT DEPENDS ON THE VIOLATION',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'HVAC',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'HVAC Fan',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'HVAC Maintenance',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: 'LIMITED ONLY TO INSTALLATION OF FLOAT SWITCHES',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'INSTALL FLOAT SWITCH ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'INSTALL FLOAT SWITCH ONLY',
        },
      },
    },
    {
      job: 'Interior and Exterior Paint',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Interior Paint',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Interior Paint',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Keys',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: 'SUPRA CONFIGURATION',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Kitchen Sink',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Lawn service',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: 'IF LAWN MOWER IS PROVIDED',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'IF LAWN MOWER IS PROVIDED',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'IF LAWN MOWER IS PROVIDED',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'IF LAWN MOWER IS PROVIDED',
        },
      },
    },
    {
      job: 'Light Fixture',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Lock Box',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Mail Box Lock',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Main Door Lock',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Make ready',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: 'INAPECTION AND CLEANING ONLY',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Marketing',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Microwave',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
      },
    },
    {
      job: 'Mold',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
      },
    },
    {
      job: 'Move In',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'FOR TRAINING',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'FOR TRAINING',
        },
      },
    },
    {
      job: 'Move Out Inspection',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'FOR TRAINING',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'FOR TRAINING',
        },
      },
    },
    {
      job: 'Occupied',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'FOR TRAINING',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'FOR TRAINING',
        },
      },
    },
    {
      job: 'oven',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
      },
    },
    {
      job: 'Paint',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'NEEDS IMPROVEMENT',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
      },
    },
    {
      job: 'Pest Control',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: "FOR NATE'S TRAINING",
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: "FOR NATE'S TRAINING",
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: "FOR NATE'S TRAINING",
        },
      },
    },
    {
      job: 'Pictures',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Plumbing',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
      },
    },
    {
      job: 'Pool Service',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Power Wash',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Re-key',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Redecoration - Caused by a Leak',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Refrigerator',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
      },
    },
    {
      job: 'Remodel',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Roof',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Roof Estimate',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Routine/Safety Inspection',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Sheetrock Repairs',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'NEEDS IMPROVEMENT',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Shower',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Sliding Door',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Smoke detectors',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'soffit',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'NEEDS IMPROVEMENT',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Sprinklers',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Stove',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
      },
    },
    {
      job: 'Stove Burner',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
      },
    },
    {
      job: 'stove vent hood',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Structural',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Structural Inspection',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Stucco',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Termite',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: "FOR NATE'S TRAINING",
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: "FOR NATE'S TRAINING",
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: "FOR NATE'S TRAINING",
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: "FOR NATE'S TRAINING",
        },
      },
    },
    {
      job: 'Thermostat',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: '',
          remark: 'N',
        },
        'Emanuel Hall': {
          mark: '',
          remark: 'N',
        },
      },
    },
    {
      job: 'Toilet Clog',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
      },
    },
    {
      job: 'Tree Trimming',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Tub',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: '',
        },
      },
    },
    {
      job: 'Turnover',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: 'INSPECTION AND CLEANING ONLY',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'AS AN ASSISTANT',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'CAN COMPLETE MAKE-READY JOBS',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'CAN COMPLETE MAKE-READY JOBS',
        },
      },
    },
    {
      job: 'Turnover - see Original Turnover',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: 'INSPECTION AND CLEANING ONLY',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'AS AN ASSISTANT',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'CAN COMPLETE MAKE-READY JOBS',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'CAN COMPLETE MAKE-READY JOBS',
        },
      },
    },
    {
      job: 'Vinyl Flooring',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'N',
          remark: '',
        },
        'Thomas Allen Kivi': {
          mark: 'N',
          remark: '',
        },
        'Emanuel Hall': {
          mark: 'N',
          remark: '',
        },
      },
    },
    {
      job: 'Washer',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
      },
    },
    {
      job: 'Water heater',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'CAN REPLACE WATER HEATER',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'CAN REPLACE WATER HEATER',
        },
      },
    },
    {
      job: 'Water leak',
      marks: {
        'Moses Rodriguez': {
          mark: 'N',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'N',
          remark: '',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'MINOR REPAIRS ONLY',
        },
      },
    },
    {
      job: 'Winterization',
      marks: {
        'Moses Rodriguez': {
          mark: 'Y',
          remark: '',
        },
        'Amy Wilson': {
          mark: 'Y',
          remark: 'PROVIDED WITH DETAILED INSTRUCTIONS',
        },
        'Kevin Granados': {
          mark: 'Y',
          remark: 'PROVIDED WITH DETAILED INSTRUCTIONS',
        },
        'Thomas Allen Kivi': {
          mark: 'Y',
          remark: 'PROVIDED WITH DETAILED INSTRUCTIONS',
        },
        'Emanuel Hall': {
          mark: 'Y',
          remark: 'PROVIDED WITH DETAILED INSTRUCTIONS',
        },
      },
    },
  ],
};
