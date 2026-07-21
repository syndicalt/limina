// STORYBOARD -- the project-level beats/quests/events artifact produced by design studios.
//
// Mirrors design-direction.ts / building-brief.ts: a version literal, strict Zod objects,
// deterministic parse/canonicalize/serialize helpers, and semantic validation for ids.

import { z } from "../../build/zod.bundle.mjs";

export const STORYBOARD_VERSION = "storyboard/1" as const;

export const QUEST_STEP_KINDS = ["flag", "counter", "reach", "talk", "collect"] as const;

const BeatSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  locationId: z.string().min(1).optional(),
  castIds: z.array(z.string().min(1)).optional(),
}).strict();

const QuestStepSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  kind: z.enum(QUEST_STEP_KINDS),
  target: z.string().min(1).optional(),
  value: z.union([z.number(), z.string()]).optional(),
}).strict();

const QuestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  giverId: z.string().min(1).optional(),
  steps: z.array(QuestStepSchema),
  reward: z.string().min(1).optional(),
}).strict();

const EventSchema = z.object({
  id: z.string().min(1),
  trigger: z.string().min(1),
  effect: z.string().min(1),
}).strict();

export const StoryboardSchema = z.object({
  version: z.literal(STORYBOARD_VERSION),
  beats: z.array(BeatSchema),
  quests: z.array(QuestSchema),
  events: z.array(EventSchema).optional(),
}).strict();

export type Storyboard = z.infer<typeof StoryboardSchema>;
export type StoryboardBeat = z.infer<typeof BeatSchema>;
export type StoryboardQuest = z.infer<typeof QuestSchema>;
export type StoryboardQuestStep = z.infer<typeof QuestStepSchema>;
export type StoryboardEvent = z.infer<typeof EventSchema>;

export interface StoryboardIssue {
  path: string;
  message: string;
}

export function parseStoryboard(json: string): Storyboard {
  return StoryboardSchema.parse(JSON.parse(json));
}

export function canonicalizeStoryboard(s: Storyboard): Storyboard {
  return {
    version: s.version,
    beats: s.beats.map((b) => ({
      id: b.id,
      title: b.title,
      description: b.description,
      ...(b.locationId !== undefined ? { locationId: b.locationId } : {}),
      ...(b.castIds !== undefined ? { castIds: b.castIds.map((id) => id) } : {}),
    })),
    quests: s.quests.map((q) => ({
      id: q.id,
      name: q.name,
      ...(q.giverId !== undefined ? { giverId: q.giverId } : {}),
      steps: q.steps.map((step) => ({
        id: step.id,
        objective: step.objective,
        kind: step.kind,
        ...(step.target !== undefined ? { target: step.target } : {}),
        ...(step.value !== undefined ? { value: step.value } : {}),
      })),
      ...(q.reward !== undefined ? { reward: q.reward } : {}),
    })),
    ...(s.events !== undefined ? {
      events: s.events.map((e) => ({
        id: e.id,
        trigger: e.trigger,
        effect: e.effect,
      })),
    } : {}),
  };
}

export function serializeStoryboard(s: Storyboard): string {
  return JSON.stringify(canonicalizeStoryboard(s));
}

export function validateStoryboard(
  input: unknown,
): { ok: boolean; data?: Storyboard; issues: StoryboardIssue[] } {
  const parsed = StoryboardSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  }

  const storyboard = parsed.data;
  const issues: StoryboardIssue[] = [];
  const beatIds = new Set<string>();
  for (const beat of storyboard.beats) {
    if (beatIds.has(beat.id)) issues.push({ path: `beats.${beat.id}`, message: `duplicate beat id "${beat.id}"` });
    beatIds.add(beat.id);
  }

  const questIds = new Set<string>();
  for (const quest of storyboard.quests) {
    if (questIds.has(quest.id)) issues.push({ path: `quests.${quest.id}`, message: `duplicate quest id "${quest.id}"` });
    questIds.add(quest.id);

    const stepIds = new Set<string>();
    for (const step of quest.steps) {
      if (stepIds.has(step.id)) issues.push({ path: `quests.${quest.id}.steps.${step.id}`, message: `duplicate step id "${step.id}" in quest "${quest.id}"` });
      stepIds.add(step.id);
    }
  }

  return issues.length === 0 ? { ok: true, data: storyboard, issues: [] } : { ok: false, data: storyboard, issues };
}

export const DEFAULT_STORYBOARD: Storyboard = {
  version: STORYBOARD_VERSION,
  beats: [
    {
      id: "arrival",
      title: "Arrival at Signal Camp",
      description: "The player reaches the frontier camp as the watchfire gutters and the forest line stirs.",
      locationId: "home",
      castIds: ["player", "elder-mara"],
    },
  ],
  quests: [
    {
      id: "first-light",
      name: "First Light",
      giverId: "elder-mara",
      steps: [
        {
          id: "reach-camp",
          objective: "Reach the signal fire before night closes in.",
          kind: "reach",
          target: "home",
        },
        {
          id: "light-signal",
          objective: "Restore the signal fire.",
          kind: "flag",
          target: "signal_lit",
          value: "true",
        },
      ],
      reward: "The camp opens its stores and marks the next trail.",
    },
  ],
  events: [
    {
      id: "blight-rustle",
      trigger: "signal_lit",
      effect: "A distant blighted movement answers from the trees.",
    },
  ],
};
