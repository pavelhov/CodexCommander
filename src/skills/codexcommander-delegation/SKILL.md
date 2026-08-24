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

## Compaction

If details were compacted, reread this skill and the live tool contract before the next spawn.

## Do not

Do not hardcode a roster, invent tools, claim delegation is forced, or expand scope beyond the user and repository instructions.
