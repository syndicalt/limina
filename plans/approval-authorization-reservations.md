# Approval authorization reservation contract

Status: accepted remediation decision.

An action held for human approval is authorized and charged exactly once, when it
is proposed. The pending approval is a bounded reservation of that decision; it
is not an instruction to re-run quota and budget accounting at grant time.

Grant semantics:

- Session and capability revocation are checked again immediately before apply.
- The proposal's validated input, permission set, profile provenance, and policy
  charge stay pinned. Profile or quota edits do not silently reinterpret it.
- Grant does not consume quota or call budget a second time.
- A reservation expires after 15 minutes by default. Hosts may lower this with
  `SkillRegistry.setApprovalHoldTimeoutMs`.
- Denial and expiry do not refund proposal-time usage. The policy window performs
  normal expiry; this prevents repeated proposals from bypassing anti-spam limits.
- Expired actions are removed and emit `skill.approval.denied` with an explicit
  `approval hold expired` reason.

This is intentionally a reservation model, not current-policy reauthorization.
Changing that choice requires reservation-aware policy tokens that exclude the
action's own committed quota from a grant-time evaluation; a naïve second
`evaluate()` would self-deny quota-one actions and is prohibited.
