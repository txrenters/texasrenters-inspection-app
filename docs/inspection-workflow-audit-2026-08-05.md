# Inspection workflow audit — 2026-08-05

Scope: the inspection lifecycle end to end — an administrator creating and
assigning one, a technician capturing it, an administrator reviewing it.
Supersedes the workflow parts of `readiness-review-2026-08-02.md`; that
document's security and performance sections still stand.

**Evidence.** Items marked **[verified]** were exercised in this session
against the live stack or closed with a test. Items marked **[read]** come from
reading the code and have not been run. Nothing here was checked on a physical
device, which is the single largest gap in this audit.

---

## Closed since 2026-08-02

| Was | Now |
|---|---|
| Scheduling carried a time nobody used | Date-only column and picker **[verified]** |
| Properties without a portfolio never synced | 560 buildings, 11 unassigned, 0 failures **[verified]** |
| Checklists were generated mocks | Administrator-authored, one shared source for both screens **[verified]** |
| A property with no floor plan could not be inspected | Technician surveys the areas on site **[read]** |
| The 360° guide filled itself on a still phone | Measured from the gyroscope projected onto gravity **[read]** |
| Home queue hid work more than 7 days out | No date bound; `take` bounds it **[verified]** |
| Skip / add-area / checklist sheets sat under the keyboard | One `BottomSheet` owns the safe area **[read]** |

---

## 1. Functionality gaps

| # | Item | Why it matters | Size |
|---|---|---|---|
| 1.1 | **A technician-added area gives no sign it is pending approval.** It is written `DRAFT` with `source: TECHNICIAN` and appears immediately in their area list, indistinguishable from an approved one. The administrator sees it only by opening that property's floor plan manager. | The whole point of the survey feature is that an administrator approves the layout. Neither side can see that anything is waiting. | M |
| 1.2 | **No queue of inspections left unassigned.** Creation offers "Leave unassigned" and then nothing surfaces it again. | An inspection can be scheduled and simply never reach anyone. | S |
| 1.3 | **The checklist is invisible at creation.** It is configured per property area on a different screen; nothing at creation says whether the areas have one. | An administrator schedules work believing they have specified what to cover. | M |
| 1.4 | **Simultaneous capture is undecided.** Two devices on one area: the second primary video silently replaces the first. Carried over from 5.5. | Evidence loss with no error. | M |
| 1.5 | **No way to re-run one area's AI summary** from the app. Carried over from 5.4. | A failed analysis strands the area. | S |
| 1.6 | **Findings are approved one at a time.** No bulk action for an area or an inspection. | Review of a large inspection is slow enough to discourage care. | S |

## 2. UI / UX

| # | Item | Size |
|---|---|---|
| 2.1 | **Camera layout is still unmeasured.** `pt-36`/`pb-60` and the 42% grid were reasoned on paper. `archive/camera-rebuild` has a `camera-layout.ts` that solved it properly. Carried over from 4.1. | M |
| 2.2 | **Writes are not queued.** Half done — see below. | M |
| 2.3 | **"0 photos" appears twice** on the camera. Carried over from 4.2. | S |
| 2.4 | **Reduce-motion covers loaders and skeletons only**; `active:scale-*` press states still animate. Carried over from 4.3. | S |
| 2.5 | **An inspection with no areas reads as broken** unless it was created with technician capture. The empty state now distinguishes the two, but an administrator looking at the same inspection in the web app sees an empty evidence workspace with no explanation. | S |

### 2.2 in detail — offline writes

Reads survive losing signal; they fall back to the SQLite cache. Writes do
not: a note, a skip reason or a new area fails with an error and is gone.

**Done.** An `OfflineBanner` over every signed-in screen says the device is
offline before anything is attempted, and names the distinction that matters
in the field — recordings are queued durably and send themselves, so seeing
the banner is not a reason to stop working and go looking for signal.

**Remaining.** Queueing the writes so they send themselves.

The prerequisite turned out to be far smaller than first assumed. The worry
was that retrying any write could double-apply one whose response was lost.
Going through the technician endpoints, almost none are exposed to that:

