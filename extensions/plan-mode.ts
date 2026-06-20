/**
 * pi-plan-mode — grill-first planning with fixed-template output.
 *
 * /plan → grill phase (inject grilling prompt, ask questions one at a time)
 *       → compose phase (inject fixed template, retry-with-emphasis on mismatch)
 *       → review / implement / exit
 *
 * Tool defaults: ALL tools enabled except edit/write.
 * Customize via /plan tools (paginated selector, like @narumitw/pi-plan-mode).
 *
 * Combines patterns from:
 *   - @narumitw/pi-plan-mode (plan_mode_question tool, /plan tools selector)
 *   - @mjasnikovs/pi-task (grill→compose separation, retry-with-emphasis validation)
 *   - pi examples/extensions/plan-mode (basic read-only mode)
 *   - grilling skill (one-question-at-a-time interview prompt)
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

// ─── Constants ───────────────────────────────────────────────────────────────

const STATE_ENTRY_TYPE = "pi-plan-mode";
const STATUS_KEY = "plan-mode";
const WIDGET_KEY = "plan-mode";

const PLAN_MODE_QUESTION_TOOL = "plan_mode_question";
const PROPOSED_PLAN_RE = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/i;
const TOOL_SELECTOR_PAGE_SIZE = 10;
const GRILLING_SKILL_PATH = join(homedir(), ".pi", "agent", "skills", "grilling", "SKILL.md");

const BLOCKED_BUILTIN_NAMES = new Set(["edit", "write"]);
const FULL_TOOLS = ["read", "bash", "edit", "write"];

// Bash stays available in plan mode, but obvious write/destructive commands are blocked.
const DESTRUCTIVE_RE = /\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|dd|sudo|su|kill|pkill|killall|reboot|shutdown|npm\s+(install|uninstall|update|ci|link|publish)|yarn\s+(add|remove|install|publish)|pnpm\s+(add|remove|install|publish)|bun\s+(add|remove|install|update)|pip\s+(install|uninstall)|uv\s+(add|remove|sync|lock)|git\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone)|(vim?|nano|emacs|code|subl))\b|(^|[^<])>(?!>)|>>/i;

// ─── Types ───────────────────────────────────────────────────────────────────

interface PlanModeState {
  enabled: boolean;
  phase: "grill" | "compose" | null;
  latestPlan: string | null;
  awaitingAction: boolean;
  selectedToolNames?: string[];
  toolsBeforePlan?: string[];
}

interface QuestionOption { label: string; description: string; }

// ─── Prompt builders ─────────────────────────────────────────────────────────

/** Grilling skill prompt — loaded from the local skill so edits stay in sync */
function grillPrompt(): string {
  const skillText = readSkillPrompt(GRILLING_SKILL_PATH) ?? `Interview the user relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a question can be answered by exploring the codebase, explore the codebase instead.`;

  return `[PLAN MODE — GRILL PHASE]

${skillText}

Plan-mode rules:
- Ask questions ONE AT A TIME using the <tool>plan_mode_question</tool> tool. Never batch multiple questions.
- The number of questions is not capped: keep asking one at a time until important uncertainty is resolved.
- Only ask about things that materially affect the plan: scope, approach, tradeoffs, constraints, preferences.
- If a question can be answered by exploring the codebase (reading files, searching config, checking packages), explore first instead of asking.
- Do NOT produce a <proposed_plan> block yet. The user must confirm before compose phase starts.`;
}

/** Compose prompt — fixed template, lean and complete */
function composePrompt(retryProblem: string | null): string {
  const emphasis = retryProblem ? `\n\nYour previous output had issues. Fix them now:\n${retryProblem}` : "";
  return `[PLAN MODE — COMPOSE PHASE]

Now write the implementation plan using the EXACT template below. Every section is required and must be non-empty.${emphasis}

<proposed_plan>
# Title

## Summary
One paragraph describing what this plan accomplishes.

## Key Changes
- File/area: what changes, and why
- File/area: what changes, and why

## Test Plan
How to verify the implementation works.

## Assumptions
What you assumed about the environment, dependencies, or user intent.
</proposed_plan>

Rules:
- Use the EXACT <proposed_plan> tags and template structure above.
- Be specific about files and changes. No placeholders.
- Do NOT suggest implementation — this is the plan.
- Keep it concise but decision-complete.`;
}

// ─── Validation ──────────────────────────────────────────────────────────────

const REQUIRED_SECTIONS = ["Summary", "Key Changes", "Test Plan", "Assumptions"];

