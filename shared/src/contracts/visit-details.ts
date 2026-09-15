/**
 * The "Details" a coordinator writes on a Jobber visit, read into its parts.
 *
 * Coordinators type this by hand, so it is a template people follow rather than
 * a format anything enforces. An occupied visit usually reads:
 *
 *   Filter Change: 20x25x1; 12x12x1 + Pest Control + Occupied Inspection (Basic Plan - Opted Out HVAC Plan)
 *
 *   Make sure to contact tenants that you are on your way.
 *   Tenant: <name> <phone> <phone>
 *
 *   Instruction for completion
 *   • Indicate in the notes which services were completed ...
 *
 * with free text anywhere: gate codes, pets, a tenant's request, a reschedule.
 * Every rule here is a reading of that habit, measured on 350 live visits, and
 * none of it is trusted alone -- whatever does not fit a part is kept as a note,
 * and the text as written always travels with what was read from it.
 *
 * Regular expressions only: this runs on the phone, where `Intl` and regex
 * lookbehind cannot be relied on.
 */

export interface VisitDetailsFilter {
  /** Width x height (x depth) as digits: "20x25x1". */
  size: string;
  /** How many of this size, when the details say ("(2 pcs)"); otherwise 1. */
  quantity: number;
  /** Where it goes, when the details say: "upstairs hallway", "1/2 N Main". */
  location: string | null;
  /** A thick media filter, which the office changes only twice a year. */
  media: boolean;
}

export interface VisitDetailsTenant {
  /** The unit the line is for, on a visit covering several ("101 1/2 N Main St"). */
  unit: string | null;
  name: string | null;
  phones: string[];
}

export interface VisitDetails {
  /** The text as Jobber holds it. What was read from it is never a replacement. */
  raw: string;
  services: {
    filterChange: boolean;
    pestControl: boolean;
    fleaTreatment: boolean;
    occupiedInspection: boolean;
    /** Anything else named on the services line, as written. */
    other: string[];
  };
  /**
   * The details say no occupied inspection is needed on this visit.
   *
   * "No need Occupied inspection since tenant just moved into the property"
   * still contains the words the sync looks for, so the visit is imported as an
   * occupied inspection all the same. This is how anyone looking at it can tell.
   */
  occupiedInspectionNotNeeded: boolean;
  filters: VisitDetailsFilter[];
  /** Filter instructions with no size: "Update if found more filter register". */
  filterNotes: string[];
  /** The tenant's benefit plan, when the details name one. */
  plan: { tier: string | null; hvacOptedOut: boolean } | null;
  /** "Make sure to contact tenants that you are on your way." */
  contactTenantsBeforeArrival: boolean;
  tenants: VisitDetailsTenant[];
  /** Lines carrying a gate, lockbox or door code. */
  accessNotes: string[];
  /** Everything else, paragraph by paragraph, in the order written. */
  notes: string[];
  /** The "Instruction for completion" block, one line per step. */
  completionInstructions: string[];
}

const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const SIZE = /(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)(?:\s*[xX×]\s*(\d+(?:\.\d+)?))?/;
const COMPLETION_HEADING =
  /^\s*(?:instructions?\s+for\s+completion|completion\s+instructions?|instructions?\s+completion)\b/i;
const CONTACT_BEFORE_ARRIVAL = /contact\s+(?:the\s+)?tenants?\s+(?:that\s+)?you\s*(?:'|’)?\s*(?:a)?re\s+on\s+(?:your|the)\s+way/i;
/** A code, a lockbox or a numbered gate -- not merely the word "door" beside a number. */
const ACCESS = /\bcode\b|\block\s?box\b|\bsupra\b|\bgate\s*#/i;
/** "Occupied Inspection", and the "Occuied" / "Ocupied" it is sometimes typed as. */
const OCCUPIED = /\boc{1,2}u\w{0,3}ied\s+insp/i;
/**
 * "No need Occupied inspection ...", "no need for Occupied Inspection", "no
 * occupied inspection needed". Stops at a sentence, a bracket or a "+", so
 * "(no need to change) + Pest Control + Occupied Inspection" is not it.
 */
const NOT_NEEDED =
  /\bno\s+need\b[^.\n+()]{0,40}\boc{1,2}u\w{0,3}ied\s+insp|\bno\s+oc{1,2}u\w{0,3}ied\s+insp\w*\s+(?:is\s+)?(?:needed|required)/i;
/** Where a services line starts: "Filter Change: ...", or "Pest Control + Occupied Inspection" without one. */
const SERVICES_START = /filter\s*change|pest\s*control|oc{1,2}u\w{0,3}ied\s+insp/i;
const SIZE_ALL = new RegExp(SIZE.source, 'g');
/** A contact line is a name and numbers; anything longer, or labelled, is a note that mentions a phone. */
const MAX_TENANT_NAME = 60;
/** The management plans the tenant report carries, as the office names them. */
const PLAN_TIERS: Record<string, string> = {
  basic: 'Basic',
  standard: 'Standard',
  plus: 'Plus',
  premium: 'Premium',
  bx: 'BX',
  mx: 'MX',
};

const clean = (value: string) =>
  value
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:;,.]+|[\s\-–—:;,]+$/g, '')
    .trim();

