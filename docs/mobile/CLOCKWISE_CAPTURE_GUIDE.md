# Clockwise capture guide

Start at the room entrance, identify Wall 1, and make one slow clockwise turn while narrating visible
conditions. Keep the walls centered and return to Wall 1 before stopping.

The v1 policy estimates:

- target rotation: 360°
- acceptable minimum: 330°
- maximum useful rotation: 420°
- return-to-start tolerance: 20°
- minimum duration: 15 seconds
- wrong-direction warning: 25° counter-clockwise

Small jitter is ignored and discontinuities larger than 45° are rejected. A complete sensor estimate
is guidance only. If readings are unavailable or low confidence, the technician may finish through an
explicit manual confirmation, which is recorded as `MANUALLY_CONFIRMED`.
