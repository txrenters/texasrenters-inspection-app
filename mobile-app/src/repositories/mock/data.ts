import type {
  DemoUser,
  Finding,
  Inspection,
  InspectionRoom,
  Property,
  UploadItem,
} from '../../domain/models';

export const demoUsers: DemoUser[] = [
  {
    id: 'demo-technician',
    name: 'Maya Rodriguez',
    initials: 'MR',
    role: 'TECHNICIAN',
    roleLabel: 'Inspection Technician',
  },
  {
    id: 'demo-reviewer',
    name: 'Jordan Lee',
    initials: 'JL',
    role: 'REVIEWER',
    roleLabel: 'Condition Reviewer',
  },
  {
    id: 'demo-administrator',
    name: 'Alex Morgan',
    initials: 'AM',
    role: 'ADMINISTRATOR',
    roleLabel: 'Property Administrator',
  },
];

export const properties: Property[] = [
  {
    id: 'property-oak-ridge',
    externalPropertyId: 'EXT-PROP-1458-OR',
    externalOwnerId: 'EXT-OWNER-1042',
    externalPortfolioId: 'EXT-PORTFOLIO-AUS-01',
    name: 'Oak Ridge House',
    address: '1458 Oak Ridge Drive',
    cityStateZip: 'Austin, TX 78704',
    bedrooms: 4,
    bathrooms: 3,
    floors: ['Ground Floor', 'Second Floor'],
    accessInstructions:
      'Lockbox is mounted beside the garage entry. Confirm occupancy before entry.',
    notes: 'Document all wall, flooring, and appliance conditions. Garage is optional.',
    imageTone: 'teal',
  },
  {
    id: 'property-cedar-bend',
    externalPropertyId: 'EXT-PROP-2840-CB',
    externalOwnerId: 'EXT-OWNER-1188',
    externalPortfolioId: 'EXT-PORTFOLIO-AUS-01',
    name: 'Cedar Bend Townhome',
    address: '2840 Cedar Bend Lane',
    cityStateZip: 'Round Rock, TX 78681',
    bedrooms: 3,
    bathrooms: 3,
    floors: ['Ground Floor', 'Second Floor'],
    accessInstructions: 'Use the smart lock code from the assignment notes.',
    notes: 'HOA parking is limited to marked visitor spaces.',
    imageTone: 'navy',
  },
  {
    id: 'property-south-congress',
    externalPropertyId: 'EXT-PROP-918-SC',
    externalOwnerId: 'EXT-OWNER-1203',
    externalPortfolioId: 'EXT-PORTFOLIO-AUS-02',
    name: 'South Congress Loft',
    address: '918 South Congress Avenue, Unit 304',
    cityStateZip: 'Austin, TX 78704',
    bedrooms: 2,
    bathrooms: 2,
    floors: ['Level 3'],
    accessInstructions: 'Check in with the concierge and present company identification.',
    notes: 'Pay special attention to polished concrete flooring.',
    imageTone: 'sand',
  },
  {
    id: 'property-willow-creek',
    externalPropertyId: 'EXT-PROP-772-WC',
    externalOwnerId: 'EXT-OWNER-1042',
    externalPortfolioId: 'EXT-PORTFOLIO-AUS-02',
    name: 'Willow Creek Duplex',
    address: '772 Willow Creek Road, Unit B',
    cityStateZip: 'Pflugerville, TX 78660',
    bedrooms: 3,
    bathrooms: 2,
    floors: ['Ground Floor'],
    accessInstructions: 'Unit B entrance is on the east side of the building.',
    notes: 'Backyard condition is documented separately and is not part of room video capture.',
    imageTone: 'sage',
  },
];

const oakRoomNames = [
  ['Ground Floor', 'Entryway', true],
  ['Ground Floor', 'Living Area', true],
  ['Ground Floor', 'Kitchen', true],
  ['Ground Floor', 'Dining Area', true],
  ['Ground Floor', 'Common Bathroom', true],
  ['Ground Floor', 'Garage', false],
  ['Second Floor', 'Master Bedroom', true],
  ['Second Floor', 'Master Bathroom', true],
  ['Second Floor', 'Bedroom 1', true],
  ['Second Floor', 'Bedroom 2', true],
  ['Second Floor', 'Common Bathroom 2', true],
] as const;

