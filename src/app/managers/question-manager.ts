import type {
  Question,
  QuestionOption,
  QuestionState,
  QuestionAnswer,
  QuestionSettledOutcome,
} from "../types/question.js";
import type { InteractionManager } from "./interaction-manager.js";
import { logger } from "../../utils/logger.js";

function formatOptionLine(option: QuestionOption): string {
  return `* ${option.label}: ${option.description}`;
}

export class QuestionManager {
  constructor(private readonly interactionManager: InteractionManager) {}

  private get state(): QuestionState | null {
    return this.interactionManager.getPayload("question");
  }

  /**
   * Opens the question slot, replacing a poll of the same session already on screen.
   * Refuses while permission prompts or another session's poll hold the slot: the
   * poll has to wait for them.
   */
  startQuestions(questions: Question[], requestID: string, sessionId: string): boolean {
    const current = this.interactionManager.getSnapshot();
    logger.debug(
      `[QuestionManager] startQuestions called: slot=${current?.kind ?? "none"}, newQuestions=${questions.length}, requestID=${requestID}`,
    );

    if (current?.kind === "permission") {
      logger.info(
        `[QuestionManager] Permission prompts are on screen, not starting poll: requestID=${requestID}`,
      );
      return false;
    }

    const onScreen = this.state;
    if (onScreen && onScreen.sessionId !== sessionId) {
      logger.info(
        `[QuestionManager] A poll of another session is on screen, not starting poll: requestID=${requestID}`,
      );
      return false;
    }

    if (current?.kind === "question") {
      logger.info(`[QuestionManager] Poll already active! Replacing it with the new poll.`);
    }

    logger.info(
      `[QuestionManager] Starting new poll with ${questions.length} questions, requestID=${requestID}`,
    );
    this.interactionManager.start({
      kind: "question",
      expectedInput: "callback",
      payload: {
        questions,
        currentIndex: 0,
        selectedOptions: new Map(),
        customAnswers: new Map(),
        selectedCustomAnswers: new Set(),
        customInputQuestionIndex: null,
        activeMessageId: null,
        messageIds: [],
        requestID,
        sessionId,
        answeredFromTelegram: false,
        dismissing: false,
        settledWhileDismissing: null,
        lastCancelFailed: false,
      },
    });
    return true;
  }

  getRequestID(): string | null {
    return this.state?.requestID ?? null;
  }

  getSessionId(): string | null {
    return this.state?.sessionId ?? null;
  }

  /** The poll's answers are being sent from Telegram: OpenCode's own reply event is ours. */
  markAnsweredFromTelegram(): void {
    const state = this.state;
    if (state) {
      state.answeredFromTelegram = true;
    }
  }

  isAnsweredFromTelegram(): boolean {
    return this.state?.answeredFromTelegram ?? false;
  }

  /**
   * Cancel was tapped: the dismissal is being sent to OpenCode. A custom-text wait ends
   * here, so text typed afterwards is never taken as an answer.
   */
  startDismissal(): void {
    const state = this.state;
    if (state) {
      state.dismissing = true;
      state.settledWhileDismissing = null;
      state.lastCancelFailed = false;
      state.customInputQuestionIndex = null;
    }
  }

  isDismissing(): boolean {
    return this.state?.dismissing ?? false;
  }

  /** The dismissal did not reach OpenCode: the poll stays answerable. */
  failDismissal(): void {
    const state = this.state;
    if (state) {
      state.dismissing = false;
      state.settledWhileDismissing = null;
      state.lastCancelFailed = true;
    }
  }

  /** OpenCode reported the question settled while the dismissal was on its way. */
  noteSettledWhileDismissing(outcome: QuestionSettledOutcome): void {
    const state = this.state;
    if (state?.dismissing && state.settledWhileDismissing !== "answered") {
      state.settledWhileDismissing = outcome;
    }
  }

  getSettledWhileDismissing(): QuestionSettledOutcome | null {
    return this.state?.settledWhileDismissing ?? null;
  }

