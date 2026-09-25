import React, { useMemo, useState } from "https://esm.sh/react@19.2.0";
import { createRoot } from "https://esm.sh/react-dom@19.2.0/client";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);
const colors = ["#7656ff", "#ef6548", "#168b78", "#db9f11", "#ca4d96", "#3e76d5", "#7b8f26", "#8e5a3d"];
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function defaultDates() {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);
  return { start: isoDate(start), end: isoDate(end) };
}

function valueFor(project, metric) {
  return metric === "cost" ? project.cost : project.tokens;
}

function formatValue(value, metric) {
  return metric === "cost" ? usd.format(value) : integer.format(value);
}

function aggregateModels(projects) {
  const byName = new Map();
  for (const project of projects) {
    for (const projectModel of project.models) {
      const model = byName.get(projectModel.name) ?? {
        id: `model:${projectModel.name}`,
        name: projectModel.name,
        cost: 0,
        tokens: 0,
        llmSpans: 0,
        dailyByDay: new Map(),
      };
      model.cost += projectModel.cost;
      model.tokens += projectModel.tokens;
      model.llmSpans += projectModel.llmSpans;
      for (const point of projectModel.daily) {
        const day = point.day.slice(0, 10);
        const daily = model.dailyByDay.get(day) ?? { day, cost: 0, tokens: 0, llmSpans: 0 };
        daily.cost += point.cost;
        daily.tokens += point.tokens;
        daily.llmSpans += point.llmSpans;
        model.dailyByDay.set(day, daily);
      }
      byName.set(projectModel.name, model);
    }
  }
  return [...byName.values()].map((model) => ({
    id: model.id,
    name: model.name,
    cost: model.cost,
    tokens: model.tokens,
    llmSpans: model.llmSpans,
    daily: [...model.dailyByDay.values()].sort((left, right) => left.day.localeCompare(right.day)),
  }));
}

function LineChart({ projects, metric }) {
  const width = 920;
  const height = 350;
  const padding = { top: 22, right: 24, bottom: 42, left: 70 };
  const days = [...new Set(projects.flatMap((project) => project.daily.map((point) => point.day.slice(0, 10))))].sort();
  const series = projects.map((project) => new Map(project.daily.map((point) => [point.day.slice(0, 10), metric === "cost" ? point.cost : point.tokens])));
  const max = Math.max(1, ...series.flatMap((points) => days.map((day) => points.get(day) ?? 0)));
  const x = (index) => padding.left + index * ((width - padding.left - padding.right) / Math.max(1, days.length - 1));
  const y = (value) => padding.top + (height - padding.top - padding.bottom) * (1 - value / max);
  const ticks = [0, .25, .5, .75, 1];

  if (!days.length) {
    return html`<div className="empty-chart">No ${metric === "cost" ? "spend" : "token usage"} was recorded in this range.</div>`;
  }

  return html`<div className="plot-wrap"><svg className="plot" viewBox=${`0 0 ${width} ${height}`} role="img" aria-label=${`${metric} over time by project`}>
    ${ticks.map((tick) => html`<g key=${tick}><line x1=${padding.left} x2=${width - padding.right} y1=${y(max * tick)} y2=${y(max * tick)} className="grid-line" /><text x=${padding.left - 12} y=${y(max * tick) + 4} textAnchor="end" className="axis-label">${formatValue(max * tick, metric)}</text></g>`)}
    ${series.map((points, projectIndex) => {
      const path = days.map((day, index) => `${index ? "L" : "M"}${x(index)},${y(points.get(day) ?? 0)}`).join(" ");
      return html`<path key=${projects[projectIndex].id} d=${path} fill="none" stroke=${colors[projectIndex % colors.length]} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />`;
    })}
    <text x=${padding.left} y=${height - 12} className="axis-label">${days[0]}</text><text x=${width - padding.right} y=${height - 12} textAnchor="end" className="axis-label">${days.at(-1)}</text>
  </svg></div>`;
}