function baseline(name: string) {
  if (name === 'Bedroom 1') {
    return {
      summary: 'Walls, carpet, and closet door documented in good condition at move-in.',
      condition: 'DOCUMENTED' as const,
      existingDefects: ['Small paint chip beside the light switch'],
      evidenceCount: 4,
    };
  }
  if (name === 'Kitchen') {
    return {
      summary: 'Cabinetry and appliances were functional with light countertop wear.',
      condition: 'DOCUMENTED' as const,
      existingDefects: ['Light wear at the sink-side countertop edge'],
      evidenceCount: 6,
    };
  }
  return {
    summary: 'Move-in condition is documented with room notes and reference photos.',
    condition: 'DOCUMENTED' as const,
    existingDefects: [],
    evidenceCount: 3,
  };
}

export const oakRooms: InspectionRoom[] = oakRoomNames.map(
  ([floorName, name, isRequired], index) => {
    const completed = index < 4;
    const uploadFailed = name === 'Kitchen';
    const processing = name === 'Dining Area';
    return {
      id: `room-oak-${index + 1}`,
      inspectionId: 'inspection-oak',
      propertyAreaId: `external-area-oak-${index + 1}`,
      name,
      floorName,
      order: index + 1,
      isRequired,
      inspectionType: 'MOVE_OUT',
      baseline: baseline(name),
      completionStatus: completed ? 'COMPLETED' : 'NOT_STARTED',
      uploadStatus: uploadFailed ? 'FAILED' : completed ? 'COMPLETED' : 'PENDING',
      processingStatus: processing ? 'ANALYZING' : completed ? 'READY_FOR_REVIEW' : 'NOT_STARTED',
      reviewStatus: completed && !processing ? 'PENDING_REVIEW' : undefined,
    };
  },
);

function simpleRooms(
  inspectionId: string,
  floorName: string,
  count = 6,
  inspectionType: Inspection['type'] = 'MOVE_OUT',
): InspectionRoom[] {
  const names = ['Entryway', 'Living Area', 'Kitchen', 'Primary Bedroom', 'Bathroom', 'Laundry'];
  return names.slice(0, count).map((name, index) => ({
    id: `room-${inspectionId}-${index + 1}`,
    inspectionId,
    propertyAreaId: `external-area-${inspectionId}-${index + 1}`,
    name,
    floorName,
    order: index + 1,
    isRequired: true,
    inspectionType,
    baseline: baseline(name),
    completionStatus: 'COMPLETED',
    uploadStatus: 'COMPLETED',
    processingStatus: 'READY_FOR_REVIEW',
    reviewStatus: 'APPROVED',
  }));
}

function inspectionPresentation(
  propertyId: string,
  progress: Inspection['progress'],
): Pick<Inspection, 'property' | 'progress'> {
  const property = properties.find((item) => item.id === propertyId)!;
  return {
    property: {
      id: property.id,
      address: property.address,
      cityStateZip: property.cityStateZip,
      imageTone: property.imageTone,
    },
    progress,
  };
}

