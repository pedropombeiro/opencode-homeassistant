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

The config file path can be overridden with the `OPENCODE_HA_CONFIG_PATH` environment variable. See [webhook trigger documentation at Home Assistant](https://www.home-assistant.io/docs/automation/trigger/#webhook-trigger).

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

timer:
  opencode_agent_state:
    name: OpenCode agent state auto-revert
    duration: "00:00:05"

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

The timer ensures transient states (`error`, `waiting`, `completed`) auto-revert to `idle` after 5 seconds. The `completed` state is synthesized when the agent goes from `busy` → `idle` after at least 10 seconds — a signal that a real task finished.

### Mobile notification when waiting for input after a long-running prompt

Get a push notification only when the agent has been working for a while (>30s) and then needs your input — avoiding noise from quick prompts:

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
```

This relies on the trigger-based template sensor described above.

## License

[MIT](LICENSE)
