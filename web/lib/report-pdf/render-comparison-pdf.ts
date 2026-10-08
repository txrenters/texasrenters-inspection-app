import { buildComparisonView } from '@texasrenters/shared';
import type { ComparisonReport, ComparisonView, ReportPhotoView } from '@texasrenters/shared';

import { ComparisonPdfDocument, comparisonPdfPhotos } from './comparison-document';
import type { ReportImages } from './report-document';
import type { RenderOptions } from './render-report-pdf';

/**
 * A width the backend caches. The comparison prints its photographs small --
 * three a side in a room, a grid at the end -- so the 640 copy is sharp and
 * holds about twice the photographs in the same bytes as the 1000 one did.
 */
const PHOTO_WIDTH = 640;
/**
 * Caps the work one comparison can do. Two inspections' photographs, so more
 * than an inspection report's 60. Taken in the order the PDF prints them -- each
 * room's first few, then the rest -- so the cap thins the pages at the end,
 * never a room's own.
 */
const MAX_EMBEDDED_PHOTOS = 180;
const PHOTO_CONCURRENCY = 6;

/** The photographs in the order they are fetched: each room's first few, then the rest. */
export function comparisonPhotos(view: ComparisonView): ReportPhotoView[] {
  const { inline, later } = comparisonPdfPhotos(view);
  return [...inline, ...later.flatMap((group) => group.photos)];
}

/**
 * Fetches the photographs as data URIs. One that cannot be fetched is left out
 * rather than failing the download: a report missing a photograph is far more
 * use to its reader than no report.
 */
async function loadImages(view: ComparisonView, options: RenderOptions): Promise<ReportImages> {
  const images: ReportImages = new Map();
  const queue = comparisonPhotos(view).slice(0, MAX_EMBEDDED_PHOTOS);
  if (!queue.length) return images;
  const origin = options.apiOrigin.replace(/\/$/, '');
  const workers = Array.from({ length: Math.min(PHOTO_CONCURRENCY, queue.length) }, async () => {
    for (let photo = queue.shift(); photo; photo = queue.shift()) {
      try {
        const response = await fetch(`${origin}${photo.contentPath}?w=${PHOTO_WIDTH}`, {
          signal: options.signal,
        });
        if (!response.ok) continue;
        const bytes = Buffer.from(await response.arrayBuffer());
        const mime = response.headers.get('content-type') ?? 'image/jpeg';
        images.set(photo.id, `data:${mime};base64,${bytes.toString('base64')}`);
      } catch {
        // Left out; the document renders without it.
      }
    }
  });
  await Promise.all(workers);
  return images;
}

/** The comparison as PDF bytes. Nothing beyond what the share token already exposes. */
export async function renderComparisonPdf(
  report: ComparisonReport,
  options: RenderOptions,
): Promise<Buffer> {
  const view = buildComparisonView(report);
  const images = await loadImages(view, options);
  const { renderToBuffer } = await import('@react-pdf/renderer');
  return Buffer.from(await renderToBuffer(ComparisonPdfDocument({ view, images })));
}

/** `318-notional-harbor-ln-move-in-move-out-comparison.pdf` */
export function comparisonFileName(report: ComparisonReport) {
  const base = report.property.addressLine1 || report.property.name || 'property';
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'property'}-move-in-move-out-comparison.pdf`;
}
