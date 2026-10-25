// Simulation constants. Every value is ASSUMED, tunable: change them here, nowhere else.
// Times are sim seconds unless the name says REAL.

export const SEED = 20251220;
export const SIM_SPEED = 10;                 // sim-seconds per real second

export const VEHICLES = 250;                 // plus 1 ambulance, simulated separately
export const PASSENGER_SHARE = 0.6;          // 60% PASSENGER, 40% EMPTY
export const CRUISE_MPS = 9;
export const GAP_M = 8;                      // bumper-to-bumper spacing in a queue

export const DARK_HEADWAY_S = 4;             // a dark node lets 1 vehicle through every 4 s
export const P_CONFIRM_DARK = 0.35;          // chance a car asks for help at a dark node
export const P_CONFIRM_DARK_ZONE_POLICY = 0.03; // same, once the zone policy is approved
export const P_STOP_INSIDE_BOX = 0.3;        // chance a car asking for help stops inside the box
export const STUCK_TIMEOUT_S = 45;
export const AMBULANCE_STUCK_S = 20;

export const OPERATORS = 5;
export const SERVICE_SINGLE_S = 30;
export const SERVICE_BATCH_S = 45;

export const LOT_CAPACITY = 25;
export const STAGING_LOTS = 8;            // at most this many lots are used for staging
export const STAGING_MIN_DIST_M = 850;     // ...and only lots this far from the blackout center
export const OUTAGE_RADIUS_M = 700;
export const AMBULANCE_DISPATCH_DELAY_S = 60;

export const REVIEW_LOCK_REAL_S = SERVICE_SINGLE_S / SIM_SPEED; // = 3
// 4 s x B's 450-frame buffer = 30 sim-minutes, enough to rewind past the outage after a 3-minute demo.
export const HISTORY_EVERY_S = 4;

export const DEFAULT_WEIGHTS = { onCorridor: 10, insideBox: 3, perQueuedBehind: 1, passenger: 0.5 };

// Prototype scenario assumptions, not measurements of real AV performance.
export const RANDOM_OUTAGE_START_S = [25, 55] as const;
export const RANDOM_OUTAGE_RADIUS_M = [420, 850] as const;
export const RANDOM_RESTORATION_DELAY_S = [240, 360] as const;
export const RESTORATION_SPREAD_S = 90;
export const COLLISION_CLEARANCE_S = [90, 150] as const;
export const MAX_COLLISION_INCIDENTS = 6;
export const CORRIDOR_LEAD_S = 20;
export const CORRIDOR_LOOKAHEAD_M = 650;
export const YIELD_ACK_S = 1;
export const YIELD_MANEUVER_S = 4;
export const YIELD_OFFSET_M = 4;
export const CURB_SLOTS_PER_LANE = 3;
export const LOCAL_EMERGENCY_YIELD_M = 90;
