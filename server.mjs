import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));
const publicDirectory = join(directory, "public");
const port = Number(process.env.PORT ?? 4173);
const apiUrl = (process.env.BRAINTRUST_API_URL ?? "https://api.braintrust.dev").replace(/\/$/, "");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export function parseProjectList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    if (Array.isArray(value.objects)) {
      return value.objects;
    }
    if (Array.isArray(value.projects)) {
      return value.projects;
    }
  }
  throw new Error("Braintrust returned an unexpected project list response.");
}

export function quoteBtql(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildCostQuery(projectIds, startDate, endDate) {
  const sources = projectIds.map(quoteBtql).join(", ");
  return `SELECT
  project_id,
  COALESCE(metadata.model, 'Unknown model') AS model,
  date_trunc('day', created) AS day,
  sum(COALESCE(estimated_cost(), 0)) AS cost,
  count(1) AS llm_spans,
  sum(COALESCE(metrics.tokens, 0)) AS tokens
FROM project_logs(${sources}, shape => 'spans')
WHERE created >= ${quoteBtql(`${startDate}T00:00:00Z`)}
  AND created < ${quoteBtql(`${endDate}T00:00:00Z`)} + interval 1 day
  AND span_attributes.type = 'llm'
GROUP BY 1, 2, 3
ORDER BY 3 ASC`;
}

function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function combineProjectCosts(projects, rows) {
  const byId = new Map(
    projects.map((project) => [project.id, {
      ...project,
      cost: 0,
      llmSpans: 0,
      tokens: 0,
      dailyByDay: new Map(),
      modelsByName: new Map(),
    }]),
  );

  for (const row of rows) {
    const project = byId.get(row.project_id);
    if (!project) {
      continue;
    }
    const values = {
      day: String(row.day),
      cost: numberValue(row.cost),
      llmSpans: numberValue(row.llm_spans),
      tokens: numberValue(row.tokens),
    };
    project.cost += values.cost;
    project.llmSpans += values.llmSpans;
    project.tokens += values.tokens;

    const day = values.day.slice(0, 10);
    const daily = project.dailyByDay.get(day) ?? { day, cost: 0, llmSpans: 0, tokens: 0 };
    daily.cost += values.cost;
    daily.llmSpans += values.llmSpans;
    daily.tokens += values.tokens;
    project.dailyByDay.set(day, daily);

    const modelName = typeof row.model === "string" ? row.model : "Unknown model";
    const model = project.modelsByName.get(modelName) ?? {
      name: modelName,
      cost: 0,
      llmSpans: 0,
      tokens: 0,
      dailyByDay: new Map(),
    };
    model.cost += values.cost;
    model.llmSpans += values.llmSpans;
    model.tokens += values.tokens;
    const modelDaily = model.dailyByDay.get(day) ?? { day, cost: 0, llmSpans: 0, tokens: 0 };
    modelDaily.cost += values.cost;
    modelDaily.llmSpans += values.llmSpans;
    modelDaily.tokens += values.tokens;
    model.dailyByDay.set(day, modelDaily);
    project.modelsByName.set(modelName, model);
  }

  return [...byId.values()].map((project) => ({
    id: project.id,
    name: project.name,
    cost: project.cost,
    llmSpans: project.llmSpans,
    tokens: project.tokens,
    daily: [...project.dailyByDay.values()].sort((left, right) => left.day.localeCompare(right.day)),
    models: [...project.modelsByName.values()].map((model) => ({
      name: model.name,
      cost: model.cost,
      llmSpans: model.llmSpans,
      tokens: model.tokens,
      daily: [...model.dailyByDay.values()].sort((left, right) => left.day.localeCompare(right.day)),
    })),
  })).sort((left, right) => right.cost - left.cost);
}

async function braintrustFetch(path, token, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Braintrust request failed (${response.status}): ${detail || response.statusText}`);
  }
  return response.json();
}

async function loadProjects(orgName, token) {
  const projects = [];
  let cursor;

  do {
    const params = new URLSearchParams({ org_name: orgName, limit: "100" });
    if (cursor) {
      params.set("cursor", cursor);
    }
    const response = await braintrustFetch(`/v1/project?${params}`, token);
    projects.push(...parseProjectList(response));
    cursor = response && typeof response === "object" && typeof response.cursor === "string"
      ? response.cursor
      : undefined;
  } while (cursor);

  return projects.filter(
    (project) => project && typeof project.id === "string" && typeof project.name === "string",
  );
}

async function handleCosts(request, response) {
  const token = process.env.BRAINTRUST_SERVICE_TOKEN;
  if (!token) {
    sendJson(response, 500, {
      error: "Set BRAINTRUST_SERVICE_TOKEN before starting the dashboard.",
    });
    return;
  }

  const url = new URL(request.url, "http://localhost");
  const orgName = url.searchParams.get("org")?.trim();
  const startDate = url.searchParams.get("start") ?? "";
  const endDate = url.searchParams.get("end") ?? "";
  if (!orgName) {
    sendJson(response, 400, { error: "Organization name is required." });
    return;
  }
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const rangeDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (!datePattern.test(startDate) || !datePattern.test(endDate)) {
    sendJson(response, 400, { error: "Start and end dates are required." });
    return;
  }
  if (!Number.isFinite(rangeDays) || rangeDays < 1 || rangeDays > 366) {
    sendJson(response, 400, { error: "Date range must be between 1 and 366 days." });
    return;
  }

  try {
    const projects = await loadProjects(orgName, token);
    if (projects.length === 0) {
      sendJson(response, 200, { projects: [], totalCost: 0, startDate, endDate, orgName });
      return;
    }
    const query = buildCostQuery(projects.map((project) => project.id), startDate, endDate);
    const result = await braintrustFetch("/btql", token, {
      method: "POST",
      body: JSON.stringify({ query, use_brainstore: true, brainstore_realtime: true }),
    });
    const rows = Array.isArray(result.data) ? result.data : [];
    const costs = combineProjectCosts(projects, rows);
    sendJson(response, 200, {
      projects: costs,
      totalCost: costs.reduce((sum, project) => sum + project.cost, 0),
      startDate,
      endDate,
      orgName,
    });
  } catch (error) {
    sendJson(response, 502, {
      error: error instanceof Error ? error.message : "Unable to load Braintrust costs.",
    });
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function serveStatic(request, response) {
  const url = new URL(request.url, "http://localhost");
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(pathname) || pathname.includes("..")) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const file = await readFile(join(publicDirectory, pathname));
    response.writeHead(200, { "Content-Type": contentTypes[extname(pathname)] ?? "application/octet-stream" });
    response.end(file);
  } catch {
    response.writeHead(404).end("Not found");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createServer(async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/costs")) {
      await handleCosts(request, response);
      return;
    }
    if (request.method === "GET") {
      await serveStatic(request, response);
      return;
    }
    response.writeHead(405).end("Method not allowed");
  }).listen(port, "0.0.0.0", () => {
    process.stdout.write(`Project cost dashboard: http://localhost:${port}\n`);
  });
}
