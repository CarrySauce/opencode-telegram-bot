import { resetAllStreamThrottles, resetStreamThrottle } from "../../bot/streaming/stream-throttle.js";
import { logger } from "../../utils/logger.js";

export interface AssistantRunStartInfo {
  startedAt: number;
  configuredAgent?: string | undefined;
  configuredProviderID?: string | undefined;
  configuredModelID?: string | undefined;
}

export interface AssistantRunResolvedInfo {
  agent?: string | undefined;
  providerID?: string | undefined;
  modelID?: string | undefined;
}

export interface AssistantRunInfo extends AssistantRunStartInfo {
  sessionId: string;
  /** False for a turn the bot only observed: OpenCode's own follow-up or a prompt typed in a client. */
  startedByBot: boolean;
  actualAgent?: string | undefined;
  actualProviderID?: string | undefined;
  actualModelID?: string | undefined;
  hasCompletedResponse: boolean;
}

export class AssistantRunState {
  private readonly runs = new Map<string, AssistantRunInfo>();

  startRun(sessionId: string, info: AssistantRunStartInfo): void {
    if (!sessionId) {
      return;
    }

    resetStreamThrottle(sessionId);
    this.runs.set(sessionId, {
      sessionId,
      startedByBot: true,
      startedAt: info.startedAt,
      configuredAgent: info.configuredAgent,
      configuredProviderID: info.configuredProviderID,
      configuredModelID: info.configuredModelID,
      hasCompletedResponse: false,
    });

    logger.debug(
      `[AssistantRunState] Started run: session=${sessionId}, agent=${info.configuredAgent || "unknown"}, model=${info.configuredProviderID || "unknown"}/${info.configuredModelID || "unknown"}`,
    );
  }

  /** Opens a run for a turn the bot did not start; its agent and model come with its reply. */
  startObservedRun(sessionId: string, startedAt: number): void {
    if (!sessionId || this.runs.has(sessionId)) {
      return;
    }

    this.runs.set(sessionId, {
      sessionId,
      startedByBot: false,
      startedAt,
      hasCompletedResponse: false,
    });

    logger.debug(`[AssistantRunState] Started observed run: session=${sessionId}`);
  }

  markResponseCompleted(sessionId: string, info?: AssistantRunResolvedInfo): void {
    const run = this.runs.get(sessionId);
    if (!run) {
      return;
    }

    run.hasCompletedResponse = true;
    if (info?.agent) {
      run.actualAgent = info.agent;
    }
    if (info?.providerID) {
      run.actualProviderID = info.providerID;
    }
    if (info?.modelID) {
      run.actualModelID = info.modelID;
    }
  }

  hasRun(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  hasBotRun(sessionId: string): boolean {
    return this.runs.get(sessionId)?.startedByBot === true;
  }

  isResponseCompleted(sessionId: string): boolean {
    return this.runs.get(sessionId)?.hasCompletedResponse === true;
  }

  finishRun(sessionId: string, reason: string): AssistantRunInfo | null {
    resetStreamThrottle(sessionId);
    const run = this.runs.get(sessionId) ?? null;
    if (!run) {
      return null;
    }

    this.runs.delete(sessionId);
    logger.debug(`[AssistantRunState] Finished run: session=${sessionId}, reason=${reason}`);
    return { ...run };
  }

  clearRun(sessionId: string, reason: string): void {
    resetStreamThrottle(sessionId);
    if (!this.runs.delete(sessionId)) {
      return;
    }

    logger.debug(`[AssistantRunState] Cleared run: session=${sessionId}, reason=${reason}`);
  }

  clearAll(reason: string): void {
    resetAllStreamThrottles();
    if (this.runs.size === 0) {
      return;
    }

    logger.debug(`[AssistantRunState] Cleared all runs: count=${this.runs.size}, reason=${reason}`);
    this.runs.clear();
  }
}
