import { inspectionIsWalkedAsOccupied } from '@texasrenters/shared';
import * as ImagePicker from 'expo-image-picker';

import type { PhotoCaptureType, RoomSnapshot } from '../domain/models';

import { downscaleForUpload } from './downscale';
import { buildRoomSnapshot, persistRoomSnapshot } from './local-snapshots';

/**
 * Photographs a technician already has, attached to the area they are in.
 *
 * Moses Rodriguez, 2026-09-18: "The upload button for the pictures would help
 * so much right now. It does take me a little longer to complete the occupied
 * inspections." An occupied visit is fifteen minutes and the camera is the
 * slowest part of it -- a technician who photographed the kitchen on their own
 * phone a minute earlier had no way to hand that photograph over.
 *
 * ── IT JOINS THE ORDINARY PIPELINE ───────────────────────────────────────────
 *
 * Picked files are copied into the app's own snapshot folder and built into
 * `RoomSnapshot`s exactly as the camera's are, so everything downstream is
 * already written: `UploadQueueRunner` sends them, a failure retries with the
 * same idempotency key, and a technician with no signal keeps working. Nothing
 * here talks to the network.
 *
 * ── THE TWO THINGS IT DELIBERATELY DOES NOT CLAIM ────────────────────────────
 *
 * **A capture time.** `captureTimeToSend` sends `capturedAt` only for a
 * photograph timed at the shutter, and a library asset's real moment lives in
 * EXIF with no zone attached. Guessing is how 651 imported reports ended up
 * stamped wrong, so an imported photograph carries no claim and the server
 * stamps it with its own receipt, labelled as such. Reading EXIF honestly is a
 * later job, not a reason to guess now.
 *
 * **That it is a photograph of this property.** `GALLERY_IMPORT` records where
 * it came from, so the office reading a report can tell a shot taken on the
 * walk from one chosen out of a camera roll.
 */

/**
 * The visits that offer it, which is not yet all of them.
 *
 * Occupied and HVAC (the office, 2026-09-22: "this request is only applicable
 * for occupied and HVAC inspection for now"). Those are the two Moses was
 * talking about -- an occupied walk is the fifteen-minute one, and an HVAC
 * visit photographs equipment somebody is often already standing in front of
 * with their own phone out.
 *
 * And back-to-market, which the office has said is the same inspection as an
 * occupied one (2026-09-15) and is walked as one (`inspectionIsWalkedAsOccupied`).
 * The list named OCCUPIED and HVAC only, so a BTM room offered no gallery --
 * noticed after submitting one (2026-09-30).
 *
 * Move-in and move-out are left off deliberately rather than forgotten. They
 * are the two a comparison is built from, area by area, and a photograph whose
 * moment and place nobody can vouch for is a different kind of evidence from
 * one taken on the walk. Widening this is a decision, not an oversight.
 *
 * A client rule, not a server one: the API accepts a GALLERY_IMPORT against any
 * area. What it governs is which screens offer the button.
 */
export function inspectionAllowsGalleryImport(inspectionType: string | null | undefined): boolean {
  return inspectionIsWalkedAsOccupied(inspectionType) || inspectionType === 'HVAC';
}

/** The reason an import produced nothing, when it is worth telling the technician. */
export type GalleryImportOutcome =
  | { status: 'IMPORTED'; snapshots: RoomSnapshot[] }
  /** The technician closed the picker. Says nothing, because they meant to. */
  | { status: 'CANCELLED' }
  /** The library was refused. The only outcome with something for them to do. */
  | { status: 'DENIED' };

/**
 * How many an area can take in one go.
 *
 * The backend caps `sequenceNumber` at 1000 and an area is a room, not an
 * album. Twenty is more than any area has ever needed and small enough that a
 * mis-tap on "select all" does not queue a holiday.
 */
export const GALLERY_IMPORT_LIMIT = 20;

