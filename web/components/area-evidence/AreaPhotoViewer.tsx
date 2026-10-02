'use client';

import type { AreaEvidenceSummaryItem } from '@texasrenters/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { usePermissions } from '@/lib/auth';
import { areaEvidenceQuery, useAreaEvidence } from '@/lib/queries';

import { areaPhotoItems, nextAreaWithPhotos } from './area-photos';
import { EvidenceViewer } from './EvidenceViewer';
import { ReviewPanel } from './ReviewPanel';

/** Wide enough for the photograph and the review panel side by side. */
const PANEL_BY_DEFAULT = '(min-width: 1280px)';

/** How long "Now in Kitchen" stays up after crossing into an area. */
const NOTICE_MS = 1800;

/**
 * The photo viewer, walking every area in the order of the list beside it.
 *
 * It used to belong to one area. Next on an area's last photograph went back
 * to the start of the same area -- usually its walkthrough video -- and an area
 * with a single photograph had no arrows at all. On an occupied inspection,
 * where sixteen of twenty areas hold exactly one photograph, reviewing them
 * meant close, choose the next area, open its photograph, eighteen times over.
 * The office asked for Next to carry on into the next area, and it does: past
 * either end it moves to the neighbouring area that has photographs, and ↑/↓
 * jump a whole area.
 *
 * Photographs only. A recording's own full-screen view, from the Recording
 * tab, still steps through that area's video and photographs together.
 */
export function AreaPhotoViewer({
  inspectionId,
  areas,
  startAreaId,
  startPhotoId,
  onAreaChange,
  onClose,
}: {
  inspectionId: string;
  /** The areas in the order to walk them: the list as filtered, so a filter narrows the walk. */
  areas: AreaEvidenceSummaryItem[];
  startAreaId: string;
  startPhotoId: string;
  /** Told on every crossing, so the page underneath follows and closing lands there. */
  onAreaChange: (areaId: string) => void;
  onClose: () => void;
}) {
  const client = useQueryClient();
  /**
   * The area on screen, and which end of it to start at. `visit` changes on
   * every crossing and keys the viewer, so each area starts at its own first
   * (or, walking back, last) photograph.
   */
  const [at, setAt] = useState<{
    areaId: string;
    photoId: string | null;
    edge: 'first' | 'last';
    visit: number;
  }>({ areaId: startAreaId, photoId: startPhotoId, edge: 'first', visit: 0 });
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  // One crossing at a time: a held arrow key must not queue a run of them.
  const moving = useRef(false);
  /**
   * The review panel beside the photograph, open by default where there is
   * room for both. Held here, not in the viewer, so closing it stays closed
   * through the areas that follow.
   */
  const [panelOpen, setPanelOpen] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(PANEL_BY_DEFAULT).matches),
  );
  const canReview = usePermissions().has('findings:review');

  const previous = nextAreaWithPhotos(areas, at.areaId, -1);
  const next = nextAreaWithPhotos(areas, at.areaId, 1);
  const current = useAreaEvidence(inspectionId, at.areaId);
  // The neighbours are read as soon as an area opens: an area's bundle is about
  // a kilobyte, so crossing into the next one never waits on it, and its first
  // photograph can be fetched ahead like any other.
  const following = useAreaEvidence(inspectionId, next?.id ?? null);
  const preceding = useAreaEvidence(inspectionId, previous?.id ?? null);

  const items = useMemo(() => (current.data ? areaPhotoItems(current.data) : []), [current.data]);
  const edges = useMemo(() => {
    const ahead = following.data ? areaPhotoItems(following.data) : [];
    const behind = preceding.data ? areaPhotoItems(preceding.data) : [];
    return {
      next: ahead[0]?.contentPath ?? null,
      previous: behind[behind.length - 1]?.contentPath ?? null,
    };
  }, [following.data, preceding.data]);

  const announce = useCallback((text: string) => {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  /**
   * Into the neighbouring area that has photographs.
   *
   * Its bundle is read before switching -- normally already cached, above -- so
   * the viewer never shows an empty frame between areas. An area the summary
   * counts photographs for, but whose bundle shows none, is passed over in the
   * same direction rather than stopped at.
   */
  const cross = useCallback(
    async (direction: 1 | -1, edge: 'first' | 'last') => {
      if (moving.current) return;
      moving.current = true;
      try {
        let target = nextAreaWithPhotos(areas, at.areaId, direction);
        while (target) {
          const query = areaEvidenceQuery(inspectionId, target.id);
          if (!client.getQueryData(query.queryKey)) announce(`Loading ${target.name}…`);
          const photos = areaPhotoItems(await client.ensureQueryData(query)).length;
          if (photos) {
            const arrived = target;
            setAt((state) => ({ areaId: arrived.id, photoId: null, edge, visit: state.visit + 1 }));
            onAreaChange(arrived.id);
            announce(`Now in ${arrived.name} · ${photos} photo${photos === 1 ? '' : 's'}`);
            return;
          }
          target = nextAreaWithPhotos(areas, target.id, direction);
        }
        announce(direction === 1 ? 'That was the last photo' : 'This is the first photo');
      } catch {
        announce('That area could not be loaded');
      } finally {
        moving.current = false;
      }
    },
    [announce, areas, at.areaId, client, inspectionId, onAreaChange],
  );

  if (!items.length) return null;

  const ordinal = areas.findIndex((area) => area.id === at.areaId);
  const startIndex =
    at.edge === 'last'
      ? items.length - 1
      : Math.max(
          0,
          items.findIndex((item) => item.id === at.photoId),
        );

  return (
    <EvidenceViewer
      aside={
        current.data
          ? {
              content: (
                <ReviewPanel
                  bundle={current.data}
                  canReview={canReview}
                  inspectionId={inspectionId}
                  onNextArea={next ? () => void cross(1, 'first') : undefined}
                />
              ),
              open: panelOpen,
              onToggle: () => setPanelOpen((open) => !open),
            }
          : undefined
      }
      beyond={{ previous: Boolean(previous), next: Boolean(next) }}
      edges={edges}
      heading={current.data?.area.name}
      items={items}
      key={at.visit}
      notice={notice}
      onArea={(direction) => void cross(direction, 'first')}
      onBeyond={(direction) => void cross(direction, direction === 1 ? 'first' : 'last')}
      onClose={onClose}
      position={ordinal === -1 ? undefined : `Area ${ordinal + 1} of ${areas.length}`}
      startIndex={startIndex}
    />
  );
}
