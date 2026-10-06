import { NextResponse } from 'next/server';

import {
  comparisonFileName,
  renderComparisonPdf,
} from '@/lib/report-pdf/render-comparison-pdf';
import type { ComparisonReport } from '@texasrenters/shared';

/**
 * Downloadable PDF of a shared move-in / move-out comparison.
 *
 * As for the inspection report's PDF: the share token is the only credential,
 * and this re-fetches the public comparison through the backend rather than
 * reading any database, so an expired, revoked or paused link fails here for
 * the same reason, and in the same words, as it does on the page.
 */
export const dynamic = 'force-dynamic';
/** PDF generation needs Node APIs (Buffer, the @react-pdf font stack). */
export const runtime = 'nodejs';

function apiOrigin() {
  return (process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(
    /\/$/,
    '',
  );
}

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const origin = apiOrigin();
  if (!origin)
    return NextResponse.json(
      { code: 'API_NOT_CONFIGURED', message: 'The report service is not configured.' },
      { status: 503 },
    );

  const response = await fetch(`${origin}/api/v1/reports/comparison/${encodeURIComponent(token)}`, {
    signal: request.signal,
    cache: 'no-store',
  }).catch(() => null);
  if (!response?.ok) {
    // The backend's own words when it gave some -- "being updated" is not
    // "revoked" -- and the generic ones otherwise.
    const refusal = (await response?.json().catch(() => null)) as {
      code?: string;
      message?: string;
    } | null;
    return NextResponse.json(
      {
        code: refusal?.code ?? 'REPORT_NOT_AVAILABLE',
        message:
          refusal?.message ?? 'This report link is invalid, expired, or has been revoked.',
      },
      { status: response?.status === 404 || response?.status === 409 ? response.status : 502 },
    );
  }

  const report = (await response.json()) as ComparisonReport;
  let pdf: Buffer;
  try {
    pdf = await renderComparisonPdf(report, { apiOrigin: origin, signal: request.signal });
  } catch (error) {
    console.error('comparison_pdf_render_failed', error);
    return NextResponse.json(
      {
        code: 'REPORT_PDF_FAILED',
        message: 'The PDF could not be generated. The report page itself can still be printed.',
      },
      { status: 500 },
    );
  }

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(pdf.length),
      'content-disposition': `attachment; filename="${comparisonFileName(report)}"`,
      // Private to whoever holds the link; no shared cache keeps a copy.
      'cache-control': 'private, no-store',
    },
  });
}