function ProjectPicker({ projects, selected, setSelected }) {
  const [open, setOpen] = useState(false);
  const toggle = (id) => setSelected(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  return html`<div className="picker"><button className="secondary compact" type="button" onClick=${() => setOpen(!open)}>Projects <span>${selected.length}/${projects.length} ▾</span></button>
    ${open && html`<div className="picker-menu"><div className="picker-actions"><button type="button" onClick=${() => setSelected(projects.map((project) => project.id))}>All</button><button type="button" onClick=${() => setSelected([])}>None</button></div>${projects.map((project) => html`<label className="check" key=${project.id}><input type="checkbox" checked=${selected.includes(project.id)} onChange=${() => toggle(project.id)} /><span>${project.name}</span></label>`)}</div>`}
  </div>`;
}

function Dashboard({ data }) {
  const [metric, setMetric] = useState("cost");
  const [groupBy, setGroupBy] = useState("project");
  const [selected, setSelected] = useState(data.projects.map((project) => project.id));
  const visible = useMemo(() => data.projects.filter((project) => selected.includes(project.id)), [data, selected]);
  const comparison = useMemo(() => groupBy === "project" ? visible : aggregateModels(visible), [visible, groupBy]);
  const sorted = useMemo(() => [...comparison].sort((a, b) => valueFor(b, metric) - valueFor(a, metric)), [comparison, metric]);
  const total = visible.reduce((sum, project) => sum + valueFor(project, metric), 0);
  const totalSpans = visible.reduce((sum, project) => sum + project.llmSpans, 0);
  const highest = sorted[0];

  function downloadCsv() {
    const label = groupBy === "project" ? "Project" : "Model";
    const rows = [[label, "Estimated cost", "Tokens", "LLM spans"], ...sorted.map((item) => [item.name, item.cost, item.tokens, item.llmSpans])];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = `${data.orgName}-${groupBy}-usage-${data.startDate}-${data.endDate}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return html`<section className="dashboard"><div className="toolbar"><div className="toolbar-toggles"><div className="metric-toggle" aria-label="Metric"><button className=${metric === "cost" ? "active" : ""} onClick=${() => setMetric("cost")}>Estimated spend</button><button className=${metric === "tokens" ? "active" : ""} onClick=${() => setMetric("tokens")}>Tokens consumed</button></div><div className="metric-toggle" aria-label="Compare by"><button className=${groupBy === "project" ? "active" : ""} onClick=${() => setGroupBy("project")}>By project</button><button className=${groupBy === "model" ? "active" : ""} onClick=${() => setGroupBy("model")}>By model</button></div></div><${ProjectPicker} projects=${data.projects} selected=${selected} setSelected=${setSelected} /></div>
    <div className="summary-grid"><article className="stat stat-primary"><span>${metric === "cost" ? "Total estimated spend" : "Total tokens"}</span><strong>${formatValue(total, metric)}</strong><small>${data.startDate} – ${data.endDate}</small></article><article className="stat"><span>Projects selected</span><strong>${visible.length}</strong><small>of ${data.projects.length} projects</small></article><article className="stat"><span>LLM spans</span><strong>${integer.format(totalSpans)}</strong><small>Across selected projects</small></article><article className="stat"><span>Highest usage</span><strong>${formatValue(highest ? valueFor(highest, metric) : 0, metric)}</strong><small>${highest?.name ?? "No project selected"}</small></article></div>
    <article className="panel timeline-panel"><div className="panel-heading"><div><span className="kicker">Daily trend</span><h2>${metric === "cost" ? "Spend" : "Tokens"} per ${groupBy}</h2></div><span className="muted">${comparison.length} lines overlaid</span></div><${LineChart} projects=${comparison} metric=${metric} /><div className="legend">${comparison.map((item, index) => html`<span key=${item.id}><i style=${{ background: colors[index % colors.length] }}></i>${item.name}</span>`)}</div></article>
    <article className="panel table-panel"><div className="panel-heading"><div><span className="kicker">Comparison</span><h2>${groupBy === "project" ? "Project" : "Model"} breakdown</h2></div><button className="secondary compact" type="button" onClick=${downloadCsv}>Download CSV</button></div><div className="table-scroll"><table><thead><tr><th>${groupBy === "project" ? "Project" : "Model"}</th><th>Estimated spend</th><th>Tokens</th><th>LLM spans</th><th>Avg. spend / span</th></tr></thead><tbody>${sorted.map((item) => html`<tr key=${item.id}><td>${item.name}</td><td>${usd.format(item.cost)}</td><td>${integer.format(item.tokens)}</td><td>${integer.format(item.llmSpans)}</td><td>${usd.format(item.llmSpans ? item.cost / item.llmSpans : 0)}</td></tr>`)}</tbody></table></div></article>
  </section>`;
}

function App() {
  const defaults = defaultDates();
  const [org, setOrg] = useState("");
  const [start, setStart] = useState(defaults.start);
  const [end, setEnd] = useState(defaults.end);
  const [data, setData] = useState(null);
  const [status, setStatus] = useState({ kind: "intro", title: "Ready when you are", copy: "Choose an organization and date range. Your service token stays on this server." });
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setData(null);
    setStatus({ kind: "loading", title: "Analyzing project usage", copy: "Loading every project and aggregating daily metrics…" });
    try {
      const response = await fetch(`/api/costs?${new URLSearchParams({ org, start, end })}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to load usage.");
      setData(result);
      setStatus({ kind: "success", title: "Analysis complete", copy: `Compared ${result.projects.length} projects in ${result.orgName}.` });
    } catch (error) {
      setStatus({ kind: "error", title: "Could not load project usage", copy: error instanceof Error ? error.message : "Unknown error" });
    } finally {
      setLoading(false);
    }
  }

  return html`<main><header className="hero"><div><div className="eyebrow"><span className="mark">B</span> Braintrust usage explorer</div><h1>Usage<br /><em>dashboard.</em></h1><p>Compare estimated spend and token consumption across every project in your organization.</p></div><form onSubmit=${submit}><label>Organization<input value=${org} onChange=${(event) => setOrg(event.target.value)} placeholder="acme-inc" autoComplete="organization" required /></label><div className="date-grid"><label>Start date<input type="date" value=${start} max=${end} onChange=${(event) => setStart(event.target.value)} required /></label><label>End date<input type="date" value=${end} min=${start} onChange=${(event) => setEnd(event.target.value)} required /></label></div><button type="submit" disabled=${loading}>${loading ? "Analyzing…" : "Analyze usage"}<span aria-hidden="true">↗</span></button></form></header><section className=${`status ${status.kind}`}><span className="status-icon">${status.kind === "loading" ? "◌" : status.kind === "error" ? "!" : status.kind === "success" ? "✓" : "↳"}</span><div><strong>${status.title}</strong><p>${status.copy}</p></div></section>${data && html`<${Dashboard} key=${`${data.orgName}-${data.startDate}-${data.endDate}`} data=${data} />`}<footer>Costs are estimates based on logged LLM spans and Braintrust model pricing.</footer></main>`;
}

createRoot(document.querySelector("#root")).render(html`<${App} />`);
