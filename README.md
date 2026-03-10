# opencode-homeassistant

An [OpenCode](https://opencode.ai) plugin that sends agent status to [Home Assistant](https://www.home-assistant.io) via webhooks -- and optionally lets you respond to permission requests from HA.

## Features

- Notifies Home Assistant when the OpenCode agent becomes busy, idle, waiting, or encounters an error
- Sends the hostname alongside the state, so you can identify which machine triggered the automation
- Tracks session duration -- `idle`, `waiting`, and `error` payloads include `durationMs` (time since the last `busy` event)
- Per-state webhook routing -- send different states to different webhook IDs
- Multiple webhook targets -- send the same state to several Home Assistant instances
- Includes question choices in `waiting` payloads -- HA can render actionable notifications with the available options
- Remote permission response -- approve or deny agent permissions from HA (via entity polling)
- Hot-reloads configuration when OpenCode's config changes (no restart needed)
- JSON payload, compatible with Home Assistant's webhook trigger out of the box

## States

| State     | OpenCode Event / Hook        | Condition                | Description                             |
| --------- | ---------------------------- | ------------------------ | --------------------------------------- |
| `busy`    | `event` → `session.status`   | `status.type === 'busy'` | Agent starts processing                 |
| `idle`    | `event` → `session.status`   | `status.type === 'idle'` | Agent finishes and is waiting for input |
| `waiting` | `event` → `permission.asked` |                          | Agent requests user permission          |
| `waiting` | `tool.execute.before`        | `tool === 'question'`    | Agent asks the user a question          |
| `error`   | `event` → `session.error`    |                          | Session encounters an error             |

## Payload

The plugin sends a `POST` request with `Content-Type: application/json`:

```json
{
  "state": "idle",
  "hostname": "my-macbook",
  "project": "my-app",
  "sessionId": "01JFF...",
  "durationMs": 12345
}
```

| Field        | Description                                                                 |
| ------------ | --------------------------------------------------------------------------- |
| `state`      | One of `busy`, `idle`, `waiting`, `error`                                   |
| `hostname`   | Machine hostname (`os.hostname()`)                                          |
| `project`    | Directory name of the current project                                       |
| `sessionId`  | OpenCode session ID (useful for correlating events)                         |
| `durationMs` | Milliseconds since the session became `busy` (omitted from `busy` payloads) |
| `waiting`    | Details about what the agent is waiting for (only on `waiting` payloads)    |

### `waiting` object

| Field       | Description                                                                      |
| ----------- | -------------------------------------------------------------------------------- |
| `reason`    | Either `permission` (agent needs approval) or `question` (agent asks a question) |
| `id`        | Permission ID, used for remote replies (only for `permission`)                   |
| `type`      | Permission type, e.g. `bash`, `edit`, `webfetch` (only for `permission`)         |
| `title`     | Human-readable description of the request                                        |
| `pattern`   | The command or path pattern being requested (only for `permission`)              |
| `questions` | Array of question details with options (only for `question`)                     |

In a Home Assistant automation, access these values via `trigger.json.*`, e.g. `trigger.json.state`.

### Permission payload example

```json
{
  "state": "waiting",
  "hostname": "my-macbook",
  "project": "my-app",
  "sessionId": "ses_...",
  "durationMs": 4200,
  "waiting": {
    "reason": "permission",
    "id": "per_cd77d4766001...",
    "type": "bash",
    "title": "bash: mkdir test-folder",
    "pattern": ["mkdir test-folder"]
  }
}
```

### Question payload example

```json
{
  "state": "waiting",
  "hostname": "my-macbook",
  "project": "my-app",
  "sessionId": "ses_...",
  "durationMs": 5000,
  "waiting": {
    "reason": "question",
    "title": "Choose framework",
    "questions": [
      {
        "header": "Choose framework",
        "question": "Which framework would you like to use?",
        "options": [
          { "label": "React", "description": "Component-based UI library" },
          { "label": "Vue", "description": "Progressive framework" }
        ],
        "multiple": false
      }
    ]
  }
}
```

Each question in the `questions` array has:

| Field      | Type       | Description                                 |
| ---------- | ---------- | ------------------------------------------- |
| `header`   | `string`   | Short label (max 30 chars)                  |
| `question` | `string`   | Full question text                          |
| `options`  | `array`    | Available choices (`label` + `description`) |
| `multiple` | `boolean?` | Whether multiple selections are allowed     |

## Installation

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-homeassistant"]
}
```

## Configuration

Create `~/.config/opencode/opencode-homeassistant.json`:

```json
{
  "webhookUrl": "https://your-home-assistant/api/webhook/your_webhook_id"
}
```

The config file path can be overridden with the `OPENCODE_HA_CONFIG_PATH` environment variable. See [webhook trigger documentation at Home Assistant](https://www.home-assistant.io/docs/automation/trigger/#webhook-trigger).

If no webhook URLs are configured or the config file is missing, the plugin is disabled silently.

The configuration is hot-reloaded whenever OpenCode's config changes -- no restart needed.

### Per-state webhook routing

Use `webhookUrls` to send different states to different webhook IDs. A `default` key acts as a fallback for any state without its own entry:

```json
{
  "webhookUrls": {
    "busy": "https://ha.local/api/webhook/opencode_busy",
    "error": "https://ha.local/api/webhook/opencode_error",
    "default": "https://ha.local/api/webhook/opencode_general"
  }
}
```

With this config, `busy` and `error` events go to their own webhooks while `idle` and `waiting` fall back to the `default` webhook.

### Multiple webhook targets

Each entry in `webhookUrls` can be a single URL or an array, allowing you to notify multiple Home Assistant instances or trigger several automations at once:

```json
{
  "webhookUrls": {
    "default": [
      "https://ha-home.local/api/webhook/opencode_status",
      "https://ha-office.local/api/webhook/opencode_status"
    ],
    "error": "https://ha-home.local/api/webhook/opencode_errors"
  }
}
```

### Precedence

The plugin resolves webhook URLs in this order:

1. `webhookUrls[state]` -- exact match for the current state
2. `webhookUrls.default` -- fallback for unmatched states
3. `webhookUrl` -- legacy single-URL config (used when `webhookUrls` is absent)

### Remote permission response

The plugin can relay permission responses from Home Assistant back to OpenCode. When a `permission.asked` event fires, the plugin sends the webhook **and** starts polling an HA entity for a response. If the user answers the permission locally in the TUI, the poll aborts immediately.

To enable this, add the following to your config:

```json
{
  "webhookUrl": "https://ha.local/api/webhook/opencode_status",
  "haApiUrl": "https://ha.local/api",
  "haToken": "${HA_LONG_LIVED_TOKEN}",
  "permissionResponseEntity": "input_text.opencode_permission_response",
  "permissionTimeout": 120
}
```

| Field                      | Default                                   | Description                                               |
| -------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| `haApiUrl`                 | _(required)_                              | Home Assistant REST API base URL                          |
| `haToken`                  | _(required)_                              | Long-lived access token (supports `${ENV_VAR}` expansion) |
| `permissionResponseEntity` | `input_text.opencode_permission_response` | Entity the plugin polls for the user's response           |
| `permissionTimeout`        | `120`                                     | Seconds to wait for a response before giving up           |

**How it works:**

1. Plugin sends the `waiting` webhook (with `waiting.id` set to the permission ID)
2. Plugin starts polling `permissionResponseEntity` every 2 seconds
3. HA automation shows an actionable notification; when the user taps Allow/Deny, the automation sets the entity state to `<permissionId>:<response>` (e.g. `per_abc123:allow`)
4. Plugin reads the response, clears the entity, and replies to OpenCode via the SDK
5. If the user answers locally in the TUI instead, the plugin receives a `permission.replied` event and stops polling immediately

Valid responses: `allow`, `always`, `deny`.

## Automation ideas

### Busy light / desk LED

Change the color of a smart bulb or LED strip based on agent state -- red for errors, yellow for waiting on input, green for busy, off when idle:

```yaml
automation:
  - alias: OpenCode busy light
    triggers:
      - trigger: webhook
        webhook_id: your_webhook_id
        allowed_methods:
          - POST
        local_only: false
    actions:
      - choose:
          - conditions: "{{ trigger.json.state == 'busy' }}"
            sequence:
              - action: light.turn_on
                target:
                  entity_id: light.desk_led
                data:
                  color_name: green
                  brightness: 128
          - conditions: "{{ trigger.json.state == 'waiting' }}"
            sequence:
              - action: light.turn_on
                target:
                  entity_id: light.desk_led
                data:
                  color_name: yellow
                  brightness: 200
          - conditions: "{{ trigger.json.state == 'error' }}"
            sequence:
              - action: light.turn_on
                target:
                  entity_id: light.desk_led
                data:
                  color_name: red
                  brightness: 255
          - conditions: "{{ trigger.json.state == 'idle' }}"
            sequence:
              - action: light.turn_off
                target:
                  entity_id: light.desk_led
