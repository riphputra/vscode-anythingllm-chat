import * as vscode from 'vscode';
import { AnythingLLMClient, AnythingLLMError } from './anythingllmClient';
import { executeTool, toNativeToolDefinitions, type ToolContext, type ToolProgressFn } from './agentTools';
import { Config } from './config';
import { Logger } from './logger';
import type {
  AgentEventHandler,
  AgentPlan,
  AgentStep,
  AgentStepStatus,
  AgentToolName,
  ChatStreamChunk,
  NativeToolCall,
} from './types';

/**
 * Tier 3 — Agentic mode (v0.3.0).
 *
 * Supports four planner strategies:
 *   1. 'heuristic' — pattern-match intent from the goal (fast, deterministic)
 *   2. 'llm'        — ask the LLM to produce a JSON plan (for complex goals)
 *   3. 'react'      — ReAct loop: Reason → Act → Observe → repeat until the goal is met or maxIterations is hit (default)
 *   4. 'native'     — use AnythingLLM's native function-calling API (if the model supports it)
 *
 * The tool registry lives in agentTools.ts (11 tools + vector_search).
 */

const MAX_ITERATIONS_DEFAULT = 5;
const MAX_STEPS_TOTAL = 25;
const MAX_CHARS_PER_OBSERVATION = 8_000;

export type { AgentStepStatus, AgentToolName };

export interface AgentRunOptions {
  strategy?: 'heuristic' | 'llm' | 'react' | 'native';
  maxIterations?: number;
  /** MCP call function (from the MCP client) */
  mcpCall?: ToolContext['mcpCall'];
}

interface AgentContext {
  workspaceSlug: string;
  goal: string;
  editorContext?: { label: string; content: string; language: string };
  accumulatedSources: Array<{ title?: string; source: string; text?: string }>;
  accumulatedObservations: string[];
  abortSignal?: AbortSignal;
  iteration: number;
  toolContext: ToolContext;
}

export class Agent {
  constructor(private client: AnythingLLMClient) {}

  /**
   * Run the agent loop.
   */
  async run(
    workspaceSlug: string,
    goal: string,
    onEvent: AgentEventHandler,
    abortSignal?: AbortSignal,
    options: AgentRunOptions = {}
  ): Promise<void> {
    if (!workspaceSlug) {
      onEvent({ type: 'error', payload: { message: 'No workspace selected.' } });
      return;
    }
    if (!goal.trim()) {
      onEvent({ type: 'error', payload: { message: 'Agent goal cannot be empty.' } });
      return;
    }

    const strategy = options.strategy ?? this.getDefaultStrategy();
    const maxIterations = Math.min(options.maxIterations ?? this.getDefaultMaxIterations(), 10);

    const ctx: AgentContext = {
      workspaceSlug,
      goal: goal.trim(),
      editorContext: this.getActiveEditorContext(),
      accumulatedSources: [],
      accumulatedObservations: [],
      abortSignal,
      iteration: 0,
      toolContext: {
        workspaceSlug,
        client: this.client,
        signal: abortSignal,
        mcpCall: options.mcpCall,
      },
    };

    try {
      onEvent({
        type: 'plan_created',
        payload: {
          strategy,
          maxIterations,
          goal: ctx.goal,
        },
      });

      switch (strategy) {
        case 'react':
          await this.runReActLoop(ctx, onEvent, maxIterations);
          break;
        case 'llm':
          await this.runLlmPlannerLoop(ctx, onEvent);
          break;
        case 'native':
          await this.runNativeFunctionCallingLoop(ctx, onEvent);
          break;
        case 'heuristic':
        default:
          await this.runHeuristicLoop(ctx, onEvent);
          break;
      }

      onEvent({
        type: 'done',
        payload: {
          sourcesCount: ctx.accumulatedSources.length,
          iterations: ctx.iteration,
          strategy,
        },
      });
    } catch (err) {
      Logger.error('Agent loop error', err);
      const msg = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'error', payload: { message: msg } });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Strategy 1: Heuristic planner (original, kept as fallback)
  // ─────────────────────────────────────────────────────────────────────────────

