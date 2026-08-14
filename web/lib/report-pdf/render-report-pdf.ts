import { buildReportView } from '@texasrenters/shared';
import type { PublicInspectionReport } from '@texasrenters/shared';

import { ReportDocument } from './report-document';
import type { ReportImages } from './report-document';

/**
 * Width requested for embedded photos. The backend caches this variant, so the
 * expensive re-encode happens once per photo rather than once per download.
 */
const PHOTO_WIDTH = 1000;
/** Caps the work one report can do regardless of how many photos it carries. */
const MAX_EMBEDDED_PHOTOS = 60;
const PHOTO_CONCURRENCY = 6;

export interface RenderOptions {
  /** Absolute origin of the backend, used to resolve each photo's contentPath. */
  apiOrigin: string;
  signal?: AbortSignal;
}

/**
 * Fetches the report's photos as data URIs. A photo that cannot be retrieved is
 * omitted rather than failing the download — a report missing one image is far
 * more useful to a homeowner than no report at all.
 */
async function loadImages(
  report: PublicInspectionReport,
  options: RenderOptions,
): Promise<ReportImages> {
  const images: ReportImages = new Map();
  const queue = (report.photos ?? []).slice(0, MAX_EMBEDDED_PHOTOS);
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
 * Renders a report payload to PDF bytes. The payload is whatever the caller was
 * already entitled to see, so this adds nothing a share token did not expose.
 */
export async function renderReportPdf(
  report: PublicInspectionReport,
  options: RenderOptions,
): Promise<Buffer> {
  const view = buildReportView(report);
  const images = await loadImages(report, options);
  const { renderToBuffer } = await import('@react-pdf/renderer');
  // Invoked directly rather than through createElement: renderToBuffer wants
  // the <Document> element itself, not a wrapper component around it.
  return Buffer.from(await renderToBuffer(ReportDocument({ view, images })));
}

/** `302-watercrest-harbor-ln-inspection-report.pdf` */
export function reportFileName(report: PublicInspectionReport) {
  const base = report.property.addressLine1 || report.property.name || 'inspection';
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'inspection'}-inspection-report.pdf`;
}
