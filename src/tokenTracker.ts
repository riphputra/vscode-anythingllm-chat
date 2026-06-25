import * as vscode from 'vscode';
import { Logger } from './logger';
import type { TokenStats, TokenUsageRecord } from './types';

/**
 * Token & cost tracker.
 *
 * - Token estimation uses the heuristic ~4 chars/token for English, ~2 chars/token for CJK
 * - Cost is computed from per-1K-token rates (configurable in settings)
 * - Warns when the daily budget is exceeded
 */

interface ModelRate {
  inputPer1k: number; // USD per 1K input tokens
  outputPer1k: number; // USD per 1K output tokens
}

const DEFAULT_RATES: Record<string, ModelRate> = {
  // OpenAI
  'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01 },
  'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  'gpt-4-turbo': { inputPer1k: 0.01, outputPer1k: 0.03 },
  // Anthropic
  'claude-3-5-sonnet': { inputPer1k: 0.003, outputPer1k: 0.015 },
  'claude-3-5-haiku': { inputPer1k: 0.0008, outputPer1k: 0.004 },
  // Open-source / local
  'llama-3': { inputPer1k: 0, outputPer1k: 0 },
  'mistral': { inputPer1k: 0.0002, outputPer1k: 0.0006 },
  // Default fallback
  'default': { inputPer1k: 0.001, outputPer1k: 0.003 },
};

export class TokenTracker {
  private records: TokenUsageRecord[] = [];
  private budgetUsd: number;
  private budgetWarningEmitted: boolean = false;
  private onBudgetWarning = new vscode.EventEmitter<number>();
  readonly onBudgetWarningEvent = this.onBudgetWarning.event;

  constructor() {
    this.budgetUsd = vscode.workspace
      .getConfiguration('anythingllm')
      .get<number>('costBudgetUsd', 1.0);
  }

  /**
   * Estimate token count for a string.
   * Heuristic: ~4 chars/token English; ~2 chars/token for CJK.
   */
  static estimateTokens(text: string): number {
    if (!text) return 0;
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
    const otherChars = text.length - cjkCount;
    return Math.ceil(cjkCount / 2 + otherChars / 4);
  }

  /**
   * Get rate for a model (case-insensitive substring match).
   */
  static getRate(model?: string): ModelRate {
    if (!model) return DEFAULT_RATES.default;
    const lc = model.toLowerCase();
    for (const key of Object.keys(DEFAULT_RATES)) {
      if (lc.includes(key)) return DEFAULT_RATES[key];
    }
    return DEFAULT_RATES.default;
  }

  /**
   * Record a usage event.
   */
  record(record: Omit<TokenUsageRecord, 'estimatedCostUsd'>): number {
    const rate = TokenTracker.getRate(record.model);
    const cost = (record.tokensIn / 1000) * rate.inputPer1k + (record.tokensOut / 1000) * rate.outputPer1k;

    const full: TokenUsageRecord = { ...record, estimatedCostUsd: cost };
    this.records.push(full);

    // Check budget
    const stats = this.getStats();
    if (!this.budgetWarningEmitted && stats.totalEstimatedCostUsd >= this.budgetUsd) {
      this.budgetWarningEmitted = true;
      this.onBudgetWarning.fire(stats.totalEstimatedCostUsd);
      vscode.window.showWarningMessage(
        `AnythingLLM: Estimasi biaya harian $${stats.totalEstimatedCostUsd.toFixed(4)} melebihi budget $${this.budgetUsd.toFixed(2)}.`,
        'Open Settings'
      ).then((a) => {
        if (a === 'Open Settings') {
          vscode.commands.executeCommand('anythingllm.openSettings');
        }
      });
    }

    return cost;
  }

  /**
   * Get aggregated stats. Today's tokens reset daily.
   */
  getStats(): TokenStats {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();

    let totalTokensIn = 0, totalTokensOut = 0, totalCost = 0;
    let todayTokens = 0;
    let totalRequests = 0;

    for (const r of this.records) {
      totalTokensIn += r.tokensIn;
      totalTokensOut += r.tokensOut;
      totalCost += r.estimatedCostUsd;
      totalRequests++;
      if (r.timestamp >= todayMs) {
        todayTokens += r.tokensIn + r.tokensOut;
      }
    }

    return {
      totalRequests,
      totalTokensIn,
      totalTokensOut,
      totalEstimatedCostUsd: totalCost,
      todayTokens,
      budgetUsd: this.budgetUsd,
      budgetWarningEmitted: this.budgetWarningEmitted,
    };
  }

  setBudget(usd: number): void {
    this.budgetUsd = usd;
    this.budgetWarningEmitted = false;
  }

  reset(): void {
    this.records = [];
    this.budgetWarningEmitted = false;
    Logger.info('Token tracker reset.');
  }

  /**
   * Export all records as JSON for external analysis.
   */
  exportJson(): string {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      stats: this.getStats(),
      records: this.records,
    }, null, 2);
  }
}