export const inspections: Inspection[] = [
  {
    id: 'inspection-oak',
    externalInspectionId: 'EXT-INSP-2026-0717-001',
    propertyId: 'property-oak-ridge',
    type: 'MOVE_OUT',
    scheduledAt: '2026-07-17T09:00:00.000Z',
    assignedUserId: 'demo-technician',
    status: 'IN_PROGRESS',
    priority: 'HIGH',
    roomIds: oakRooms.map((room) => room.id),
    propertyNotes: 'Tenant returned keys yesterday. Verify all required rooms before completion.',
    ...inspectionPresentation('property-oak-ridge', {
      completed: 4,
      total: 10,
      hasFailedUpload: true,
    }),
  },
  {
    id: 'inspection-cedar',
    externalInspectionId: 'EXT-INSP-2026-0717-002',
    propertyId: 'property-cedar-bend',
    type: 'BACK_TO_MARKET',
    baselineInspectionId: 'inspection-cedar-complete',
    baselineScheduledAt: '2026-07-09T13:00:00.000Z',
    scheduledAt: '2026-07-17T14:30:00.000Z',
    assignedUserId: 'demo-technician',
    status: 'SCHEDULED',
    priority: 'STANDARD',
    roomIds: [],
    propertyNotes: 'Begin after 2:30 PM. Resident has confirmed vacancy.',
    ...inspectionPresentation('property-cedar-bend', {
      completed: 0,
      total: 6,
      hasFailedUpload: false,
    }),
  },
  {
    id: 'inspection-loft',
    externalInspectionId: 'EXT-INSP-2026-0716-004',
    propertyId: 'property-south-congress',
    type: 'OCCUPIED',
    scheduledAt: '2026-07-16T11:00:00.000Z',
    assignedUserId: 'demo-technician',
    status: 'IN_PROGRESS',
    priority: 'STANDARD',
    roomIds: [],
    propertyNotes: 'Upload was paused when the building Wi-Fi became unavailable.',
    ...inspectionPresentation('property-south-congress', {
      completed: 3,
      total: 6,
      hasFailedUpload: false,
    }),
  },
  {
    id: 'inspection-willow',
    externalInspectionId: 'EXT-INSP-2026-0715-003',
    propertyId: 'property-willow-creek',
    type: 'MOVE_IN',
    scheduledAt: '2026-07-15T10:00:00.000Z',
    assignedUserId: 'demo-technician',
    status: 'COMPLETED',
    priority: 'STANDARD',
    roomIds: [],
    propertyNotes: 'Completed and ready for management report review.',
    ...inspectionPresentation('property-willow-creek', {
      completed: 6,
      total: 6,
      hasFailedUpload: false,
    }),
  },
  {
    id: 'inspection-cedar-complete',
    externalInspectionId: 'EXT-INSP-2026-0709-008',
    propertyId: 'property-cedar-bend',
    type: 'MOVE_IN',
    scheduledAt: '2026-07-09T13:00:00.000Z',
    assignedUserId: 'demo-technician',
    status: 'COMPLETED',
    priority: 'STANDARD',
    roomIds: [],
    propertyNotes: 'Archived demo inspection.',
    ...inspectionPresentation('property-cedar-bend', {
      completed: 6,
      total: 6,
      hasFailedUpload: false,
    }),
  },
];

export const rooms: InspectionRoom[] = [
  ...oakRooms,
  ...simpleRooms('inspection-cedar', 'Ground Floor', 6, 'BACK_TO_MARKET').map((room) => ({
    ...room,
    completionStatus: 'NOT_STARTED' as const,
    uploadStatus: 'PENDING' as const,
    processingStatus: 'NOT_STARTED' as const,
    reviewStatus: undefined,
  })),
  ...simpleRooms('inspection-loft', 'Level 3', 6, 'OCCUPIED').map((room, index) =>
    index < 3
      ? room
      : {
          ...room,
          completionStatus: 'NOT_STARTED' as const,
          uploadStatus: 'PENDING' as const,
          processingStatus: 'NOT_STARTED' as const,
          reviewStatus: undefined,
        },
  ),
  ...simpleRooms('inspection-willow', 'Ground Floor', 6, 'MOVE_IN'),
  ...simpleRooms('inspection-cedar-complete', 'Ground Floor', 6, 'MOVE_IN'),
];

for (const inspection of inspections) {
  if (!inspection.roomIds.length) {
    inspection.roomIds = rooms
      .filter((room) => room.inspectionId === inspection.id)
      .map((room) => room.id);
  }
}

