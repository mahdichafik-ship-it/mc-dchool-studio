---
name: Platform-owner desktop scope
description: Authorization boundary for project visibility and pulling from the Mac capture app.
---

A connected platform owner may list and pull projects from every studio in the desktop app. Ordinary studio owners and admins remain limited to their own studio, while assistants and photographers still require assignment.

**Why:** Platform ownership must support photographing any school project, not only managing it on the web. Applying the normal studio-member filter to a platform-owner desktop token makes globally visible web projects disappear from the Mac app.

**How to apply:** Recognize platform ownership from the user identity attached to the authenticated desktop connection for both project listing and bundle access. Keep token revocation, retirement, offline checks, and all non-platform role boundaries unchanged.