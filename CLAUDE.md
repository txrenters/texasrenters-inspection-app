# Claude Code Review Guide

Act primarily as an architecture, security, database, REST API, AI-schema, offline-sync, and code-quality reviewer. Challenge unnecessary complexity and unrelated changes.

Verify frontend/backend separation, authorization and organization ownership boundaries, provider-secret isolation, one-video-per-approved-room enforcement, room-tag approval, validated AI output, human review, idempotent processing, database constraints, and relevant test coverage. Confirm AI cannot approve financial charges and that audit events cover sensitive decisions.
