import type { ComparisonReport } from '@texasrenters/shared';

import { ComparisonReportDocument } from './comparison-report-document';
import type { ReportImages } from './comparison-report-document';

/**
 * Width requested for embedded photos. The backend caches this variant, so the
 * expensive re-encode happens once per photo rather than once per download.
 */
const PHOTO_WIDTH = 1000;
/**
 * Caps the work one document can do.
 *
 * A comparison carries two inspections, so the ceiling is higher than the
 * single-inspection report's — but it is still a ceiling: a 17-area property
 * with hundreds of photographs on each side would otherwise render until it
 * timed out.
 */
const MAX_EMBEDDED_PHOTOS = 120;
const PHOTO_CONCURRENCY = 6;

export interface RenderOptions {
  /** Absolute origin of the backend, used to resolve each photo's contentPath. */
  apiOrigin: string;
  signal?: AbortSignal;
}

/** Every photograph the document references, from both sides of every area. */
function photoQueue(report: ComparisonReport) {
  const queue: Array<{ id: string; contentPath: string }> = [];
  for (const area of report.areas) {
    for (const side of [area.moveIn, area.moveOut]) {
      for (const photo of side?.photos ?? []) queue.push(photo);
    }
  }
  return queue.slice(0, MAX_EMBEDDED_PHOTOS);
}

/**
 * Fetches photos as data URIs. One that cannot be retrieved is omitted rather
 * than failing the download — a report missing an image is far more useful than
 * no report at all.
 */
async function loadImages(
  report: ComparisonReport,
  options: RenderOptions,
): Promise<ReportImages> {
  const images: ReportImages = new Map();
  const queue = photoQueue(report);
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
        // Omit this photo; the document renders without it.
      }
    }
  });
  await Promise.all(workers);
  return images;
}

/**
 * Renders a comparison payload to PDF bytes. The payload is whatever the caller
 * was already entitled to see, so this exposes nothing the share token did not.
 */
export async function renderComparisonReportPdf(
  report: ComparisonReport,
  options: RenderOptions,
): Promise<Buffer> {
  const images = await loadImages(report, options);
  const { renderToBuffer } = await import('@react-pdf/renderer');
  // Invoked directly rather than through createElement: renderToBuffer wants
  // the <Document> element itself, not a wrapper component around it.
  return Buffer.from(await renderToBuffer(ComparisonReportDocument({ report, images })));
}

/** `25303-lynbriar-ln-comparison-report.pdf` */
export function comparisonReportFileName(report: ComparisonReport) {
  const base = report.property.addressLine1 || report.property.name || 'inspection';
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'inspection'}-comparison-report.pdf`;
}