export const seedFindings: Finding[] = [
  {
    id: 'finding-bedroom-wall',
    inspectionId: 'inspection-oak',
    roomId: 'room-oak-9',
    roomName: 'Bedroom 1',
    title: 'Deep scratches near closet',
    category: 'Walls and paint',
    severity: 'MEDIUM',
    comparisonResult: 'POSSIBLE_NEW_DAMAGE',
    confidence: 0.88,
    videoTimestampStart: 12,
    videoTimestampEnd: 19,
    baselineCondition:
      'Walls documented in good condition with one small paint chip by the switch.',
    observation: 'Several deep linear scratches are visible on the wall beside the closet.',
    aiSummary: 'Possible change from the move-in baseline. Human evidence review is required.',
    recommendedReview: 'Compare the wall close-up with move-in photo 3.',
    reviewStatus: 'PENDING_REVIEW',
  },
  {
    id: 'finding-bedroom-carpet',
    inspectionId: 'inspection-oak',
    roomId: 'room-oak-9',
    roomName: 'Bedroom 1',
    title: 'Large carpet stain near window',
    category: 'Flooring',
    severity: 'HIGH',
    comparisonResult: 'POSSIBLE_NEW_DAMAGE',
    confidence: 0.92,
    videoTimestampStart: 24,
    videoTimestampEnd: 31,
    baselineCondition: 'Carpet documented in good condition at move-in.',
    observation: 'A dark irregular stain is visible near the window.',
    aiSummary: 'The condition may differ from the baseline; this is not a final determination.',
    recommendedReview: 'Review the full-resolution video and baseline flooring photos.',
    reviewStatus: 'PENDING_REVIEW',
  },
  {
    id: 'finding-bedroom-hinge',
    inspectionId: 'inspection-oak',
    roomId: 'room-oak-9',
    roomName: 'Bedroom 1',
    title: 'Damaged lower closet-door hinge',
    category: 'Doors and hardware',
    severity: 'MEDIUM',
    comparisonResult: 'INSUFFICIENT_EVIDENCE',
    confidence: 0.71,
    videoTimestampStart: 34,
    videoTimestampEnd: 39,
    baselineCondition: 'Closet door was documented as functional.',
    observation: 'Lower hinge appears loose and the door is not aligned.',
    aiSummary: 'Available framing is limited. A reviewer may request closer evidence.',
    recommendedReview: 'Request reinspection if hinge movement cannot be confirmed.',
    reviewStatus: 'PENDING_REVIEW',
  },
];

export const seedUploads: UploadItem[] = [
  {
    id: 'upload-kitchen',
    mediaId: 'media-kitchen',
    inspectionId: 'inspection-oak',
    roomId: 'room-oak-3',
    propertyAddress: '1458 Oak Ridge Drive',
    roomName: 'Kitchen',
    durationSeconds: 64,
    estimatedSizeMb: 42.8,
    status: 'FAILED',
    progress: 0.43,
    lastError: 'Connection interrupted. The local video is safe.',
    processingStatus: 'NOT_STARTED',
    processingProgress: 0,
    createdAt: '2026-07-17T09:24:00.000Z',
  },
  {
    id: 'upload-living',
    mediaId: 'media-living',
    inspectionId: 'inspection-oak',
    roomId: 'room-oak-2',
    propertyAddress: '1458 Oak Ridge Drive',
    roomName: 'Living Area',
    durationSeconds: 78,
    estimatedSizeMb: 51.2,
    status: 'UPLOADING',
    progress: 0.66,
    processingStatus: 'NOT_STARTED',
    processingProgress: 0,
    createdAt: '2026-07-17T09:10:00.000Z',
  },
  {
    id: 'upload-dining',
    mediaId: 'media-dining',
    inspectionId: 'inspection-oak',
    roomId: 'room-oak-4',
    propertyAddress: '1458 Oak Ridge Drive',
    roomName: 'Dining Area',
    durationSeconds: 48,
    estimatedSizeMb: 31.6,
    status: 'COMPLETED',
    progress: 1,
    processingStatus: 'ANALYZING',
    processingProgress: 0.52,
    createdAt: '2026-07-17T08:55:00.000Z',
  },
];
