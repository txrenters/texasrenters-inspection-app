# Outdoor and exterior areas

Inspection areas are not limited to interior rooms. Each `PropertyArea` carries
an `environment`:

- `INDOOR` — rooms, closets, hallways, attic, basement.
- `OUTDOOR` — yard, driveway, patio, porch, exterior walls, roof, perimeter
  fence, gate, pool, shed, etc.
- `SEMI_OUTDOOR` — garage, balcony (attached but exposed).

`environment` is paired with a finer `AreaCategory` (see the enum in
`schema.prisma`). Floor-plan extraction only produces indoor rooms, so outdoor
targets are added manually — by an administrator (`source: MANUAL`) or by a
technician on site (`source: TECHNICIAN`).

## Mobile presentation

The technician area checklist groups areas into three sections — **Indoor
areas**, **Outdoor areas**, and **Manually added areas** (any `TECHNICIAN`
area, flagged "awaiting administrator approval"). The **Add area** flow lets the
technician pick a location (indoor/outdoor/semi-outdoor) and a category filtered
to that location, so exterior targets like perimeter fencing, gates, and roofs
can be recorded even when they are absent from the floor plan.

## Open configuration decision

Whether specific outdoor areas (patio, garage, yard, fence, pool) are **required
for every property** or **configurable per property/inspection type** is a
business decision that is not yet encoded — areas are currently optional unless
an administrator marks them required. Tracked as a configurable rule for a later
phase.
