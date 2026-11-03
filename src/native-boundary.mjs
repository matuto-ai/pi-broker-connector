// Observe supported Pi APIs only. Never read, change or submit the human's draft.
export function canStartNativeTurn(ctx, promptActive = false) {
  try {
    if (promptActive || ctx.isIdle?.() !== true || ctx.hasPendingMessages?.() !== false) return false;
    // TUI exposes the core draft; RPC may expose one through its UI binding.
    // A missing/unreadable UI accessor is unknown, not evidence of an empty draft.
    if (ctx.hasUI === true && ctx.ui?.getEditorText?.() !== '') return false;
    return true;
  } catch { return false; }
}

export class NativeInputBoundary {
  constructor(pi, currentDelivery = () => null) {
    this.promptActive = false; this.abortRevision = 0; this.pausedSessions = new Set();
    this.currentDelivery = currentDelivery;
    // Pi coalesces nested prompts into one outer start/end pair. Do not store titles.
    pi.on('ui_prompt_start', () => { this.promptActive = true; });
    pi.on('ui_prompt_end', () => { this.promptActive = false; });
    pi.on('agent_settled', (event, ctx) => {
      if (event.aborted === true) {
        this.abortRevision++;
        const id = ctx?.sessionManager?.getSessionId?.();
        if (id) this.pausedSessions.add(id);
        currentDelivery(ctx)?.setHumanPaused(true);
      }
    });
    pi.on('input', (event, ctx) => {
      if (event.source === 'interactive' || event.source === 'rpc') this.resume(ctx);
    });
  }
  isPaused(ctx) { return this.pausedSessions.has(ctx?.sessionManager?.getSessionId?.()); }
  resume(ctx, revision = this.abortRevision) {
    if (revision !== this.abortRevision) return false;
    const delivery = this.currentDelivery(ctx);
    delivery?.setHumanPaused(false);
    if (delivery?.humanPaused) return false;
    this.pausedSessions.delete(ctx?.sessionManager?.getSessionId?.());
    return true;
  }
  allows(ctx) { return !this.isPaused(ctx) && canStartNativeTurn(ctx, this.promptActive); }
}
