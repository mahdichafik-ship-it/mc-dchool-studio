---
name: Group photo entry point
description: Visibility rule for the class-photo and custom-group capture targets in the desktop shoot workspace.
---

The class-photo and custom-group capture targets must remain visibly available in the main roster workspace. A backend group model and a secondary toolbar menu are not sufficient: photographers need an obvious, always-present place to select a class or group before shooting.

**Why:** A layout refactor preserved the group database, IPC, and detail screen but moved the only practical entry point into a compact header dropdown. In release testing this looked like class/group capture had been removed.

**How to apply:** Keep an explicit class/group photo section in the primary roster column, label the default class group as a class photo, and reload groups after project initialization so default targets are not lost to the project/group initialization race.