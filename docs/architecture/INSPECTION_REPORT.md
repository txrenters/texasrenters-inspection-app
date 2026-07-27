# Inspection report (web + PDF)

The homeowner-facing deliverable for an inspection, rendered two ways from one
source of truth: a shareable web page and a downloadable PDF.

## What it contains

Findings-first, not a checklist. Each report is:

1. **Cover** — property, inspection type, date, brand letterhead.
2. **At a glance** — rooms inspected, findings reviewed, counts by severity.
3. **Summary of findings** — every approved finding, most severe first.
4. **Room by room** — per-room card with captioned, timestamped photos and that
   room's findings.
5. **Other areas** — rooms inspected with nothing to report, or not accessible.
6. **Closing** — review disclaimer, letterhead, generation date.

Deliberately *not* modelled: the per-item `Clean / Undamaged / Working` grid used
by the previous vendor's report. That format requires a checklist-item table and
a template concept, and in practice arrived almost entirely blank. Condition is
expressed through reviewed findings and photographic evidence instead.

## One view model, two renderers

`shared/src/report/report-view.ts` owns **all content decisions**: which sections
exist, their order, enum wording, severity ranking, and the colour tokens.

| Renderer | File | Engine |
|---|---|---|
| Web page | `web-app/app/report/[token]/page.tsx` | React + CSS |
| PDF | `web-app/lib/report-pdf/report-document.tsx` | `@react-pdf/renderer` |

@react-pdf uses its own primitives, not HTML, so no markup can be shared between
them — which is exactly why the *content* layer is shared. **Put presentation in
the renderers and everything else in `buildReportView`**; content logic added to
one renderer silently diverges from the other.

## Why the PDF renders in the web tier

`@react-pdf/renderer` is ESM-only. The backend compiles to CommonJS, and while
Node 24 loads ESM through `require()` natively (so it *would* run in
production), Jest's module sandbox cannot — not via `await import`, not via
`createRequire`. Testing it there would mean babel-transforming ~13 ESM packages
on every backend test run. The web app is already ESM with React and Vitest, so
the renderer lives there and the backend gains no dependency at all.

> **Tests must declare `@vitest-environment node`.** Under the project's default
> jsdom environment, @react-pdf resolves to its **browser** build, which pushes
> image bytes through a text decoder — every embedded photo comes out corrupt
> (`FF D8 FF E0` → `FD FD FD FD`) while the PDF still parses as valid. A `%PDF-`
> header assertion does not catch this; `render-report-pdf.test.ts` counts intact
> JPEG markers so it cannot regress silently.

## Access

The share token in the URL is the only credential, for both the page and the
PDF:

```
GET  /api/v1/reports/:token                     public report JSON
GET  /api/v1/reports/:token/photos/:id?w=<n>    photo bytes
GET  /report/:token/pdf                         PDF (Next route handler)
```

The PDF route re-fetches the public report through the backend rather than
touching the database, so an expired or revoked link fails identically in both
places. Nothing is exposed that the JSON endpoint would not already return.

### What a homeowner may see

Only reviewed material. Findings are filtered to `APPROVED`. Photos must satisfy
`HOMEOWNER_VISIBLE_PHOTO`:

```
(captureType = AREA_OVERVIEW AND findingId IS NULL)  OR  finding.reviewStatus = APPROVED
```

Both clauses are required. `findingId IS NULL` alone would re-expose a detail
photo if its rejected finding were ever deleted, since that relation is
`onDelete: SetNull`. `publicPhoto()` re-applies the same predicate *and* scopes
to the share's inspection, so a valid token for one property can never read
another's evidence.

Still private, by design: technician identity, internal notes, pending or
rejected AI output, raw provider payloads, and all internal identifiers.

## Photo sizing

Phone photos are 3–8 MB each; a twenty-photo report of originals is unusable.
`?w=` returns a width-limited copy, restricted to `ALLOWED_PHOTO_WIDTHS`
(320 for grid thumbnails, 1000 for the PDF and lightbox). An open integer would
let anyone fill the bucket with variants.

Resizing uses **ffmpeg-static**, already a dependency for video processing, and
the result is cached in object storage under a derived key —
`<storageKey>.w<width>.jpg` — the same pattern as video poster frames. The
re-encode happens once per photo, not once per view.

## Branding

The letterhead is deployment-level, not per-organization (`Organization` has only
a name, and adding columns would mean a migration):

```
REPORT_BRAND_NAME=TexasRenters.com
REPORT_BRAND_ADDRESS_LINE1=5225 Katy Fwy, Suite 545
REPORT_BRAND_ADDRESS_LINE2=Houston, TX 77007
REPORT_BRAND_PHONE=281-407-3815
REPORT_BRAND_EMAIL=
```

Per-organization branding would need a small migration on `Organization`.
