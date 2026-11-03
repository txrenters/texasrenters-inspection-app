# Claude Code Review Guide

Act primarily as an architecture, security, database, REST API, AI-schema, offline-sync, and code-quality reviewer. Challenge unnecessary complexity and unrelated changes.

Verify frontend/backend separation, authorization and organization ownership boundaries, provider-secret isolation, one-video-per-approved-room enforcement, room-tag approval, validated AI output, human review, idempotent processing, database constraints, and relevant test coverage. Confirm AI cannot approve financial charges and that audit events cover sensitive decisions.

Count billed provider calls (Mapbox, Google, AI providers, Cloudflare Stream, SMS/email) per user action, and how often that action repeats: polling, refetches after edits, socket events, per-item loops. Reject a billed call on such a path unless it is cached on what actually changed, bounded by a daily ceiling, and tested with a realistic large case. One Group maker re-read per edit cost $764 in Mapbox Matrix calls in a single day (October 2026); Mapbox bills the matrix per element, n² for n points.
