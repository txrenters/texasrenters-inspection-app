# Capture session model

Guided capture extends existing evidence models instead of creating a parallel media system.

- One primary `InspectionMedia` remains the canonical room walkthrough.
- Additional labelled videos remain `ADDITIONAL_ISSUE` media.
- `captureSessionId`, `capturePolicyVersion`, and `captureSummary` are stored on primary media.
- `InspectionPhoto.metadata` stores photo provenance, capture-session identity, and video timestamp.
- Raw sensor samples never cross the REST boundary.

`captureSummary` contains bounded, validated values: clockwise/counter-clockwise totals, start/end
heading, return estimate, sensor support/confidence, coverage status, evidence counts, and manual
confirmation. AI processing remains downstream of uploaded media and cannot convert capture confidence
into approval or legal responsibility.
