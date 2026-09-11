---
name: Desktop capture-key scope
description: Why desktop capture identities must be isolated between photographer connections.
---

Treat capture keys generated from desktop-local IDs as unique only within one desktop connection, not across a project.

**Why:** Independent photographer databases can generate identical legacy keys such as `legacy-photo:53`. Project-wide matching can then attach or reject one photographer's capture based on another photographer's unrelated student.

**How to apply:** Scope server-side capture identity by desktop connection while preserving same-connection retry and JPEG/RAW pairing compatibility. Test collisions using two assigned desktop connections and different students.