**MVP Spec: Skill/Hook System + MCP-Style Interface + Observability Layer + Agent Ecosystem**

This document defines a focused, high-leverage MVP that makes **Agent Builders** (creation agents) and **Agent Players** (in-world autonomous entities) first-class citizens from the start.

The design prioritizes:
- Discoverability and structured tool use (MCP-style)
- Safety and governance
- Rich observability (EventLoom + Pathlight inspired)
- Tight integration with the ECS + Three.js/WebGPU runtime
- Realistic scope that can ship in months while feeling intentional and extensible

### High-Level Architecture View (MVP)

```
┌─────────────────────────────────────────────────────────────┐
│                    Native Runtime Layer                     │
│  (V8/QuickJS + Dawn/wgpu WebGPU + SDL3 + minimal Web APIs)  │
│                  Three.js WebGPU Renderer                   │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                     Core Engine Layer                       │
│  • Data-oriented ECS (bitECS or archetype-based)            │
│  • Fixed-timestep loop + RenderSystem + Physics (Rapier)    │
│  • Spatial partitioning                                     │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│              Agent Ecosystem (MVP)                          │
│  ┌─────────────────────┐   ┌─────────────────────────────┐  │
│  │  Skill/Hook Registry│   │  Observability Layer        │  │
│  │  (typed, discoverable)│ │  (events + tracing)         │  │
│  └──────────┬──────────┘   └──────────────┬──────────────┘  │
│             │                              │                 │
│  ┌──────────▼──────────┐   ┌──────────────▼──────────────┐  │
│  │ MCP-style Tool      │   │  Agent Components & Systems │  │
│  │ Interface           │   │  (Builders + Players)       │  │
│  └─────────────────────┘   └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

External agents (LLM-powered via local Ollama or your Provara-style gateway) connect through the MCP-style interface and call skills. Both builder and player agents live in the same ECS world.

### 1. Skill/Hook System (MVP)

**Purpose**: A central, typed registry of engine capabilities that agents can discover and invoke safely.

**Core Concepts**:
- **Skill**: A named, versioned, schema-described capability (e.g., `scene.createEntity`, `ecs.addComponent`, `three.setMaterial`).
- **Hook**: Optional pre/post execution callbacks (e.g., validation, logging, permission checks).
- **Execution Context**: Carries agent identity, permissions, session ID, and world snapshot.

**Data Model (TypeScript sketch)**

```ts
interface SkillDefinition {
  name: string;                    // e.g. "scene.createEntity"
  version: string;                 // "1.0.0"
  description: string;
  category: 'scene' | 'ecs' | 'three' | 'physics' | 'agent' | 'system';
  inputSchema: JSONSchema;         // Zod or JSON Schema
  outputSchema: JSONSchema;
  permissions: string[];           // e.g. ["scene.write", "ecs.modify"]
  handler: (input: any, ctx: ExecutionContext) => Promise<any>;
  hooks?: {
    before?: (input: any, ctx: ExecutionContext) => Promise<void>;
    after?: (result: any, ctx: ExecutionContext) => Promise<void>;
  };
}

interface ExecutionContext {
  agentId: string;
  sessionId: string;
  permissions: string[];
  timestamp: number;
  worldSnapshot?: any;             // lightweight summary
}
```

**MVP Skills (Minimal but Powerful Set)**

**Scene / World**
- `scene.createEntity` (with optional initial components)
- `scene.destroyEntity`
- `scene.queryEntities` (by tags, distance, components)

**ECS**
- `ecs.addComponent`
- `ecs.removeComponent`
- `ecs.updateComponent` (targeted updates)

**Three.js / Rendering**
- `three.setTransform`
- `three.setMaterial` (basic PBR properties via TSL-friendly params)
- `three.loadGLTF` (with asset path or embedded data)
- `three.setLighting` (basic directional + ambient)

**Physics (Rapier)**
- `physics.applyImpulse`
- `physics.raycast`

**Agent / Meta**
- `agent.getPerception` (current view for the calling agent)
- `agent.emitEvent` (for inter-agent or system communication)

**Registration & Discovery**
- Skills are registered at engine startup or dynamically.
- Agents call a discovery skill: `skills.list()` or `skills.describe(name)`.
- All skills are versioned and documented.

**Safety & Permissions (MVP)**
- Every skill declares required permissions.
- Agent sessions are created with a permission profile (e.g., `builder.readWrite`, `player.limited`).
- Execution layer enforces allow-lists before calling the handler.
- Failed permission checks emit security events.

### 2. MCP-Style Interface (MVP)

**Purpose**: Structured, discoverable tool-calling protocol optimized for LLM agents (inspired by function calling / tool use standards).

**Interface Contract**

```ts
interface MCPTool {
  name: string;
  description: string;
  input_schema: JSONSchema;
  // Optional: output schema, examples, cost hints
}

interface MCPRequest {
  tool: string;
  input: Record<string, any>;
  context?: {
    agentId: string;
    sessionId: string;
    previousResults?: any[];
  };
}

