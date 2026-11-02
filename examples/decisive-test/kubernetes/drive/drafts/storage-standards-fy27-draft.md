# DRAFT: storage standards for FY27

Draft by the Platform team for the FY27 planning review, 2026-10-21. Not approved; the cluster
standards page stays in force until the review decides.

## Proposed changes

- `gold` VolumeAttributesClass: 16000 IOPS and 1000 MiB/s, up from 10000 IOPS, for the
  database teams moving off dedicated hosts.
- A namespace may hold at most 50 PersistentVolumeClaims, up from 20; the quota requests
  this quarter were almost all for more claims, not more capacity.

## Open questions

- Should the `silver` class move to 4000 IOPS?
- Who pays for snapshot storage on the database teams' volumes?
