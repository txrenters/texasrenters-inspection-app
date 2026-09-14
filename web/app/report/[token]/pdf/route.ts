import { NextResponse } from 'next/server';

import { renderReportPdf, reportFileName } from '@/lib/report-pdf/render-report-pdf';
import type { PublicInspectionReport } from '@texasrenters/shared';

/**
 * Downloadable PDF of a shared inspection report.
 *
 * The share token in the URL is the only credential, exactly as for the HTML
 * page: this handler re-fetches the public report through the backend rather
 * than reading any database, so an expired or revoked link fails here for the
 * same reason and with the same 404 it fails there. Rendering happens in the
 * web tier because @react-pdf is ESM-only and React already lives here.
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

  const response = await fetch(`${origin}/api/v1/reports/${encodeURIComponent(token)}`, {
    signal: request.signal,
    cache: 'no-store',
  }).catch(() => null);
  if (!response?.ok)
    return NextResponse.json(
      {
        code: 'REPORT_NOT_AVAILABLE',
        message: 'This report link is invalid, expired, or has been revoked.',
      },
      { status: response?.status === 404 ? 404 : 502 },
    );

  const report = (await response.json()) as PublicInspectionReport;
  /**
   * A render that throws is logged with its stack and answered in words.
   *
   * Left to Next, it logged one line -- `[Error: unsupported number:
   * -1.9064433873226668e+21]`, naming no file -- and the browser showed "This
   * page isn't working". That is how every report past ten pages failed to
   * download for as long as it did.
   */
  let pdf: Buffer;
  try {
    pdf = await renderReportPdf(report, { apiOrigin: origin, signal: request.signal });
  } catch (error) {
    console.error('report_pdf_render_failed', error);
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
      'content-disposition': `attachment; filename="${reportFileName(report)}"`,
      // The report is private to whoever holds the link; never let a shared
      // cache keep a copy.
      'cache-control': 'private, no-store',
    },
  });
}
