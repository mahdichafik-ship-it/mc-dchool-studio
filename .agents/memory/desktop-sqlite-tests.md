---
name: Desktop SQLite tests
description: How to choose between injectable stores and real restart-backed SQLite coverage for desktop tests.
---

Use injectable stores for focused desktop logic tests, but use the real Drizzle/SQLite adapter when the regression specifically depends on process-restart durability or production query behavior.

**Why:** Desktop packaging work can leave a macOS `better-sqlite3` binary in the shared workspace, which Linux reports as an invalid ELF file. The binding can be rebuilt for the active Node runtime, but the older node-gyp used here requires Python 3.11 rather than the default Python 3.13.

**How to apply:** Keep most tests adapter-driven. For restart-sensitive regressions, provide a narrow database close/reopen test seam and use a temporary user-data directory. If the native binding has the wrong platform, rebuild the existing pinned package with Python 3.11 before judging the test itself.