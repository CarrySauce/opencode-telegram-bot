import type { AppContainer } from "../../app/bootstrap/app-container.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { watchLateModelCatalogChanges } from "../../opencode/ready-refresh.js";
import { logger } from "../../utils/logger.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";

export type ModelViewsDeps = Pick<AppContainer, "keyboardManager" | "pinnedMessageManager">;

/** Redraws what shows the selected model: the pinned dashboard and the keyboard model button. */
export async function refreshModelViews(deps: ModelViewsDeps): Promise<void> {
  await deps.pinnedMessageManager.refreshContextLimit();
  await deps.pinnedMessageManager.refresh();
  if (deps.keyboardManager.isInitialized()) {
    deps.keyboardManager.updateModel(getStoredModel());
  }
}

// The views were drawn before the model catalog settled: redraw on each later change.
export function refreshModelViewsAfterLateCatalogSettle(
  deps: ModelViewsDeps,
  reason: string,
): void {
  const nextLateCatalogChange = watchLateModelCatalogChanges();

  safeBackgroundTask({
    taskName: "bot.refreshModelViewsAfterLateCatalogSettle",
    task: async () => {
      while (await nextLateCatalogChange()) {
        await refreshModelViews(deps);
        logger.info(
          `[Bot] Refreshed model views after the model catalog settled: reason=${reason}`,
        );
      }
    },
  });
}