```

### Track agent status as a template sensor (with attributes)

Rather than an `input_select`, a [trigger-based template sensor](https://www.home-assistant.io/integrations/template/#trigger-based-template-sensors) gives you a richer entity with `hostname`, `project`, and `session_id` as attributes, and lets you implement derived state logic (e.g. promoting `idle` to `completed` when the agent was busy for a while):

```yaml
template:
  - trigger:
      - trigger: webhook
        webhook_id: your_webhook_id
        allowed_methods:
          - POST
        local_only: true
      - trigger: event
        event_type: timer.finished
        event_data:
          entity_id: timer.opencode_agent_state
    sensor:
      - name: OpenCode Agent Status
        unique_id: opencode_agent_status
        device_class: enum
        state: >
          {% if trigger.platform == 'event' %}
            idle
          {% else %}
            {% set raw = trigger.json.state %}
            {% set was_busy_long = raw == 'idle'
               and this.state == 'busy'
               and (now() - this.last_changed).total_seconds() >= 10 %}
            {{ 'completed' if was_busy_long else raw }}
          {% endif %}
        attributes:
          hostname: "{{ trigger.json.hostname | default(this.attributes.get('hostname', '')) }}"
          project: "{{ trigger.json.project | default(this.attributes.get('project', '')) }}"
          session_id: "{{ trigger.json.sessionId | default(this.attributes.get('session_id', '')) }}"
          duration_ms: '{{ trigger.json.durationMs | default(none) }}'
          waiting_reason: '{{ trigger.json.waiting.reason | default(none) }}'
          waiting_title: '{{ trigger.json.waiting.title | default(none) }}'
          permission_id: '{{ trigger.json.waiting.id | default(none) }}'
          question_options: '{{ trigger.json.waiting.questions | default(none) }}'

