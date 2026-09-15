---
name: Gallery contact consent
description: Privacy and audience rules for email identity collected at private gallery access.
---

An email address is required alongside the private-gallery access code and identifies visits, but it is not proof of mailbox ownership and does not itself authorize promotional messages. Marketing consent is a separate optional choice; an unchecked box leaves consent unknown rather than revoking or granting it.

Campaign audience calculations must include only explicitly consented contacts and always exclude unsubscribed contacts. A later explicit gallery opt-in may restore consent after an earlier unsubscribe, but studio-side changes must remain visible and auditable.

Promotional campaign sending is production-ready only with a verified custom-domain sender; Resend's onboarding sender is setup-only. Until durable background batching exists, keep each campaign to one provider batch of at most 100 recipients. If provider acceptance cannot be confirmed, mark delivery as needing review rather than failed, and never offer an automatic retry.

Roster intake may include the intended gallery recipient's email: a parent or guardian for a school subject, or the employee for a corporate subject. Publishing can then support two parallel handoff methods: a transactional email invitation tied to that subject's access record, and the existing printed QR/access card distributed by the school or company.

**Why:** Gallery access is a service transaction involving school families or corporate subjects. Treating roster contact data or required access data as marketing permission would conflate identity with consent and could expose studios to privacy and email-compliance risk. Keeping cards preserves an offline handoff and recovery option. A lost provider response may hide an accepted send, so retrying an uncertain delivery can duplicate customer email.

**How to apply:** Preserve the separation in roster imports, access forms, schemas, exports, templates, campaigns, and future email sending. Gallery invitations are transactional and may use the recipient email supplied for that subject; promotional email still requires explicit consent. Never mark a campaign sent or deliver promotional email when consent is absent, false, or unsubscribed. Recheck eligibility immediately before dispatch, persist provider evidence, and require manual Resend reconciliation for uncertain outcomes.