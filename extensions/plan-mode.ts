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

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

// ─── Constants ───────────────────────────────────────────────────────────────

const STATE_ENTRY_TYPE = "pi-plan-mode";
const STATUS_KEY = "plan-mode";
const WIDGET_KEY = "plan-mode";

const PLAN_MODE_QUESTION_TOOL = "plan_mode_question";
const PLAN_MODE_READY_TOOL = "plan_mode_ready_to_compose";
const PLAN_ONLY_TOOLS = [
  PLAN_MODE_QUESTION_TOOL,
  PLAN_MODE_READY_TOOL,
  "submit_plan",
];
const UPDATE_PLAN_TASK_TOOL = "update_plan_task";
const TOOL_SELECTOR_PAGE_SIZE = 10;
const GRILLING_SKILL_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "skills",
  "grilling",
  "SKILL.md",
);

const BLOCKED_BUILTIN_NAMES = new Set(["edit", "write"]);
const FULL_TOOLS = ["read", "bash", "edit", "write"];

// Bash stays available in plan mode, but obvious write/destructive commands are blocked.
const DESTRUCTIVE_RE =
  /\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|dd|sudo|su|kill|pkill|killall|reboot|shutdown|npm\s+(install|uninstall|update|ci|link|publish)|yarn\s+(add|remove|install|publish)|pnpm\s+(add|remove|install|publish)|bun\s+(add|remove|install|update)|pip\s+(install|uninstall)|uv\s+(add|remove|sync|lock)|git\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone)|(vim?|nano|emacs|code|subl))\b|(^|[^<])>(?!>)|>>/i;

// ─── Types ───────────────────────────────────────────────────────────────────

interface PlanModeState {
  enabled: boolean;
  phase: "grill" | "awaiting_compose_confirmation" | "compose" | null;
  latestPlan: string | null;
  awaitingAction: boolean;
  selectedToolNames?: string[];
  knownToolNames?: string[];
  toolsBeforePlan?: string[];
}

