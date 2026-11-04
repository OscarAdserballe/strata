// Older decks may use retired MCQ shapes; flatten them at the boundary so the app speaks only front/back.

export function asFlashcard(type: unknown, card: Record<string, unknown>): Record<string, unknown> {
  const kind = String(type || "flashcard").toLowerCase();
  if (kind === "mcq") {
    const {
      stem, options, correct, explanation,
      ...rest
    } = card;
    const choices = Array.isArray(options) ? options.map(String) : [];
    const answer = typeof correct === "number" && Number.isInteger(correct) ? choices[correct] || "" : "";
    return {
      ...rest,
      // A front/back patch means the user has edited this card after it was flattened.
      front: String(card.front || stem || "").trim(),
      back: String(card.back || [answer, String(explanation || "").trim()].filter(Boolean).join("\n\n")).trim(),
    };
  }
  if (kind === "trick") {
    const {
      problem, topic: _topic, title, cue: _cue, trick, trap: _trap, solution,
      ...rest
    } = card;
    return {
      ...rest,
      front: String(card.front || problem || "").trim(),
      back: String(card.back || solution || trick || title || "").trim(),
    };
  }
  return { ...card, front: String(card.front || "").trim(), back: String(card.back || "").trim() };
}
