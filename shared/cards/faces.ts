// The first face is the question and may not be emptied; options keep count and order so `correct` holds.
export interface Face { key: string; label: string; rows: number }

// `rows` is a floor, not a height: the box grows with its content.
export const FACES: Record<string, Face[]> = {
  flashcard: [{ key: "front", label: "the question", rows: 2 }, { key: "back", label: "the answer", rows: 3 }],
  mcq: [{ key: "stem", label: "the question", rows: 2 }, { key: "options", label: "the options", rows: 1 },
        { key: "explanation", label: "the answer", rows: 3 }],
  trick: [{ key: "problem", label: "the question", rows: 2 }, { key: "title", label: "what this is", rows: 1 },
          { key: "cue", label: "when you see", rows: 1 }, { key: "trick", label: "the move", rows: 2 },
          { key: "trap", label: "trap", rows: 2 }, { key: "solution", label: "full solution", rows: 3 }],
};

/** an unknown type is treated as the plain two-sided card */
export const facesOf = (type: unknown): Face[] => FACES[String(type)] || FACES.flashcard;

export const TYPE_LABEL: Record<string, string> = { flashcard: "flashcard", mcq: "multiple choice", trick: "the move" };