| Endpoint | Retry safety |
|---|---|
| `PATCH rooms/:id/note` | Sets a value — applying it twice is the same state |
| `POST rooms/:id/skip` | Sets completion status and reason |
| `POST rooms/:id/complete` | Sets completion status |
| `POST inspections/:id/start`, `/complete` | Set timestamps |
| `rooms/:id/media`, `/videos`, `/photos` | Already keyed — `MediaUploadSession.idempotencyKey` is unique |
| `POST inspections/:id/areas` | Already returns the existing area when a retry follows a timeout |
| `POST inspections/:id/pet-observations` | **Appends.** The one endpoint that needs a key |

So the work is one endpoint keyed the way three models already do it, not a
general idempotency mechanism.

**Caveat.** That table was derived from the route list and the services'
purpose, not by reading each implementation line by line. Confirm that skip,
note and complete really are pure state-sets before building on it — an audit
row per call is fine, a second finding or history row is not.

**Order.** Key `pet-observations`; add a SQLite mutation queue beside the
existing upload queue, drained by `ConnectivitySync`; extend the banner with a
count of changes waiting. It is worth nothing until it is tested on a phone
with no signal.

## 3. Correctness risks

| # | Item | Size |
|---|---|---|
| 3.1 | **Validation rules are duplicated between client and server and have drifted twice.** The password screen checked 8 while the API required 12; the checklist and reset pages each carried their own copy. Both are fixed, and both were found by a user hitting them rather than by a test. The rules belong in `shared/` with one definition per rule. | M |
| 3.2 | **Three fetch wrappers now exist** in the web app — `api`, `publicApi`, `publicApiSend` — and the newest one shipped missing the ngrok header that the oldest carries and documents. | S |
| 3.3 | **`WEB_APP_ORIGIN` is a LAN address.** Password reset links are built from it, so they break when the DHCP lease moves. | S |
| 3.4 | **No end-to-end test covers upload → transcription → summary.** Carried over. The most valuable missing test in the repo. | L |
| 3.5 | **No test asserts a technician cannot reach admin routes.** Carried over. The boundary is enforced in both app and backend; nothing proves it stays that way. | M |

## 4. What is genuinely solid

Worth recording so it is not re-litigated:

- **Completion is never automatic.** `deriveAreaRequirements` and
  `areaCompletionGate` derive status on read; submitting captures does not
  complete an inspection. The constraint holds. **[read]**
- **AI never decides.** Findings carry a review status a human sets, and
  technicians cannot approve — enforced in both app and backend. **[read]**
- **Sensitive actions are audited** — `TECHNICIAN_AREA_ADDED`,
  `INSPECTION_CREATED` (now including the area-capture decision and how many
  areas came from an approved plan), and the checklist mutations. **[verified]**
- **Accessibility is better than typical.** Every `Pressable` carries a label,
  no touch target under 44pt, status conveyed in words as well as colour.

---

## Suggested order

Closed since this was written: **1.1** (technician areas approve on creation
and stay correctable), **1.2** and **1.3** (unassigned inspections and missing
checklists are both visible at last), **3.1** (the password policy is defined
once, in `shared`), and the visible half of **2.2**.

What is left, in order:

1. **2.2, remaining** — the mutation queue. Smaller than it looked; see above.
2. **2.1** — camera layout, gated on a physical device rather than effort.
3. **3.4** — expensive, and the thing most likely to catch a regression nobody predicted.
4. **1.4, 1.5, 1.6** — simultaneous capture, re-running one area's summary, bulk finding approval.

## The honest caveat

Everything shipped this week — the gyro rewrite, the sheets, the checklist
chain, technician area capture — is **verified by tests and by reading, not by
use**. The gyro in particular has now been diagnosed wrong twice, and the
current fix rests on an axis mapping and a gravity sign derived from the
expo-sensors source rather than observed on hardware. A single walkthrough on a
real phone would be worth more than any further static review.
