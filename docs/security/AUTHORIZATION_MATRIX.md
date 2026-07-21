# Authorization Matrix

| Capability                    | System admin   | Property admin | Supervisor | Technician    | Reviewer     | Charge approver | Owner read-only |
| ----------------------------- | -------------- | -------------- | ---------- | ------------- | ------------ | --------------- | --------------- |
| Manage properties/floor plans | Yes            | Yes            | Limited    | No            | No           | No              | No              |
| Create technician account     | Yes            | Yes            | No         | No            | No           | No              | No              |
| Approve room tags             | Yes            | Yes            | Yes        | No            | No           | No              | No              |
| Access assigned inspection    | Yes            | Yes            | Yes        | Assigned only | Review scope | Review scope    | Read scope      |
| Upload room video             | No             | No             | No         | Assigned only | No           | No              | No              |
| Review findings               | Administrative | No             | Oversight  | Read          | Yes          | Read            | Read only       |
| Approve tenant charge         | No             | No             | No         | No            | No           | Yes             | No              |

AI has no human role and cannot approve findings or charges.

A technician can list or open only inspections with a current assignment to that technician in the same organization. This scope also applies transitively to properties, rooms, media, uploads, and findings. A valid identifier outside that scope is returned as not found.
