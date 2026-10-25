# DARK GRID

DARK GRID is an interactive, deterministic simulation of robotaxi remote operations during a citywide disruption. It runs two versions of the same scenario side by side: a **FIFO** dispatch queue and **DARK GRID** impact-based triage. Compare how operator decisions affect waiting requests, blocked vehicles, and an ambulance route.

> This is a simulation and demonstration, not a live dispatch system. Vehicle behavior and operational values are assumed model inputs, not real-world measurements.

## What it does

- Simulates 250 robotaxis and an ambulance on either a San Francisco road network or a synthetic test grid.
- Runs FIFO and DARK GRID from the same seed, so their dispatch policies can be compared under the same conditions.
- Injects a blackout that creates dark-intersection help requests and an ambulance route.
- Prioritizes DARK GRID jobs by impact relative to handling time (weighted shortest processing time), including batching compatible requests at the same intersection.
- Lets you switch between automatic operators and a manual judge, inspect the request queue, and approve the zone policy.
- Shows request volume, operator load, stuck vehicles, blocking vehicle-minutes, and a live FIFO-versus-DARK-GRID request chart.
- Analyzes a typed incident report with Claude when configured, or with built-in offline rules when no API key is available.

The current map is rendered as an SVG from the road graph; it does not require a Google Maps key. The incident analyzer currently applies **outage** events to the simulation. Demand-surge and communications-degradation reports can be analyzed, but do not yet change simulated traffic.

## Requirements

- Node.js **20.9 or later**
- npm

## Run locally

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

To enable Claude incident analysis, copy `.env.example` to `.env.local`, then set `ANTHROPIC_API_KEY`. `ANTHROPIC_MODEL` is optional; when omitted, the API route uses its configured default model. Without a key, incident analysis uses offline rules. Restart the development server after changing environment variables.

`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` and `NEXT_PUBLIC_GOOGLE_MAP_ID` are included in the example environment file for a possible future map integration, but are not used by the current SVG map.

## Using the demo

1. Choose **San Francisco** or **Test Grid** from the Environment selector.
2. The simulation starts automatically. Use **Pause**, **Resume**, or **Reset** to control the run.
3. Select **Blackout** to inject the same outage into both simulations.
4. Switch between FIFO and DARK GRID, or enable **Split view** to see both maps together.
5. Select **Judge takes over** to manually answer requests in FIFO; **Dark Grid on** switches the judge to the DARK GRID queue. **Auto operators** returns dispatch to automatic mode.
6. Use **Event injector** to analyze a preset or your own incident description. Only an outage currently injects an event into the simulation.
7. Use **Ask why** to inspect why a queued job is prioritized. Voice input is available in browsers that support the Web Speech API.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Create a production build |
| `npm run start` | Serve the production build |
| `npm run lint` | Run ESLint |
| `npm test` | Run the Vitest test suite |
| `npm run check` | Generate Next.js types, run TypeScript checks, and run tests |

## Road network data

The San Francisco environment loads the checked-in graph at `public/data/soma_roads.json`. It contains a directed OpenStreetMap road network and points of interest for the simulator. The Test Grid is generated in code and does not need downloaded map data.

To regenerate the San Francisco graph, install OSMnx 2.x and run:

```bash
python -m pip install "osmnx>=2,<3"
python scripts/export_roads.py
```

The exporter retrieves data through OSMnx/Overpass and validates the graph and selected points of interest before writing the output. Network access is required. OpenStreetMap data is available under the [Open Database License (ODbL)](https://www.openstreetmap.org/copyright); attribution is included with the export process.

## Project structure

```text
src/
  app/
    api/analyze-chaos/  Incident analysis API route
    page.tsx            Simulation UI and controls
    globals.css         DARK GRID theme
  components/           Incident analysis, queue explanation, and chart components
  lib/
    config.ts           Simulation constants and assumed values
    dispatch.ts         Triage scoring, batching, and job ordering
    graph.ts            Road-graph validation and routing
    hungarian.ts        Assignment algorithm
    sim.ts              Deterministic simulation engine
  types/sim.ts          Shared simulation types
public/data/
  soma_roads.json       San Francisco road graph
scripts/
  export_roads.py       OSM road graph exporter
```

Simulation assumptions and tunable values are centralized in `src/lib/config.ts`.
