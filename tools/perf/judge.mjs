// A budget line is a ceiling (12), a floor (["min", 1]) or an exact count (["eq", 1]); anything else throws.
const KINDS = {
  max: ["≤", (v, b) => v <= b],
  min: ["≥", (v, b) => v >= b],
  eq: ["=", (v, b) => v === b],
};

/** what `limit` asks of `value`: { ok, bound } (bound as the report prints it) */
export function judge(limit, value) {
  const [kind, bound, ...rest] = Array.isArray(limit) ? limit : ["max", limit];
  if (!KINDS[kind] || typeof bound !== "number" || !Number.isFinite(bound) || rest.length) {
    throw new Error(`a budget is a number, ["min", n] or ["eq", n], not ${JSON.stringify(limit)}`);
  }
  const [sign, holds] = KINDS[kind];
  return { ok: typeof value === "number" && holds(value, bound), bound: `${sign} ${bound}` };
}

export const isFloor = (limit) => Array.isArray(limit) && (limit[0] === "min" || limit[0] === "eq") && limit[1] > 0;
