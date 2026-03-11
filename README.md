# AI Dodge Prototype Editor

A demo-first AI-native 2D game prototype editor built with Next.js, AI SDK, Pixi.js, and a constrained game DSL.

This repository focuses on one narrow but reliable loop:

1. The user writes a natural-language prompt.
2. The model generates or modifies a constrained dodge-survival DSL.
3. The DSL is normalized, schema-checked, rule-checked, and smoke-tested.
4. The app previews the result as a playable browser game.
5. The user can archive, restore, branch from previous versions, and iterate again.

The goal of this version is not to be a general-purpose game engine. The goal is to show a stable, inspectable AI editing workflow for a constrained arcade game domain.

## What This Version Delivers

- Natural-language generation of a playable 2D dodge-survival prototype.
- Natural-language modification of an existing prototype.
- Validation pipeline with schema checks, gameplay rules, smoke simulation, repair attempt, and last-known-good fallback.
- Playable in-browser preview using keyboard input.
- Read-only workbench for inspecting DSL, validation state, and model attempts.
- Lightweight version management:
  - live vs staged editing states
  - archive and restore
  - explicit modify baseline selection (`staged`, `live`, or a chosen archive)
  - archive lineage display for lightweight branching
  - cascade delete warning when removing a parent archive branch

## What Problem This Project Solves

Typical AI demo prototypes stop at "the model returned JSON". This project tries to close the loop and make the result inspectable and playable.

Instead of trusting raw model output directly, it adds:

- a constrained DSL
- normalization of messy model outputs
- validation and smoke simulation
- fallback behavior when generation is invalid
- a browser runtime that interprets the DSL
- lightweight version control inside the editor UI

This makes the system more demoable and easier to explain in an interview setting.

## Problems Encountered In This Version

This version was shaped by a few concrete problems during implementation.

### 1. Model output was structurally inconsistent

The model could return JSON-like or YAML-like payloads with slightly different field names and shapes.

What was done:

- Added normalization logic to map loosely formatted model output into one canonical DSL.
- Added schema validation, rules validation, and smoke simulation.
- Added one repair pass before falling back.

### 2. A generation could look successful but still be unreliable

A model response might parse but still be semantically weak, malformed, or unsupported by runtime behavior.

What was done:

- Added attempt logging.
- Added repair/fallback states.
- Preserved last-known-good behavior to keep the demo playable.

### 3. Iterative modification was ambiguous

Before the recent version-management pass, "apply modification" did not clearly communicate which version it was modifying.

What was done:

- Added explicit modify baseline selection.
- Allowed the user to modify from `staged`, `live`, or a selected archived version.

### 4. Archive history was hard to reason about

Flat archive lists made it difficult to see how one modified version related to another.

What was done:

- Added lightweight archive lineage.
- Added branch-like parent-child relationships between archives.
- Added cascade-delete warnings for parent archive removal.

### 5. The runtime is narrower than natural language suggests

The current model can be asked for things that sound reasonable in plain language but are not yet truly supported by runtime semantics.

Example:

- Asking for a "speed orb" can still produce a valid DSL-like collectible entry.
- However, the current runtime only supports score-style collectibles, not general power-up effects.

This is an important limitation of the current version and is intentionally documented below.

## What The Current System Can Do

### AI Editing Loop

- Generate a fresh playable prototype from a prompt.
- Modify the current prototype with follow-up instructions.
- Surface model provider, model name, attempt traces, and validation state.

### Game Runtime

- Render a top-down 2D playable preview in the browser.
- Support player movement with WASD / arrow keys.
- Support enemy pursuit behavior.
- Support survival and score-based victory conditions.
- Support score collectibles.

### Version Management

- Keep `live` and `staged` states separate.
- Promote staged to live.
- Archive current live states.
- Restore archived versions.
- Modify from an archived version without losing the current branch context.
- Display lightweight parent-child archive lineage.

### Reliability Guardrails

- Normalize model output before schema parsing.
- Validate against a constrained DSL.
- Apply additional rule checks.
- Run a smoke simulation before accepting the result.
- Attempt one repair pass.
- Fall back to a last-known-good DSL when needed.

