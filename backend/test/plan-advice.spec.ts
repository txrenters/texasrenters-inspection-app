import { AiProvider, InspectionType, TbpPlanStatus } from '@prisma/client';

import type { AiProviderSettingsService } from '../src/admin/ai-provider-settings.service';
import type { TechnicianSkillsService } from '../src/admin/technician-skills.service';
import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import { PlanAdvisorService } from '../src/planning/plan-advisor.service';
import type { TbpStopEditService } from '../src/planning/tbp-stop-edit.service';

/**
 * The office (2026-09-20): "can you integrate ai into this also cause I have
 * openai integrated already with the system".
 *
 * What a model says about a quarter is a suggestion, and this is where it is
 * held to the office's rules. Every test here is about a move the model asked
 * for and the plan refused, or one it earned.
 */

const USER = { id: 'user-1', organizationId: 'org-1', principalType: 'USER' } as unknown as AuthenticatedUser;

const PLAN = {
  id: 'plan-1',
  status: TbpPlanStatus.DRAFT,
  quarterYear: 2026,
  quarterNumber: 4,
  minStopsPerDay: 9,
  maxStopsPerDay: 10,
  maxOnSiteMinutes: 360,
  maxLegMinutes: 20,
};

/** Four visits in one neighbourhood, and one fifteen kilometres north of them. */
const DAY_ONE = ['a1', 'a2', 'a3', 'a4'].map((id, index) => ({
  id,
  zone: '1',
  scheduledOn: new Date('2026-10-01T00:00:00.000Z'),
  assignedTechnicianId: 'tech-1',
  onSiteMinutes: 20,
  inspectionType: InspectionType.OCCUPIED,
  assignedTechnician: { displayName: 'Moses' },
  propertywareBuilding: { latitude: 29.76 + index * 0.001, longitude: -95.37 },
  tenant: { addressLine1: `${index + 1} Near St` },
}));

const STRAY = {
  id: 'stray',
  zone: '1',
  scheduledOn: new Date('2026-10-01T00:00:00.000Z'),
  assignedTechnicianId: 'tech-1',
  onSiteMinutes: 20,
  inspectionType: InspectionType.OCCUPIED,
  assignedTechnician: { displayName: 'Moses' },
  propertywareBuilding: { latitude: 29.901, longitude: -95.37 },
  tenant: { addressLine1: '9 Far Rd' },
};

/** Two visits where the stray belongs. */
const DAY_TWO = ['b1', 'b2'].map((id, index) => ({
  id,
  zone: '2',
  scheduledOn: new Date('2026-10-02T00:00:00.000Z'),
  assignedTechnicianId: 'tech-2',
  onSiteMinutes: 20,
  inspectionType: InspectionType.OCCUPIED,
  assignedTechnician: { displayName: 'Kevin' },
  propertywareBuilding: { latitude: 29.9 + index * 0.001, longitude: -95.37 },
  tenant: { addressLine1: `${index + 1} Far Rd` },
}));

/** Two more in the first neighbourhood, on a day of their own. */
const DAY_THREE = ['c1', 'c2'].map((id, index) => ({
  id,
  zone: '1',
  scheduledOn: new Date('2026-10-05T00:00:00.000Z'),
  assignedTechnicianId: 'tech-2',
  onSiteMinutes: 20,
  inspectionType: InspectionType.OCCUPIED,
  assignedTechnician: { displayName: 'Kevin' },
  propertywareBuilding: { latitude: 29.7605 + index * 0.001, longitude: -95.37 },
  tenant: { addressLine1: `${index + 1} Same St` },
}));

