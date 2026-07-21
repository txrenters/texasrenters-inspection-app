# External Property API Integration

## Source of truth

The company’s existing application remains the source of truth for properties, owners, portfolios, and related business records. Texas Renters Inspection does not replace or master those records.

## Integration boundary

The future NestJS backend acts as an integration and normalization layer:

```text
Existing company application
  → authenticated backend integration adapter
  → normalized TexasRenters REST contracts
  → mobile repository adapter
```

The mobile app must not call the external system directly unless a future architecture and security review explicitly approves that change. It never receives external-system credentials or privileged database access.

## Identity and storage

External identifiers should be stored alongside inspection-specific records, including `externalPropertyId`, `externalOwnerId`, `externalPortfolioId`, and where available `externalInspectionId`. TexasRenters-owned records—approved room snapshots, inspection assignments, room media, transcripts, findings, review decisions, and audit events—retain their own stable IDs.

External updates should be normalized by the backend before reaching mobile clients. The backend will define refresh, deletion, conflict, authorization, and unavailable-record behavior after contract alignment.

## Pending alignment

External endpoint paths, authentication, pagination, webhooks, field names, SLAs, and ownership semantics are not yet approved. This document intentionally does not invent them. Frontend mock models demonstrate required concepts only; repository interfaces allow future REST mapping without changing screens.
