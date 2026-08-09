# ADR 0002: Doctor separates shell proxy env from running proxy process env

## Status

Accepted

## Context

`ccx doctor` used to show only the proxy variables visible to the `ccx doctor`
process. That is accurate for the current shell, but misleading when a user
started `ccx start` or a service from a different environment and then ran
`ccx doctor` in a new terminal.

Environment variables are inherited by child processes, not shared globally
between existing shells. A new terminal can therefore show `HTTP_PROXY` as unset
while the already-running CodexCommander proxy process still has it set.

## Decision

`ccx doctor` reports three separate proxy surfaces:

- the current doctor process environment
- the effective `config.proxy` state, with the value hidden
- the running CodexCommander proxy process environment when a recorded PID is
  available and Linux `/proc/<pid>/environ` can be read

The process environment diagnostic reports only presence/absence of known proxy
keys. It never prints or stores proxy values because proxy URLs can contain
credentials.

## Consequences

- Users can distinguish "this new terminal has no proxy env" from "the running
  proxy process has no proxy env".
- Linux and WSL get an accurate runtime-process check without service-manager
  parsing.
- Non-Linux platforms show the running-process env check as unavailable instead
  of pretending service environment inspection is portable.
