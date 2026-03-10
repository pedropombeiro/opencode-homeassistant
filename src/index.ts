import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { basename } from 'path';
import { homedir, hostname, platform } from 'os';
import { join } from 'path';
import type { Plugin } from '@opencode-ai/plugin';

type AgentState = 'busy' | 'idle' | 'waiting' | 'error';
type WebhookUrlEntry = string | string[];

interface Config {
  webhookUrl?: string;
  webhookUrls?: Partial<Record<AgentState | 'default', WebhookUrlEntry>>;
  haApiUrl?: string;
  haToken?: string;
  permissionResponseEntity?: string;
  permissionTimeout?: number;
}

interface WaitingDetail {
  reason: 'permission' | 'question';
  id?: string;
  type?: string;
  title?: string;
  pattern?: string | string[];
  questions?: QuestionDetail[];
}

interface QuestionOption {
  label: string;
  description?: string;
}

interface QuestionDetail {
  header: string;
  question: string;
  options: QuestionOption[];
  multiple?: boolean;
}

interface WebhookPayload {
  state: string;
  hostname: string;
  project: string;
  sessionId?: string;
  durationMs?: number;
  waiting?: WaitingDetail;
}

interface HaEntityState {
  state: string;
  attributes: Record<string, unknown>;
}

const DEFAULT_PERMISSION_TIMEOUT = 120;
const DEFAULT_RESPONSE_ENTITY = 'input_text.opencode_permission_response';
const POLL_INTERVAL_MS = 2000;

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

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)}/g, (_match, name: string) => process.env[name] ?? '');
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

function isScreenLocked(): boolean {
  const os = platform();

  if (os === 'darwin') {
    try {
      execSync('ioreg -n Root -d1 | grep -q CGSSessionScreenIsLocked', {
        timeout: 5000,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  if (os === 'linux') {
    try {
      const out = execSync(
        "loginctl show-session $(loginctl --no-legend | awk '/seat0/ {print $1; exit}') -p LockedHint --value",
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      if (out.trim() === 'yes') return true;
      if (out.trim() === 'no') return false;
    } catch {
      /* fall through to D-Bus */
    }

    const de = (process.env['XDG_CURRENT_DESKTOP'] ?? '').toLowerCase();
    const dbusTargets: Record<string, [string, string, string]> = {
      gnome: ['org.gnome.ScreenSaver', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver.GetActive'],
      kde: ['org.freedesktop.ScreenSaver', '/ScreenSaver', 'org.freedesktop.ScreenSaver.GetActive'],
      cinnamon: [
        'org.cinnamon.ScreenSaver',
        '/org/cinnamon/ScreenSaver',
        'org.cinnamon.ScreenSaver.GetActive',
      ],
      mate: ['org.mate.ScreenSaver', '/org/mate/ScreenSaver', 'org.mate.ScreenSaver.GetActive'],
      xfce: ['org.xfce.ScreenSaver', '/org/xfce/ScreenSaver', 'org.xfce.ScreenSaver.GetActive'],
    };

    for (const [key, [dest, path, method]] of Object.entries(dbusTargets)) {
      if (!de.includes(key)) continue;
      try {
        const out = execSync(`dbus-send --session --dest=${dest} --print-reply ${path} ${method}`, {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.includes('boolean true');
      } catch {
        /* continue */
      }
    }
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHaEntity(
  apiUrl: string,
  token: string,
  entityId: string,
): Promise<HaEntityState | undefined> {
  try {
    const resp = await fetch(`${apiUrl}/states/${entityId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return undefined;
    return (await resp.json()) as HaEntityState;
  } catch {
    return undefined;
  }
}

async function setHaEntity(
  apiUrl: string,
  token: string,
  entityId: string,
  state: string,
): Promise<void> {
  try {
    await fetch(`${apiUrl}/states/${entityId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* best effort */
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

  function resolveHaConfig(): { apiUrl: string; token: string; entity: string } | undefined {
    if (!config.haApiUrl || !config.haToken) return undefined;
    const token = resolveEnvVars(config.haToken);
    if (!token) return undefined;
    return {
      apiUrl: config.haApiUrl.replace(/\/+$/, ''),
      token,
      entity: config.permissionResponseEntity ?? DEFAULT_RESPONSE_ENTITY,
    };
  }

  async function pollForPermissionResponse(
    permissionId: string,
  ): Promise<'allow' | 'deny' | undefined> {
    const ha = resolveHaConfig();
    if (!ha) return undefined;

    const timeoutMs = (config.permissionTimeout ?? DEFAULT_PERMISSION_TIMEOUT) * 1000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const entity = await fetchHaEntity(ha.apiUrl, ha.token, ha.entity);
      if (entity && entity.state) {
        const colonIdx = entity.state.indexOf(':');
        if (colonIdx > 0) {
          const respPermId = entity.state.substring(0, colonIdx);
          const response = entity.state.substring(colonIdx + 1);
          if (respPermId === permissionId) {
            await setHaEntity(ha.apiUrl, ha.token, ha.entity, '');
            if (response === 'allow' || response === 'always') return 'allow';
            if (response === 'deny') return 'deny';
          }
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }

    return undefined;
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
    'permission.ask': async (input, output) => {
      send('waiting', input.sessionID, {
        durationMs: elapsedSince(input.sessionID),
        waiting: {
          reason: 'permission',
          id: input.id,
          type: input.type,
          title: input.title,
          pattern: input.pattern,
        },
      });

      if (!isScreenLocked()) return;

      const response = await pollForPermissionResponse(input.id);
      if (response) {
        output.status = response;
      }
    },
    'tool.execute.before': async (input, output) => {
      if (input.tool === 'question') {
        let args = output.args;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = undefined;
          }
        }
        const questions = Array.isArray(args?.questions) ? args.questions : undefined;
        const title = questions?.[0]?.header;
        const questionDetails = questions
          ?.filter((question: QuestionDetail) => Boolean(question?.header || question?.question))
          .map((question: QuestionDetail) => ({
            header: question.header ?? '',
            question: question.question ?? '',
            options: Array.isArray(question.options)
              ? question.options.map((option: QuestionOption) => ({
                  label: option.label,
                  description: option.description,
                }))
              : [],
            multiple: question.multiple,
          }));
        send('waiting', input.sessionID, {
          durationMs: elapsedSince(input.sessionID),
          waiting: { reason: 'question', title, questions: questionDetails },
        });
      }
    },
  };
};
