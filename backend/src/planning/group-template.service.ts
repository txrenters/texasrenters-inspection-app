import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  type GroupTemplateOp,
  MAX_STOPS_PER_DAY,
  applyGroupOps,
  groupTemplateOpsSchema,
  zoneNumberOf,
} from '@texasrenters/shared';

import { BUILDING_POSITION_SELECT, propertyPosition } from '../admin/property-position';
import { auditActor, type AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import {
  addressKeyCandidates,
  buildAddressIndex,
  buildLooseAddressIndex,
  looseAddressKey,
  matchBuildingWithFallback,
} from '../integrations/jobber/jobber.address';
import { isTbpEnrolled } from '../integrations/propertyware/propertyware.tenant-report';
import { GroupTemplateGateway } from './group-template.gateway';

/**
 * The office's group templates: its own grouping of the benefit-package
 * properties into days, made in the console's Group maker (2026-09-30).
 *
 * A template is a list of groups, each an ordered list of buildings. It says
 * nothing about dates, technicians or tenancies -- a quarter built from it
 * (`QuarterPlannerService.route`, `groupTemplateId`) finds each building's
 * visits that quarter, and hands the groups out as its days by its own rules.
 */

/** A group as the console sends and reads it. */
export interface GroupTemplateGroupInput {
  /** Kept when given, so a group keeps its id through a save; a new one otherwise. */
  id?: string;
  name: string;
  /** `#rrggbb`. */
  color: string;
  target: number;
  /** In the group's driving order. */
  buildingIds: string[];
}

export interface GroupTemplateInput {
  name: string;
  minutesPerProperty?: number;
  groups: GroupTemplateGroupInput[];
  /** The revision the edit started from; absent on a new template. */
  revision?: number;
}

/** A property the Group maker can put in a group: an enrolled building, with its tenancies. */
export interface GroupMakerProperty {
  buildingId: string;
  address: string;
  city: string | null;
  postalCode: string | null;
  latitude: number;
  longitude: number;
  /** A city or postcode centre rather than the house: drawn as approximate. */
  approximate: boolean;
  /** The zone most of its tenancies are in, as a number; null when none says. */
  zone: string | null;
  /** Each enrolled tenancy's HVAC plan, as the tenant report writes it. */
  hvacPlans: string[];
  /** Each enrolled tenancy's lease name: who lives there. */
  leases: string[];
  /** Each enrolled tenancy's unit, where the report names one. */
  units: string[];
}

/** How many groups a template may hold: a quarter's worth several times over. */
export const MAX_TEMPLATE_GROUPS = 200;

/**
 * How long one person's live edits to one template are one audit row: the
 * first edit in ten minutes writes it. Live editing saves every click, and a
 * row a click would bury every other entry in the log.
 */
const EDIT_AUDIT_WINDOW_MS = 10 * 60 * 1000;

const COLOR = /^#[0-9a-f]{6}$/i;

const TEMPLATE_SUMMARY_SELECT = {
  id: true,
  name: true,
  isActive: true,
  minutesPerProperty: true,
  revision: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  updatedBy: { select: { id: true, displayName: true } },
} as const;

/** A template's groups, as the planner reads them: each group's buildings in order. */
export interface TemplateForPlanning {
  id: string;
  name: string;
  revision: number;
  archivedAt: Date | null;
  /**
   * Each group's buildings in order, with how many properties the office meant
   * it to hold (`target`): a property new since the template was saved joins a
   * group only while it has room under that (2026-10-01).
   */
  groups: { id: string; position: number; name: string; target: number; buildingIds: string[] }[];
}

/**
 * One template's groups, for a quarter being laid out from it. Null when the
 * organization has no template by that id.
 *
 * A plain function over the client rather than a service method, so the
 * planner can read it without another constructor argument.
 */
export async function templateForPlanning(
  prisma: Pick<PrismaService, 'tbpGroupTemplate'>,
  organizationId: string,
  templateId: string,
): Promise<TemplateForPlanning | null> {
  const template = await prisma.tbpGroupTemplate.findFirst({
    where: { id: templateId, organizationId },
    select: {
      id: true,
      name: true,
      revision: true,
      archivedAt: true,
      groups: {
        orderBy: { position: 'asc' },
        select: {
          id: true,
          position: true,
          name: true,
          target: true,
          members: { orderBy: { position: 'asc' }, select: { buildingId: true } },
        },
      },
    },
  });
  if (!template) return null;
  return {
    id: template.id,
    name: template.name,
    revision: template.revision,
    archivedAt: template.archivedAt,
    groups: template.groups.map((group) => ({
      id: group.id,
      position: group.position,
      name: group.name,
      target: group.target,
      buildingIds: group.members.map((member) => member.buildingId),
    })),
  };
}

/** The active template's id, for a quarter the daily planner creates; null when none is. */
export async function activeTemplateId(
  prisma: Pick<PrismaService, 'tbpGroupTemplate'>,
  organizationId: string,
): Promise<string | null> {
  const active = await prisma.tbpGroupTemplate.findFirst({
    where: { organizationId, isActive: true, archivedAt: null },
    select: { id: true },
  });
  return active?.id ?? null;
}

/**
 * What is wrong with a template as sent, in a sentence; null when nothing is.
 *
 * Checked before anything is written. The database refuses a building in two
 * groups too, but as a bare 500; this says which.
 */
export function templateProblem(input: GroupTemplateInput): string | null {
  if (!input.name.trim()) return 'Give the template a name.';
  if (input.groups.length > MAX_TEMPLATE_GROUPS) return `A template holds at most ${MAX_TEMPLATE_GROUPS} groups.`;
  const seen = new Map<string, string>();
  for (const group of input.groups) {
    if (!group.name.trim()) return 'Every group needs a name.';
    if (!COLOR.test(group.color)) return `${group.name}'s colour must be written as #rrggbb.`;
    if (group.buildingIds.length > MAX_STOPS_PER_DAY)
      return `${group.name} has ${group.buildingIds.length} properties; a day holds at most ${MAX_STOPS_PER_DAY}.`;
    for (const buildingId of group.buildingIds) {
      const other = seen.get(buildingId);
      if (other !== undefined)
        return other === group.name
          ? `${group.name} lists one property twice.`
          : `One property is in both ${other} and ${group.name}; a property is in one group.`;
      seen.set(buildingId, group.name);
    }
  }
  return null;
}

@Injectable()
export class GroupTemplateService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(GroupTemplateGateway) private readonly live?: GroupTemplateGateway,
  ) {}

  /**
   * The properties the Group maker draws: every building with an active,
   * enrolled tenancy and a position, with who lives there.
   *
   * The same enrolment as a quarter's (`isTbpEnrolled`) and the same position
   * as the planner's (`propertyPosition`), so a group drawn here is a group of
   * the visits a quarter will have. A building's tenancies are one property:
   * its units are visited together.
   */
  async properties(organizationId: string): Promise<{ properties: GroupMakerProperty[]; withoutPosition: number }> {
    const tenancies = await this.prisma.propertywareTenant.findMany({
      where: { organizationId, isActive: true, propertywareBuildingId: { not: null } },
      select: {
        leaseName: true,
        zone: true,
        hvacPlan: true,
        tbpEnrollment: true,
        unitName: true,
        building: {
          select: {
            id: true,
            addressLine1: true,
            city: true,
            postalCode: true,
            geocodePrecision: true,
            ...BUILDING_POSITION_SELECT,
          },
        },
      },
      orderBy: { externalId: 'asc' },
    });

    const byBuilding = new Map<string, { building: NonNullable<(typeof tenancies)[number]['building']>; tenancies: typeof tenancies }>();
    for (const tenancy of tenancies) {
      const building = tenancy.building;
      if (!building || !isTbpEnrolled(tenancy.tbpEnrollment)) continue;
      const entry = byBuilding.get(building.id);
      if (entry) entry.tenancies.push(tenancy);
      else byBuilding.set(building.id, { building, tenancies: [tenancy] });
    }

    const properties: GroupMakerProperty[] = [];
    let withoutPosition = 0;
    for (const { building, tenancies: here } of byBuilding.values()) {
      const at = propertyPosition(building);
      if (!at) {
        withoutPosition += 1;
        continue;
      }
      const corrected = at.latitude !== Number(building.latitude) || at.longitude !== Number(building.longitude);
      const present = (values: (string | null)[]) => values.flatMap((value) => (value?.trim() ? [value.trim()] : []));
      properties.push({
        buildingId: building.id,
        address: building.addressLine1?.trim() ?? '',
        city: building.city,
        postalCode: building.postalCode,
        latitude: at.latitude,
        longitude: at.longitude,
        // A position somebody corrected on the ground is exact, whatever the geocoder said.
        approximate: !corrected && building.geocodePrecision === 'CENTROID',
        zone: mostCommon(here.map((tenancy) => zoneNumberOf(tenancy.zone))),
        hvacPlans: present(here.map((tenancy) => tenancy.hvacPlan)),
        leases: present(here.map((tenancy) => tenancy.leaseName)),
        units: present(here.map((tenancy) => tenancy.unitName)),
      });
    }
    properties.sort((left, right) => left.address.localeCompare(right.address));
    return { properties, withoutPosition };
  }

  /** Every template, newest change first; archived ones are marked, not hidden. */
  async list(organizationId: string) {
    const templates = await this.prisma.tbpGroupTemplate.findMany({
      where: { organizationId },
      orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { updatedAt: 'desc' }],
      select: {
        ...TEMPLATE_SUMMARY_SELECT,
        _count: { select: { groups: true, members: true } },
      },
    });
    return templates.map(({ _count, ...template }) => ({ ...template, groupCount: _count.groups, propertyCount: _count.members }));
  }

  async get(organizationId: string, id: string) {
    const template = await this.prisma.tbpGroupTemplate.findFirst({
      where: { id, organizationId },
      select: {
        ...TEMPLATE_SUMMARY_SELECT,
        groups: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            position: true,
            name: true,
            color: true,
            target: true,
            members: {
              orderBy: { position: 'asc' },
              select: { buildingId: true, building: { select: { addressLine1: true, name: true } } },
            },
          },
        },
      },
    });
    if (!template) throw notFound();
    return {
      ...template,
      groups: template.groups.map(({ members, ...group }) => ({ ...group, buildingIds: members.map((member) => member.buildingId) })),
      /**
       * Every member's address, by building. The Group maker knows the
       * properties still in the package; this is how it names one that is not
       * any more -- left the package, or lost its position -- and says which
       * group it was in, rather than only counting them (the office, 2026-10-01).
       */
      addresses: Object.fromEntries(
        template.groups.flatMap((group) =>
          group.members.map((member) => [
            member.buildingId,
            member.building.addressLine1?.trim() || member.building.name,
          ]),
        ),
      ),
    };
  }

  /** A new template, from the groups sent. Inactive until the office makes it the active one. */
  async create(user: AuthenticatedUser, input: GroupTemplateInput) {
    const organizationId = user.organizationId;
    await this.checked(organizationId, input);
    const id = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.tbpGroupTemplate.create({
        data: {
          id,
          organizationId,
          name: input.name.trim(),
          minutesPerProperty: input.minutesPerProperty ?? 30,
          createdById: user.principalType === 'API_KEY' ? null : user.id,
          updatedById: user.principalType === 'API_KEY' ? null : user.id,
        },
      });
      await writeGroups(tx, organizationId, id, input.groups);
    });
    await this.audit(user, 'TBP_GROUP_TEMPLATE_CREATED', id, { name: input.name.trim(), revision: 1, ...counts(input) });
    return this.get(organizationId, id);
  }

  /**
   * The template's groups replaced by the ones sent, as one change.
   *
   * Refused when somebody else saved it since this edit was opened: two people
   * grouping the same properties would otherwise each lose the other's work
   * without a word. Archived templates are kept as they were.
   */
  async save(user: AuthenticatedUser, id: string, input: GroupTemplateInput) {
    const organizationId = user.organizationId;
    await this.checked(organizationId, input);
    if (input.revision === undefined)
      throw new ApplicationError(422, 'TEMPLATE_REVISION_REQUIRED', 'Say which revision of the template this edit started from.');
    const revision = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.tbpGroupTemplate.updateMany({
        where: { id, organizationId, revision: input.revision, archivedAt: null },
        data: {
          name: input.name.trim(),
          ...(input.minutesPerProperty === undefined ? {} : { minutesPerProperty: input.minutesPerProperty }),
          revision: { increment: 1 },
          updatedById: user.principalType === 'API_KEY' ? null : user.id,
        },
      });
      if (claimed.count !== 1) {
        const current = await tx.tbpGroupTemplate.findFirst({
          where: { id, organizationId },
          select: { revision: true, archivedAt: true },
        });
        if (!current) throw notFound();
        if (current.archivedAt)
          throw new ApplicationError(409, 'TEMPLATE_ARCHIVED', 'This template is archived. Copy it into a new one to change it.');
        throw new ApplicationError(
          409,
          'TEMPLATE_CHANGED',
          'Somebody saved this template since you opened it. Open it again to see their changes before saving yours.',
        );
      }
      await tx.tbpGroupTemplateGroup.deleteMany({ where: { templateId: id, organizationId } });
      await writeGroups(tx, organizationId, id, input.groups);
      return input.revision! + 1;
    });
    await this.audit(user, 'TBP_GROUP_TEMPLATE_SAVED', id, { name: input.name.trim(), revision, ...counts(input) });
    this.live?.publishReplaced({ templateId: id, revision, reason: 'SAVED', by: byOf(user) });
    return this.get(organizationId, id);
  }

  /**
   * One batch of live edits (2026-10-01), applied on top of whatever the
   * template holds now -- including what somebody else changed a moment ago --
   * and passed on to everyone with it open.
   *
   * One batch at a time per template: the revision is bumped first, which
   * locks the template's row until the batch is saved, so two batches never
   * interleave. Refused whole when what it would leave breaks a template's
   * rules -- a group past a day's stops, a property that is not the
   * organization's -- and the sender reads the template again.
   */
  async applyOps(user: AuthenticatedUser, id: string, batchId: string, raw: unknown) {
    const organizationId = user.organizationId;
    const parsed = groupTemplateOpsSchema.safeParse(raw);
    if (!parsed.success)
      throw new ApplicationError(422, 'INVALID_GROUP_TEMPLATE_OPS', 'These changes could not be read. Reload the template.');
    const ops = parsed.data as GroupTemplateOp<string>[];
    const settings: { name?: string; minutesPerProperty?: number } = {};
    for (const op of ops)
      if (op.type === 'template.update') {
        if (op.name !== undefined) settings.name = op.name.trim();
        if (op.minutesPerProperty !== undefined) settings.minutesPerProperty = op.minutesPerProperty;
      }

    const saved = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.tbpGroupTemplate.updateMany({
        where: { id, organizationId, archivedAt: null },
        data: {
          revision: { increment: 1 },
          updatedById: user.principalType === 'API_KEY' ? null : user.id,
          ...settings,
        },
      });
      if (claimed.count !== 1) {
        const exists = await tx.tbpGroupTemplate.findFirst({ where: { id, organizationId }, select: { archivedAt: true } });
        if (!exists) throw notFound();
        throw new ApplicationError(409, 'TEMPLATE_ARCHIVED', 'This template has been archived, so it can no longer be changed.');
      }
      const current = await tx.tbpGroupTemplate.findFirst({
        where: { id, organizationId },
        select: {
          name: true,
          revision: true,
          groups: {
            orderBy: { position: 'asc' },
            select: {
              id: true,
              name: true,
              color: true,
              target: true,
              members: { orderBy: { position: 'asc' }, select: { buildingId: true } },
            },
          },
        },
      });
      if (!current) throw notFound();
      const before = {
        groups: current.groups.map((group) => ({
          id: group.id,
          name: group.name,
          color: group.color,
          target: group.target,
          stops: group.members.map((member) => member.buildingId),
        })),
      };
      const after = applyGroupOps(before, ops);
      const input: GroupTemplateInput = {
        name: current.name,
        groups: after.groups.map((group) => ({
          id: group.id,
          name: group.name,
          color: group.color,
          target: group.target,
          buildingIds: group.stops,
        })),
      };
      const problem = templateProblem(input);
      if (problem) throw new ApplicationError(422, 'INVALID_GROUP_TEMPLATE', problem);
      const known = new Set(before.groups.flatMap((group) => group.stops));
      const added = [...new Set(after.groups.flatMap((group) => group.stops))].filter((building) => !known.has(building));
      if (added.length) {
        const found = await tx.propertywareBuilding.count({ where: { organizationId, id: { in: added } } });
        if (found !== added.length)
          throw new ApplicationError(422, 'UNKNOWN_PROPERTY', 'A property in this change is not one of this organization’s.');
      }
      const existing = new Set(before.groups.map((group) => group.id));
      const made = after.groups.map((group) => group.id).filter((groupId) => !existing.has(groupId));
      if (made.length && (await tx.tbpGroupTemplateGroup.count({ where: { id: { in: made } } })))
        throw new ApplicationError(422, 'INVALID_GROUP_TEMPLATE', 'A new group came with an id already in use. Reload the template.');
      await tx.tbpGroupTemplateGroup.deleteMany({ where: { templateId: id, organizationId } });
      await writeGroups(tx, organizationId, id, input.groups);
      return { revision: current.revision, name: current.name, input };
    });

    this.live?.publishOps({ templateId: id, revision: saved.revision, batchId, ops, by: byOf(user) });
    await this.auditEdit(user, id, saved.revision, saved.input);
    return { revision: saved.revision };
  }

  /**
   * Make a template the active one -- the one the daily planner builds a new
   * quarter from -- or stop it being. One at a time: making one active makes
   * the one before it inactive, in the same transaction.
   */
  async setActive(user: AuthenticatedUser, id: string, active: boolean) {
    const organizationId = user.organizationId;
    const template = await this.prisma.tbpGroupTemplate.findFirst({
      where: { id, organizationId },
      select: { id: true, name: true, archivedAt: true },
    });
    if (!template) throw notFound();
    if (active && template.archivedAt)
      throw new ApplicationError(409, 'TEMPLATE_ARCHIVED', 'An archived template cannot be the active one.');
    await this.prisma.$transaction(async (tx) => {
      if (active)
        await tx.tbpGroupTemplate.updateMany({
          where: { organizationId, isActive: true, NOT: { id } },
          data: { isActive: false },
        });
      await tx.tbpGroupTemplate.update({ where: { id }, data: { isActive: active } });
    });
    await this.audit(user, active ? 'TBP_GROUP_TEMPLATE_ACTIVATED' : 'TBP_GROUP_TEMPLATE_DEACTIVATED', id, { name: template.name });
    const detail = await this.get(organizationId, id);
    this.live?.publishReplaced({ templateId: id, revision: detail.revision, reason: 'ACTIVATED', by: byOf(user) });
    return detail;
  }

  /**
   * Put a template away. Kept rather than deleted: a quarter built from it
   * still says which grouping it was, and a rebuild of that quarter is told to
   * choose another rather than quietly grouping some other way.
   */
  async archive(user: AuthenticatedUser, id: string) {
    const organizationId = user.organizationId;
    const archived = await this.prisma.tbpGroupTemplate.updateMany({
      where: { id, organizationId, archivedAt: null },
      data: { archivedAt: new Date(), isActive: false },
    });
    if (archived.count !== 1) {
      const exists = await this.prisma.tbpGroupTemplate.findFirst({ where: { id, organizationId }, select: { id: true } });
      if (!exists) throw notFound();
    } else await this.audit(user, 'TBP_GROUP_TEMPLATE_ARCHIVED', id, {});
    const detail = await this.get(organizationId, id);
    this.live?.publishReplaced({ templateId: id, revision: detail.revision, reason: 'ARCHIVED', by: byOf(user) });
    return detail;
  }

  /**
   * Rows of a groups file, matched to the Group maker's properties by address.
   *
   * The Jobber sync's address rules -- strict first, then without the street
   * type -- so a file and a visit cannot disagree about one house. A row two
   * buildings answer to is left for the office rather than handed to either.
   */
  async match(organizationId: string, rows: readonly { address: string; postalCode?: string | null }[]) {
    const { properties } = await this.properties(organizationId);
    const candidates = properties.map((property) => ({
      id: property.buildingId,
      addressLine1: property.address,
      postalCode: property.postalCode,
    }));
    const strict = buildAddressIndex(candidates);
    const loose = buildLooseAddressIndex(candidates);
    return {
      matches: rows.map((row) => {
        const match = matchBuildingWithFallback(
          strict,
          loose,
          addressKeyCandidates(row.address, null, row.postalCode ?? null),
          looseAddressKey(row.address, row.postalCode ?? null),
        );
        return match.outcome === 'MATCHED'
          ? { buildingId: match.buildingId, outcome: match.outcome }
          : { buildingId: null, outcome: match.outcome };
      }),
    };
  }

  /** Refused unless every property is this organization's, and the groups make sense. */
  private async checked(organizationId: string, input: GroupTemplateInput) {
    const problem = templateProblem(input);
    if (problem) throw new ApplicationError(422, 'INVALID_GROUP_TEMPLATE', problem);
    const buildingIds = [...new Set(input.groups.flatMap((group) => group.buildingIds))];
    if (buildingIds.length === 0) return;
    const known = await this.prisma.propertywareBuilding.count({ where: { organizationId, id: { in: buildingIds } } });
    if (known !== buildingIds.length)
      throw new ApplicationError(422, 'UNKNOWN_PROPERTY', 'A property in this template is not one of this organization’s.');
  }

  /** One row per person per template per ten minutes of live editing, however many clicks. */
  private async auditEdit(user: AuthenticatedUser, templateId: string, revision: number, input: GroupTemplateInput) {
    const recent = await this.prisma.auditLog.findFirst({
      where: {
        organizationId: user.organizationId,
        action: 'TBP_GROUP_TEMPLATE_EDITED',
        entityType: 'TbpGroupTemplate',
        entityId: templateId,
        ...auditActor(user),
        createdAt: { gte: new Date(Date.now() - EDIT_AUDIT_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (!recent) await this.audit(user, 'TBP_GROUP_TEMPLATE_EDITED', templateId, { revision, ...counts(input) });
  }

  /** Who changed which template and how much of it: never an address or a tenant. */
  private async audit(user: AuthenticatedUser, action: string, templateId: string, metadata: Record<string, unknown>) {
    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        ...auditActor(user),
        action,
        entityType: 'TbpGroupTemplate',
        entityId: templateId,
        metadata: metadata as object,
      },
    });
  }
}

/** Groups and their members, written in two statements rather than one per group. */
async function writeGroups(
  tx: Pick<PrismaService, 'tbpGroupTemplateGroup' | 'tbpGroupTemplateMember'>,
  organizationId: string,
  templateId: string,
  groups: readonly GroupTemplateGroupInput[],
) {
  const rows = groups.map((group, index) => ({
    id: group.id ?? randomUUID(),
    organizationId,
    templateId,
    position: index + 1,
    name: group.name.trim(),
    color: group.color.toLowerCase(),
    target: group.target,
  }));
  if (rows.length) await tx.tbpGroupTemplateGroup.createMany({ data: rows });
  const members = groups.flatMap((group, index) =>
    group.buildingIds.map((buildingId, at) => ({
      organizationId,
      templateId,
      groupId: rows[index]!.id,
      buildingId,
      position: at + 1,
    })),
  );
  if (members.length) await tx.tbpGroupTemplateMember.createMany({ data: members });
}

const counts = (input: GroupTemplateInput) => ({
  groups: input.groups.length,
  properties: input.groups.reduce((total, group) => total + group.buildingIds.length, 0),
});

const notFound = () => new ApplicationError(404, 'TEMPLATE_NOT_FOUND', 'This group template does not exist.');

/** Who made a change, as the others with the template open are told it. */
const byOf = (user: AuthenticatedUser) => ({ userId: user.id, name: user.displayName });

/** The value most of them have, the first of a tie; null when none has one. */
export function mostCommon(values: readonly (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  let most = 0;
  for (const [value, count] of counts)
    if (count > most) {
      best = value;
      most = count;
    }
  return best;
}
