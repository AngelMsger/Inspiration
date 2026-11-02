# Storage FAQ

Questions teams ask the Platform team about volumes on our clusters.

Last updated: 2026-07-10.

## How big can a PersistentVolumeClaim be?

Up to 4 TiB without a review. Above that, open a capacity request and say how fast the data
grows.

## Can I get scratch space that goes away with the Pod?

Use a generic ephemeral volume. Generic ephemeral volumes are a beta feature since Kubernetes
v1.21, enabled by default through the `GenericEphemeralVolume` feature gate. The volume is
created with the Pod and deleted with it, and can use any StorageClass.

## How many EBS volumes can a node attach?

Kubernetes allows 39 EBS volumes per node on AWS. Plan your StatefulSets so that no node needs
more.

## How do I grow a volume?

Edit the PersistentVolumeClaim's `spec.resources.requests.storage`. Our StorageClasses set
`allowVolumeExpansion: true`, so the volume grows in place.