interface QuestionOption {
  label: string;
  description: string;
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

/** Grilling skill prompt — loaded from the local skill so edits stay in sync */
function grillPrompt(): string {
  const skillText =
    readSkillPrompt(GRILLING_SKILL_PATH) ??
    `Interview the user relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a question can be answered by exploring the codebase, explore the codebase instead.`;

  return `[PLAN MODE — GRILL PHASE]

${skillText}

Plan-mode rules:
- Ask questions ONE AT A TIME using the <tool>plan_mode_question</tool> tool. Never batch multiple questions.
- The number of questions is not capped: keep asking one at a time until important uncertainty is resolved.
- Only ask about things that materially affect the plan: scope, approach, tradeoffs, constraints, preferences.
- If a question can be answered by exploring the codebase (reading files, searching config, checking packages), explore first instead of asking.
- Do NOT produce a <proposed_plan> block yet. When no important uncertainty remains, call <tool>plan_mode_ready_to_compose</tool>. The user can also type /plan compose to start compose phase.`;
}

/** Compose prompt — fixed template, lean and complete */
function composePrompt(retryProblem: string | null): string {
  const emphasis = retryProblem
    ? `\n\nYour previous output had issues. Fix them now:\n${retryProblem}`
    : "";
  return `[PLAN MODE — COMPOSE PHASE]

Now call the <tool>submit_plan</tool> tool with your plan.
Do NOT output markdown or <proposed_plan> tags — only call the tool.

Rules:
- Every task must have a concrete action with exact commands/tools.
- Every task must list the files it touches in target_files.
- Vague actions like "check", "review", "look into" are rejected by validation.
- Be specific and decision-complete.${emphasis}`;
}

// ─── Validation ──────────────────────────────────────────────────────────────

// ─── Helper: filter messages with plan context ───────────────────────────────

function hasPlanContext(msg: unknown): boolean {
  const m = msg as { customType?: string };
  return (
    m.customType === "plan-mode-context" ||
    m.customType === "proposed-plan" ||
    m.customType === "plan-mode-instruction"
  );
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let state: PlanModeState = {
    enabled: false,
    phase: null,
    latestPlan: null,
    awaitingAction: false,
  };
  let toolsBeforePlan: string[] | undefined;

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
    description:
      "Ask the user ONE clarifying question during Plan mode. Call repeatedly for multiple questions, one at a time.",
    promptSnippet:
      "Ask users structured decision questions one at a time during planning",
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
          description: Type.String({
            description: "Short explanation of tradeoff",
          }),
        }),
        { minItems: 2, maxItems: 4 },
      ),
    }),
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (!state.enabled) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                cancelled: true,
                reason: "plan_mode_inactive",
              }),
            },
          ],
        };
      }
      const q = params as {
        id: string;
        header: string;
        question: string;
        options: QuestionOption[];
      };
      if (!q?.id || !q.header || !q.question || !q.options?.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                cancelled: true,
                reason: "invalid_input",
              }),
            },
          ],
        };
      }
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                cancelled: true,
                reason: "ui_unavailable",
              }),
            },
          ],
        };
      }

      const choices = q.options.map(
        (o, i) => `${i + 1}. ${o.label} — ${o.description}`,
      );
      const other = `${q.options.length + 1}. Other (type your own)`;
      const choice = await ctx.ui.select(`${q.header}: ${q.question}`, [
        ...choices,
        other,
      ]);
      if (!choice) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ cancelled: true, reason: "cancelled" }),
            },
          ],
        };
      }
      let answer: string;
      let wasCustom = false;
      if (choice === other) {
        const custom = (await ctx.ui.editor(q.question, ""))?.trim();
        if (!custom)
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ cancelled: true, reason: "cancelled" }),
              },
            ],
          };
        answer = custom;
        wasCustom = true;
      } else {
        const idx = choices.indexOf(choice);
        answer = q.options[idx].label;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              cancelled: false,
              id: q.id,
              answer,
              wasCustom,
            }),
          },
        ],
      };
    },
  });

  // ── Tool: plan_mode_ready_to_compose (explicit grill → compose gate) ───────
  pi.registerTool({
    name: PLAN_MODE_READY_TOOL,
    label: "Ready to compose",
    description:
      "Call when grill-phase uncertainty is resolved and you are ready to ask the user for compose-phase confirmation.",
    promptSnippet:
      "Ask the user to confirm that plan grilling is complete before composing the plan",
    promptGuidelines: [
      "Use plan_mode_ready_to_compose only after material planning uncertainty is resolved.",
      "Do not write a proposed plan before plan_mode_ready_to_compose or /plan compose moves Plan mode into compose phase.",
    ],
    parameters: Type.Object({
      reason: Type.Optional(
        Type.String({
          description: "Brief reason the grill phase appears complete",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (!state.enabled || state.phase !== "grill") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, reason: "not_in_grill_phase" }),
            },
          ],
        };
      }
      const reason = (params as { reason?: string } | undefined)?.reason;
      const confirmed = await requestComposeConfirmation(ctx, reason);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, confirmed }),
          },
        ],
        terminate: true,
      };
    },
  });

  // ── Tool: submit_plan (structured plan submission, replaces proposed_plan tags) ──

  const SUBMIT_PLAN_TOOL = "submit_plan";

  pi.registerTool({
    name: SUBMIT_PLAN_TOOL,
    label: "Submit plan",
    description:
      "Submit a structured implementation plan after grill phase. Only available in compose phase.",
    promptSnippet:
      "Submit a structured plan with tasks, files, and verification steps",
    promptGuidelines: [
      "Use submit_plan only in compose phase — never in grill phase.",
      "Every task must have concrete action commands, specific target files, and clear verification.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Short plan title" }),
      summary: Type.String({
        description: "One paragraph describing what this plan accomplishes",
      }),
      tasks: Type.Array(
        Type.Object({
          id: Type.String({
            description: "Unique task identifier (kebab-case)",
          }),
          action: Type.String({
            description:
              "Concrete action with exact commands or edits. Vague verbs rejected.",
          }),
          target_files: Type.Array(Type.String(), {
            description:
              "Files this task touches. Empty only for discovery tasks.",
          }),
          verification: Type.String({
            description:
              "How to verify. Include command or explicit manual check.",
          }),
        }),
        { minItems: 1 },
      ),
      assumptions: Type.Array(Type.String(), {
        description:
          "What you assumed about environment, dependencies, user intent.",
      }),
    }),
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (!state.enabled || state.phase !== "compose") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                reason: "not_in_compose_phase",
              }),
            },
          ],
        };
      }
      const p = params as {
        title: string;
        summary: string;
        tasks: Array<{
          id: string;
          action: string;
          target_files: string[];
          verification: string;
        }>;
        assumptions: string[];
      };

      // Client-side validation
      const errors: string[] = [];
      const VAGUE_RE =
        /^(check|verify|review|look\s+into|fix\s+stuff|investigate|tweak|adjust|improve|refactor|clean\s+up)/i;
      for (const task of p.tasks) {
        if (!task.id)
          errors.push(`Task #${p.tasks.indexOf(task) + 1}: missing id`);
        if (!task.action) errors.push(`${task.id || "?"}: missing action`);
        else if (VAGUE_RE.test(task.action.trim()))
          errors.push(
            `${task.id}: vague action "${task.action}" — be concrete`,
          );
        if (
          (!task.target_files || task.target_files.length === 0) &&
          !task.id?.includes("discover") &&
          !task.id?.includes("explore")
        ) {
          errors.push(
            `${task.id}: target_files empty — list files or mark task as discovery/explore`,
          );
        }
        if (!task.verification) errors.push(`${task.id}: missing verification`);
      }

      if (errors.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, errors }),
            },
          ],
        };
      }

      // Render markdown
      const tasksMd = p.tasks
        .map(
          (t, i) =>
            `| ${i + 1} | ${t.action} | ${(t.target_files || []).join(", ") || "—"} | ${t.verification} |`,
        )
        .join("\n");
      const assumptionsMd = p.assumptions.map((a) => `- ${a}`).join("\n");
      const now = new Date().toISOString();
      const md = `# ${p.title}\n\nGenerated: ${now}\n\n## Summary\n${p.summary}\n\n## Tasks\n\n| # | Action | Files | Verification |\n|---|---|---|---|\n${tasksMd}\n\n## Assumptions\n${assumptionsMd}\n`;

      // Write to .plans/current.md (human-readable handoff)
      const cwd = process.cwd();
      const plansDir = join(cwd, ".plans");
      mkdirSync(plansDir, { recursive: true });
      writeFileSync(join(plansDir, "current.md"), md, "utf8");

      // Write .plans/current.tasks.jsonl — source of truth for task status
      const tasksJsonl =
        p.tasks
          .map((t) =>
            JSON.stringify({
              id: t.id,
              status: "pending",
              action: t.action,
              target_files: t.target_files,
              verification: t.verification,
            }),
          )
          .join("\n") + "\n";
      writeFileSync(join(plansDir, "current.tasks.jsonl"), tasksJsonl, "utf8");

      state.latestPlan = md;
      persistState();
      updateUi(ctx);

      // Send proposed-plan display message
      pi.sendMessage(
        {
          customType: "proposed-plan",
          content: "Proposed plan ready.",
          display: true,
        },
        { triggerTurn: false },
      );

      // Ask user what to do — await choice before returning
      if (ctx.hasUI) {
        const choice = await ctx.ui.select("Plan ready — what next?", [
          "Implement this plan",
          "Stay in Plan mode",
        ]);
        if (choice === "Implement this plan") {
          startImplementation(ctx);
        } else {
          const reason = (
            await ctx.ui.editor("Why not implement now?", "")
          )?.trim();
          const reasonSuffix = reason ? ` Reason: ${reason}.` : "";
          const reasonMsg = `Plan was not approved for execution.${reasonSuffix} Stay in compose phase — modify tasks and call submit_plan again, or use /plan for more options.`;
          if (ctx.isIdle())
            pi.sendMessage(
              {
                customType: "plan-mode-instruction",
                content: reasonMsg,
                display: false,
              },
              { triggerTurn: true },
            );
          else
            pi.sendMessage(
              {
                customType: "plan-mode-instruction",
                content: reasonMsg,
                display: false,
              },
              { triggerTurn: true, deliverAs: "followUp" },
            );
        }
      } else {
        // No UI — auto-implement
        startImplementation(ctx);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, taskCount: p.tasks.length }),
          },
        ],
        terminate: true,
      };
    },
  });

  // ── Tool: update_plan_task (update task status in JSONL ledger) ─────────────
  // ponytail: JSONL file read/write is fine at plan-scale task counts (<100).
  // Upgrade: switch to append-only log + compaction if task counts grow.

  pi.registerTool({
    name: UPDATE_PLAN_TASK_TOOL,
    label: "Update plan task",
    description:
      "Update a task's status in .plans/current.tasks.jsonl. Available during and after plan execution.",
    promptSnippet: "Track implementation progress by updating task statuses",
    promptGuidelines: [
      "Call update_plan_task after completing, starting, skipping, or blocking each task.",
      "Valid statuses: pending, in_progress, done, skipped, blocked.",
      "Update status promptly — the JSONL ledger is the source of truth.",
    ],
    parameters: Type.Object({
      task_id: Type.String({
        description: "Task identifier from the plan (kebab-case)",
      }),
      status: Type.Union(
        [
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("done"),
          Type.Literal("skipped"),
          Type.Literal("blocked"),
        ],
        { description: "New status for the task" },
      ),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { task_id, status } = params as { task_id: string; status: string };
      const validStatuses = new Set([
        "pending",
        "in_progress",
        "done",
        "skipped",
        "blocked",
      ]);
      if (!task_id || !validStatuses.has(status)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, reason: "invalid_input" }),
            },
          ],
        };
      }

      const jsonlPath = join(process.cwd(), ".plans", "current.tasks.jsonl");
      let lines: string[];
      try {
        const raw = readFileSync(jsonlPath, "utf8");
        lines = raw.split("\n").filter((l) => l.trim());
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, reason: "no_plan_active" }),
            },
          ],
        };
      }

      let found = false;
      const updated = lines.map((line) => {
        const task = JSON.parse(line);
        if (task.id === task_id) {
          found = true;
          task.status = status;
        }
        return JSON.stringify(task);
      });

      if (!found) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                reason: `task "${task_id}" not found`,
              }),
            },
          ],
        };
      }

      writeFileSync(jsonlPath, updated.join("\n") + "\n", "utf8");

      // Summary: count statuses for feedback
      const counts: Record<string, number> = {};
      for (const line of updated) {
        const s = (JSON.parse(line) as { status: string }).status;
        counts[s] = (counts[s] ?? 0) + 1;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              task_id,
              status,
              summary: counts,
            }),
          },
        ],
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

      if (trimmed === "compose") {
        if (!state.enabled) enterPlanMode(ctx);
        beginCompose(ctx);
        return;
      }

      if (trimmed === "tools") {
        if (!state.enabled) enterPlanMode(ctx);
        await showToolSelector(ctx);
        return;
      }

      if (!state.enabled) {
        enterPlanMode(ctx);
        ctx.ui.notify(
          "Plan mode active — grilling first, then compose.",
          "info",
        );
        return;
      }

      await showPlanMenu(ctx);
    },
  });

  // ── Events ─────────────────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    restoreState(ctx);
    if (pi.getFlag("plan") === true && !state.enabled) {
      state = {
        enabled: true,
        phase: "grill",
        latestPlan: null,
        awaitingAction: false,
        toolsBeforePlan: safeGetActiveTools(),
      };
      toolsBeforePlan = state.toolsBeforePlan;
    }
    if (state.enabled) setPlanTools(ctx);
    else removePlanQuestionTool();
    updateUi(ctx);
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    persistState();
  });

  // Block edit/write tools (safety net — both at event level and tool level)
  pi.on("tool_call", (event) => {
    if (!state.enabled) return;
    if (event.toolName === "edit" || event.toolName === "write") {
      return {
        block: true,
        reason: `Plan mode: '${event.toolName}' is blocked. Exit plan mode to edit files.`,
      };
    }
    if (event.toolName === "bash") {
      const cmd = (event.input as { command?: string }).command ?? "";
      if (isDestructiveCommand(cmd)) {
        return {
          block: true,
          reason: `Plan mode blocks destructive bash. Exit plan mode to run: ${cmd}`,
        };
      }
    }
  });

  // Inject phase-specific prompt before agent start
  pi.on("before_agent_start", (event, ctx) => {
    if (!state.enabled) return;
    setPlanTools(ctx);
    state.awaitingAction = false;
    if (state.phase === "compose") {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${composePrompt(null)}`,
      };
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${grillPrompt()}` };
  });

  // Detect compose completion via submit_plan (plan already stored by tool)
  pi.on("agent_end", async (event, ctx) => {
    if (!state.enabled) return;

    // If compose phase ended and no plan was submitted, retry
    if (state.phase === "compose" && !state.latestPlan) {
      requestComposeRetry(
        ctx,
        "No plan submitted. Call the submit_plan tool with your plan.",
      );
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
    const knownToolNames = state.knownToolNames;
    if (!state.enabled) toolsBeforePlan = safeGetActiveTools();
    state = {
      enabled: true,
      phase: "grill",
      latestPlan: null,
      awaitingAction: false,
      selectedToolNames,
      knownToolNames,
      toolsBeforePlan,
    };
    setPlanTools(ctx);
    persistState();
    updateUi(ctx);
  }

  function exitPlanMode(ctx: ExtensionContext) {
    const selectedToolNames = state.selectedToolNames;
    const knownToolNames = state.knownToolNames;
    state = {
      enabled: false,
      phase: null,
      latestPlan: null,
      awaitingAction: false,
      selectedToolNames,
      knownToolNames,
    };
    restoreTools();
    persistState();
    updateUi(ctx);
  }

  function startImplementation(ctx: ExtensionContext) {
    exitPlanMode(ctx);
    // Keep update_plan_task active for task tracking during execution
    const active = safeGetActiveTools();
    if (!active.includes(UPDATE_PLAN_TASK_TOOL)) {
      pi.setActiveTools([...active, UPDATE_PLAN_TASK_TOOL]);
    }
    const msg =
      "Read `.plans/current.tasks.jsonl` for the task ledger. Execute tasks step by step. Update task status with `update_plan_task` as you go — start each task with in_progress, then done/skipped/blocked.";
    if (ctx.isIdle())
      pi.sendMessage(
        { customType: "plan-mode-instruction", content: msg, display: false },
        { triggerTurn: true },
      );
    else
      pi.sendMessage(
        { customType: "plan-mode-instruction", content: msg, display: false },
        { triggerTurn: true, deliverAs: "followUp" },
      );
  }

  function beginCompose(ctx: ExtensionContext) {
    state.phase = "compose";
    persistState();
    updateUi(ctx);
    ctx.ui.notify("Compose phase — submit structured plan.", "info");
    const msg = "Compose the plan now.";
    if (ctx.isIdle()) pi.sendUserMessage(msg);
    else pi.sendUserMessage(msg, { deliverAs: "followUp" });
  }

  async function requestComposeConfirmation(
    ctx: ExtensionContext,
    reason?: string,
  ) {
    if (!ctx.hasUI) {
      beginCompose(ctx);
      return true;
    }

    state.phase = "awaiting_compose_confirmation";
    persistState();
    updateUi(ctx);

    const detail = reason ? `\n\nReason: ${reason}` : "";
    const proceed = await ctx.ui.confirm(
      "Questions done?",
      `Proceed to compose phase — write the plan in fixed template?${detail}`,
    );
    if (proceed) {
      beginCompose(ctx);
      return true;
    }

    state.phase = "grill";
    persistState();
    updateUi(ctx);
    const denyReason = (
      await ctx.ui.editor("Why not proceed to compose?", "")
    )?.trim();
    const reasonSuffix = denyReason ? ` Reason: ${denyReason}.` : "";
    const reasonMsg = `Compose phase declined.${reasonSuffix} Continue the grill phase — ask targeted questions about this concern.`;
    if (ctx.isIdle())
      pi.sendMessage(
        {
          customType: "plan-mode-instruction",
          content: reasonMsg,
          display: false,
        },
        { triggerTurn: true },
      );
    else
      pi.sendMessage(
        {
          customType: "plan-mode-instruction",
          content: reasonMsg,
          display: false,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    return false;
  }

  async function showPlanMenu(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const options = state.latestPlan
      ? ["Implement this plan", "Stay in Plan mode"]
      : [
          "Compose plan",
          "Configure tools",
          "Stay in Plan mode",
          "Exit Plan mode",
        ];
    const choice = await ctx.ui.select(
      state.latestPlan ? "Plan ready. What next?" : "What next?",
      options,
    );
    if (choice === "Implement this plan") {
      startImplementation(ctx);
    } else if (choice === "Compose plan") {
      beginCompose(ctx);
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
    setPlanTools(ctx);
    const allTools = selectableTools();
    if (allTools.length === 0) {
      ctx.ui.notify("No tools available.", "info");
      return;
    }

    let page = 0;
    const pageCount = Math.max(
      1,
      Math.ceil(allTools.length / TOOL_SELECTOR_PAGE_SIZE),
    );

    while (true) {
      page = Math.min(page, pageCount - 1);
      const start = page * TOOL_SELECTOR_PAGE_SIZE;
      const pageTools = allTools.slice(start, start + TOOL_SELECTOR_PAGE_SIZE);
      const selected = new Set(
        state.selectedToolNames ?? defaultSelectedNames(allTools),
      );

      const choices = pageTools.map((t, i) => {
        const blocked = isBlockedTool(t.name);
        const marker = blocked ? "[-]" : selected.has(t.name) ? "[x]" : "[ ]";
        const label = blocked
          ? "blocked in plan mode"
          : isBuiltin(t)
            ? t.name === "bash"
              ? "built-in, destructive commands blocked"
              : "built-in"
            : `extension: ${sourceLabel(t)}`;
        return `${marker} ${start + i + 1}. ${t.name} (${label})`;
      });

      const nav: string[] = [];
      if (page > 0) nav.push("← Previous page");
      if (page < pageCount - 1) nav.push("Next page →");
      nav.push("Done");

      const choice = await ctx.ui.select(
        `Plan-mode tools (page ${page + 1}/${pageCount})`,
        [...choices, ...nav],
      );
      if (!choice || choice === "Done") break;

      if (choice === "← Previous page") {
        page--;
        continue;
      }
      if (choice === "Next page →") {
        page++;
        continue;
      }

      // Toggle tool selection
      const choiceIdx = choices.indexOf(choice);
      const toolName = pageTools[choiceIdx]?.name;
      if (!toolName || isBlockedTool(toolName)) continue;

      if (selected.has(toolName)) selected.delete(toolName);
      else selected.add(toolName);

      state.selectedToolNames = [...selected].sort();
      state.knownToolNames = allTools.map((t) => t.name).sort();
      applySelectedTools(allTools, state.selectedToolNames);
      persistState();
      updateUi(ctx);
    }
  }

  function selectableTools(): ToolInfo[] {
    try {
      return pi
        .getAllTools()
        .filter((t) => !PLAN_ONLY_TOOLS.includes(t.name))
        .sort((a, b) => {
          const aB = isBuiltin(a),
            bB = isBuiltin(b);
          if (aB !== bB) return aB ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
    } catch {
      return [];
    }
  }

  function defaultSelectedNames(tools: ToolInfo[]): string[] {
    // Default: ALL tools enabled except edit/write + plan_mode_question
    return tools.filter((t) => !isBlockedTool(t.name)).map((t) => t.name);
  }

  function isBlockedTool(name: string): boolean {
    return BLOCKED_BUILTIN_NAMES.has(name) || PLAN_ONLY_TOOLS.includes(name);
  }

  function isBuiltin(t: ToolInfo): boolean {
    return t.sourceInfo?.source === "builtin";
  }

  function sourceLabel(t: ToolInfo): string {
    const s = t.sourceInfo;
    return s?.path
      ? `${s.source}/${s.scope} ${s.path}`
      : `${s?.source ?? "unknown"}`;
  }

  // ── Tool management ────────────────────────────────────────────────────────

  function setPlanTools(ctx: ExtensionContext) {
    const allTools = selectableTools();
    const allNames = allTools.map((t) => t.name).sort();
    const defaults = defaultSelectedNames(allTools);
    const known = new Set(state.knownToolNames ?? []);
    const names = state.selectedToolNames
      ? [
          ...new Set([
            ...state.selectedToolNames,
            ...defaults.filter((name) => !known.has(name)),
          ]),
        ]
      : defaults;
    state.selectedToolNames = names.sort();
    state.knownToolNames = allNames;
    applySelectedTools(allTools, state.selectedToolNames);
  }

  function applySelectedTools(allTools: ToolInfo[], selectedNames: string[]) {
    const selectable = new Set(
      selectedNames.filter(
        (n) => allTools.some((t) => t.name === n) && !isBlockedTool(n),
      ),
    );
    const tools = [...selectable, ...PLAN_ONLY_TOOLS].sort();
    pi.setActiveTools(tools);
  }

  function restoreTools() {
    const tools = toolsBeforePlan ?? state.toolsBeforePlan ?? FULL_TOOLS;
    const restored = tools.filter((t) => !PLAN_ONLY_TOOLS.includes(t));
    pi.setActiveTools(restored);
    toolsBeforePlan = undefined;
  }

  function removePlanQuestionTool() {
    const active = safeGetActiveTools();
    const filtered = active.filter((t) => !PLAN_ONLY_TOOLS.includes(t));
    if (filtered.length !== active.length) pi.setActiveTools(filtered);
  }

  function safeGetActiveTools(): string[] {
    try {
      return pi.getActiveTools();
    } catch {
      return FULL_TOOLS;
    }
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
      ctx.ui.notify(
        `Plan validation: ${validationError}. Retrying...`,
        "warning",
      );
      pi.sendUserMessage(
        `The plan was incomplete: ${validationError}. Rewrite using the exact template from the compose-phase instructions.`,
        { deliverAs: "followUp" },
      );
    }, 0);
  }

  function restoreState(ctx: ExtensionContext) {
    const entries = ctx.sessionManager.getBranch() as Array<{
      type?: string;
      customType?: string;
      data?: Partial<PlanModeState>;
    }>;
    const entry = entries
      .filter((e) => e.type === "custom" && e.customType === STATE_ENTRY_TYPE)
      .pop();
    if (entry?.data) {
      state = {
        enabled: entry.data.enabled ?? false,
        phase: entry.data.phase ?? (entry.data.enabled ? "grill" : null),
        latestPlan: entry.data.latestPlan ?? null,
        awaitingAction: entry.data.awaitingAction ?? false,
        selectedToolNames: entry.data.selectedToolNames,
        knownToolNames: entry.data.knownToolNames,
        toolsBeforePlan: entry.data.toolsBeforePlan,
      };
      toolsBeforePlan = entry.data.toolsBeforePlan;
    }
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  function updateUi(ctx: ExtensionContext) {
    if (state.enabled) {
      const phaseLabel =
        state.phase === "compose"
          ? "composing"
          : state.phase === "awaiting_compose_confirmation"
            ? "confirming"
            : "grilling";
      ctx.ui.setStatus(
        STATUS_KEY,
        state.latestPlan ? "📝 plan ready" : `📝 plan ${phaseLabel}`,
      );
      if (state.latestPlan) {
        ctx.ui.setWidget(WIDGET_KEY, [
          "Proposed plan ready. Use /plan to review, implement, or exit.",
        ]);
      } else {
        const selectedCount = (
          state.selectedToolNames ?? defaultSelectedNames(selectableTools())
        ).length;
        ctx.ui.setWidget(WIDGET_KEY, [
          `Plan mode: ${phaseLabel} | ${selectedCount} tools active | /plan tools to customize`,
        ]);
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
    return readFileSync(path, "utf8")
      .replace(/^---[\s\S]*?---\s*/, "")
      .trim();
  } catch {
    return null;
  }
}

function latestAssistantText(messages: unknown[]): string {
  for (const entry of [...messages].reverse()) {
    const msg =
      (entry as { message?: { role?: string; content?: unknown } }).message ??
      (entry as { role?: string; content?: unknown });
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
