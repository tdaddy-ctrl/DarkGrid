// src/types/sim.ts — shared by the whole team. Owner: person A. Nobody else edits it.
// Units, everywhere: time = SIM seconds since the blackout starts (not wall-clock, not ms);
// distance = meters; angles = degrees, 0 = north, clockwise.

export type LatLng = { lat: number; lng: number };

export type RoadNode = { id: number; lat: number; lng: number; x: number; y: number }; // x,y = meters from center
// oneway = true: drivable only from -> to. oneway = false: drivable both ways.
export type RoadEdge = { id: number; from: number; to: number; lengthM: number; oneway: boolean; geometry?: LatLng[] };
export type RoadGraph = {
  center: LatLng;
  nodes: RoadNode[];
  edges: RoadEdge[];
  pois: { fireStation: LatLng; hospital: LatLng; lots: LatLng[] };
};

export type VehicleState = 'DRIVING' | 'REQUESTING_HELP' | 'QUEUED_BEHIND' | 'STAGED' | 'ARRIVED' | 'YIELDING' | 'YIELDED';
// The ambulance is NOT in vehicles[]; it lives only in SimSnapshot.ambulance.
export type Vehicle = { id: number; pos: LatLng; headingDeg: number; state: VehicleState;
                        type: 'PASSENGER' | 'EMPTY'; road?: RoadMotion };

// Directed street geometry lets the renderer interpolate through bends and intersections.
export type RoadMotion = { laneId: number; from: number; to: number; shape: LatLng[] };

// Why a vehicle asked for help. Only MISSING_OUTAGE_INFO is answered by shared outage information
// (a zone policy); every other cause needs its own handling. The sim maps MISSING_OUTAGE_INFO to
// reason DARK_SIGNAL_CONFIRM (batchable per intersection) and every other cause to reason STUCK.
export type HelpCause =
  | 'MISSING_OUTAGE_INFO'   // dark signal, the vehicle cannot confirm it is an outage
  | 'SIGHTLINE_OCCLUDED'    // dark signal, this approach cannot see cross traffic
  | 'PRIORITY_AMBIGUOUS'    // four-way stop deadlock: every waiting vehicle has one on its right
  | 'EXIT_BLOCKED'          // no room past the intersection for too long
  | 'INCIDENT'              // the next road is closed and no detour exists
  | 'VEHICLE_FAULT'         // scheduled fault: stopped in its lane
  | 'CORRIDOR_BLOCKED'      // asked to clear the ambulance corridor and unable to
  | 'STUCK';                // stopped in traffic for STUCK_TIMEOUT_S

export type HelpRequest = {
  id: string; vehicleId: number; nodeId: number;
  reason: 'DARK_SIGNAL_CONFIRM' | 'STUCK';
  createdAt: number; onCorridor: boolean; insideBox: boolean;
  queuedBehind: number; passenger: boolean;
  cause?: HelpCause;
};

// Jobs are sorted by w / p, highest first (WSPT). In FIFO mode they are sorted by createdAt.
// ZONE_POLICY: DARK GRID only, added by the sim (not orderJobs) at the top of the queue after
// an outage. Only a human approves it (automatic operators skip it). Approving shares outage
// information for the dark signals in its area for ZONE_POLICY_TTL_S; it answers only
// MISSING_OUTAGE_INFO requests there. requestIds is empty.
export type Job = {
  id: string; kind: 'BATCH' | 'CORRIDOR' | 'STUCK' | 'SINGLE' | 'FIFO' | 'ZONE_POLICY' | 'COLLISION';
  incidentId?: string;
  requestIds: string[]; vehicleIds: number[];
  w: number;          // weight: how much answering this job helps (sum of triage weights)
  p: number;          // expected operator handling time, seconds
  createdAt: number;
  title: string; sub: string;
  breakdown: { label: string; value: number }[];   // how w was computed, shown in the UI
};

export type Policy = {
  dispatch: 'FIFO' | 'WSPT_TRIAGE';   // SimSnapshot.mode 'FIFO' <=> 'FIFO', 'DARKGRID' <=> 'WSPT_TRIAGE'
  batchMax: number;
  darkSignalsAsFourWayStop: number[]; // RoadNode ids
  triageWeights: { onCorridor: number; insideBox: number; perQueuedBehind: number; passenger: number };
};

export type Metrics = {
  requests: number; jobs: number; lambdaPerMin: number; rho: number;
  blockingVehMin: number; stuck: number; darkCount: number;
  ambulanceTripS: number | null;
  createdByCause?: Partial<Record<HelpCause, number>>;   // requests raised since the start
  openByCause?: Partial<Record<HelpCause, number>>;      // requests waiting now
};