const EMPTY: Omit<VisitDetails, 'raw'> = {
  services: {
    filterChange: false,
    pestControl: false,
    fleaTreatment: false,
    occupiedInspection: false,
    other: [],
  },
  occupiedInspectionNotNeeded: false,
  filters: [],
  filterNotes: [],
  plan: null,
  contactTenantsBeforeArrival: false,
  tenants: [],
  accessNotes: [],
  notes: [],
  completionInstructions: [],
};

/** Reads a visit's Details into its parts. Never throws; unreadable text becomes notes. */
export function parseVisitDetails(text: string | null | undefined): VisitDetails {
  const raw = (text ?? '').replace(/\r\n?/g, '\n').trim();
  const details: VisitDetails = {
    ...EMPTY,
    services: { ...EMPTY.services, other: [] },
    filters: [],
    filterNotes: [],
    tenants: [],
    accessNotes: [],
    notes: [],
    completionInstructions: [],
    raw,
  };
  if (!raw) return details;

  let lines = raw.split('\n');

  // The completion block is the office's standing checklist and always comes
  // last, so everything from its heading down belongs to it.
  const headingAt = lines.findIndex((line) => COMPLETION_HEADING.test(line));
  if (headingAt >= 0) {
    const heading = lines[headingAt]!.replace(COMPLETION_HEADING, '');
    details.completionInstructions = [heading, ...lines.slice(headingAt + 1)]
      .map((line) => clean(line.replace(/^\s*[•●▪*-]\s*/, '')))
      .filter(Boolean);
    lines = lines.slice(0, headingAt);
  }

  const kept: string[] = [];
  let servicesRead = false;
  for (const line of lines) {
    if (!servicesRead && (/filter\s*change/i.test(line) || (line.includes('+') && SERVICES_START.test(line)))) {
      servicesRead = true;
      // "Coordinate with Nathan on the pest control ... Filter change: ..." --
      // the services start at the filter change, not at the note before it.
      const filterAt = line.search(/filter\s*change/i);
      const start = filterAt >= 0 ? filterAt : line.search(SERVICES_START);
      const before = clean(line.slice(0, start));
      if (before) kept.push(before);
      readServices(line.slice(start), details);
      continue;
    }
    if (CONTACT_BEFORE_ARRIVAL.test(line)) {
      details.contactTenantsBeforeArrival = true;
      continue;
    }
    const phones = line.match(PHONE);
    const tenant = phones?.length || /^\s*tenant\s*:/i.test(line) ? readTenant(line, phones ?? []) : null;
    if (tenant && (tenant.name === null || looksLikeNames(tenant.name))) {
      details.tenants.push(tenant);
      if (ACCESS.test(line) && /\d/.test(line.replace(PHONE, ''))) details.accessNotes.push(clean(line));
      continue;
    }
    if (ACCESS.test(line) && /[#\d]/.test(line)) {
      details.accessNotes.push(clean(line));
      continue;
    }
    kept.push(line);
  }

  // What is left is notes. Blank lines separate them; lines within one run on.
  let paragraph: string[] = [];
  const flush = () => {
    const note = clean(paragraph.join(' '));
    if (note) details.notes.push(note);
    paragraph = [];
  };
  for (const line of kept) {
    if (line.trim()) paragraph.push(line.trim());
    else flush();
  }
  flush();

  if (NOT_NEEDED.test(raw)) details.occupiedInspectionNotNeeded = true;
  return details;
}

/** "Filter Change: 20x25x1; 12x12x1 + Pest Control + Occupied Inspection (Basic Plan - ...)" */
function readServices(line: string, details: VisitDetails) {
  for (const part of line.split('+').map((piece) => piece.trim()).filter(Boolean)) {
    const filterChange = /^filter\s*change\s*[:;]?\s*/i.exec(part);
    if (filterChange) {
      details.services.filterChange = true;
      readFilters(part.slice(filterChange[0].length), details);
      continue;
    }
    const plan = readPlan(part);
    if (plan) details.plan = plan;
    const named = clean(plan ? part.slice(0, part.indexOf('(')) : part);
    if (NOT_NEEDED.test(part)) {
      details.occupiedInspectionNotNeeded = true;
    } else if (OCCUPIED.test(part)) {
      details.services.occupiedInspection = true;
    } else if (/pest\s*control/i.test(part)) {
      details.services.pestControl = true;
    } else if (/flea/i.test(part)) {
      details.services.fleaTreatment = true;
    } else if (SIZE.test(part)) {
      // "1 (20x25x1) - master bedroom + 1 (16x25x1) downstairs": the filters
      // were listed with "+" as well, so this is the same filter change.
      readFilters(part, details);
    } else if (named) {
      details.services.other.push(named);
    }
  }
}

/** "(Basic Plan - Opted Out HVAC Plan)", "(Premium (w/o HVAC) - Opted out HVAC plan)" */
function readPlan(part: string): VisitDetails['plan'] {
  const open = part.indexOf('(');
  const close = part.lastIndexOf(')');
  if (open < 0) return null;
  const inside = part.slice(open + 1, close > open ? close : undefined);
  if (!/plan|opted|hvac/i.test(inside)) return null;
  const tier = /\b(basic|standard|plus|premium|bx|mx)\b/i.exec(inside);
  return {
    tier: tier ? PLAN_TIERS[tier[1]!.toLowerCase()]! : null,
    // "Opted Ou HVAC" is how one coordinator types it; "w/o HVAC" says the same.
    hvacOptedOut: /opted\s*ou\w*\s*(?:of\s+)?(?:the\s+)?hvac|w\/o\s*hvac|without\s+hvac/i.test(inside),
  };
}

/** "20x20x1 (N Main); 14 x 18 x 1(N Main); (2 pcs) 20x25x4 MEDIA; Update if found more" */
function readFilters(text: string, details: VisitDetails) {
  for (const chunk of text.split(/[;,]/).map((piece) => piece.trim()).filter(Boolean)) {
    const size = SIZE.exec(chunk);
    if (!size) {
      details.filterNotes.push(clean(chunk));
      continue;
    }
    const sizes = chunk.match(SIZE_ALL) ?? [];
    if (sizes.length > 1) {
      // "20x25x1: 12x24x1", "Aprilair 20x25x4 or 20x30x1": several sizes with no
      // separator the office uses. Each is a filter, and where the chunk says
      // more than sizes -- an "or", a brand -- it is kept as written too.
      for (const each of sizes) readFilters(each, details);
      if (/[a-z]{2,}/i.test(chunk.replace(SIZE_ALL, ' ').replace(/\bmedia\b|\bpcs?\b/gi, ' ')))
        details.filterNotes.push(clean(chunk));
      continue;
    }
    const quantity = /\((\d+)\s*pcs?\.?\)|\b(\d+)\s*pcs?\b|^(\d+)\s*\(/i.exec(chunk);
    const location = clean(
      chunk
        .replace(size[0], ' ')
        .replace(/\(?\s*\d+\s*pcs?\.?\s*\)?/gi, ' ')
        .replace(/^\s*\d+\s*(?=\()/, ' ')
        .replace(/\bmedia\b/gi, ' ')
        .replace(/[()]/g, ' ')
        .replace(/^\s*(?:in|at|-|–)\s+/i, ' '),
    );
    details.filters.push({
      size: [size[1], size[2], size[3]].filter(Boolean).join('x'),
      quantity: Number(quantity?.[1] ?? quantity?.[2] ?? quantity?.[3] ?? 1) || 1,
      location: location || null,
      media: /\bmedia\b/i.test(chunk),
    });
  }
}

/**
 * Whether what is left of a phone line is people's names rather than a sentence.
 *
 * "There is a mouse in the house. Can you please put traps out <phone>" is a
 * tenant's message that happens to carry a number; filing it as a name would
 * hide the message. Names carry no label, no question and no full stop after a
 * word (an initial's is fine), and are short.
 */
function looksLikeNames(name: string) {
  return (
    name.length <= MAX_TENANT_NAME &&
    !/[:?!"“”]/.test(name) &&
    !/\b\w{2,}\.(?:\s|$)/.test(name) &&
    name.split(/\s+/).length <= 8
  );
}

/** "Tenant: <name> <phone>", "<name> <phone> <phone>", "101 N Main St - Tenant: <name> <phone>" */
function readTenant(line: string, phones: string[]): VisitDetailsTenant {
  let rest = line.replace(PHONE, ' ');
  let unit: string | null = null;
  const labelled = /^(.*?)\s*[-–]\s*tenant\s*:/i.exec(rest);
  if (labelled) {
    unit = clean(labelled[1]!) || null;
    rest = rest.slice(labelled[0].length);
  }
  rest = rest.replace(/^\s*tenant\s*:/i, ' ');
  return {
    unit,
    // "Name One - ; Name Two": a dash left dangling where a number was.
    name: clean(rest.replace(/\t/g, ' ').replace(/\s*[-–]\s*(?=;|$)/g, '')) || null,
    phones: phones.map((phone) => phone.trim()),
  };
}
