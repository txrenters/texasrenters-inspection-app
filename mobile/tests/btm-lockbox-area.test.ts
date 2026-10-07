import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { lockboxUnansweredMessage } from '@texasrenters/shared';

import { checklistForArea } from '../src/capture/area-checklist';
import type { InspectionRoom } from '../src/domain/models';
import { areaCompletionGate, deriveAreaRequirements } from '../src/utils/area-requirements';

/**
 * The sign, supra and lockbox on every back-to-market visit (Moses, 2026-10-08):
 * "Installed?" and "Key functioning?", both required, and a box for notes.
 */

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('the questions, with no signal', () => {
  it('are the sign, supra and lockbox questions for that area', () => {
    const items = checklistForArea({ name: 'Sign, supra and lockbox', inspectionType: 'BACK_TO_MARKET' });
    expect(items.map((item) => [item.label, item.responseType, item.choices])).toEqual([
      ['Installed?', 'CHOICE', ['Yes', 'No']],
      ['Key functioning?', 'CHOICE', ['Yes', 'No']],
      ['Notes on installation or the key', 'TEXT', []],
    ]);
  });

  it('stay the condition pair everywhere else on the visit', () => {
    const items = checklistForArea({ name: 'Kitchen', inspectionType: 'BACK_TO_MARKET' });
    expect(items.map((item) => item.label)).toEqual(['Room condition', 'Overall condition']);
  });
});

describe('submitting the area', () => {
  const room: InspectionRoom = {
    id: 'room-1',
    inspectionId: 'insp-1',
    propertyAreaId: 'area-1',
    name: 'Sign, supra and lockbox',
    floorName: 'Property',
    order: 1,
    isRequired: true,
    inspectionType: 'BACK_TO_MARKET',
    baseline: { summary: '', condition: 'NOT_AVAILABLE', existingDefects: [], evidenceCount: 0 },
    completionStatus: 'NOT_STARTED',
    uploadStatus: 'PENDING',
    processingStatus: 'NOT_STARTED',
  };
  const wording = { label: 'Both questions answered', hint: lockboxUnansweredMessage };

  it('waits for both questions, and says which is missing', () => {
    const requirements = deriveAreaRequirements(room, {
      hasPrimaryRecording: false,
      photoCount: 2,
      findingCount: 0,
      uploadSettled: false,
      unansweredItems: ['Key functioning?'],
      unansweredWording: wording,
    });
    const questions = requirements.find((requirement) => requirement.key === 'checklist');
    expect(questions).toMatchObject({
      label: 'Both questions answered',
      met: false,
      blocking: true,
      hint: 'Answer "Key functioning?" before submitting this area.',
    });
    expect(areaCompletionGate(requirements).canComplete).toBe(false);
  });

  it('goes once both are answered and a photo is taken', () => {
    const requirements = deriveAreaRequirements(room, {
      hasPrimaryRecording: false,
      photoCount: 1,
      findingCount: 0,
      uploadSettled: false,
      unansweredItems: [],
      unansweredWording: wording,
    });
    expect(areaCompletionGate(requirements).canComplete).toBe(true);
  });
});

describe('on the area screen', () => {
  const card = read('src/areas/OccupiedConditionCard.tsx');
  const screen = read('app/(app)/areas/[id].tsx');

  it('writes the notes in a text box, not a row of options', () => {
    expect(card).toMatch(/item\.responseType === 'TEXT'[\s\S]*<TextField/);
  });

  it('opens no comment box under a "No": the notes box is for that', () => {
    expect(card).toMatch(/!lockbox && choiceInvitesComment\(answer\)/);
  });

  it('never offers to remove the area from a back-to-market visit', () => {
    expect(screen).toMatch(/lockboxArea && item\.inspectionType === InspectionType\.BACK_TO_MARKET\) \? null/);
  });
});