export type ControlMode = 'AUTO' | 'MANUAL';   // MANUAL = a judge answers requests by clicking
export type CameraMode = 'OVERVIEW' | 'FOLLOW_AMBULANCE';   // UI only; the sim never reads it

export type Ambulance = {
  pos: LatLng; headingDeg: number;
  status: 'WAITING' | 'EN_ROUTE' | 'STUCK' | 'ARRIVED';
  tripS: number;                                 // seconds since dispatch
  road?: RoadMotion;
  mission?: {
    origin: LatLng; pickup: LatLng; hospital: LatLng;
    phase: 'TO_PICKUP' | 'PICKING_UP' | 'TO_HOSPITAL' | 'DELIVERED';
    pickupStartedAt: number | null; pickupCompleteAt: number | null;
  };
};

export type LotState = { pos: LatLng; used: number; cap: number };

// Injected scenario incidents, separate from both the robotaxi fleet and visual civilian cars.
export type CollisionIncident = {
  id: string; edgeId: number; pos: LatLng; headingDeg: number; createdAt: number;
  status: 'BLOCKED' | 'RESPONDING' | 'CLEARED'; clearanceS: number; clearAt: number | null;
};
// CLEAR goes to a vehicle on the reserved road: SENT -> ACKNOWLEDGED -> EXECUTING -> CLEARED, or
// UNABLE -> ESCALATED (an operator request). CLEARED means the vehicle is physically off the reserved road.
// REROUTE goes only to vehicles whose route used the reserved road: SENT -> REROUTED, or UNABLE.
export type YieldCommand = {
  vehicleId: number; edgeId: number; issuedAt: number; epoch: number;
  kind: 'CLEAR' | 'REROUTE';
  state: 'SENT' | 'ACKNOWLEDGED' | 'EXECUTING' | 'CLEARED' | 'REROUTED' | 'UNABLE' | 'ESCALATED';
  reason: string; requestId?: string;
};
export type CorridorStatus = {
  active: boolean; commands: YieldCommand[]; epoch: number; ambulanceReroutes: number;
  segments: { edgeId: number; from: LatLng; to: LatLng; shape?: LatLng[]; state: 'RESERVED' | 'CLEARING' | 'CLEAR' }[];
};
// A human-approved zone policy: shared outage information for the dark signals in its area, until it
// expires, power returns to the whole area, or a human revokes it. Vehicles still check conflicts,
// box occupancy and exit room under it.
export type ZonePolicyState = {
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  areaNodes: number; approvedAt: number; expiresAt: number;
  endedAt: number | null; endReason: 'EXPIRED' | 'POWER_RESTORED' | 'MANUAL' | null;
};
export type OutageState = {
  center: LatLng; radiusM: number; startedAt: number; restoreAt: number | null; restoredAt: number | null;
  status: 'ACTIVE' | 'RESTORING' | 'RESTORED';
};

export type SimSnapshot = {
  t: number; mode: 'FIFO' | 'DARKGRID';
  control: ControlMode;
  manual: { reviewingJobId: string | null; lockRemainingS: number; answered: number };
  vehicles: Vehicle[]; ambulance: Ambulance | null;
  darkNodes: LatLng[]; corridor: LatLng[];
  lots: LotState[];
  jobs: Job[];                      // already sorted, first = answered next
  operators: { id: string; task: string }[];
  metrics: Metrics; policy: Policy;
  incidents?: CollisionIncident[];
  corridorStatus?: CorridorStatus;
  outage?: OutageState | null;
  zonePolicy?: ZonePolicyState | null;
  scenario?: { seed: number; automatic: boolean; outageAt: number; collisionCount: number };
};

// Everything the UI can ask the sim to do. The UI never changes a snapshot directly.
export type SimCommand =
  | { type: 'ANSWER_JOB'; jobId: string }           // MANUAL mode: the judge clicked a job
  | { type: 'SET_CONTROL'; control: ControlMode }
  | { type: 'REVOKE_ZONE_POLICY' }                  // a human ends the active zone policy
  | { type: 'RESET'; seed: number };                // restart the blackout; same seed = same run

export type ChartPoint = { t: number; fifo: number; darkgrid: number }; // requests waiting

// One recorded moment, used for rewind. Recorded every HISTORY_EVERY_S sim-seconds (config.ts).
// Light: only what the screen draws.
export type FrameLite = {
  t: number; vehicles: Vehicle[]; ambulance: Ambulance | null;
  corridor: LatLng[]; lots: LotState[];
  metrics: Metrics; jobs: Job[];   // top 8 jobs only
};
export type HistoryFrame = { t: number; fifo: FrameLite; darkgrid: FrameLite };
