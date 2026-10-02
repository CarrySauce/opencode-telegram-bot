export interface QuestionOption {
  label: string;
  description: string;
  /** What is sent to OpenCode for this choice when it differs from the text shown (V2 only). */
  value?: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  /** Whether a custom answer is accepted; unstated means accepted. */
  custom?: boolean;
}

export interface QuestionAnswer {
  question: string;
  answer: string;
}

export interface QuestionState {
  questions: Question[];
  currentIndex: number;
  selectedOptions: Map<number, Set<number>>;
  customAnswers: Map<number, string>;
  selectedCustomAnswers: Set<number>;
  customInputQuestionIndex: number | null;
  activeMessageId: number | null;
  messageIds: number[];
  requestID: string | null;
  sessionId: string;
  /** The poll's answers are on their way to OpenCode. */
  answeredFromTelegram: boolean;
  /** Cancel was tapped and the dismissal is on its way to OpenCode. */
  dismissing: boolean;
  /** How OpenCode reported the question settled while the answers or the dismissal were on their way. */
  settledWhileSending: QuestionSettledOutcome | null;
  /** The last Cancel did not reach OpenCode and nothing was tapped since. */
  lastCancelFailed: boolean;
}

/** How a question was settled outside Telegram. */
export type QuestionSettledOutcome = "answered" | "cancelled";

/**
 * How a question ended while its poll message was not on screen yet: settled outside
 * Telegram, ended unanswered (reset, run end, tool failure), or replaced by a newer poll.
 */
export type QuestionInFlightEnding = QuestionSettledOutcome | "not_answered" | "replaced";
