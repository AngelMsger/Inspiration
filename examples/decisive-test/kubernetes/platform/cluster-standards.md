# Kubernetes cluster standards

Owned by the Platform team. Every production cluster runs with these settings. To change one,
open a platform change request; the Platform team reviews it in the weekly change meeting.

Last reviewed: 2026-09-15.

## Versions

- Production clusters run Kubernetes 1.36. Staging clusters run the same minor version and are
  upgraded two weeks before production.
- We skip no minor version: each upgrade moves one minor version at a time.

## Networking

- Every new namespace gets a default-deny ingress NetworkPolicy. Teams add allow rules for the
  traffic their workloads need.
- Internet-facing Services of type LoadBalancer must set `externalTrafficPolicy: Local`, so that
  the web application firewall sees the client's source IP.
- A namespace may have at most 5 Services of type LoadBalancer. Ask the Platform team for more.
- Internal Services use `type: ClusterIP`. Ask the Platform team before creating a NodePort
  Service.

## Storage

- The default StorageClass is `standard-rwo`. A PersistentVolumeClaim without a
  `storageClassName` gets a volume of this class.
- A PersistentVolumeClaim of up to 2 TiB needs no review. A larger one needs a capacity review
  by the Platform team.
- A namespace may hold at most 20 PersistentVolumeClaims.
- VolumeAttributesClasses: `silver` gives 3000 IOPS and 125 MiB/s; `gold` gives 10000 IOPS and
  500 MiB/s. Change a volume's class to move it between them without downtime.
- Scheduled VolumeSnapshots are kept for 14 days, then deleted.
