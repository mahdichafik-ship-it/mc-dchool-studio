---
name: Photo group membership
description: Synchronization rules for automatic class groups and manual membership overrides.
---

Every class has one default photo group initially containing the class roster. New students join automatically, but a person manually removed from that group must stay removed through refreshes, offline work, restarts, and web/desktop synchronization.

For delivery galleries, a default class-group photo belongs to every student in that class who has at least one durable individual portrait in the project. Roster membership alone is not enough. Custom group photos remain limited to photographed members of that group.

**Why:** Rebuilding default membership from the current class roster erases intentional exclusions. Conversely, treating any edited membership as fully frozen prevents late students from joining and can strand their class-photo workflow. Gallery delivery must not create galleries for absent students merely because they were imported on the roster.

**How to apply:** Keep explicit server-side exclusions for default groups. On desktop, persist both a roster snapshot and a dirty flag: compare new rosters to the previous snapshot to add only genuine arrivals, preserve removals, avoid overwriting newer cloud edits from clean clients, and clear dirty state only after confirmed cloud synchronization. Reconcile class photos when either upload order occurs: group first or portrait first, and once more when the gallery is published.