import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { homedir, hostname } from 'os';
import { join } from 'path';
import type { Plugin } from '@opencode-ai/plugin';

type AgentState = 'busy' | 'idle' | 'waiting' | 'error';
type WebhookUrlEntry = string | string[];

interface Config {
  webhookUrl?: string;
  webhookUrls?: Partial<Record<AgentState | 'default', WebhookUrlEntry>>;
}

interface WaitingDetail {
  reason: 'permission' | 'question';
  type?: string;
  title?: string;
  pattern?: string | string[];
}

interface WebhookPayload {
  state: string;
  hostname: string;
  project: string;
  sessionId?: string;
  durationMs?: number;
  waiting?: WaitingDetail;
}

function loadConfig(): Config {
  const configPath =
    process.env['OPENCODE_HA_CONFIG_PATH'] ??
    join(homedir(), '.config', 'opencode', 'opencode-homeassistant.json');

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      return JSON.parse(raw) as Config;
    } catch {
      return {};
    }
  }

  return {};
}

function resolveWebhookUrls(config: Config, state: AgentState): string[] {
  const entry = config.webhookUrls?.[state] ?? config.webhookUrls?.default;
  if (entry) return (Array.isArray(entry) ? entry : [entry]).filter(Boolean);
  if (config.webhookUrl) return [config.webhookUrl];
  return [];
}

function sendWebhook(urls: string[], payload: WebhookPayload): void {
  for (const url of urls) {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  }
}

export const HomeAssistantPlugin: Plugin = async ({ directory }) => {
  let config = loadConfig();
  const project = basename(directory);
  const host = hostname();
  const sessionStartTimes = new Map<string, number>();

  function elapsedSince(sessionId?: string): number | undefined {
    if (!sessionId) return undefined;
    const start = sessionStartTimes.get(sessionId);
    return start !== undefined ? Date.now() - start : undefined;
  }

  function send(
    state: AgentState,
    sessionId?: string,
    extra?: { durationMs?: number; waiting?: WaitingDetail },
  ) {
    const urls = resolveWebhookUrls(config, state);
    if (urls.length === 0) return;
    const payload: WebhookPayload = { state, hostname: host, project, sessionId };
    if (extra?.durationMs !== undefined) payload.durationMs = extra.durationMs;
    if (extra?.waiting) payload.waiting = extra.waiting;
    sendWebhook(urls, payload);
  }

  return {
    config: async () => {
      config = loadConfig();
    },
    event: async ({ event }) => {
      if (event.type === 'session.status') {
        const { sessionID, status } = event.properties;
        if (status.type === 'busy') {
          sessionStartTimes.set(sessionID, Date.now());
          send('busy', sessionID);
        } else if (status.type === 'idle') {
          const durationMs = elapsedSince(sessionID);
          sessionStartTimes.delete(sessionID);
          send('idle', sessionID, { durationMs });
        }
      } else if (event.type === 'session.error') {
        const sessionID = event.properties.sessionID;
        const durationMs = elapsedSince(sessionID);
        if (sessionID) sessionStartTimes.delete(sessionID);
        send('error', sessionID, { durationMs });
      }
    },
    'permission.ask': async (input, _output) => {
      send('waiting', input.sessionID, {
        durationMs: elapsedSince(input.sessionID),
        waiting: {
          reason: 'permission',
          type: input.type,
          title: input.title,
          pattern: input.pattern,
        },
      });
    },
    'tool.execute.before': async (input, output) => {
      if (input.tool === 'question') {
        const questions = output.args?.questions;
        const title = Array.isArray(questions) ? questions[0]?.header : undefined;
        send('waiting', input.sessionID, {
          durationMs: elapsedSince(input.sessionID),
          waiting: { reason: 'question', title },
        });
      }
    },
  };
};
