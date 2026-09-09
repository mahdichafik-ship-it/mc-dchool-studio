---
name: Photo group membership
description: Synchronization rules for automatic class groups and manual membership overrides.
---

Every class has one default photo group initially containing the class roster. New students join automatically, but a person manually removed from that group must stay removed through refreshes, offline work, restarts, and web/desktop synchronization.

**Why:** Rebuilding default membership from the current class roster erases intentional exclusions. Conversely, treating any edited membership as fully frozen prevents late students from joining and can strand their class-photo workflow.

**How to apply:** Keep explicit server-side exclusions for default groups. On desktop, persist both a roster snapshot and a dirty flag: compare new rosters to the previous snapshot to add only genuine arrivals, preserve removals, avoid overwriting newer cloud edits from clean clients, and clear dirty state only after confirmed cloud synchronization.