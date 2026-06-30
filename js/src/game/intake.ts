// STAGE 1 — INTAKE (M6). The two paths that both converge on ONE Game Design Spec:
//
//   1a Built-Spec Mode  — parseGdd(): pull the GDS out of a design doc (a fenced ```json block in a
//      markdown GDD), validate it, and emit a GAP REPORT for whatever is missing. (In production an
//      LLM/llmff infer stage turns freeform prose into that json block; this is the structural
//      extract + validation + gap report that gates it.)
//   1b Interview Mode   — an expert PANEL (game designer, systems designer, art director, QA lead)
//      whose questions COVER every required GDS field; synthesizeGds() assembles the collected
//      answers into a validated GDS. interviewCoverage() proves the panel is complete (no required
//      field is unasked).

import { validateGDS, type GameDesignSpec, type GdsIssue } from "./gds.ts";

// ── 1a: GDD parsing ─────────────────────────────────────────────────────────────────────────────
export interface GddParse {
  ok: boolean;
  data?: GameDesignSpec;
  issues: GdsIssue[];
  /** Top-level fields the GDD is missing/invalid — the gap report to take back to the author. */
  gaps: string[];
}

function extractJsonBlock(markdown: string): string | undefined {
  const m = /```(?:json|gds)\s*\n([\s\S]*?)```/.exec(markdown);
  return m ? m[1] : undefined;
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Parse a GDD markdown that embeds the GDS as a fenced ```json (or ```gds) block: extract →
 *  validate → gap-report. A doc with no block, invalid JSON, or an invalid spec returns ok:false. */
export function parseGdd(markdown: string): GddParse {
  const block = extractJsonBlock(markdown);
  if (block === undefined) {
    return { ok: false, issues: [{ path: "", message: "no fenced ```json GDS block found in the GDD" }], gaps: ["(entire spec)"] };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(block);
  } catch (e) {
    return { ok: false, issues: [{ path: "", message: "GDS json block is invalid JSON: " + (e instanceof Error ? e.message : String(e)) }], gaps: ["(json)"] };
  }
  const v = validateGDS(obj);
  const gaps = v.ok ? [] : uniq(v.issues.map((i) => (i.path.split(".")[0] || "(root)")));
  return { ok: v.ok, data: v.data, issues: v.issues, gaps };
}

// ── 1b: the interview panel ──────────────────────────────────────────────────────────────────────
/** A GDS field an interview question fills (drives the coverage proof). */
export type GdsField = keyof GameDesignSpec;

export interface InterviewQuestion {
  id: string;
  prompt: string;
  /** The GDS field this answer fills. */
  field: GdsField;
}

export interface InterviewPersona {
  id: string;
  role: string;
  questions: InterviewQuestion[];
}

/** The required GDS top-level fields (id is DERIVED from the pitch when unspecified; mechanics +
 *  content are optional). The interview panel must cover all of these. */
export const REQUIRED_GDS_FIELDS: GdsField[] = [
  "pitch", "loopSentence", "controls", "winCondition", "loseCondition",
  "artDirection", "targetPlatforms", "scopeTier", "optIn", "entities", "dod",
];

/** The expert panel: each persona owns the questions in its domain. Together they cover every
 *  required GDS field (proven by interviewCoverage). */
export function interviewPlan(): InterviewPersona[] {
  return [
    {
      id: "game-designer",
      role: "Game Designer",
      questions: [
        { id: "pitch", prompt: "In a sentence, what is the game?", field: "pitch" },
        { id: "loop", prompt: "Describe the core loop: verb · objective · pressure · reward · fail · restart.", field: "loopSentence" },
        { id: "win", prompt: "What is the win condition?", field: "winCondition" },
        { id: "lose", prompt: "What is the lose/fail condition?", field: "loseCondition" },
      ],
    },
    {
      id: "systems-designer",
      role: "Systems Designer",
      questions: [
        { id: "controls", prompt: "What is the control scheme and the named input intents?", field: "controls" },
        { id: "entities", prompt: "What are the entities (player, NPCs, hazards, pickups, props) and their states?", field: "entities" },
        { id: "scope", prompt: "Scope tier: prototype, polished, or premium?", field: "scopeTier" },
        { id: "optin", prompt: "Does it need replay/export or multiplayer, or is it a local direct-path game?", field: "optIn" },
      ],
    },
    {
      id: "art-director",
      role: "Art Director",
      questions: [
        { id: "art", prompt: "Describe the art direction (mood, palette, focal points).", field: "artDirection" },
        { id: "platforms", prompt: "Which target platforms (desktop, mobile, web)?", field: "targetPlatforms" },
      ],
    },
    {
      id: "qa-lead",
      role: "QA Lead",
      questions: [
        { id: "dod", prompt: "What are the falsifiable Definition-of-Done assertions (state transitions + feel)?", field: "dod" },
      ],
    },
  ];
}

/** Proof that the interview panel covers every required GDS field (id is derived). */
export function interviewCoverage(): { covered: GdsField[]; required: GdsField[]; missing: GdsField[]; complete: boolean } {
  const covered = uniq(interviewPlan().flatMap((p) => p.questions.map((q) => q.field))) as GdsField[];
  const missing = REQUIRED_GDS_FIELDS.filter((f) => !covered.includes(f));
  return { covered, required: REQUIRED_GDS_FIELDS, missing, complete: missing.length === 0 };
}

/** Collected interview answers — a partial GDS keyed by field. */
export type InterviewAnswers = Partial<Record<GdsField, unknown>> & { id?: string };

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "game";
}

export interface SynthesisResult {
  ok: boolean;
  data?: GameDesignSpec;
  issues: GdsIssue[];
}

/** Assemble collected interview answers into a validated GDS. The id is derived from the pitch when
 *  not supplied. Returns validation issues (the unanswered/invalid fields) when incomplete. */
export function synthesizeGds(answers: InterviewAnswers): SynthesisResult {
  const candidate: Record<string, unknown> = { ...answers };
  if (candidate.id === undefined && typeof answers.pitch === "string") {
    candidate.id = slug(answers.pitch);
  }
  const v = validateGDS(candidate);
  return { ok: v.ok, data: v.data, issues: v.issues };
}