## What The Current System Cannot Do

This section is intentionally explicit so the repository is honest about scope.

### Not a general-purpose game engine

- It only supports one genre right now: top-down 2D dodge-survival.
- It does not support platformers, puzzle games, card games, or arbitrary 2D gameplay loops.

### Not a multi-mechanic item system yet

- Collectibles are effectively score collectibles.
- The runtime does not yet support true gameplay-affecting power-ups such as speed boost, shield, heal, or buff stacking.
- Labels/icons such as a visible `S` on a collectible are not supported yet.

### Not production-grade persistence

- Archive history is currently browser-local and stored in localStorage.
- There is no backend persistence, user account system, or collaborative editing.

### Not a visual node editor

- Editing is prompt-first, not canvas-first.
- The workbench is inspection-oriented, not a full visual authoring tool.

## Why The Scope Is Intentionally Narrow

This repository is optimized for a take-home / interview-style deliverable.

The tradeoff is deliberate:

- narrower design space
- stronger validation and fallback behavior
- more reliable demo flow
- easier explanation of system boundaries

Rather than pretending to support any game idea, the project tries to show one constrained AI editing workflow done clearly and honestly.

## Tech Stack

- Next.js 16 (App Router)
- React 19
- AI SDK with OpenAI-compatible provider adapters
- Pixi.js for browser runtime preview
- Zod for DSL schema validation
- Vitest for critical tests
- TypeScript

## Project Structure

```text
src/
  app/
    api/
      game/generate/
      game/modify/
      health/
  components/
    AppShell.tsx
    GamePreview.tsx
    PromptPanel.tsx
    StatusRail.tsx
    Workbench.tsx
  lib/
    ai/
    game/
    runtime/
    state/
scripts/
  smoke-sim.ts
tests/
  critical/
```

## Requirements

- Node.js 22 LTS
- npm

## Environment Variables

Copy `.env.example` to `.env.local` (or `.env`) and fill in the required values.

### Active provider

- `LLM_PROVIDER=apiyi` or `LLM_PROVIDER=openrouter`

### APIYI (primary)

- `APIYI_BASE_URL=https://api.apiyi.com/v1`
- `APIYI_LLM_API_KEY=...`
- `APIYI_LOGIC_MODEL=gpt-5.4`
- `APIYI_STYLE_MODEL=gemini-3.1-pro-preview`

### OpenRouter (fallback)

- `OPENROUTER_BASE_URL=https://openrouter.ai/api/v1`
- `OPENROUTER_LLM_API_KEY=...`
- `OPENROUTER_LOGIC_MODEL=openai/gpt-5.4`
- `OPENROUTER_STYLE_MODEL=google/gemini-3.1-pro-preview`

### Optional tuning

- `MAX_REPAIR_ATTEMPTS=1`
- `SMOKE_SIM_TICKS=600`
- `MODEL_CALL_TIMEOUT_MS=60000`

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Validation Commands

```bash
npm run lint
npm run test:critical
npm run smoke:sim
npm run build
```

## API Routes

- `GET /api/health`
  - returns provider/model readiness summary
  - does not force a real model generation call
- `POST /api/game/generate`
  - generates a fresh DSL from a natural-language prompt
- `POST /api/game/modify`
  - modifies an existing DSL using a natural-language instruction

## Demo Script

1. Generate a space-themed dodge-survival game from a prompt.
2. Play the preview with keyboard controls.
3. Apply one or two natural-language modifications.
4. Show validation state and model attempt visibility in the center panel.
5. Archive the result.
6. Modify from a chosen archive baseline to show lightweight branching.
7. Restore a previous archive and show branch-aware delete behavior.

## Suggested Submission Bundle

Recommended handoff for a take-home submission:

1. Source code repository or zip
2. This `README.md`
3. A 1-3 minute demo video or GIF
4. Optional deployed preview link

## Current Status Summary

This version is best described as:

> A constrained AI-native dodge-survival prototype editor with validation, fallback, playable preview, and lightweight in-app version management.

That description is intentionally narrower than "AI game engine", but much more accurate for what the code currently does well.
