import { type RefObject, useCallback, useEffect, useMemo, useState } from 'react';

import { computeContainRect } from './floor-plan-geometry';

/**
 * Measures the object-fit:contain rendered rectangle for a plan image. The stage
 * (untransformed) is observed for its container size; the image's natural size is
 * read on load. `resetKey` (the source URL) clears the size when the plan changes.
 *
 * The stage is passed as an *element* rather than a ref so measurement restarts
 * when it mounts late — a PDF plan only renders the stage once its page has been
 * rasterized, which a ref-based effect would miss.
 */
export function useImageRect(
  stage: HTMLElement | null,
  imgRef: RefObject<HTMLImageElement | null>,
  resetKey: string | undefined,
) {
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [container, setContainer] = useState({ w: 0, h: 0 });

  const measureImage = useCallback(() => {
    const img = imgRef.current;
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0)
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
  }, [imgRef]);

  // A new source resets the size; it is re-measured on load (below).
  useEffect(() => {
    setNatural({ w: 0, h: 0 });
  }, [resetKey]);

  useEffect(() => {
    if (!stage) return undefined;
    const measure = () => setContainer({ w: stage.clientWidth, h: stage.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stage]);

  // Cached blob URLs can already be `complete`, so onLoad may never fire — read
  // the natural size eagerly whenever the source changes.
  useEffect(() => {
    measureImage();
  }, [measureImage, resetKey]);

  const rect = useMemo(
    () => computeContainRect(natural.w, natural.h, container.w, container.h),
    [natural.w, natural.h, container.w, container.h],
  );

  return { rect, natural, container, onImageLoad: measureImage };
}