  private async runHeuristicLoop(ctx: AgentContext, onEvent: AgentEventHandler): Promise<void> {
    const plan = this.buildHeuristicPlan(ctx);
    onEvent({
      type: 'plan_updated',
      payload: {
        goal: plan.goal,
        steps: plan.steps.map((s) => this.stepToPublic(s)),
      },
    });

    for (const step of plan.steps) {
      if (ctx.abortSignal?.aborted) {
        onEvent({ type: 'error', payload: { message: 'Agent cancelled.' } });
        return;
      }
      await this.executeStep(step, ctx, onEvent);
    }
  }

  private buildHeuristicPlan(ctx: AgentContext): AgentPlan {
    const goal = ctx.goal.toLowerCase();
    const steps: AgentStep[] = [];
    let stepId = 0;
    const nextId = () => `s${++stepId}`;

    const editorKeywords = ['file', 'code', 'this', 'current', 'active', 'editor', 'selection'];
    const wantsEditor = ctx.editorContext && editorKeywords.some((k) => goal.includes(k));
    if (wantsEditor && ctx.editorContext) {
      steps.push({
        id: nextId(),
        tool: 'read_editor',
        title: `Read editor context: ${ctx.editorContext.label}`,
        detail: `${ctx.editorContext.language} • ${ctx.editorContext.content.length} chars`,
        status: 'pending',
      });
    }

    const searchKeywords = ['search', 'doc', 'document', 'information', 'info', 'about', 'find', 'look up'];
    const wantsSearch = searchKeywords.some((k) => goal.includes(k));
    if (wantsSearch) {
      steps.push({
        id: nextId(),
        tool: 'vector_search',
        title: 'Search for relevant documents in the workspace',
        detail: `Query: "${this.extractQuery(ctx.goal)}"`,
        status: 'pending',
      });
    }

    const uploadKeywords = ['upload', 'add', 'embed', 'insert'];
    const wantsUpload = ctx.editorContext && uploadKeywords.some((k) => goal.includes(k));
    if (wantsUpload) {
      steps.push({
        id: nextId(),
        tool: 'upload_current',
        title: `Upload ${ctx.editorContext?.label} to the workspace`,
        status: 'pending',
      });
    }

    steps.push({
      id: nextId(),
      tool: 'chat',
      title: 'Generate the final answer with LLM + RAG',
      detail: 'Synthesize all accumulated context',
      status: 'pending',
    });

    steps.push({ id: nextId(), tool: 'finalize', title: 'Done', status: 'pending' });
    return { goal: ctx.goal, steps, strategy: 'heuristic' };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Strategy 2: LLM-based planner
  // ─────────────────────────────────────────────────────────────────────────────

  private async runLlmPlannerLoop(ctx: AgentContext, onEvent: AgentEventHandler): Promise<void> {
    const plan = await this.buildLlmPlan(ctx, onEvent);
    onEvent({
      type: 'plan_updated',
      payload: {
        goal: plan.goal,
        steps: plan.steps.map((s) => this.stepToPublic(s)),
      },
    });

    for (const step of plan.steps) {
      if (ctx.abortSignal?.aborted) {
        onEvent({ type: 'error', payload: { message: 'Agent cancelled.' } });
        return;
      }
      await this.executeStep(step, ctx, onEvent);
    }
  }

  private async buildLlmPlan(ctx: AgentContext, onEvent: AgentEventHandler): Promise<AgentPlan> {
    const toolsList = ['vector_search', 'read_editor', 'upload_current', 'file_read', 'grep_search', 'run_diagnostics', 'web_fetch', 'git_status', 'list_directory'];
    const plannerPrompt = `You are an AI Agent planner. Given a user goal, return a JSON plan of tool calls.

Available tools: ${toolsList.join(', ')}

Goal: "${ctx.goal}"

Return STRICT JSON in this format (no prose, no markdown fence):
{
  "steps": [
    { "tool": "<tool_name>", "title": "<short title>", "detail": "<what to do>", "args": { "<arg>": "<value>" } }
  ]
}

Rules:
- Maximum 6 steps.
- The last step should always be "chat" (to synthesize the final answer).
- Use "read_editor" only if user references the active editor.
- Use "vector_search" if user asks about documents/information.
- Use specific tools (file_read, grep_search, run_diagnostics) when clearly needed.`;

    onEvent({ type: 'step_progress', payload: { stepId: 'planner', message: 'Asking the LLM to produce a plan...' } });

    let planJson = '';
    try {
      await this.client.streamChat(
        ctx.workspaceSlug,
        {
          message: plannerPrompt,
          mode: 'chat',
        },
        (chunk: ChatStreamChunk) => {
          if (chunk.textResponse) planJson += chunk.textResponse;
        },
        ctx.abortSignal
      );
    } catch (err) {
      Logger.warn('LLM planner failed, falling back to heuristic', err);
      return this.buildHeuristicPlan(ctx);
    }

    // Try to parse JSON (be tolerant of ```json fences)
    const jsonStr = planJson.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let parsed: { steps?: Array<{ tool: string; title: string; detail?: string; args?: Record<string, unknown> }> };
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      Logger.warn('LLM planner returned invalid JSON, falling back to heuristic');
      return this.buildHeuristicPlan(ctx);
    }

    const steps: AgentStep[] = (parsed.steps ?? []).slice(0, 6).map((s, i) => ({
      id: `s${i + 1}`,
      tool: (s.tool as AgentToolName) ?? 'chat',
      title: s.title || s.tool,
      detail: s.detail,
      status: 'pending' as AgentStepStatus,
      reasoning: `LLM-planned: ${s.tool}`,
    }));

    // Always ensure finalize at the end
    if (steps.length === 0 || steps[steps.length - 1].tool !== 'finalize') {
      steps.push({ id: `s${steps.length + 1}`, tool: 'finalize', title: 'Done', status: 'pending' });
    }

    return { goal: ctx.goal, steps, strategy: 'llm' };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Strategy 3: ReAct (Reason → Act → Observe → repeat)
  // ─────────────────────────────────────────────────────────────────────────────

  private async runReActLoop(ctx: AgentContext, onEvent: AgentEventHandler, maxIterations: number): Promise<void> {
    for (let iter = 1; iter <= maxIterations; iter++) {
      if (ctx.abortSignal?.aborted) {
        onEvent({ type: 'error', payload: { message: 'Agent cancelled.' } });
        return;
      }
      if (iter > MAX_STEPS_TOTAL) {
        onEvent({ type: 'error', payload: { message: `Max total steps (${MAX_STEPS_TOTAL}) reached.` } });
        return;
      }

      ctx.iteration = iter;
      onEvent({ type: 'iteration', payload: { iteration: iter, maxIterations } });

      // 1. REASON: ask LLM what to do next given history of observations
      const prompt = this.buildReActPrompt(ctx, iter);
      let thought = '';

      const thoughtStep: AgentStep = {
        id: `iter${iter}-thought`,
        tool: 'plan',
        title: `Iterasi ${iter}: Berpikir`,
        status: 'running',
        iteration: iter,
      };
      onEvent({ type: 'step_start', payload: { stepId: thoughtStep.id, tool: 'plan', iteration: iter } });
      onEvent({ type: 'step_progress', payload: { stepId: thoughtStep.id, message: 'Reasoning...' } });

      try {
        await this.client.streamChat(
          ctx.workspaceSlug,
          { message: prompt, mode: 'chat' },
          (chunk: ChatStreamChunk) => {
            if (ctx.abortSignal?.aborted) return;
            if (chunk.textResponse) {
              thought += chunk.textResponse;
              onEvent({ type: 'thinking', payload: { text: chunk.textResponse, iteration: iter } });
            }
          },
          ctx.abortSignal
        );
      } catch (err) {
        thoughtStep.status = 'failed';
        const msg = err instanceof Error ? err.message : String(err);
        onEvent({ type: 'step_failed', payload: { stepId: thoughtStep.id, tool: 'plan', error: msg } });
        throw err;
      }

      thoughtStep.status = 'done';
      thoughtStep.result = thought.slice(0, 500);
      thoughtStep.endedAt = Date.now();
      thoughtStep.startedAt = thoughtStep.startedAt ?? Date.now();
      onEvent({ type: 'step_done', payload: { stepId: thoughtStep.id, tool: 'plan', result: thought.slice(0, 200), durationMs: 0 } });

      // Parse thought for ACTION
      const actionMatch = thought.match(/ACTION:\s*(\w+)\s*(?:\((.+?)\))?/i);
      const finishMatch = thought.match(/FINAL_ANSWER\s*:/i) || thought.match(/FINISH\s*$/i) || thought.match(/^FINISH\s*$/im);

      if (finishMatch || iter === maxIterations) {
        // 3. FINAL: synthesize answer from all observations
        onEvent({ type: 'step_progress', payload: { stepId: thoughtStep.id, message: 'Synthesizing final answer...' } });
        await this.synthesizeFinalAnswer(ctx, onEvent, thought);
        return;
      }

      if (!actionMatch) {
        // LLM didn't follow format — try synthesize anyway
        await this.synthesizeFinalAnswer(ctx, onEvent, thought);
        return;
      }

      const toolName = actionMatch[1].toLowerCase();
      const argsStr = actionMatch[2];

      // 2. ACT: execute the chosen tool
      const actStep: AgentStep = {
        id: `iter${iter}-act`,
        tool: (toolName as AgentToolName) ?? 'chat',
        title: `Iterasi ${iter}: Eksekusi ${toolName}`,
        status: 'running',
        iteration: iter,
        reasoning: thought.slice(0, 300),
      };
      onEvent({ type: 'step_start', payload: { stepId: actStep.id, tool: toolName, iteration: iter } });

      let args: Record<string, unknown> = {};
      if (argsStr) {
        try {
          args = JSON.parse(argsStr);
        } catch {
          // Treat as query string
          args = { query: argsStr, path: argsStr, pattern: argsStr, command: argsStr, url: argsStr };
        }
      }

      onEvent({
        type: 'tool_call',
        payload: {
          stepId: actStep.id,
          tool: toolName,
          args,
          iteration: iter,
        },
      });

      const progress: ToolProgressFn = (msg) => {
        onEvent({ type: 'step_progress', payload: { stepId: actStep.id, message: msg, iteration: iter } });
      };

      const result = await executeTool(toolName, args, ctx.toolContext, progress);

      actStep.status = result.ok ? 'done' : 'failed';
      actStep.result = result.output.slice(0, 500);
      actStep.endedAt = Date.now();
      onEvent({
        type: result.ok ? 'step_done' : 'step_failed',
        payload: {
          stepId: actStep.id,
          tool: toolName,
          result: result.output.slice(0, 200),
          error: result.ok ? undefined : result.output,
          iteration: iter,
        },
      });
      onEvent({
        type: 'tool_result',
        payload: {
          stepId: actStep.id,
          tool: toolName,
          ok: result.ok,
          output: result.output,
          iteration: iter,
        },
      });

      if (result.sources && result.sources.length > 0) {
        for (const s of result.sources) ctx.accumulatedSources.push(s);
        onEvent({ type: 'sources', payload: { sources: ctx.accumulatedSources.map((s) => ({ title: s.title ?? s.source, source: s.source, text: s.text?.slice(0, 300) })) } });
      }

      // 3. OBSERVE: store observation for next iteration
      ctx.accumulatedObservations.push(`[Iteration ${iter}] Tool: ${toolName}\nArgs: ${JSON.stringify(args).slice(0, 500)}\nResult: ${result.output.slice(0, MAX_CHARS_PER_OBSERVATION)}`);
    }

    // Hit max iterations — synthesize anyway
    onEvent({ type: 'step_progress', payload: { message: 'Max iterations reached, synthesizing final answer...' } });
    await this.synthesizeFinalAnswer(ctx, onEvent, '');
  }

  private buildReActPrompt(ctx: AgentContext, iter: number): string {
    const observations = ctx.accumulatedObservations.length > 0
      ? `\n\n--- PREVIOUS OBSERVATIONS ---\n${ctx.accumulatedObservations.join('\n\n')}`
      : '';

    const editorHint = ctx.editorContext
      ? `\nActive editor: ${ctx.editorContext.label} (${ctx.editorContext.language}, ${ctx.editorContext.content.length} chars)`
      : '\nNo active editor.';

    return `You are an AI Agent using the ReAct (Reason → Act → Observe) framework. Iteration ${iter}.

GOAL:
${ctx.goal}
${editorHint}${observations}

Available tools: vector_search(query, topN), file_read(path), file_write(path, content), grep_search(pattern, glob), find_references(file, line, character), terminal_exec(command), web_fetch(url), run_diagnostics(file), git_status(), git_diff(staged), open_file(path, line), list_directory(path), mcp_call(serverId, toolName, args)

Respond in EXACTLY this format:

THOUGHT: <reasoning about what to do next, max 3 sentences>
ACTION: <tool_name>(<JSON args>)
OR
FINAL_ANSWER: <if goal is complete>

Example:
THOUGHT: I should search the workspace for documents about the leave policy.
ACTION: vector_search({"query": "leave policy", "topN": 6})`;
  }

  private async synthesizeFinalAnswer(ctx: AgentContext, onEvent: AgentEventHandler, _lastThought: string): Promise<void> {
    const observationsBlock = ctx.accumulatedObservations.length > 0
      ? `\n\n--- OBSERVATIONS FROM TOOL CALLS ---\n${ctx.accumulatedObservations.join('\n\n')}`
      : '';

    const editorBlock = ctx.editorContext
      ? `\n\n--- EDITOR CONTEXT (${ctx.editorContext.label}) ---\n\`\`\`${ctx.editorContext.language}\n${ctx.editorContext.content.slice(0, 4000)}\n\`\`\``
      : '';

    const prompt = `You are an AnythingLLM AI Agent. Based on the goal and the tool-call observations below, produce a comprehensive final answer in clear, structured English.

GOAL:
${ctx.goal}${editorBlock}${observationsBlock}

Provide a structured, complete, and actionable answer. If information is insufficient, admit it honestly and suggest next steps.`;

    const step: AgentStep = {
      id: `final-synthesize`,
      tool: 'chat',
      title: 'Synthesize the final answer',
      status: 'running',
    };
    onEvent({ type: 'step_start', payload: { stepId: step.id, tool: 'chat' } });
    onEvent({ type: 'step_progress', payload: { stepId: step.id, message: 'Streaming final answer...' } });

    let totalChars = 0;
    await this.client.streamChat(
      ctx.workspaceSlug,
      { message: prompt, mode: Config.chatMode },
      (chunk: ChatStreamChunk) => {
        if (ctx.abortSignal?.aborted) return;
        if (chunk.textResponse) {
          totalChars += chunk.textResponse.length;
          onEvent({ type: 'token', payload: { text: chunk.textResponse } });
        }
        if (chunk.reasoningResponse) {
          onEvent({ type: 'thinking', payload: { text: chunk.reasoningResponse } });
        }
        if (chunk.sources && chunk.sources.length > 0) {
          for (const s of chunk.sources) {
            ctx.accumulatedSources.push({
              title: s.title ?? s.source,
              source: s.source,
              text: s.text?.slice(0, 300),
            });
          }
          onEvent({
            type: 'sources',
            payload: {
              sources: ctx.accumulatedSources.map((s) => ({
                title: s.title ?? s.source,
                source: s.source,
                text: s.text?.slice(0, 300),
              })),
            },
          });
        }
        if (chunk.error) {
          onEvent({ type: 'error', payload: { message: chunk.error } });
        }
      },
      ctx.abortSignal
    );

    step.status = 'done';
    step.result = `Generated ${totalChars} chars`;
    onEvent({ type: 'step_done', payload: { stepId: step.id, tool: 'chat', result: step.result } });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Strategy 4: Native function calling
  // ─────────────────────────────────────────────────────────────────────────────

  private async runNativeFunctionCallingLoop(ctx: AgentContext, onEvent: AgentEventHandler): Promise<void> {
    const tools = toNativeToolDefinitions();
    let iteration = 0;
    const maxIter = 5;

    while (iteration < maxIter) {
      if (ctx.abortSignal?.aborted) return;
      iteration++;
      ctx.iteration = iteration;
      onEvent({ type: 'iteration', payload: { iteration, maxIterations: maxIter } });

      const observationsBlock = ctx.accumulatedObservations.length > 0
        ? `\n\n--- TOOL RESULTS SO FAR ---\n${ctx.accumulatedObservations.join('\n\n')}`
        : '';

      const prompt = `${ctx.goal}${observationsBlock}`;

      let assistantText = '';
      const toolCalls: NativeToolCall[] = [];
      let reasoning = '';

      const step: AgentStep = {
        id: `native-iter${iteration}`,
        tool: 'chat',
        title: `Native call iteration ${iteration}`,
        status: 'running',
        iteration,
      };
      onEvent({ type: 'step_start', payload: { stepId: step.id, tool: 'chat', iteration } });

      try {
        await this.client.streamChat(
          ctx.workspaceSlug,
          { message: prompt, mode: 'chat', tools },
          (chunk: ChatStreamChunk) => {
            if (ctx.abortSignal?.aborted) return;
            if (chunk.textResponse) {
              assistantText += chunk.textResponse;
              onEvent({ type: 'token', payload: { text: chunk.textResponse } });
            }
            if (chunk.reasoningResponse) {
              reasoning += chunk.reasoningResponse;
              onEvent({ type: 'thinking', payload: { text: chunk.reasoningResponse } });
            }
            if (chunk.toolCalls && chunk.toolCalls.length > 0) {
              for (const tc of chunk.toolCalls) {
                toolCalls.push(tc);
                onEvent({ type: 'tool_call', payload: { tool: tc.function.name, args: tc.function.arguments, iteration } });
              }
            }
            if (chunk.sources && chunk.sources.length > 0) {
              for (const s of chunk.sources) {
                ctx.accumulatedSources.push({ title: s.title ?? s.source, source: s.source, text: s.text?.slice(0, 300) });
              }
              onEvent({ type: 'sources', payload: { sources: ctx.accumulatedSources.map((s) => ({ title: s.title ?? s.source, source: s.source, text: s.text?.slice(0, 300) })) } });
            }
          },
          ctx.abortSignal
        );
      } catch (err) {
        step.status = 'failed';
        const msg = err instanceof Error ? err.message : String(err);
        onEvent({ type: 'step_failed', payload: { stepId: step.id, tool: 'chat', error: msg } });
        // Fallback to ReAct
        Logger.warn('Native function calling failed, falling back to ReAct', err);
        await this.runReActLoop(ctx, onEvent, 3);
        return;
      }

      step.status = 'done';
      onEvent({ type: 'step_done', payload: { stepId: step.id, tool: 'chat', result: `${toolCalls.length} tool calls, ${assistantText.length} chars text, ${reasoning.length} chars reasoning` } });

      // No tool calls = model gave final answer
      if (toolCalls.length === 0) {
        return;
      }

      // Execute each tool call
      for (const tc of toolCalls) {
        if (ctx.abortSignal?.aborted) return;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          args = {};
        }

        const execStep: AgentStep = {
          id: `native-exec-${tc.id}`,
          tool: (tc.function.name as AgentToolName) ?? 'chat',
          title: `Execute ${tc.function.name}`,
          status: 'running',
          iteration,
        };
        onEvent({ type: 'step_start', payload: { stepId: execStep.id, tool: tc.function.name, iteration } });

        const result = await executeTool(tc.function.name, args, ctx.toolContext, (msg) => {
          onEvent({ type: 'step_progress', payload: { stepId: execStep.id, message: msg, iteration } });
        });

        execStep.status = result.ok ? 'done' : 'failed';
        execStep.result = result.output.slice(0, 500);
        onEvent({
          type: result.ok ? 'step_done' : 'step_failed',
          payload: { stepId: execStep.id, tool: tc.function.name, result: result.output.slice(0, 200), error: result.ok ? undefined : result.output, iteration },
        });

        if (result.sources) {
          for (const s of result.sources) ctx.accumulatedSources.push(s);
        }

        ctx.accumulatedObservations.push(`Tool ${tc.function.name} returned:\n${result.output.slice(0, MAX_CHARS_PER_OBSERVATION)}`);
      }
    }

    // Hit max iter — give whatever we have
    if (ctx.accumulatedObservations.length > 0) {
      await this.synthesizeFinalAnswer(ctx, onEvent, '');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Step executor (for heuristic & llm strategies)
  // ─────────────────────────────────────────────────────────────────────────────

  private async executeStep(
    step: AgentStep,
    ctx: AgentContext,
    onEvent: AgentEventHandler
  ): Promise<void> {
    step.status = 'running';
    step.startedAt = Date.now();
    onEvent({ type: 'step_start', payload: { stepId: step.id, tool: step.tool } });

    try {
      switch (step.tool) {
        case 'read_editor':
          await this.toolReadEditor(step, ctx, onEvent);
          break;
        case 'vector_search':
          await this.toolVectorSearch(step, ctx, onEvent);
          break;
        case 'upload_current':
          await this.toolUploadCurrent(step, ctx, onEvent);
          break;
        case 'chat':
          await this.toolChat(step, ctx, onEvent);
          break;
        case 'finalize':
          break;
        default:
          // Delegate to new tool registry
          await this.toolFromRegistry(step, ctx, onEvent);
      }
      step.status = 'done';
      step.endedAt = Date.now();
      onEvent({
        type: 'step_done',
        payload: {
          stepId: step.id,
          tool: step.tool,
          result: step.result,
          durationMs: step.endedAt - (step.startedAt ?? 0),
        },
      });
    } catch (err) {
      step.status = 'failed';
      step.endedAt = Date.now();
      const msg = err instanceof Error ? err.message : String(err);
      step.result = `FAILED: ${msg}`;
      onEvent({
        type: 'step_failed',
        payload: { stepId: step.id, tool: step.tool, error: msg },
      });
      if (step.tool === 'chat') throw err;
    }
  }

  private async toolReadEditor(step: AgentStep, ctx: AgentContext, _onEvent: AgentEventHandler): Promise<void> {
    if (!ctx.editorContext) {
      step.result = 'No active editor.';
      return;
    }
    const truncated = ctx.editorContext.content.slice(0, 6000);
    ctx.accumulatedObservations.push(
      `--- Editor context: ${ctx.editorContext.label} (${ctx.editorContext.language}) ---\n\`\`\`${ctx.editorContext.language}\n${truncated}\n\`\`\``
    );
    step.result = `Loaded ${truncated.length} chars from ${ctx.editorContext.label}`;
  }

  private async toolVectorSearch(step: AgentStep, ctx: AgentContext, onEvent: AgentEventHandler): Promise<void> {
    const query = this.extractQuery(ctx.goal);
    onEvent({ type: 'step_progress', payload: { stepId: step.id, message: `Searching: "${query}"` } });

    const result = await executeTool('vector_search', { query, topN: 6 }, ctx.toolContext, (msg) => {
      onEvent({ type: 'step_progress', payload: { stepId: step.id, message: msg } });
    });

    step.result = result.output.slice(0, 500);
    if (result.sources) {
      for (const s of result.sources) ctx.accumulatedSources.push(s);
      onEvent({
        type: 'sources',
        payload: {
          sources: ctx.accumulatedSources.map((s) => ({
            title: s.title ?? s.source,
            source: s.source,
            text: s.text?.slice(0, 300),
          })),
        },
      });
    }
  }

  private async toolUploadCurrent(step: AgentStep, ctx: AgentContext, onEvent: AgentEventHandler): Promise<void> {
    if (!ctx.editorContext) {
      step.result = 'No file to upload.';
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      step.result = 'Editor is not active.';
      return;
    }

    const fileName = editor.document.uri.fsPath.split('/').pop() ?? 'document.txt';
    onEvent({ type: 'step_progress', payload: { stepId: step.id, message: `Uploading ${fileName}...` } });

    const content = new Uint8Array(Buffer.from(editor.document.getText(), 'utf-8'));
    const result = await this.client.uploadFile(content, fileName, 'text/plain');

    if (result.success && result.documents.length > 0) {
      await this.client.updateEmbeddings(
        ctx.workspaceSlug,
        result.documents.map((d) => d.name)
      );
      step.result = `Uploaded & embedded: ${fileName}`;
    } else {
      step.result = `Upload failed: ${result.error ?? 'Unknown'}`;
    }
  }

  private async toolChat(step: AgentStep, ctx: AgentContext, onEvent: AgentEventHandler): Promise<void> {
    const contextBlock = ctx.accumulatedObservations.length > 0
      ? `\n\n--- Additional context accumulated so far ---\n${ctx.accumulatedObservations.join('\n\n')}`
      : '';

    const systemPrompt = `You are an AnythingLLM AI Agent. Accomplish the user's goal below by leveraging the context you gathered via tool calls. Reply in clear, structured English.`;
    const finalPrompt = `${systemPrompt}\n\nUSER GOAL:\n${ctx.goal}${contextBlock}`;

    onEvent({ type: 'step_progress', payload: { stepId: step.id, message: 'Streaming LLM response...' } });

    let totalChars = 0;
    await this.client.streamChat(
      ctx.workspaceSlug,
      { message: finalPrompt, mode: Config.chatMode },
      (chunk: ChatStreamChunk) => {
        if (ctx.abortSignal?.aborted) return;
        if (chunk.textResponse) {
          totalChars += chunk.textResponse.length;
          onEvent({ type: 'token', payload: { text: chunk.textResponse } });
        }
        if (chunk.reasoningResponse) {
          onEvent({ type: 'thinking', payload: { text: chunk.reasoningResponse } });
        }
        if (chunk.sources && chunk.sources.length > 0) {
          for (const s of chunk.sources) {
            ctx.accumulatedSources.push({
              title: s.title ?? s.source,
              source: s.source,
              text: s.text?.slice(0, 300),
            });
          }
          onEvent({
            type: 'sources',
            payload: {
              sources: ctx.accumulatedSources.map((s) => ({
                title: s.title ?? s.source,
                source: s.source,
                text: s.text?.slice(0, 300),
              })),
            },
          });
        }
        if (chunk.error) {
          onEvent({ type: 'error', payload: { message: chunk.error } });
        }
      },
      ctx.abortSignal
    );

    step.result = `Generated ${totalChars} chars response.`;
  }

  private async toolFromRegistry(step: AgentStep, ctx: AgentContext, onEvent: AgentEventHandler): Promise<void> {
    const result = await executeTool(
      step.tool,
      { query: this.extractQuery(ctx.goal), path: this.extractQuery(ctx.goal) },
      ctx.toolContext,
      (msg) => onEvent({ type: 'step_progress', payload: { stepId: step.id, message: msg } })
    );

    step.result = result.output.slice(0, 500);
    ctx.accumulatedObservations.push(`[${step.tool}] ${result.output.slice(0, MAX_CHARS_PER_OBSERVATION)}`);

    if (result.sources) {
      for (const s of result.sources) ctx.accumulatedSources.push(s);
      onEvent({
        type: 'sources',
        payload: {
          sources: ctx.accumulatedSources.map((s) => ({
            title: s.title ?? s.source,
            source: s.source,
            text: s.text?.slice(0, 300),
          })),
        },
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private getDefaultStrategy(): 'heuristic' | 'llm' | 'react' | 'native' {
    return Config.section.get<'heuristic' | 'llm' | 'react' | 'native'>('agentPlanner', 'react');
  }

  private getDefaultMaxIterations(): number {
    return Config.section.get<number>('agentMaxIterations', MAX_ITERATIONS_DEFAULT);
  }

  private extractQuery(goal: string): string {
    return goal
      .replace(/^(search|find|look up|show)\s+(documents?|docs?)?\s*(about|for|related to)?\s*/i, '')
      .trim()
      .slice(0, 120) || goal;
  }

  private stepToPublic(s: AgentStep) {
    return {
      id: s.id,
      tool: s.tool,
      title: s.title,
      detail: s.detail,
      status: s.status,
      iteration: s.iteration,
      reasoning: s.reasoning,
    };
  }

  private getActiveEditorContext(): { label: string; content: string; language: string } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const selection = editor.selection;
    const doc = editor.document;
    const fileName = doc.uri.fsPath.split('/').pop() ?? 'untitled';
    const content = selection && !selection.isEmpty ? doc.getText(selection) : doc.getText();
    if (!content.trim()) return undefined;
    const label = selection && !selection.isEmpty ? `selection in ${fileName}` : fileName;
    return { label, content, language: doc.languageId };
  }
}

/**
 * Check whether an error originated from the AnythingLLM API.
 */
export function isAnythingLLMError(err: unknown): err is AnythingLLMError {
  return err instanceof AnythingLLMError;
}