timer:
  opencode_agent_state:
    name: OpenCode agent state auto-revert
    duration: '00:00:05'

automation:
  - alias: OpenCode agent state timer control
    mode: restart
    triggers:
      - trigger: state
        entity_id: sensor.opencode_agent_status
    actions:
      - if:
          - condition: state
            entity_id: sensor.opencode_agent_status
            state: [error, completed, waiting]
        then:
          - action: timer.start
            target:
              entity_id: timer.opencode_agent_state
        else:
          - action: timer.cancel
            target:
              entity_id: timer.opencode_agent_state
```

The timer ensures transient states (`error`, `waiting`, `completed`) auto-revert to `idle` after 5 seconds. The `completed` state is synthesized when the agent goes from `busy` → `idle` after at least 10 seconds -- a signal that a real task finished.

### Mobile notification when waiting for input after a long-running prompt

Get a push notification only when the agent has been working for a while (>30s) and then needs your input -- avoiding noise from quick prompts:

```yaml
automation:
  - alias: Notify when long-running OpenCode prompt needs input
    mode: single
    triggers:
      - trigger: state
        entity_id: sensor.opencode_agent_status
        from: busy
        to: waiting
    conditions:
      - condition: template
        value_template: >
          {{ (now() - trigger.from_state.last_changed).total_seconds() >= 30 }}
    actions:
      - action: notify.mobile_app_your_phone
        data:
          title: opencode is waiting for input
          message: >
            {{ state_attr('sensor.opencode_agent_status', 'project') }}
            on {{ state_attr('sensor.opencode_agent_status', 'hostname') }}
            {% if state_attr('sensor.opencode_agent_status', 'waiting_title') %}
            ({{ state_attr('sensor.opencode_agent_status', 'waiting_title') }})
            {% endif %}
```

This relies on the trigger-based template sensor described above.

### Session duration tracking

Log how long each agent interaction took. The `durationMs` field is included in `idle`, `waiting`, and `error` payloads, measuring the time since the session last became `busy`:

```yaml
automation:
  - alias: OpenCode session duration
    triggers:
      - trigger: webhook
        webhook_id: your_webhook_id
        allowed_methods:
          - POST
        local_only: false
    conditions:
      - condition: template
        value_template: '{{ trigger.json.durationMs is defined }}'
    actions:
      - action: input_number.set_value
        target:
          entity_id: input_number.opencode_last_duration_seconds
        data:
          value: '{{ (trigger.json.durationMs / 1000) | round(1) }}'
```

## License

[MIT](LICENSE)
