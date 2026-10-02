/**
 * Session Settings Service - adopts the agent and model a session last ran with
 */
import type { Session } from "@opencode-ai/sdk/v2";
import { selectAgent } from "./agent-selection-service.js";
import { resolveModelToAdopt, selectModel } from "./model-selection-service.js";
import type { ModelInfo } from "../types/model.js";
import { logger } from "../../utils/logger.js";

/**
 * Apply the agent and model stored on a session to the current settings.
 * Agent and model are adopted independently: a session that carries only one of
 * them changes only that one, and a session that was never prompted changes
 * nothing. The variant is part of the model record and is never adopted on its
 * own, so a model without a variant is stored at "default". A model OpenCode no
 * longer offers is replaced by the config model, or not adopted at all.
 * @param session Session to read the settings from
 */
export async function applySessionSettings(session: Session): Promise<void> {
  const model = session.model;

  if (session.agent) {
    selectAgent(session.agent);
  }

  let pulledModel: ModelInfo | null = null;
  if (model?.providerID && model.id) {
    const adoptedModel = await resolveModelToAdopt({
      providerID: model.providerID,
      modelID: model.id,
    });

    if (adoptedModel) {
      const isSessionModel =
        adoptedModel.providerID === model.providerID && adoptedModel.modelID === model.id;
      pulledModel = {
        providerID: adoptedModel.providerID,
        modelID: adoptedModel.modelID,
        variant: isSessionModel ? model.variant || "default" : "default",
      };
      selectModel(pulledModel);
    }
  }

  if (!session.agent && !model) {
    logger.debug(`[SessionSettings] Session ${session.id} carries no agent or model to pull`);
    return;
  }

  logger.info(
    `[SessionSettings] Pulled from session ${session.id}: agent=${session.agent ?? "unchanged"}, model=${
      pulledModel
        ? `${pulledModel.providerID}/${pulledModel.modelID} (${pulledModel.variant})`
        : "unchanged"
    }`,
  );
}
