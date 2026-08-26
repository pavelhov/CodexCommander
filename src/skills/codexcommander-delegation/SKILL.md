---
name: codexcommander-delegation
description: Route and coordinate Codex multi-agent work through the live CodexCommander collaboration roster without hardcoding model IDs. Use when spawning subagents, splitting independent implementation or research, or coordinating parallel workers. Do not use for trivial single-step edits, ordinary Q&A, or sessions with no collaboration tools.
metadata:
  managed-by: codexcommander
  managed-version: "1"
---

# CodexCommander delegation

## Read the live contract first

Inspect the current `spawn_agent` schema and its companion collaboration tools before acting. Use only tools present in this session. The live injected collaboration guidance and tool contract win over this skill.

## Honor the installed mode

Read the CodexCommander global block in the applicable `AGENTS.md`. If that block is unavailable, use Balanced as the safe fallback.

## When to delegate

Balanced delegates substantial, bounded, independent work when that will clearly help. Orchestrator delegates research and implementation, while allowing direct work when delegation is unavailable or clearly wasteful.

## Spawn contract

Give every child a self-contained brief with its goal, paths or inputs, owned files, constraints, checks, and required output format. Do not assume a child inherits this transcript or this skill.

## Model and effort

Use only model IDs and effort levels advertised live. Prefer the current preferred worker when it fits. Omit overrides when the roster is stale, unknown, or uncertain, and never remember IDs.

## Coordination

The root verifies and synthesizes the result. Use bounded waits; do not invent an ACK or PING ritual.

## Waiting and interruption

A `wait_agent` timeout means only that no qualifying mailbox or final event arrived during that
subscription window. It is neutral, not evidence that the child failed, stopped, or made no progress.
After a timeout, reconcile state once with `list_agents`; if the child is still running, continue
useful local work or wait again for 5–10 minutes.

Never interrupt solely because one or more waits timed out, including silence after a checkpoint or
conclude request. That silence creates no interruption authority. Interrupt only for explicit user
cancellation, a confirmed error or blocked state, a hard deadline communicated prospectively to the
child, or deliberate replacement after preserving available work. Release pressure cannot turn a
retroactive deadline into a communicated gate.

For a bounded high-stakes gate, prospectively request one explicit checkpoint or a durable partial
artifact with `send_message`. Private child commentary does not wake the parent mailbox. A conclude
message is advisory and arrives at a model or tool boundary; it does not prove that the child stopped.

## Compaction

If details were compacted, reread this skill and the live tool contract before the next spawn.

## Do not

Do not hardcode a roster, invent tools, claim delegation is forced, or expand scope beyond the user and repository instructions.
