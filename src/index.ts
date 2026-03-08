import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { homedir, hostname } from 'os';
import { join } from 'path';
import type { Plugin } from '@opencode-ai/plugin';

interface Config {
  webhookUrl: string;
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
      return { webhookUrl: '' };
    }
  }

  return { webhookUrl: '' };
}

function sendWebhook(webhookUrl: string, payload: WebhookPayload): void {
  if (!webhookUrl) return;

  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
}

export const HomeAssistantPlugin: Plugin = async ({ directory }) => {
  const config = loadConfig();
  const project = basename(directory);
  const host = hostname();
  const sessionStartTimes = new Map<string, number>();

  function elapsedSince(sessionId?: string): number | undefined {
    if (!sessionId) return undefined;
    const start = sessionStartTimes.get(sessionId);
    return start !== undefined ? Date.now() - start : undefined;
  }

  function send(
    state: string,
    sessionId?: string,
    extra?: { durationMs?: number; waiting?: WaitingDetail },
  ) {
    const payload: WebhookPayload = { state, hostname: host, project, sessionId };
    if (extra?.durationMs !== undefined) payload.durationMs = extra.durationMs;
    if (extra?.waiting) payload.waiting = extra.waiting;
    sendWebhook(config.webhookUrl, payload);
  }

  return {
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
    'tool.execute.before': async (input, _output) => {
      if (input.tool === 'question') {
        send('waiting', input.sessionID, {
          durationMs: elapsedSince(input.sessionID),
          waiting: { reason: 'question' },
        });
      }
    },
  };
};
