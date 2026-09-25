# Braintrust project cost dashboard

A lightweight React dashboard that compares estimated LLM spend and token consumption across every project accessible to a Braintrust service token in an organization. It includes project filtering, project/model comparison modes, an overlaid daily time-series plot, custom date ranges, summary cards, and CSV export.

## Run it

Use a service token with read access to every project you want to compare:

```bash
cd examples/project-cost-dashboard
BRAINTRUST_SERVICE_TOKEN="your-service-token" node server.mjs
```

Open `http://localhost:4173`, enter the organization name, and choose a date range. React and the small `htm` JSX alternative are loaded as browser ES modules, so there is no install or build step.

For a self-hosted deployment, also set `BRAINTRUST_API_URL`. To use another local port, set `PORT`.

## How costs are calculated

The server lists all projects in the organization, then sends one BTQL query across their project logs. It sums `estimated_cost()` for LLM spans, which uses a logged estimated cost when available and otherwise uses Braintrust's model pricing. Internal scorer spans are excluded by Braintrust's `estimated_cost()` behavior.

The service token is read from the server environment and is never sent to the browser. No placeholder data is shown when the API is unavailable.

Run the focused tests with `node --test server.test.mjs`.
