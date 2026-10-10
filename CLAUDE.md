# Provider Data Factory — Take-home (6 hours)

Full spec: docs/assignment.pdf

## Stack
NestJS, MongoDB (Mongoose), BullMQ (Redis), Zod, Jest, mongodb-memory-server

## Non-negotiable rules
- core/ must NOT import Mongoose or anything provider-specific. Only ports (interfaces).
- Provider specifics live ONLY in src/providers/<name>/ (adapter + declarative mapping).
- Transform steps are pure functions: no I/O, no Date.now(), no randomness.
- Raw DB is read-only. Read with cursors in configurable batches.
- All writes are upserts on a stable natural key (idempotency).
- Bad documents → quarantine with reason. Never drop silently.
- Bad config → app refuses to boot.

## Working style
- Small focused changes. Don't build features I didn't ask for.
- Keep it simple and defensible; I must explain every line in an interview.
- After each step, tell me what to commit.