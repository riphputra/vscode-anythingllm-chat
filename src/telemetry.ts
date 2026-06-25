import * as vscode from 'vscode';
import { Logger } from './logger';
import type { TelemetryEvent } from './types';

/**
 * Local telemetry (does not send data to any third party).
 * Tracks: request count, latency, error rate, token usage.
 */
export class Telemetry {
  private static events: TelemetryEvent[] = [];
  private static maxEvents = 1000;

  static isEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('anythingllm')
      .get<boolean>('enableTelemetry', true);
  }

  static log(event: Omit<TelemetryEvent, 'timestamp'>): void {
    if (!this.isEnabled()) {
      return;
    }
    const full: TelemetryEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    this.events.push(full);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
    Logger.info(`telemetry: ${event.type} ${event.endpoint} ${event.durationMs ?? 0}ms`);
  }

  static getStats(): {
    totalRequests: number;
    totalErrors: number;
    avgLatencyMs: number;
    totalTokens: number;
    recentErrors: TelemetryEvent[];
  } {
    const requests = this.events.filter((e) => e.type === 'request');
    const errors = this.events.filter((e) => e.type === 'error');
    const tokens = this.events.reduce((sum, e) => sum + (e.tokensUsed ?? 0), 0);
    const avgLatency = requests.length > 0
      ? requests.reduce((s, e) => s + (e.durationMs ?? 0), 0) / requests.length
      : 0;
    return {
      totalRequests: requests.length,
      totalErrors: errors.length,
      avgLatencyMs: Math.round(avgLatency),
      totalTokens: tokens,
      recentErrors: errors.slice(-10),
    };
  }

  static reset(): void {
    this.events = [];
  }
}