  hasLastCancelFailed(): boolean {
    return this.state?.lastCancelFailed ?? false;
  }

  clearLastCancelFailed(): void {
    const state = this.state;
    if (state) {
      state.lastCancelFailed = false;
    }
  }

  /** Answers or a dismissal are being sent from Telegram: the poll is left to that send. */
  isSettlingFromTelegram(): boolean {
    const state = this.state;
    return (state?.answeredFromTelegram ?? false) || (state?.dismissing ?? false);
  }

  getCurrentQuestion(): Question | null {
    const state = this.state;
    return state?.questions[state.currentIndex] ?? null;
  }

  selectOption(questionIndex: number, optionIndex: number): void {
    const state = this.state;
    if (!state) {
      return;
    }

    const question = state.questions[questionIndex];
    if (!question) {
      return;
    }

    const selected = state.selectedOptions.get(questionIndex) || new Set();

    if (question.multiple) {
      if (selected.has(optionIndex)) {
        selected.delete(optionIndex);
      } else {
        selected.add(optionIndex);
      }
    } else {
      selected.clear();
      selected.add(optionIndex);
    }

    state.selectedOptions.set(questionIndex, selected);

    logger.debug(
      `[QuestionManager] Selected options for question ${questionIndex}: ${Array.from(selected).join(", ")}`,
    );
  }

  getSelectedOptions(questionIndex: number): Set<number> {
    return this.state?.selectedOptions.get(questionIndex) || new Set();
  }

  getSelectedAnswer(questionIndex: number): string {
    const state = this.state;
    const question = state?.questions[questionIndex];
    if (!state || !question) {
      return "";
    }

    const selected = state.selectedOptions.get(questionIndex) || new Set();
    const options = Array.from(selected).flatMap((idx) => {
      const opt = question.options[idx];
      return opt ? [formatOptionLine(opt)] : [];
    });

    return options.join("\n");
  }

  setCustomAnswer(questionIndex: number, answer: string): void {
    logger.debug(
      `[QuestionManager] Custom answer received for question ${questionIndex}: ${answer}`,
    );
    const state = this.state;
    if (!state) {
      return;
    }

    state.customAnswers.set(questionIndex, answer);
    if (state.questions[questionIndex]?.multiple) {
      state.selectedCustomAnswers.add(questionIndex);
    }
  }

  getCustomAnswer(questionIndex: number): string | undefined {
    return this.state?.customAnswers.get(questionIndex);
  }

  hasCustomAnswer(questionIndex: number): boolean {
    return this.state?.customAnswers.has(questionIndex) ?? false;
  }

  /** Ticks or unticks the custom answer of a multi-select question, like an option. */
  toggleCustomAnswer(questionIndex: number): void {
    const state = this.state;
    if (!state || !state.customAnswers.has(questionIndex)) {
      return;
    }

    if (state.selectedCustomAnswers.has(questionIndex)) {
      state.selectedCustomAnswers.delete(questionIndex);
    } else {
      state.selectedCustomAnswers.add(questionIndex);
    }
  }

  isCustomAnswerSelected(questionIndex: number): boolean {
    return this.state?.selectedCustomAnswers.has(questionIndex) ?? false;
  }

  hasAnswer(questionIndex: number): boolean {
    return this.getAnswerItems(questionIndex).length > 0;
  }

  /**
   * The answer items sent to the agent for one question. A multi-select question
   * sends its ticked options, then the ticked custom answer as one more item.
   */
  getAnswerItems(questionIndex: number): string[] {
    const question = this.state?.questions[questionIndex];
    if (!question) {
      return [];
    }

    const selectedAnswer = this.getSelectedAnswer(questionIndex);
    const customAnswer = this.getCustomAnswer(questionIndex);

    if (!question.multiple) {
      // Each option is formatted as "* Label: Description"
      const answer = customAnswer || selectedAnswer;
      return answer.split("\n").filter((part) => part.trim());
    }

    const items = selectedAnswer.split("\n").filter((part) => part.trim());
    if (customAnswer && this.isCustomAnswerSelected(questionIndex)) {
      items.push(customAnswer);
    }

    return items;
  }

