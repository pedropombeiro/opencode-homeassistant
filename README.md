# opencode-homeassistant

An [OpenCode](https://opencode.ai) plugin that sends agent status to [Home Assistant](https://www.home-assistant.io) via a webhook.

## Features

- Notifies Home Assistant when the OpenCode agent becomes busy, idle, waiting, or encounters an error
- Sends the hostname alongside the state, so you can identify which machine triggered the automation
- JSON payload, compatible with Home Assistant's webhook trigger out of the box

## States

| State     | OpenCode Hook              | Condition                | Description                             |
| --------- | -------------------------- | ------------------------ | --------------------------------------- |
| `busy`    | `event` → `session.status` | `status.type === 'busy'` | Agent starts processing                 |
| `idle`    | `event` → `session.status` | `status.type === 'idle'` | Agent finishes and is waiting for input |
| `waiting` | `permission.ask`           |                          | Agent requests user permission          |
| `waiting` | `tool.execute.before`      | `tool === 'question'`    | Agent asks the user a question          |
| `error`   | `event` → `session.error`  |                          | Session encounters an error             |

## Payload

The plugin sends a `POST` request with `Content-Type: application/json`:

```json
{
  "state": "busy",
  "hostname": "my-macbook",
  "project": "my-app",
  "sessionId": "01JFF..."
}
```

| Field       | Description                                         |
| ----------- | --------------------------------------------------- |
| `state`     | One of `busy`, `idle`, `waiting`, `error`           |
| `hostname`  | Machine hostname (`os.hostname()`)                  |
| `project`   | Directory name of the current project               |
| `sessionId` | OpenCode session ID (useful for correlating events) |

In a Home Assistant automation, access these values via `trigger.json.*`, e.g. `trigger.json.state`.

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

The config file path can be overridden with the `OPENCODE_HA_CONFIG_PATH` environment variable.

If `webhookUrl` is empty or the config file is missing, the plugin is disabled silently.

## Automation ideas

### Busy light / desk LED

Change the color of a smart bulb or LED strip based on agent state — red for errors, yellow for waiting on input, green for busy, off when idle:

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

### Mobile notification when waiting for input

Get a push notification on your phone whenever the agent needs your attention:

```yaml
automation:
  - alias: OpenCode needs attention
    triggers:
      - trigger: webhook
        webhook_id: your_webhook_id
        allowed_methods:
          - POST
        local_only: false
    conditions:
      - condition: template
        value_template: "{{ trigger.json.state in ['waiting', 'error'] }}"
    actions:
      - action: notify.mobile_app_your_phone
        data:
          title: 'OpenCode — {{ trigger.json.project }} ({{ trigger.json.hostname }})'
          message: >-
            {% if trigger.json.state == 'waiting' %}Agent is waiting for your input
            {% else %}Agent encountered an error{% endif %}
```

### Track agent status per machine

Store the state in an `input_select` so you can build dashboards or condition other automations on whether the agent is active:

```yaml
automation:
  - alias: OpenCode agent status
    triggers:
      - trigger: webhook
        webhook_id: your_webhook_id
        allowed_methods:
          - POST
        local_only: false
    actions:
      - action: input_select.select_option
        target:
          entity_id: input_select.opencode_status
        data:
          option: '{{ trigger.json.state }} — {{ trigger.json.project }} ({{ trigger.json.hostname }})'
```

## License

[MIT](LICENSE)
