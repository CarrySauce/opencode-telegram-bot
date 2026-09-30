import { beforeEach, describe, expect, it } from "vitest";
import { QuestionManager } from "../../../src/app/managers/question-manager.js";
import type { Question } from "../../../src/app/types/question.js";
import { InteractionManager } from "../../../src/app/managers/interaction-manager.js";

const SINGLE_QUESTION: Question = {
  question: "Pick one option",
  header: "single",
  options: [
    { label: "Yes", description: "accept" },
    { label: "No", description: "decline" },
  ],
};

const MULTIPLE_QUESTION: Question = {
  question: "Pick multiple options",
  header: "multiple",
  multiple: true,
  options: [
    { label: "Alpha", description: "first" },
    { label: "Beta", description: "second" },
    { label: "Gamma", description: "third" },
  ],
};

let questionManager: QuestionManager;

beforeEach(() => {
  questionManager = new QuestionManager(new InteractionManager());
});

describe("questionManager", () => {
  it("starts poll and moves through questions", () => {
    questionManager.startQuestions([SINGLE_QUESTION, MULTIPLE_QUESTION], "req-1", "session-1");

    expect(questionManager.isActive()).toBe(true);
    expect(questionManager.getRequestID()).toBe("req-1");
    expect(questionManager.getCurrentIndex()).toBe(0);
    expect(questionManager.getCurrentQuestion()?.question).toBe(SINGLE_QUESTION.question);

    questionManager.nextQuestion();
    expect(questionManager.getCurrentIndex()).toBe(1);
    expect(questionManager.getCurrentQuestion()?.question).toBe(MULTIPLE_QUESTION.question);

    questionManager.nextQuestion();
    expect(questionManager.hasNextQuestion()).toBe(false);
    expect(questionManager.getCurrentQuestion()).toBeNull();
  });

  it("replaces a poll only with one of the same session", () => {
    questionManager.startQuestions([SINGLE_QUESTION], "req-a", "session-a");

    expect(questionManager.startQuestions([MULTIPLE_QUESTION], "req-b", "session-b")).toBe(false);
    expect(questionManager.getRequestID()).toBe("req-a");

    expect(questionManager.startQuestions([MULTIPLE_QUESTION], "req-a2", "session-a")).toBe(true);
    expect(questionManager.getRequestID()).toBe("req-a2");
    expect(questionManager.getSessionId()).toBe("session-a");
  });

  it("marks a poll answered from Telegram until it is cleared", () => {
    questionManager.startQuestions([SINGLE_QUESTION], "req-1", "session-1");
    expect(questionManager.isAnsweredFromTelegram()).toBe(false);

    questionManager.markAnsweredFromTelegram();
    expect(questionManager.isAnsweredFromTelegram()).toBe(true);

    questionManager.clear();
    expect(questionManager.isAnsweredFromTelegram()).toBe(false);
  });

  it("keeps no custom-answer input once the poll is closed", () => {
    questionManager.startQuestions([SINGLE_QUESTION], "req-1", "session-1");
    questionManager.startCustomInput(0);
    expect(questionManager.isWaitingForCustomInput(0)).toBe(true);

    questionManager.clear();

    expect(questionManager.isActive()).toBe(false);
    expect(questionManager.isWaitingForCustomInput(0)).toBe(false);
  });

  it("resets previous active poll when starting a new one", () => {
    questionManager.startQuestions([SINGLE_QUESTION], "req-old", "session-1");
    questionManager.selectOption(0, 1);
    questionManager.addMessageId(42);

    questionManager.startQuestions([MULTIPLE_QUESTION], "req-new", "session-1");

    expect(questionManager.getRequestID()).toBe("req-new");
    expect(questionManager.getTotalQuestions()).toBe(1);
    expect(questionManager.getSelectedOptions(0)).toEqual(new Set<number>());
    expect(questionManager.getMessageIds()).toEqual([]);
  });

  it("handles single-choice and multiple-choice selections", () => {
    questionManager.startQuestions([SINGLE_QUESTION, MULTIPLE_QUESTION], "req-2", "session-1");

    questionManager.selectOption(0, 0);
    questionManager.selectOption(0, 1);
    expect(questionManager.getSelectedOptions(0)).toEqual(new Set([1]));
    expect(questionManager.getSelectedAnswer(0)).toBe("* No: decline");

    questionManager.selectOption(1, 0);
    questionManager.selectOption(1, 1);
    questionManager.selectOption(1, 0);
    expect(questionManager.getSelectedOptions(1)).toEqual(new Set([1]));
    expect(questionManager.getSelectedAnswer(1)).toBe("* Beta: second");
  });

  it("stores custom answers per question and adds them after the ticked options", () => {
    questionManager.startQuestions([SINGLE_QUESTION, MULTIPLE_QUESTION], "req-3", "session-1");

    questionManager.selectOption(0, 1);
    questionManager.selectOption(1, 0);
    questionManager.setCustomAnswer(1, "Custom response for question #2");

    expect(questionManager.hasCustomAnswer(1)).toBe(true);
    expect(questionManager.getCustomAnswer(1)).toBe("Custom response for question #2");
    expect(questionManager.isCustomAnswerSelected(1)).toBe(true);

    const answers = questionManager.getAllAnswers();
    expect(answers).toEqual([
      { question: SINGLE_QUESTION.question, answer: "* No: decline" },
      {
        question: MULTIPLE_QUESTION.question,
        answer: "* Alpha: first\nCustom response for question #2",
      },
    ]);
  });

  it("builds multi-select answer items from ticked options and the ticked custom text", () => {
    questionManager.startQuestions([MULTIPLE_QUESTION], "req-3c", "session-1");

    questionManager.setCustomAnswer(0, "Line one\nline two");
    questionManager.selectOption(0, 2);
    questionManager.selectOption(0, 0);

    expect(questionManager.getAnswerItems(0)).toEqual([
      "* Gamma: third",
      "* Alpha: first",
      "Line one\nline two",
    ]);

    questionManager.toggleCustomAnswer(0);
    expect(questionManager.isCustomAnswerSelected(0)).toBe(false);
    expect(questionManager.getAnswerItems(0)).toEqual(["* Gamma: third", "* Alpha: first"]);
    expect(questionManager.getAllAnswers()).toEqual([
      { question: MULTIPLE_QUESTION.question, answer: "* Gamma: third\n* Alpha: first" },
    ]);

    questionManager.selectOption(0, 2);
    questionManager.selectOption(0, 0);
    expect(questionManager.hasAnswer(0)).toBe(false);

    questionManager.toggleCustomAnswer(0);
    expect(questionManager.hasAnswer(0)).toBe(true);
    expect(questionManager.getAnswerItems(0)).toEqual(["Line one\nline two"]);
  });

  it("keeps single-select custom answers first and split by line breaks", () => {
    questionManager.startQuestions([SINGLE_QUESTION], "req-3d", "session-1");

    questionManager.setCustomAnswer(0, "First line\nSecond line");

    expect(questionManager.isCustomAnswerSelected(0)).toBe(false);
    expect(questionManager.getAnswerItems(0)).toEqual(["First line", "Second line"]);
    expect(questionManager.getAllAnswers()).toEqual([
      { question: SINGLE_QUESTION.question, answer: "First line\nSecond line" },
    ]);
  });

  it("sends choice values while the summary keeps the display lines", () => {
    const singleWithValues: Question = {
      question: "Allow web search?",
      header: "search",
      custom: false,
      options: [
        { label: "Allow search via Exa", description: "", value: "allow" },
        { label: "Disable web search", description: "", value: "disable" },
      ],
    };
    const multipleWithValues: Question = {
      question: "Pick colours",
      header: "colours",
      multiple: true,
      custom: true,
      options: [
        { label: "Red", description: "The colour red", value: "r" },
        { label: "Green", description: "Line one\nline two", value: "g" },
      ],
    };
    questionManager.startQuestions(
      [singleWithValues, multipleWithValues],
      "req-values",
      "session-1",
    );

    questionManager.selectOption(0, 1);
    questionManager.selectOption(1, 1);
    questionManager.selectOption(1, 0);
    questionManager.setCustomAnswer(1, "Blue");

    expect(questionManager.getReplyItems(0)).toEqual(["disable"]);
    expect(questionManager.getReplyItems(1)).toEqual(["g", "r", "Blue"]);
    expect(questionManager.getAllAnswers()).toEqual([
      { question: "Allow web search?", answer: "* Disable web search: " },
      {
        question: "Pick colours",
        answer: "* Green: Line one\nline two\n* Red: The colour red\nBlue",
      },
    ]);
  });

  it("sends choices without a value as today's display lines", () => {
    questionManager.startQuestions(
      [SINGLE_QUESTION, MULTIPLE_QUESTION, SINGLE_QUESTION],
      "req-v1",
      "session-1",
    );

    questionManager.selectOption(0, 0);
    questionManager.selectOption(1, 2);
    questionManager.selectOption(1, 0);
    questionManager.setCustomAnswer(1, "Line one\nline two");
    questionManager.setCustomAnswer(2, "First line\nSecond line");

    for (const index of [0, 1, 2]) {
      expect(questionManager.getReplyItems(index)).toEqual(questionManager.getAnswerItems(index));
    }
  });

  it("does not toggle a custom answer that was never entered", () => {
    questionManager.startQuestions([MULTIPLE_QUESTION], "req-3e", "session-1");

    questionManager.toggleCustomAnswer(0);

    expect(questionManager.isCustomAnswerSelected(0)).toBe(false);
    expect(questionManager.hasAnswer(0)).toBe(false);
  });

  it("tracks custom input mode and active message id", () => {
    questionManager.startQuestions([SINGLE_QUESTION, MULTIPLE_QUESTION], "req-3b", "session-1");

    expect(questionManager.getActiveMessageId()).toBeNull();
    expect(questionManager.isWaitingForCustomInput(0)).toBe(false);

    questionManager.setActiveMessageId(123);
    expect(questionManager.isActiveMessage(123)).toBe(true);
    expect(questionManager.isActiveMessage(999)).toBe(false);

    questionManager.startCustomInput(0);
    expect(questionManager.isWaitingForCustomInput(0)).toBe(true);

    questionManager.nextQuestion();
    expect(questionManager.getActiveMessageId()).toBeNull();
    expect(questionManager.isWaitingForCustomInput(0)).toBe(false);
  });

  it("returns copied message IDs and supports cancel/clear", () => {
    questionManager.startQuestions([SINGLE_QUESTION], "req-4", "session-1");
    questionManager.addMessageId(10);
    questionManager.addMessageId(11);

    const messageIds = questionManager.getMessageIds();
    messageIds.push(999);
    expect(questionManager.getMessageIds()).toEqual([10, 11]);

    questionManager.cancel();
    expect(questionManager.isActive()).toBe(false);

    questionManager.clear();
    expect(questionManager.getTotalQuestions()).toBe(0);
    expect(questionManager.getRequestID()).toBeNull();
    expect(questionManager.getCurrentQuestion()).toBeNull();
  });
});