interface MCPResponse {
  success: boolean;
  result?: any;
  error?: string;
  metadata?: {
    executionTimeMs: number;
    eventsEmitted: string[];
  };
}
```

**MVP Features**:
- `mcp.listTools()` — Returns all available tools with schemas and descriptions.
- `mcp.callTool(request)` — Executes with full context + permission checks.
- Streaming support for long-running operations (future-proofing).
- Automatic injection of relevant world context when requested.
- Error handling with structured, agent-friendly messages.

**Integration Pattern**:
External agents (or your gateway) receive the list of tools, then make `callTool` requests. The engine handles execution, observability, and safety.

### 3. Observability Layer (MVP)

**Purpose**: Every significant action by builders or players is observable, traceable, and replayable.

**Core Components**:

**Event Bus**
- Lightweight, typed event emitter.
- All skill executions, component changes, agent decisions, and perception updates emit events.
- Events are immutable and carry `agentId`, `sessionId`, `timestamp`, `before/after` state where relevant.

**Tracing (Pathlight-inspired)**
- Decision traces: `perception → decision → tool calls → state changes`.
- Hierarchical: Builder session trace can contain sub-traces for spawned player agents.
- Lightweight in MVP (in-memory + optional export to JSON).

**Replay Foundation**
- Events are sequenced and timestamped.
- MVP supports replay of a single agent’s action history over a short window (useful for debugging builder sessions or player behavior).

**Inspector / Dev Tools (MVP)**
- Runtime view of active agents (builder + player).
- Recent events and traces per agent.
- Permission and execution history.

**Event Examples**:
- `agent.decision.made`
- `skill.executed`
- `ecs.component.added`
- `three.material.updated`
- `security.permission.denied`

### 4. Agent Ecosystem (How Builders + Players Work Together)

**Agent Component (Shared)**

```ts
interface AgentComponent {
  id: string;
  type: 'builder' | 'player';
  perceptionRadius?: number;
  decisionIntervalMs: number;
  memoryRef?: string;              // reference to external or in-memory store
  llmConfig?: {
    endpoint: string;              // local or gateway
    model: string;
    systemPrompt: string;
    guardrailProfile: string;
  };
  permissions: string[];
  sessionId: string;
}
```

**Systems (MVP)**

- **PerceptionSystem**: Runs for player agents (and optionally builders). Populates a `Perception` component with nearby entities, events, and spatial data.
- **DecisionSystem**: For player agents — runs decision loop (scripted or LLM). For builder agents — mostly external but can be triggered internally.
- **ActionSystem**: Consumes queued actions from agents and routes them through the skill/hook system.
- **ObservabilitySystem**: Listens to all relevant events and maintains traces.

**Builder Agent Workflow (MVP)**:
1. External agent connects via MCP interface.
2. Calls `skills.list()` + `skills.describe()`.
3. Receives world context.
4. Makes sequenced `callTool` requests (e.g., create entities, set transforms, load models).
5. All actions are permission-checked, executed, and fully traced.
6. Agent can query results and continue building.

**Player Agent Workflow (MVP)**:
1. Spawned via skill or initial scene.
2. PerceptionSystem updates its view.
3. DecisionSystem (scripted or simple LLM) decides actions.
4. Actions are validated and executed via the same skill system.
5. Full tracing and event emission.

**Shared Benefits**:
- Same safety, observability, and skill infrastructure.
- Builders can create or modify player agents.
- Both benefit from future memory, coordination, and advanced tracing features.

### Integration with Core Engine

- Skills are thin wrappers over ECS + Three.js + Rapier operations.
- All mutations go through the skill layer when initiated by agents (direct code paths remain available for human developers).
- Spatial partitioning is reused by both perception and `scene.queryEntities`.
- Three.js changes triggered by agents are synced through the normal RenderSystem.

### Updated Phased Roadmap

**Phase 0: Foundation (Current)**
- Native runtime basics (or integration with Mystral Native)
- ECS core + Three.js WebGPU render loop + Rapier
- Fixed timestep + basic input/camera

**Phase 1: MVP – Agent-Native Core (Next Target)**
- Skill/Hook Registry + permission system
- MCP-style tool interface
- Observability layer (events + basic tracing + inspector)
- AgentComponent + Perception/Decision/Action systems (for both builders and players)
- Core MVP skills (scene, ecs, three, physics, agent meta)
- Simple builder demo + player agent demo
- LLM integration point (local + gateway)

**Phase 2: Polish & Core Expansion**
- More skills (animation, VFX, advanced materials via TSL)
- Improved tracing and replay
- Better world context injection for agents
- Hot-reload for skills and agent behaviors
- Basic multi-agent coordination primitives

**Phase 3: Scale & Differentiation**
- Advanced memory systems
- GPU-accelerated perception/decision where beneficial
- Richer builder tooling (procedural generation skills, visual traces)
- Stronger multiplayer support for agent-driven worlds
- Mobile targets and packaging improvements

**Phase 4: Ecosystem & Production**
- Full safety/governance suite (deeper Provara/AIegis integration)
- Editor/IDE integration for human + agent collaboration
- Comprehensive examples and documentation
- Community contribution model for new skills

### Scope Guards for MVP

- Limit to ~12–15 core skills.
- LLM calls are straightforward (no complex multi-turn tool orchestration in MVP).
- Tracing is in-memory + exportable (no full persistent EventLoom yet).
- Focus on desktop native runtime first (browser fallback later).
- Permission model is profile-based rather than fully dynamic policy engine.

This spec gives us a concrete, buildable MVP that makes agent builders genuinely powerful while also supporting agent players, all while staying aligned with the broader goal of a high-performance engine that underpins Three.js.

---

Would you like me to expand any section with more detailed TypeScript interfaces, example skill implementations, security model details, or a sample builder agent workflow? Or shall we move to initial project structure / repo layout next?