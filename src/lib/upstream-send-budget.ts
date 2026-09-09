/** Shared by the initial native send and its permitted pre-generation recovery. */
export class UpstreamSendBudget {
  private sends = 0;
  private deadline: number | undefined;

  constructor(
    private readonly timeoutMs: number,
    private readonly maxSends = 2,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Reserve synchronously at the transport boundary, before invoking fetch. */
  reserve(signal: AbortSignal): number {
    if (signal.aborted) throw signal.reason ?? new DOMException("Client cancelled", "AbortError");
    const now = this.now();
    this.deadline ??= now + this.timeoutMs;
    const remaining = this.deadline - now;
    if (remaining <= 0) throw new DOMException("Upstream request deadline elapsed", "TimeoutError");
    if (this.sends >= this.maxSends) throw new Error("Upstream request send budget exhausted");
    this.sends += 1;
    return remaining;
  }
}
