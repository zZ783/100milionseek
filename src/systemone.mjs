// Magpie's System One answers, in the shape a classifier has to be read in.
//
// magpie POSTs {model, questions, state} to {baseURL}/systemone and reads back
// {model, answers: {"<question>": {choice, score, confidence}}}. The service
// documents its judge as answering "one probability per question" in the
// vendor's own wording, so this renames numbers into `score` and leaves
// anything already shaped like an answer alone. An unrecognised body passes
// through untouched: a wrong guess about the format is not worth losing the
// vendor's own error.

function scoreOf(value) {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function answerObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // Already what magpie wants: at least one of choice / score / confidence.
  if ("score" in value || "confidence" in value || "choice" in value) return value;
  const probability = scoreOf(value.probability ?? value.p ?? value.value);
  return probability === null ? null : { score: probability };
}

export function normalizeSystemOne(body, questions) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;

  const source = body.answers ?? body.probabilities ?? body.scores ?? body.results;
  if (source === undefined || source === null) return body;

  const answers = {};
  let renamed = false;

  if (Array.isArray(source)) {
    // Either bare numbers, or rows that name their own question.
    for (const [index, row] of source.entries()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        const probability = scoreOf(row);
        const question = Array.isArray(questions) ? questions[index] : undefined;
        if (probability !== null && question !== undefined) {
          answers[String(question)] = { score: probability };
          renamed = true;
        }
        continue;
      }
      const question = row.question ?? row.id ?? row.name;
      const probability = scoreOf(row.probability ?? row.p ?? row.score ?? row.value);
      if (question !== undefined && probability !== null) {
        answers[String(question)] = { score: probability };
        renamed = true;
      }
    }
  } else if (typeof source === "object") {
    for (const [question, value] of Object.entries(source)) {
      const asAnswer = answerObject(value);
      if (asAnswer) {
        answers[question] = asAnswer;
        if (asAnswer !== value) renamed = true;
        continue;
      }
      const probability = scoreOf(value);
      if (probability !== null) {
        answers[question] = { score: probability };
        renamed = true;
      }
    }
  }

  if (!renamed) return body;
  return { ...body, answers };
}
