import { useEffect, useState } from 'react';

/** Long-edge pixel target for the rasterized page — enough detail to zoom into. */
const RASTER_TARGET_PX = 2200;

interface PdfPageImage {
  /** Object URL of the rasterized page, fed into the normal <img> path. */
  imageUrl?: string;
  pageCount: number;
  loading: boolean;
  error: string | null;
}

/**
 * Renders one page of a PDF floor plan to an image so the marker overlay can use
 * the same geometry as image plans: normalized coordinates stay relative to the
 * page, because the raster is a uniform scale of it.
 *
 * pdf.js is imported dynamically so it is only downloaded for PDF plans.
 */
export function usePdfPageImage(
  sourceUrl: string | undefined,
  pageNumber: number,
  enabled: boolean,
): PdfPageImage {
  const [state, setState] = useState<PdfPageImage>({
    pageCount: 0,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!enabled || !sourceUrl) {
      setState({ pageCount: 0, loading: false, error: null });
      return undefined;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    setState((previous) => ({ ...previous, loading: true, error: null }));

    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        // The worker ships with the package; this URL form lets the bundler emit it.
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url,
        ).toString();

        const document = await pdfjs.getDocument({ url: sourceUrl }).promise;
        if (cancelled) return;
        const safePage = Math.min(Math.max(pageNumber, 1), document.numPages);
        const page = await document.getPage(safePage);
        if (cancelled) return;

        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(RASTER_TARGET_PX / Math.max(base.width, base.height), 4);
        const viewport = page.getViewport({ scale });
        const canvas = window.document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas is unavailable in this browser.');
        // A white backdrop keeps line-art plans readable on the dark canvas.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        if (cancelled) return;

        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/png'),
        );
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setState({
          imageUrl: objectUrl,
          pageCount: document.numPages,
          loading: false,
          error: null,
        });
      } catch {
        if (cancelled) return;
        setState({
          pageCount: 0,
          loading: false,
          error: 'This PDF page could not be rendered for marker placement.',
        });
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sourceUrl, pageNumber, enabled]);

  return state;
}
