# DARK GRID

DARK GRID is a deterministic, interactive simulation of robotaxi remote operations during city disruptions. It runs two copies of the same scenario side by side: a **FIFO** dispatch queue and **DARK GRID** impact-based triage. Compare how the dispatch policies affect requests, blocked vehicles, and an ambulance mission.

> **Simulation only.** DARK GRID is a prototype and demonstration, not a live dispatch system. Vehicle behavior, operator capacity, incident timing, and other operational values are model assumptions—not real-world measurements. Civilian traffic on the 3D map is visual only and does not affect simulation metrics.

## Features

- Simulates 250 robotaxis and a separately modeled ambulance on a San Francisco road network or a generated test grid.
- Runs FIFO and DARK GRID from the same seed and delivers the same injected outage or collision to both runs.
- Schedules a seeded blackout scenario; you can also trigger an outage or inject road collisions from the interface.
- Prioritizes DARK GRID requests by weighted impact per handling time (WSPT) and batches compatible dark-signal requests at the same intersection.
- Supports automatic operators and manual judging, including a human-approved zone policy that treats dark signals as four-way stops.
- Models ambulance routing, corridor reservations and vehicle yielding, road closures and recovery, and vehicle staging.
- Shows queue and operator metrics, a FIFO-versus-DARK-GRID comparison, and a rewindable simulation timeline.
- Provides incident analysis with Claude when configured, or offline keyword rules without an API key. Outages and collisions can affect a live run; demand-surge and communications-degradation results are currently analysis only.
- Renders a deck.gl 3D tactical map with vehicle models, traffic, buildings, and the ambulance route. Use optional Google photorealistic 3D tiles or the OpenStreetMap building model; an SVG map is available as a fallback if the 3D renderer cannot start.

## Requirements

- Node.js **20.9 or later**
- npm

## Run locally

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Optional integrations

Copy `.env.example` to `.env.local` and set only the keys for the integrations you want:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enables Claude incident analysis. If unset or the Claude request fails, the analyzer uses offline rules. |
| `ANTHROPIC_MODEL` | Optional model override for incident analysis. |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Enables the **Photo** city model using Google Maps 3D Tiles. Without it, use the **Blocks** model. |

`NEXT_PUBLIC_GOOGLE_MAP_ID` is present in `.env.example` for a possible future integration but is not currently read by the application. Restart the development server after changing environment variables. The core simulation and offline incident analysis do not require API keys.

## Using the demo

1. Choose **Downtown SF**, **SoMa / Mission**, or **Test Grid** from the environment selector.
2. The paired simulations start automatically. Pause, resume, reset, or create a new seeded scenario from the session controls.
3. Trigger a blackout to apply the same outage to both simulations. Use the **Requests** view to compare queues, take over as a judge, or return to automatic operators.
4. On DARK GRID, review the zone-policy card and approve it to treat dark signals as four-way stops. Automatic operators do not approve this policy.
5. Inject collisions using the scenario controls or analyze a collision description. The road remains closed until the modeled recovery finishes.
6. Open **Compare** to inspect the paired runs and metrics. Use the timeline to rewind recorded simulation state, then select **LIVE** to return to the active run.
7. Open **Analyze** to submit an incident description or ask why a dispatch job is ranked where it is. Voice input for “Ask why” depends on browser Web Speech API support.
8. Use **Follow ambulance** to track the rescue mission. The camera controls let you rotate, zoom, and reset the map view.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Create a production build |
| `npm run start` | Serve the production build |
| `npm run lint` | Run ESLint |
| `npm test` | Run the Vitest test suite |
| `npm run check` | Generate Next.js types, run TypeScript checks, and run tests |

## Maps and road data

The San Francisco environments use checked-in road graphs:

- `public/data/downtown_roads.json` — Downtown / Financial District area
- `public/data/soma_roads.json` — SoMa / Mission area

The **Test Grid** graph is generated in the simulator and requires no downloaded map data. The 3D map also uses the checked-in building and ground-height data in `public/data/`, plus the robotaxi and ambulance models in `public/models/`. Google 3D Tiles are an optional online background; the bundled OpenStreetMap-based city model works without a Google key.

To regenerate the SoMa / Mission road graph, install OSMnx 2.x and run:

```bash
python -m pip install "osmnx>=2,<3"
python scripts/export_roads.py
```

This exporter retrieves road and point-of-interest data through OSMnx/Overpass and validates the graph before writing it. Network access is required. The other San Francisco map assets are checked in; `scripts/fetch-ground.mjs` can regenerate the ground-height data using OpenTopoData and also requires network access.

OpenStreetMap data is available under the [Open Database License (ODbL)](https://www.openstreetmap.org/copyright). The map displays source attribution.

## Project structure

```text
src/
  app/
    api/analyze-chaos/route.ts  Incident analysis API (Claude and offline rules)
    page.tsx                    Simulation lifecycle and workspace views
    globals.css                 Application theme and layout
  components/
    TacticalMap3D.tsx           3D city, vehicles, and map controls
    ChaosInjectorPanel.tsx      Incident analysis and event injection
    AskWhyBar.tsx               Dispatch-priority explanations
    MetricsChart.tsx            FIFO/DARK GRID comparison chart
    TimelineScrubber.tsx        Recorded-history playback controls
    civilianTraffic.ts          Visual-only civilian traffic
  lib/
    config.ts                   Simulation constants and assumptions
    dispatch.ts                 Triage scoring, batching, and job ordering
    graph.ts                    Road-graph validation and routing
    hungarian.ts                Minimum-cost assignment
    history.ts                  Bounded simulation history
    sim.ts                      Deterministic simulation engine
  types/sim.ts                  Shared simulation types
  mock/snapshot.ts              Example simulation snapshot
public/
  data/                         Road graphs, building footprints, and ground heights
  models/                       Robotaxi and ambulance models
scripts/
  export_roads.py               SoMa / Mission road-graph exporter
  fetch-ground.mjs              Ground-height data fetcher
  build-car-models.mjs          Vehicle-model generator
```

The simulation assumptions and tunable values are centralized in `src/lib/config.ts`. Tests for dispatch, graph routing, history, and assignment are alongside their implementations in `src/lib/`.
