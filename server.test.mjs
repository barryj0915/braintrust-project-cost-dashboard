import test from "node:test";
import assert from "node:assert/strict";
import { buildCostQuery, combineProjectCosts, parseProjectList, quoteBtql } from "./server.mjs";

test("parses supported project list response shapes", () => {
  assert.deepEqual(parseProjectList([{ id: "one" }]), [{ id: "one" }]);
  assert.deepEqual(parseProjectList({ objects: [{ id: "two" }] }), [{ id: "two" }]);
  assert.deepEqual(parseProjectList({ projects: [{ id: "three" }] }), [{ id: "three" }]);
});

test("escapes BTQL string literals", () => {
  assert.equal(quoteBtql("project's"), "'project''s'");
  const query = buildCostQuery(["one", "two"], "2026-01-01", "2026-01-31");
  assert.match(query, /project_logs\('one', 'two'/);
  assert.match(query, /created >= '2026-01-01T00:00:00Z'/);
  assert.match(query, /created < '2026-01-31T00:00:00Z' \+ interval 1 day/);
});

test("combines daily rows and preserves projects without spend", () => {
  const projects = [{ id: "one", name: "One" }, { id: "two", name: "Two" }];
  const rows = [
    { project_id: "one", model: "gpt-5", day: "2026-01-01", cost: "1.25", llm_spans: 2, tokens: 100 },
    { project_id: "one", model: "gpt-5", day: "2026-01-02", cost: 0.75, llm_spans: 3, tokens: 200 },
    { project_id: "one", model: "claude", day: "2026-01-02", cost: 0.5, llm_spans: 1, tokens: 50 },
  ];
  const result = combineProjectCosts(projects, rows);
  assert.equal(result[0].cost, 2.5);
  assert.equal(result[0].llmSpans, 6);
  assert.equal(result[0].daily[1].cost, 1.25);
  assert.equal(result[0].models.length, 2);
  assert.equal(result[0].models[0].cost, 2);
  assert.equal(result[1].cost, 0);
});