  /**
   * The answer items sent to OpenCode for one question. A choice that carries a value is
   * sent as that value; one without is sent as its display line, like `getAnswerItems`.
   */
  getReplyItems(questionIndex: number): string[] {
    const question = this.state?.questions[questionIndex];
    if (!question) {
      return [];
    }

    const customAnswer = this.getCustomAnswer(questionIndex);
    if (!question.multiple && customAnswer) {
      return this.getAnswerItems(questionIndex);
    }

    const items = Array.from(this.getSelectedOptions(questionIndex)).flatMap((idx) => {
      const opt = question.options[idx];
      if (!opt) {
        return [];
      }
      if (opt.value !== undefined) {
        return [opt.value];
      }
      return formatOptionLine(opt)
        .split("\n")
        .filter((part) => part.trim());
    });

    if (question.multiple && customAnswer && this.isCustomAnswerSelected(questionIndex)) {
      items.push(customAnswer);
    }

    return items;
  }

  nextQuestion(): void {
    const state = this.state;
    if (!state) {
      return;
    }

    state.currentIndex++;
    state.customInputQuestionIndex = null;
    state.activeMessageId = null;

    logger.debug(
      `[QuestionManager] Moving to next question: ${state.currentIndex}/${state.questions.length}`,
    );
  }

  hasNextQuestion(): boolean {
    const state = this.state;
    return state !== null && state.currentIndex < state.questions.length;
  }

  getCurrentIndex(): number {
    return this.state?.currentIndex ?? 0;
  }

  getTotalQuestions(): number {
    return this.state?.questions.length ?? 0;
  }

  addMessageId(messageId: number): void {
    this.state?.messageIds.push(messageId);
  }

  setActiveMessageId(messageId: number): void {
    const state = this.state;
    if (state) {
      state.activeMessageId = messageId;
    }
  }

  getActiveMessageId(): number | null {
    return this.state?.activeMessageId ?? null;
  }

  isActiveMessage(messageId: number | null): boolean {
    const activeMessageId = this.getActiveMessageId();
    return activeMessageId !== null && messageId === activeMessageId;
  }

  startCustomInput(questionIndex: number): void {
    const state = this.state;
    if (!state || !state.questions[questionIndex]) {
      return;
    }

    state.customInputQuestionIndex = questionIndex;
  }

  clearCustomInput(): void {
    const state = this.state;
    if (state) {
      state.customInputQuestionIndex = null;
    }
  }

  isWaitingForCustomInput(questionIndex: number): boolean {
    return this.state?.customInputQuestionIndex === questionIndex;
  }

  getMessageIds(): number[] {
    return [...(this.state?.messageIds ?? [])];
  }

  isActive(): boolean {
    const active = this.state !== null;
    logger.debug(`[QuestionManager] isActive check: ${active}`);
    return active;
  }

  cancel(): void {
    logger.info("[QuestionManager] Poll cancelled");
    this.interactionManager.clearKind("question", "question_cancelled");
  }

  clear(): void {
    this.interactionManager.clearKind("question", "question_cleared");
  }

  getAllAnswers(): QuestionAnswer[] {
    const state = this.state;
    const answers: QuestionAnswer[] = [];
    if (!state) {
      return answers;
    }

    for (let i = 0; i < state.questions.length; i++) {
      const question = state.questions[i];
      if (!question) {
        continue;
      }
      const finalAnswer = question.multiple
        ? this.getAnswerItems(i).join("\n")
        : this.getCustomAnswer(i) || this.getSelectedAnswer(i);

      if (finalAnswer) {
        answers.push({
          question: question.question,
          answer: finalAnswer,
        });
      }
    }

    return answers;
  }
}