function validatePlan(text: string): string | null {
  if (!text.includes("## Summary")) return "Missing section: ## Summary";
  if (!text.includes("## Key Changes")) return "Missing section: ## Key Changes";
  if (!text.includes("## Test Plan")) return "Missing section: ## Test Plan";
  if (!text.includes("## Assumptions")) return "Missing section: ## Assumptions";
  // Check each section has content beyond the header
  for (const section of REQUIRED_SECTIONS) {
    const parts = text.split(`## ${section}`);
    if (parts.length < 2) return `Empty section: ## ${section}`;
    const afterHeader = parts[1].split("\n## ")[0].trim();
    if (!afterHeader) return `Empty section: ## ${section}`;
  }
  return null; // valid
}

// ─── Helper: filter messages with plan context ───────────────────────────────

function hasPlanContext(msg: unknown): boolean {
  const m = msg as { customType?: string };
  return m.customType === "plan-mode-context" || m.customType === "proposed-plan";
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let state: PlanModeState = { enabled: false, phase: null, latestPlan: null, awaitingAction: false };
  let toolsBeforePlan: string[] | undefined;
  let askedQuestionThisRun = false;

  // ── Flags ──────────────────────────────────────────────────────────────────

  pi.registerFlag("plan", {
    description: "Start in Plan mode",
    type: "boolean",
    default: false,
  });

  // ── Tool: plan_mode_question (one question at a time) ──────────────────────

  pi.registerTool({
    name: PLAN_MODE_QUESTION_TOOL,
    label: "Plan question",
    description: "Ask the user ONE clarifying question during Plan mode. Call repeatedly for multiple questions, one at a time.",
    promptSnippet: "Ask users structured decision questions one at a time during planning",
    promptGuidelines: [
      "Use plan_mode_question for ONE question at a time — never batch multiple.",
      "Always provide your recommended answer as the first option with a clear rationale.",
      "Only ask when the answer materially changes the plan.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Stable identifier (snake_case)" }),
      header: Type.String({ description: "Short label (12 chars or fewer)" }),
      question: Type.String({ description: "Single-sentence question" }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "1-5 word label" }),
          description: Type.String({ description: "Short explanation of tradeoff" }),
        }),
        { minItems: 2, maxItems: 4 }
      ),
    }),
    async execute(_toolCallId: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) {
      if (!state.enabled) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ cancelled: true, reason: "plan_mode_inactive" }) }] };
      }
      const q = params as { id: string; header: string; question: string; options: QuestionOption[] };
      if (!q?.id || !q.header || !q.question || !q.options?.length) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ cancelled: true, reason: "invalid_input" }) }] };
      }
      if (!ctx.hasUI) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ cancelled: true, reason: "ui_unavailable" }) }] };
      }
      askedQuestionThisRun = true;

      const choices = q.options.map((o, i) => `${i + 1}. ${o.label} — ${o.description}`);
      const other = `${q.options.length + 1}. Other (type your own)`;
      const choice = await ctx.ui.select(`${q.header}: ${q.question}`, [...choices, other]);
      if (!choice) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ cancelled: true, reason: "cancelled" }) }] };
      }
      let answer: string;
      let wasCustom = false;
      if (choice === other) {
        const custom = (await ctx.ui.editor(q.question, ""))?.trim();
        if (!custom) return { content: [{ type: "text" as const, text: JSON.stringify({ cancelled: true, reason: "cancelled" }) }] };
        answer = custom;
        wasCustom = true;
      } else {
        const idx = choices.indexOf(choice);
        answer = q.options[idx].label;
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ cancelled: false, id: q.id, answer, wasCustom }) }],
      };
    },
  });

  // ── Command: /plan ─────────────────────────────────────────────────────────

  pi.registerCommand("plan", {
    description: "Enter or manage Plan mode. /plan tools — open tool selector.",
    handler: async (args, ctx) => {
      const trimmed = args.trim().toLowerCase();

      if (trimmed === "exit" || trimmed === "off") {
        exitPlanMode(ctx);
        ctx.ui.notify("Plan mode disabled.", "info");
        return;
      }

      if (trimmed === "tools") {
        if (!state.enabled) enterPlanMode(ctx);
        await showToolSelector(ctx);
        return;
      }

      if (!state.enabled) {
        enterPlanMode(ctx);
        ctx.ui.notify("Plan mode active — grilling first, then compose.", "info");
        return;
      }

      await showPlanMenu(ctx);
    },
  });

  // ── Events ─────────────────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    restoreState(ctx);
    if (pi.getFlag("plan") === true && !state.enabled) {
      state = { enabled: true, phase: "grill", latestPlan: null, awaitingAction: false, toolsBeforePlan: safeGetActiveTools() };
      toolsBeforePlan = state.toolsBeforePlan;
      setPlanTools(ctx);
      updateUi(ctx);
    }
    if (!state.enabled) removePlanQuestionTool();
    updateUi(ctx);
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    persistState();
  });

  // Block edit/write tools (safety net — both at event level and tool level)
  pi.on("tool_call", (event) => {
    if (!state.enabled) return;
    if (event.toolName === "edit" || event.toolName === "write") {
      return { block: true, reason: `Plan mode: '${event.toolName}' is blocked. Exit plan mode to edit files.` };
    }
    if (event.toolName === "bash") {
      const cmd = (event.input as { command?: string }).command ?? "";
      if (isDestructiveCommand(cmd)) {
        return { block: true, reason: `Plan mode blocks destructive bash. Exit plan mode to run: ${cmd}` };
      }
    }
  });

  pi.on("agent_start", () => {
    askedQuestionThisRun = false;
  });

  // Inject phase-specific prompt before agent start
  pi.on("before_agent_start", (event) => {
    if (!state.enabled) return;
    state.awaitingAction = false;
    if (state.phase === "compose") {
      return { systemPrompt: `${event.systemPrompt}\n\n${composePrompt(null)}` };
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${grillPrompt()}` };
  });

  // Detect proposed plan / manage transitions
  pi.on("agent_end", async (event, ctx) => {
    if (!state.enabled) return;
    const text = latestAssistantText(event.messages);

    // ── If a proposed plan is detected ────────────────────────────────────
    const match = PROPOSED_PLAN_RE.exec(text);
    if (match) {
      if (state.phase !== "compose") {
        setTimeout(() => {
          if (!state.enabled || state.phase !== "grill") return;
          pi.sendUserMessage("You wrote a plan before the user confirmed the grill phase is complete. Continue the grill phase: ask the next important one-at-a-time question, or state that no material uncertainty remains.", { deliverAs: "followUp" });
        }, 0);
        return;
      }

      const plan = match[1].trim();
      const validationError = validatePlan(plan);

      if (validationError) {
        requestComposeRetry(ctx, validationError);
        return;
      }

      // Valid plan
      state.latestPlan = plan;
      state.awaitingAction = true;
      persistState();
      updateUi(ctx);

      setTimeout(async () => {
        if (!state.enabled || !state.latestPlan) return;
        if (ctx.hasUI) {
          const choice = await ctx.ui.select("Plan ready — what next?", [
            "Implement this plan",
            "Stay in Plan mode",
            "Exit Plan mode (discard plan)",
          ]);
          if (choice === "Implement this plan") startImplementation(ctx);
          else if (choice === "Exit Plan mode (discard plan)") exitPlanMode(ctx);
        }
        pi.sendMessage(
          { customType: "proposed-plan", content: `**Proposed Plan**\n\n${state.latestPlan}`, display: true },
          { triggerTurn: false },
        );
      }, 0);
      return;
    }

    // ── Grill → compose transition ──────────────────────────────────────
    if (state.phase === "grill" && !state.latestPlan) {
      // If agent asked questions this turn, wait for more — don't prompt yet
      if (askedQuestionThisRun) return;

      setTimeout(async () => {
        if (!state.enabled || state.phase !== "grill") return;
        if (!ctx.hasUI) { state.phase = "compose"; persistState(); updateUi(ctx); return; }
        const proceed = await ctx.ui.confirm("Questions done?", "Proceed to compose phase — write the plan in fixed template?");
        if (proceed) {
          state.phase = "compose";
          persistState();
          updateUi(ctx);
          ctx.ui.notify("Compose phase — write plan in fixed template.", "info");
          pi.sendUserMessage("Proceed to write the plan using the fixed template.", { deliverAs: "followUp" });
        } else {
          pi.sendUserMessage("Continue the grill phase. Ask the next important one-at-a-time question, or explore the codebase first if the answer is discoverable.", { deliverAs: "followUp" });
        }
      }, 0);
      return;
    }

    if (state.phase === "compose" && !state.latestPlan) {
      requestComposeRetry(ctx, "Missing <proposed_plan>...</proposed_plan> block.");
    }
  });

  // Filter stale plan messages when not in plan mode
  pi.on("context", (event) => {
    if (state.enabled) return;
    return { messages: event.messages.filter((m) => !hasPlanContext(m)) };
  });

  // ── Core state management ──────────────────────────────────────────────────

  function enterPlanMode(ctx: ExtensionContext) {
    const selectedToolNames = state.selectedToolNames;
    if (!state.enabled) toolsBeforePlan = safeGetActiveTools();
    state = { enabled: true, phase: "grill", latestPlan: null, awaitingAction: false, selectedToolNames, toolsBeforePlan };
    setPlanTools(ctx);
    persistState();
    updateUi(ctx);
  }

  function exitPlanMode(ctx: ExtensionContext) {
    const selectedToolNames = state.selectedToolNames;
    state = { enabled: false, phase: null, latestPlan: null, awaitingAction: false, selectedToolNames };
    restoreTools();
    persistState();
    updateUi(ctx);
  }

  function startImplementation(ctx: ExtensionContext) {
    const plan = state.latestPlan;
    exitPlanMode(ctx);
    if (!plan) return;
    const msg = `Plan mode is now disabled. Implement this plan:\n\n<proposed_plan>\n${plan}\n</proposed_plan>`;
    if (ctx.isIdle()) pi.sendUserMessage(msg);
    else pi.sendUserMessage(msg, { deliverAs: "followUp" });
  }

  async function showPlanMenu(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const options = state.latestPlan
      ? ["Show plan", "Implement this plan", "Configure tools", "Stay in Plan mode", "Exit Plan mode"]
      : ["Configure tools", "Stay in Plan mode", "Exit Plan mode"];
    const choice = await ctx.ui.select(state.latestPlan ? "Plan ready. What next?" : "What next?", options);
    if (choice === "Show plan" && state.latestPlan) {
      ctx.ui.notify(state.latestPlan, "info");
    } else if (choice === "Implement this plan") {
      startImplementation(ctx);
    } else if (choice === "Configure tools") {
      await showToolSelector(ctx);
    } else if (choice === "Exit Plan mode") {
      exitPlanMode(ctx);
      ctx.ui.notify("Plan mode disabled.", "info");
    }
  }

  // ── Tool selector (narumitw-style paginated) ──────────────────────────────

  async function showToolSelector(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const allTools = selectableTools();
    if (allTools.length === 0) {
      ctx.ui.notify("No tools available.", "info");
      return;
    }

    let page = 0;
    const pageCount = Math.max(1, Math.ceil(allTools.length / TOOL_SELECTOR_PAGE_SIZE));

    while (true) {
      page = Math.min(page, pageCount - 1);
      const start = page * TOOL_SELECTOR_PAGE_SIZE;
      const pageTools = allTools.slice(start, start + TOOL_SELECTOR_PAGE_SIZE);
      const selected = new Set(state.selectedToolNames ?? defaultSelectedNames(allTools));

      const choices = pageTools.map((t, i) => {
        const blocked = isBlockedTool(t.name);
        const marker = blocked ? "[-]" : selected.has(t.name) ? "[x]" : "[ ]";
        const label = blocked ? "blocked in plan mode" : isBuiltin(t) ? (t.name === "bash" ? "built-in, destructive commands blocked" : "built-in") : `extension: ${sourceLabel(t)}`;
        return `${marker} ${start + i + 1}. ${t.name} (${label})`;
      });

      const nav: string[] = [];
      if (page > 0) nav.push("← Previous page");
      if (page < pageCount - 1) nav.push("Next page →");
      nav.push("Done");

      const choice = await ctx.ui.select(`Plan-mode tools (page ${page + 1}/${pageCount})`, [...choices, ...nav]);
      if (!choice || choice === "Done") break;

      if (choice === "← Previous page") { page--; continue; }
      if (choice === "Next page →") { page++; continue; }

      // Toggle tool selection
      const choiceIdx = choices.indexOf(choice);
      const toolName = pageTools[choiceIdx]?.name;
      if (!toolName || isBlockedTool(toolName)) continue;

      if (selected.has(toolName)) selected.delete(toolName);
      else selected.add(toolName);

      state.selectedToolNames = [...selected].sort();
      applySelectedTools(allTools, state.selectedToolNames);
      persistState();
      updateUi(ctx);
    }
  }

  function selectableTools(): ToolInfo[] {
    try {
      return pi.getAllTools()
        .filter((t) => t.name !== PLAN_MODE_QUESTION_TOOL)
        .sort((a, b) => {
          const aB = isBuiltin(a), bB = isBuiltin(b);
          if (aB !== bB) return aB ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
    } catch { return []; }
  }

  function defaultSelectedNames(tools: ToolInfo[]): string[] {
    // Default: ALL tools enabled except edit/write + plan_mode_question
    return tools.filter((t) => !isBlockedTool(t.name)).map((t) => t.name);
  }

  function isBlockedTool(name: string): boolean {
    return BLOCKED_BUILTIN_NAMES.has(name) || name === PLAN_MODE_QUESTION_TOOL;
  }

  function isBuiltin(t: ToolInfo): boolean {
    return t.sourceInfo?.source === "builtin";
  }

  function sourceLabel(t: ToolInfo): string {
    const s = t.sourceInfo;
    return s?.path ? `${s.source}/${s.scope} ${s.path}` : `${s?.source ?? "unknown"}`;
  }

  // ── Tool management ────────────────────────────────────────────────────────

  function setPlanTools(ctx: ExtensionContext) {
    const allTools = selectableTools();
    const names = state.selectedToolNames ?? defaultSelectedNames(allTools);
    state.selectedToolNames = names;
    applySelectedTools(allTools, names);
  }

  function applySelectedTools(allTools: ToolInfo[], selectedNames: string[]) {
    const selectable = new Set(selectedNames.filter((n) => allTools.some((t) => t.name === n) && !isBlockedTool(n)));
    const tools = [...selectable, PLAN_MODE_QUESTION_TOOL].sort();
    pi.setActiveTools(tools);
  }

  function restoreTools() {
    const tools = toolsBeforePlan ?? state.toolsBeforePlan ?? FULL_TOOLS;
    pi.setActiveTools(tools.filter((t) => t !== PLAN_MODE_QUESTION_TOOL));
    toolsBeforePlan = undefined;
  }

  function removePlanQuestionTool() {
    const active = safeGetActiveTools();
    const filtered = active.filter((t) => t !== PLAN_MODE_QUESTION_TOOL);
    if (filtered.length !== active.length) pi.setActiveTools(filtered);
  }

  function safeGetActiveTools(): string[] {
    try { return pi.getActiveTools(); } catch { return FULL_TOOLS; }
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  function persistState() {
    pi.appendEntry(STATE_ENTRY_TYPE, state);
  }

  function requestComposeRetry(ctx: ExtensionContext, validationError: string) {
    state.phase = "compose";
    persistState();
    setTimeout(() => {
      if (!state.enabled || state.phase !== "compose") return;
      ctx.ui.notify(`Plan validation: ${validationError}. Retrying...`, "warning");
      pi.sendUserMessage(
        `The plan was incomplete. Fix this issue and rewrite with the exact template:\n${validationError}`,
        { deliverAs: "followUp" },
      );
    }, 0);
  }

  function restoreState(ctx: ExtensionContext) {
    const entries = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: Partial<PlanModeState> }>;
    const entry = entries.filter((e) => e.type === "custom" && e.customType === STATE_ENTRY_TYPE).pop();
    if (entry?.data) {
      state = {
        enabled: entry.data.enabled ?? false,
        phase: entry.data.phase ?? (entry.data.enabled ? "grill" : null),
        latestPlan: entry.data.latestPlan ?? null,
        awaitingAction: entry.data.awaitingAction ?? false,
        selectedToolNames: entry.data.selectedToolNames,
        toolsBeforePlan: entry.data.toolsBeforePlan,
      };
      toolsBeforePlan = entry.data.toolsBeforePlan;
    }
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  function updateUi(ctx: ExtensionContext) {
    if (state.enabled) {
      const phaseLabel = state.phase === "compose" ? "composing" : "grilling";
      ctx.ui.setStatus(STATUS_KEY, state.latestPlan ? "📝 plan ready" : `📝 plan ${phaseLabel}`);
      if (state.latestPlan) {
        ctx.ui.setWidget(WIDGET_KEY, ["Proposed plan ready. Use /plan to review, implement, or exit."]);
      } else {
        const selectedCount = (state.selectedToolNames ?? defaultSelectedNames(selectableTools())).length;
        ctx.ui.setWidget(WIDGET_KEY, [`Plan mode: ${phaseLabel} | ${selectedCount} tools active | /plan tools to customize`]);
      }
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  }
}

// ─── Pure utilities ──────────────────────────────────────────────────────────

function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_RE.test(command.trim());
}

function readSkillPrompt(path: string): string | null {
  try {
    return readFileSync(path, "utf8").replace(/^---[\s\S]*?---\s*/, "").trim();
  } catch {
    return null;
  }
}

function latestAssistantText(messages: unknown[]): string {
  for (const entry of [...messages].reverse()) {
    const msg = (entry as { message?: { role?: string; content?: unknown } }).message ?? entry as { role?: string; content?: unknown };
    if (msg.role !== "assistant") continue;
    return messageText(msg);
  }
  return "";
}

function messageText(msg: { content?: unknown }): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((b: { type?: string }) => b.type === "text")
      .map((b: { text?: string }) => b.text ?? "")
      .join("\n");
  }
  return "";
}
