// POST { text } -> a structured chaos event plus a suggested dispatch policy.
// Uses Claude when ANTHROPIC_API_KEY is set; otherwise, or on any failure, a keyword
// parser answers instead. Always returns valid JSON, never throws.

export type EventType = 'OUTAGE' | 'COLLISION' | 'DEMAND_SURGE' | 'COMMS_DEGRADATION';

export type ChaosResult = {
  event: { type: EventType; zone?: string; radius_m?: number; magnitude?: number };
  policy: { dispatch: 'WSPT_TRIAGE'; batchMax: number; darkSignalsAsFourWayStop: number[] };
  rationale: string;
  source: 'CLAUDE' | 'OFFLINE_RULES';
};

const EVENT_TYPES: EventType[] = ['OUTAGE', 'COLLISION', 'DEMAND_SURGE', 'COMMS_DEGRADATION'];
const CLAUDE_TIMEOUT_MS = 20_000;   // the demo falls back to offline rules rather than hang

const SYSTEM_PROMPT = `You turn a short incident report into a structured event for DARK GRID, the dispatch platform a robotaxi remote-operations team uses in San Francisco (SoMa / Mission).

Event types:
- COLLISION: a crash, collision, or wreck blocks a road. Dispatch recovery; maintain the closure until recovery completes. Vehicles may reroute but must not drive through the wreck.
- OUTAGE: power loss, substation fire, blackout. Traffic lights go dark, so robotaxis ask operators for help at every intersection. radius_m is the blackout radius (a typical substation outage is about 700 m).
- DEMAND_SURGE: a crowd leaving a venue (concert, game). magnitude is the multiplier on ride requests (1-5).
- COMMS_DEGRADATION: cellular or network trouble, so cars lose their link to operators. magnitude is the share of cars affected (0-1).

zone is the neighborhood or landmark named in the report, or null. Use null for any field that doesn't apply.
batchMax is how many identical requests at one intersection an operator may approve with one click: around 40 for a large outage, lower when requests are diverse.
rationale is one or two sentences an operator reads on screen: what happened and why that policy.

Reply with JSON only, matching the schema.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    event: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: EVENT_TYPES },
        zone: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        radius_m: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        magnitude: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      },
      required: ['type', 'zone', 'radius_m', 'magnitude'],
      additionalProperties: false,
    },
    batchMax: { type: 'integer' },
    rationale: { type: 'string' },
  },
  required: ['event', 'batchMax', 'rationale'],
  additionalProperties: false,
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function policy(batchMax: number): ChaosResult['policy'] {
  // Node ids are filled in by the sim; the API can't know them.
  return { dispatch: 'WSPT_TRIAGE', batchMax: Math.round(clamp(batchMax, 1, 60)), darkSignalsAsFourWayStop: [] };
}

// ---------- offline keyword rules ----------

const ZONES = ['SoMa', 'Mission', 'Chase Center', 'Financial District', 'Dogpatch', 'Mission Bay', 'Tenderloin'];

function offline(text: string, why: string): ChaosResult {
  const t = text.toLowerCase();
  const zone = ZONES.find((z) => t.includes(z.toLowerCase()));
  if (/collision|crash|wreck|撞车|车祸|追尾/.test(t)) {
    return { event: { type: 'COLLISION', zone }, policy: policy(1),
      rationale: 'Collision blocks a road. Dispatch recovery, divert approaching vehicles, and verify the ambulance route. The road stays closed until on-scene recovery finishes.', source: 'OFFLINE_RULES' };
  }
  if (/cell|network|signal loss|comms|lte|5g/.test(t)) {
    return {
      event: { type: 'COMMS_DEGRADATION', zone, magnitude: 0.4 },
      policy: policy(20),
      rationale: `Network trouble${zone ? ` around ${zone}` : ''}: cars may lose their operator link, so similar requests are grouped to save operator time.`,
      source: 'OFFLINE_RULES',
    };
  }
  if (/concert|game|exit|crowd|stadium|arena|festival/.test(t)) {
    return {
      event: { type: 'DEMAND_SURGE', zone: zone ?? 'Chase Center', magnitude: 3 },
      policy: policy(20),
      rationale: `Crowd leaving ${zone ?? 'Chase Center'}: ride requests spike, so requests are triaged by impact instead of arrival order.`,
      source: 'OFFLINE_RULES',
    };
  }
  // power / outage / substation / blackout, and the default for anything unrecognized
  return {
    event: { type: 'OUTAGE', zone: zone ?? 'SoMa', radius_m: 700 },
    policy: policy(40),
    rationale: `Power outage${zone ? ` in ${zone}` : ''}: traffic lights within ~700 m go dark. Dark signals become four-way stops and identical confirmations are approved in batches of up to 40.${why ? ` (${why})` : ''}`,
    source: 'OFFLINE_RULES',
  };
}

// ---------- Claude ----------

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

// Checks every field and clamps numbers. Returns null if the shape is wrong.
function validate(raw: unknown): ChaosResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { event?: Record<string, unknown>; batchMax?: unknown; rationale?: unknown };
  const e = r.event;
  if (!e || !EVENT_TYPES.includes(e.type as EventType)) return null;
  if (typeof r.batchMax !== 'number' || !Number.isFinite(r.batchMax)) return null;
  if (typeof r.rationale !== 'string' || !r.rationale.trim()) return null;
  const event: ChaosResult['event'] = { type: e.type as EventType };
  if (typeof e.zone === 'string' && e.zone.trim()) event.zone = e.zone.trim();
  if (typeof e.radius_m === 'number' && Number.isFinite(e.radius_m)) event.radius_m = clamp(e.radius_m, 100, 3000);
  if (typeof e.magnitude === 'number' && Number.isFinite(e.magnitude)) event.magnitude = e.magnitude;
  if (event.type === 'OUTAGE' && event.radius_m === undefined) event.radius_m = 700;
  return { event, policy: policy(r.batchMax), rationale: r.rationale.trim(), source: 'CLAUDE' };
}

async function askClaude(text: string, apiKey: string): Promise<ChaosResult> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      fallbacks: 'default',   // a safety decline is retried on another model server-side
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const msg = (await res.json()) as { stop_reason?: string; content?: { type: string; text?: string }[] };
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined');
  const textBlock = msg.content?.find((b) => b.type === 'text' && b.text);
  if (!textBlock?.text) throw new Error('no text in response');
  const result = validate(JSON.parse(stripFences(textBlock.text)));
  if (!result) throw new Error('response failed validation');
  return result;
}

export async function POST(request: Request) {
  let text = '';
  try {
    const body = (await request.json()) as { text?: unknown };
    if (typeof body.text === 'string') text = body.text.trim().slice(0, 2000);
  } catch {
    // fall through with empty text
  }
  if (!text) return Response.json({ error: 'Send JSON like { "text": "substation fire in SoMa" }' }, { status: 400 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Response.json(offline(text, ''));
  try {
    return Response.json(await askClaude(text, apiKey));
  } catch (err) {
    console.error('[analyze-chaos] falling back to offline rules:', err instanceof Error ? err.message : err);
    return Response.json(offline(text, 'Claude unavailable, offline rules used'));
  }
}
