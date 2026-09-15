---
name: Prepublication access credentials
description: Stable parent or customer delivery cards prepared before gallery publication.
---

Delivery credentials may be prepared after roster import while the gallery remains draft. They stay stable through roster updates, within-project class moves, capture, upload, review, and publication until explicitly revoked or regenerated.

**Why:** Schools distribute physical cards before photo day. Creating credentials only at publication makes that workflow impossible, while allowing draft credentials to authenticate would expose unpublished delivery state.

**How to apply:** Atomically create missing project-scoped access records and always reread the persisted winner. Preparation must not publish, validate public codes, issue tokens, expose photos, or send invitations. Use canonical absolute fragment URLs for new delivery QRs, preserve legacy query links, and keep photographer capture QRs separate and unchanged.