export interface GalleryImportInput {
  inspectionId: string;
  roomId: string;
  ownerUserId?: string;
  /**
   * Photographs this area already has, so the imported ones number after them.
   *
   * The sequence is what orders photographs on the report, and restarting at 1
   * would interleave an import with the walk it followed.
   */
  existingPhotoCount: number;
  /**
   * One photograph, not a selection: the job's filters, stacked, are one
   * picture (the office, 2026-09-29), and a multi-select there would invite
   * attaching several to a register that points at one.
   */
  single?: boolean;
  /** What the photograph shows. The area as a whole unless the caller knows better. */
  captureType?: PhotoCaptureType;
  /** Injected by the tests; the picker itself is native and cannot run in one. */
  picker?: Pick<
    typeof ImagePicker,
    'requestMediaLibraryPermissionsAsync' | 'launchImageLibraryAsync'
  >;
  persist?: typeof persistRoomSnapshot;
  /** Injected by the tests; the resize is native and cannot run in one. */
  downscale?: typeof downscaleForUpload;
}

export async function importFromGallery({
  inspectionId,
  roomId,
  ownerUserId,
  existingPhotoCount,
  single = false,
  captureType = 'AREA_OVERVIEW',
  picker = ImagePicker,
  persist = persistRoomSnapshot,
  downscale = downscaleForUpload,
}: GalleryImportInput): Promise<GalleryImportOutcome> {
  const permission = await picker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return { status: 'DENIED' };

  const picked = await picker.launchImageLibraryAsync({
    // Images only. Video from the library would have to go through the
    // recording review and Cloudflare Stream, which is a different pipeline
    // entirely — and it is not what was asked for.
    mediaTypes: ['images'],
    allowsMultipleSelection: !single,
    selectionLimit: single ? 1 : GALLERY_IMPORT_LIMIT,
    // Matches the camera's own `takePictureAsync` quality, so an imported
    // photograph is not visibly better or worse than the ones beside it.
    quality: 0.82,
    // No `exif`: nothing here reads it, and asking for it on iOS widens what
    // the app is handed for no purpose.
    exif: false,
  });
  if (picked.canceled) return { status: 'CANCELLED' };

  const snapshots: RoomSnapshot[] = [];
  for (const [index, asset] of picked.assets.slice(0, single ? 1 : GALLERY_IMPORT_LIMIT).entries()) {
    /**
     * Brought down to the size the camera aims for, before anything is queued.
     *
     * The picker hands back whatever the camera roll holds. Measured on
     * production: imports averaging **6.38 MB** against the camera's 1.83, and
     * a single photograph taking 20 to 82 seconds to upload -- which is what
     * made a technician's submit appear to hang. `quality` above does not
     * help: it applies to JPEG encoding, and the first two imports were PNG
     * screenshots.
     */
    const sized = await downscale({ uri: asset.uri, width: asset.width, height: asset.height });
    // `persistRoomSnapshot` *moves* the file. Safe here: the picker hands back
    // a copy in the app's cache directory, never the library asset itself, so
    // the technician's own photograph stays in their camera roll.
    const stored = persist(sized.uri, inspectionId, roomId);
    snapshots.push(
      buildRoomSnapshot({
        ownerUserId,
        inspectionId,
        roomId,
        uri: stored.uri,
        width: sized.width,
        height: sized.height,
        // The asset's own byte count describes the file the picker handed
        // over, which is not the one being queued once it has been resized.
        sizeBytes: stored.sizeBytes,
        // The area as a whole by default. A picked photograph has no finding
        // attached to it and nothing here knows which room feature it shows;
        // the technician files it against a finding afterwards if it is one.
        captureType,
        captureSource: 'GALLERY_IMPORT',
        sequenceNumber: existingPhotoCount + index + 1,
        // No `clock`, so `captureTimeToSend` sends nothing and the server
        // stamps its own receipt. See the header.
        // No `nextAttemptAt` either: the review window exists to let a test
        // frame be thrown away before it is filed, and nobody picks a test
        // frame out of their gallery on purpose.
      }),
    );
  }
  return { status: 'IMPORTED', snapshots };
}
