# #platform-announcements, October 2026

Exported from the #platform-announcements channel on 2026-10-30 for the Platform team's records.
Posts are in the order they were posted.

---

**2026-10-12, Platform team:** Scheduled VolumeSnapshots are now kept for 30 days instead of
14, on every production cluster, after the restore drill showed we needed older restore points.
The cluster standards page will be updated at the next review.

---

**2026-10-19, Platform team:** The default StorageClass on production clusters is now
`balanced-rwo`. New PersistentVolumeClaims without a `storageClassName` get it; existing
volumes keep their class.

---

**2026-10-26, Platform team:** All production clusters now run Kubernetes 1.37. Thanks to
everyone who tested on staging. Report anything odd in #platform-help.
