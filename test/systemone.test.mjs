import test from "node:test";
import assert from "node:assert/strict";

import { normalizeSystemOne } from "../src/systemone.mjs";

test("an answer body that is already in magpie's shape is left as it is", () => {
  const body = {
    model: "jev-1.13-free",
    answers: { "is this a coding task?": { choice: "yes", score: 0.91, confidence: 0.8 } },
  };
  assert.deepEqual(normalizeSystemOne(body, ["is this a coding task?"]), body);
});

test("probability per question becomes a score", () => {
  const body = { model: "jev-1.13-free", answers: { q1: 0.75, q2: 0.1 } };
  const out = normalizeSystemOne(body, ["q1", "q2"]);
  assert.deepEqual(out.answers, { q1: { score: 0.75 }, q2: { score: 0.1 } });
  assert.equal(out.model, "jev-1.13-free");
});

test("the vendor's own probability names are renamed", () => {
  const body = { answers: { q1: { probability: 0.4 }, q2: { p: "0.6" }, q3: { value: 1 } } };
  assert.deepEqual(normalizeSystemOne(body, []).answers, {
    q1: { score: 0.4 },
    q2: { score: 0.6 },
    q3: { score: 1 },
  });
});

test("a bare list of probabilities is paired with the questions asked", () => {
  const body = { answers: [0.2, 0.9] };
  assert.deepEqual(normalizeSystemOne(body, ["a", "b"]).answers, {
    a: { score: 0.2 },
    b: { score: 0.9 },
  });
});

test("rows that name their own question are read by name", () => {
  const body = {
    results: [
      { question: "a", probability: 0.3 },
      { id: "b", score: 0.7 },
      { name: "c", value: 0.5 },
    ],
  };
  assert.deepEqual(normalizeSystemOne(body, []).answers, {
    a: { score: 0.3 },
    b: { score: 0.7 },
    c: { score: 0.5 },
  });
});

test("probability maps under other keys are read too", () => {
  const body = { probabilities: { a: 0.11 } };
  assert.deepEqual(normalizeSystemOne(body, []).answers, { a: { score: 0.11 } });
});

test("an unrecognised body passes through untouched", () => {
  const error = { error: { message: "model_not_found" } };
  assert.deepEqual(normalizeSystemOne(error, ["a"]), error);
  const odd = { answers: { a: { unexpected: true } } };
  assert.deepEqual(normalizeSystemOne(odd, ["a"]), odd);
});

test("a body that is not an object is returned as it came", () => {
  assert.equal(normalizeSystemOne("nope", []), "nope");
  assert.equal(normalizeSystemOne(null, []), null);
  assert.deepEqual(normalizeSystemOne([1, 2], []), [1, 2]);
});