const reply = (body: { notes?: string[]; moves?: unknown[] }) => ({
  ok: true,
  status: 200,
  json: () =>
    Promise.resolve({
      output: [{ content: [{ text: JSON.stringify({ notes: body.notes ?? [], moves: body.moves ?? [] }) }] }],
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
});

const build = (answer: { notes?: string[]; moves?: unknown[] }) => {
  const auditCreate = jest.fn().mockResolvedValue({});
  const prisma = {
    tbpQuarterPlan: { findFirst: jest.fn().mockResolvedValue(PLAN) },
    tbpQuarterPlanStop: { findMany: jest.fn().mockResolvedValue([...DAY_ONE, STRAY, ...DAY_TWO, ...DAY_THREE]) },
    tbpQuarterPlanAnchor: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: auditCreate },
  } as unknown as PrismaService;
  const ai = {
    resolve: jest.fn().mockResolvedValue({ provider: AiProvider.OPENAI, modelId: 'gpt-5.6-terra', apiKey: 'key' }),
    recordUsage: jest.fn().mockResolvedValue(undefined),
  } as unknown as AiProviderSettingsService;
  const skills = {
    qualificationCalendar: jest
      .fn()
      .mockImplementation((_organizationId: string, _type: InspectionType, dates: Date[]) =>
        Promise.resolve(
          new Map(
            dates.map((date) => [
              date.toISOString().slice(0, 10),
              [{ technicianId: 'tech-1' }, { technicianId: 'tech-2' }],
            ]),
          ),
        ),
      ),
  } as unknown as TechnicianSkillsService;
  const edit = jest.fn().mockResolvedValue({ id: 'stray', changed: ['scheduledOn'] });
  const edits = { edit } as unknown as TbpStopEditService;
  const fetchMock = jest.fn().mockResolvedValue(reply(answer));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { service: new PlanAdvisorService(prisma, ai, skills, edits), edit, auditCreate, fetchMock, ai };
};

describe('what AI makes of a quarter', () => {
  it('keeps a move that shortens the driving and breaks no rule', async () => {
    const { service } = build({
      notes: ['Thu 1 Oct mixes four visits in one neighbourhood with one fifteen kilometres north.'],
      moves: [{ stopId: 'stray', toDate: '2026-10-02', toTechnicianId: 'tech-2', why: 'It is next to Kevin’s day.' }],
    });

    const advice = await service.advise(USER, 'plan-1');

    expect(advice.notes).toHaveLength(1);
    expect(advice.proposed).toBe(1);
    expect(advice.moves).toHaveLength(1);
    expect(advice.moves[0]).toMatchObject({ stopId: 'stray', toDate: '2026-10-02', toTechnicianId: 'tech-2' });
    expect(advice.moves[0]!.savedMinutes).toBeGreaterThan(0);
    expect(advice.savedMinutes).toBeGreaterThan(0);
  });

  /** Advice changes nothing by itself: the office applies what it wants. */
  it('writes nothing to the plan', async () => {
    const { service, edit } = build({
      moves: [{ stopId: 'stray', toDate: '2026-10-02', toTechnicianId: 'tech-2' }],
    });

    await service.advise(USER, 'plan-1');

    expect(edit).not.toHaveBeenCalled();
  });

  it('refuses a move that would drive further than the office allows between two properties', async () => {
    const { service } = build({
      moves: [{ stopId: 'a1', toDate: '2026-10-02', toTechnicianId: 'tech-2', why: 'Balance the days.' }],
    });

    const advice = await service.advise(USER, 'plan-1');

    expect(advice.moves).toEqual([]);
    expect(advice.refused[0]!.refused).toContain('more than 20 minutes');
  });

  it('refuses a move to a day the plan does not have, and a visit it does not have', async () => {
    const { service } = build({
      moves: [
        { stopId: 'stray', toDate: '2026-10-09', toTechnicianId: 'tech-2' },
        { stopId: 'not-a-stop', toDate: '2026-10-02', toTechnicianId: 'tech-2' },
      ],
    });

    const advice = await service.advise(USER, 'plan-1');

    expect(advice.moves).toEqual([]);
    expect(advice.refused.map((one) => one.refused)).toEqual([
      'That day and technician are not a day of this plan.',
      'No visit in this quarter has that id.',
    ]);
  });

  it('refuses a move that does not shorten the driving', async () => {
    const { service } = build({
      // Next door to where it already is: legal, and worth nothing.
      moves: [{ stopId: 'a1', toDate: '2026-10-05', toTechnicianId: 'tech-2' }],
    });

    const advice = await service.advise(USER, 'plan-1');

    expect(advice.moves).toEqual([]);
    expect(advice.refused[0]!.refused).toBe('It would not shorten the driving.');
  });

  /** A malformed answer is no advice, not a failed request. */
  it('reads an answer that is not the JSON it asked for as nothing', async () => {
    const { service, fetchMock } = build({});
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ output: [{ content: [{ text: 'sorry' }] }] }) });

    const advice = await service.advise(USER, 'plan-1');

    expect(advice).toMatchObject({ notes: [], proposed: 0, moves: [], savedMinutes: 0 });
  });

  it('says so when the provider fails, rather than half-applying anything', async () => {
    const { service, fetchMock, edit } = build({});
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });

    await expect(service.advise(USER, 'plan-1')).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' });
    expect(edit).not.toHaveBeenCalled();
  });

  it('records what it asked and what survived, and the tokens it cost', async () => {
    const { service, auditCreate, ai } = build({
      notes: ['One note.'],
      moves: [{ stopId: 'stray', toDate: '2026-10-02', toTechnicianId: 'tech-2' }],
    });

    await service.advise(USER, 'plan-1');

    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      action: 'TBP_PLAN_ADVICE_ASKED',
      entityId: 'plan-1',
      metadata: expect.objectContaining({ proposed: 1, kept: 1 }),
    });
    expect((ai.recordUsage as jest.Mock).mock.calls[0][3]).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });
});

describe('applying the moves the office took', () => {
  it('judges each one again and writes it as a coordinator’s own edit', async () => {
    const { service, edit } = build({});

    const applied = await service.apply(USER, 'plan-1', [
      { stopId: 'stray', toDate: '2026-10-02', toTechnicianId: 'tech-2' },
    ]);

    expect(applied).toMatchObject({ applied: 1, refused: [] });
    expect(edit).toHaveBeenCalledWith(USER, 'stray', { scheduledOn: '2026-10-02', assignedTechnicianId: 'tech-2' });
  });

  it('writes nothing for a move the plan now refuses', async () => {
    const { service, edit } = build({});

    const applied = await service.apply(USER, 'plan-1', [
      { stopId: 'a1', toDate: '2026-10-02', toTechnicianId: 'tech-2' },
    ]);

    expect(applied.applied).toBe(0);
    expect(applied.refused).toHaveLength(1);
    expect(edit).not.toHaveBeenCalled();
  });

  /** No provider call: applying is the office's decision, already made. */
  it('asks the model nothing', async () => {
    const { service, fetchMock } = build({});

    await service.apply(USER, 'plan-1', [{ stopId: 'stray', toDate: '2026-10-02', toTechnicianId: 'tech-2' }]);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
