---
name: Manual subject authority
description: The confirmed precedence rule between photographer selection and QR-based subject identification.
---

An explicitly selected student or corporate staff member is authoritative for photo assignment and renaming until the photographer clears or changes that selection. QR recognition may identify a mismatch or create a review signal, but it must not replace the selected subject. QR may establish the active subject only when no explicit manual selection is active.

**Why:** The photographer is making a deliberate subject decision at capture time. Allowing a QR result to silently override it can assign JPEG/RAW files to the wrong person, especially during rapid switching or when a visible QR belongs to someone else.

**How to apply:** Enforce the same precedence in production watcher paths, sequence helpers, file-drop paths, tests, offline/restart behavior, and both school and corporate projects. Register filesystem arrivals before asynchronous stability checks and drain them in arrival order so later QR markers cannot claim older files. Preserve JPEG/RAW ownership by resolving the existing shutter pair before choosing a delayed RAW destination, and fail visibly instead of silently reassigning a capture.