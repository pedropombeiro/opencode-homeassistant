import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { homedir, hostname } from 'os';
import { join } from 'path';
import type { Plugin } from '@opencode-ai/plugin';

interface Config {
  webhookUrl: string;
}

interface WebhookPayload {
  state: string;
  hostname: string;
  project: string;
  sessionId?: string;
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

  function send(state: string, sessionId?: string) {
    sendWebhook(config.webhookUrl, { state, hostname: host, project, sessionId });
  }

  return {
    event: async ({ event }) => {
      if (event.type === 'session.status') {
        const { sessionID, status } = event.properties;
        if (status.type === 'busy') {
          send('busy', sessionID);
        } else if (status.type === 'idle') {
          send('idle', sessionID);
        }
      } else if (event.type === 'session.error') {
        send('error', event.properties.sessionID);
      }
    },
    'permission.ask': async (input, _output) => {
      send('waiting', input.sessionID);
    },
    'tool.execute.before': async (input, _output) => {
      if (input.tool === 'question') {
        send('waiting', input.sessionID);
      }
    },
  };
};
