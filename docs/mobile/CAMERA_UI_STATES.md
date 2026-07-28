# Camera UI states

| State | Primary UI | Allowed actions |
| --- | --- | --- |
| Prepare | Wall 1 instructions and sensor disclosure | Enable guidance, continue manually, cancel |
| Ready | Camera preview and concise checklist | Snapshot, configure evidence type, start |
| Recording | Camera, progress ring, timer, snapshot and finding controls | Snapshot/bookmark, mark finding, stop |
| Finalizing | Saving indicator | Wait; camera controls disabled |
| Review | Video, capture summary, evidence summary | Confirm, retake, discard, queue |

The camera screen is safe-area aware and scrollable at compact heights. Action groups wrap rather than
squeezing summary text into a zero-width column. Long instructional material is kept in preparation or
on-demand sheets, not permanently mounted beside the live camera controls.
