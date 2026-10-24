// src/mock/snapshot.ts
// Mock data for the UI. Matches the REAL src/types/sim.ts

import type {
  SimSnapshot,
  Vehicle,
  Job,
  Ambulance,
  LatLng,
  ChartPoint,
  Policy,
  Metrics,
} from '@/types/sim';

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const CENTER: LatLng = { lat: 37.777, lng: -122.405 };

function makeDarkNodes(n = 47): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const ring = Math.floor(i / 8) + 1;
    const ang = (i % 8) * (Math.PI / 4) + ring * 0.3;
    const r = 0.0011 * ring;
    out.push({
      lat: CENTER.lat + Math.sin(ang) * r,
      lng: CENTER.lng + Math.cos(ang) * r,
    });
  }
  return out;
}

const CORRIDOR: LatLng[] = [
  { lat: 37.7825, lng: -122.4045 },
  { lat: 37.7801, lng: -122.4058 },
  { lat: 37.7779, lng: -122.4071 },
  { lat: 37.7752, lng: -122.4083 },
  { lat: 37.7724, lng: -122.4091 },
  { lat: 37.7698, lng: -122.4098 },
  { lat: 37.7671, lng: -122.4106 },
];

const FIRE_STATION: LatLng = CORRIDOR[0];
const HOSPITAL: LatLng = CORRIDOR[CORRIDOR.length - 1];

const LOTS = [
  { pos: { lat: 37.7800, lng: -122.4010 }, used: 18, cap: 40 },
  { pos: { lat: 37.7745, lng: -122.4120 }, used: 31, cap: 50 },
  { pos: { lat: 37.7710, lng: -122.4065 }, used: 9, cap: 30 },
];

const OPERATORS = [
  { id: 'op-1', task: 'BATCH · corridor' },
  { id: 'op-2', task: 'STUCK · box' },
  { id: 'op-3', task: 'SIGNAL · confirm' },
  { id: 'op-4', task: 'idle' },
  { id: 'op-5', task: 'idle' },
];

// NOTE: real sim.ts types this as number[] (node IDs), not street names.
const POLICY: Policy = {
  dispatch: 'WSPT_TRIAGE',
  batchMax: 6,
  darkSignalsAsFourWayStop: [101, 204, 318, 422],
  triageWeights: {
    onCorridor: 5,
    insideBox: 4,
    perQueuedBehind: 1.5,
    passenger: 2,
  },
};

// ---------------------------------------------------------------------------
// Vehicles — real Vehicle requires headingDeg.
// ---------------------------------------------------------------------------

function makeVehicles(): Vehicle[] {
  const vs: Vehicle[] = [];
  for (let i = 0; i < 24; i++) {
    const base = CORRIDOR[i % CORRIDOR.length];
    const jitterLat = ((i * 7) % 9 - 4) * 0.00012;
    const jitterLng = ((i * 5) % 11 - 5) * 0.00012;
    const states: Vehicle['state'][] = [
      'DRIVING',
      'REQUESTING_HELP',
      'QUEUED_BEHIND',
      'STAGED',
    ];
    const types: Vehicle['type'][] = ['PASSENGER', 'EMPTY', 'PASSENGER'];
    vs.push({
      id: i + 1,
      pos: { lat: base.lat + jitterLat, lng: base.lng + jitterLng },
      headingDeg: (i * 37) % 360,
      state: states[i % states.length],
      type: types[i % types.length],
    });
  }
  return vs;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

function fifoJobs(): Job[] {
  return [
    {
      id: 'j-f1',
      kind: 'FIFO',
      requestIds: ['r-101'],
      vehicleIds: [3],
      w: 1,
      p: 0.8,
      createdAt: 12,
      title: 'DARK_SIGNAL_CONFIRM · 4th & Brannan',
      sub: 'oldest request · no triage',
      breakdown: [
        { label: 'on corridor', value: 1 },
        { label: 'inside box', value: 0 },
        { label: 'queued behind', value: 0 },
      ],
    },
    {
      id: 'j-f2',
      kind: 'FIFO',
      requestIds: ['r-102'],
      vehicleIds: [7],
      w: 1,
      p: 0.9,
      createdAt: 13,
      title: 'STUCK · 3rd & Townsend',
      sub: 'oldest-first · blocking',
      breakdown: [
        { label: 'on corridor', value: 0 },
        { label: 'inside box', value: 1 },
        { label: 'queued behind', value: 3 },
      ],
    },
    {
      id: 'j-f3',
      kind: 'FIFO',
      requestIds: ['r-103'],
      vehicleIds: [11],
      w: 1,
      p: 0.7,
      createdAt: 14,
      title: 'DARK_SIGNAL_CONFIRM · 2nd & Folsom',
      sub: 'oldest-first',
      breakdown: [
        { label: 'on corridor', value: 0 },
        { label: 'inside box', value: 0 },
        { label: 'queued behind', value: 1 },
      ],
    },
    {
      id: 'j-f4',
      kind: 'FIFO',
      requestIds: ['r-104'],
      vehicleIds: [15],
      w: 1,
      p: 1.0,
      createdAt: 15,
      title: 'STUCK · Howard & 7th',
      sub: 'oldest-first · blocking',
      breakdown: [
        { label: 'on corridor', value: 1 },
        { label: 'inside box', value: 1 },
        { label: 'queued behind', value: 5 },
      ],
    },
  ];
}

function darkgridJobs(): Job[] {
  return [
    {
      id: 'j-d1',
      kind: 'CORRIDOR',
      requestIds: ['r-201', 'r-202'],
      vehicleIds: [4, 9],
      w: 9,
      p: 1.0,
      createdAt: 10,
      title: 'CORRIDOR · 4th & Brannan',
      sub: 'on-corridor + passenger · clear first',
      breakdown: [
        { label: 'on corridor', value: 1 },
        { label: 'inside box', value: 1 },
        { label: 'queued behind', value: 4 },
      ],
    },
    {
      id: 'j-d2',
      kind: 'BATCH',
      requestIds: ['r-203', 'r-204', 'r-205'],
      vehicleIds: [6, 13, 17],
      w: 8,
      p: 1.2,
      createdAt: 11,
      title: 'BATCH · 3rd & Townsend',
      sub: '3 identical signal confirms · 1 operator decision',
      breakdown: [
        { label: 'on corridor', value: 1 },
        { label: 'inside box', value: 0 },
        { label: 'queued behind', value: 2 },
      ],
    },
    {
      id: 'j-d3',
      kind: 'STUCK',
      requestIds: ['r-206'],
      vehicleIds: [8],
      w: 7,
      p: 1.1,
      createdAt: 12,
      title: 'STUCK · Howard & 7th',
      sub: 'blocking box · pull over',
      breakdown: [
        { label: 'on corridor', value: 0 },
        { label: 'inside box', value: 1 },
        { label: 'queued behind', value: 5 },
      ],
    },
    {
      id: 'j-d4',
      kind: 'BATCH',
      requestIds: ['r-207', 'r-208'],
      vehicleIds: [12, 20],
      w: 6,
      p: 1.3,
      createdAt: 13,
      title: 'BATCH · 2nd & Folsom',
      sub: '2 signal confirms batched',
      breakdown: [
        { label: 'on corridor', value: 0 },
        { label: 'inside box', value: 0 },
        { label: 'queued behind', value: 1 },
      ],
    },
    {
      id: 'j-d5',
      kind: 'SINGLE',
      requestIds: ['r-209'],
      vehicleIds: [22],
      w: 3,
      p: 0.9,
      createdAt: 14,
      title: 'SIGNAL · confirm · empty car',
      sub: 'no passenger · low risk',
      breakdown: [
        { label: 'on corridor', value: 0 },
        { label: 'inside box', value: 0 },
        { label: 'queued behind', value: 0 },
      ],
    },
    {
      id: 'j-d6',
      kind: 'SINGLE',
      requestIds: ['r-210'],
      vehicleIds: [24],
      w: 2,
      p: 1.0,
      createdAt: 15,
      title: 'SIGNAL · confirm · parked',
      sub: 'already pulled over · defer',
      breakdown: [
        { label: 'on corridor', value: 0 },
        { label: 'inside box', value: 0 },
        { label: 'queued behind', value: 0 },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Ambulance
// ---------------------------------------------------------------------------

function fifoAmbulance(): Ambulance {
  return { pos: CORRIDOR[2], headingDeg: 200, status: 'STUCK', tripS: 0 };
}

function darkgridAmbulance(): Ambulance {
  return { pos: HOSPITAL, headingDeg: 200, status: 'ARRIVED', tripS: 250 };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const FIFO_METRICS: Metrics = {
  requests: 232,
  jobs: 232,
  lambdaPerMin: 58,
  rho: 6.2,
  blockingVehMin: 1842,
  stuck: 96,
  darkCount: 47,
  ambulanceTripS: null,
};

const DARKGRID_METRICS: Metrics = {
  requests: 52,
  jobs: 6,
  lambdaPerMin: 9,
  rho: 0.72,
  blockingVehMin: 296,
  stuck: 7,
  darkCount: 47,
  ambulanceTripS: 250,
};

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export const fifoSnapshot: SimSnapshot = {
  t: 390,
  mode: 'FIFO',
  control: 'AUTO',
  manual: { reviewingJobId: null, lockRemainingS: 0, answered: 0 },
  vehicles: makeVehicles(),
  ambulance: fifoAmbulance(),
  darkNodes: makeDarkNodes(),
  corridor: CORRIDOR,
  lots: LOTS,
  jobs: fifoJobs(),
  operators: OPERATORS,
  metrics: FIFO_METRICS,
  policy: { ...POLICY, dispatch: 'FIFO' },
};

export const darkgridSnapshot: SimSnapshot = {
  t: 390,
  mode: 'DARKGRID',
  control: 'AUTO',
  manual: { reviewingJobId: null, lockRemainingS: 0, answered: 0 },
  vehicles: makeVehicles(),
  ambulance: darkgridAmbulance(),
  darkNodes: makeDarkNodes(),
  corridor: CORRIDOR,
  lots: LOTS,
  jobs: darkgridJobs(),
  operators: OPERATORS,
  metrics: DARKGRID_METRICS,
  policy: POLICY,
};

export const manualSnapshot: SimSnapshot = {
  ...darkgridSnapshot,
  control: 'MANUAL',
  manual: { reviewingJobId: 'j-d1', lockRemainingS: 6, answered: 3 },
};

// ---------------------------------------------------------------------------
// Chart data
// ---------------------------------------------------------------------------

export const chartData: ChartPoint[] = [
  { t: 0.0, fifo: 0, darkgrid: 0 },
  { t: 0.5, fifo: 18, darkgrid: 6 },
  { t: 1.0, fifo: 46, darkgrid: 11 },
  { t: 1.5, fifo: 88, darkgrid: 15 },
  { t: 2.0, fifo: 134, darkgrid: 18 },
  { t: 2.5, fifo: 171, darkgrid: 20 },
  { t: 3.0, fifo: 198, darkgrid: 21 },
  { t: 3.5, fifo: 214, darkgrid: 22 },
  { t: 4.0, fifo: 223, darkgrid: 22 },
  { t: 4.5, fifo: 228, darkgrid: 23 },
  { t: 5.0, fifo: 230, darkgrid: 23 },
  { t: 5.5, fifo: 231, darkgrid: 23 },
  { t: 6.0, fifo: 232, darkgrid: 23 },
  { t: 6.5, fifo: 232, darkgrid: 23 },
];

export const snapshotById = {
  FIFO: fifoSnapshot,
  DARKGRID: darkgridSnapshot,
  MANUAL: manualSnapshot,
} as const;

export { CENTER, FIRE_STATION, HOSPITAL, CORRIDOR };

