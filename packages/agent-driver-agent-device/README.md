# @stim-cli/agent-driver-agent-device

The [agent-device](https://github.com/callstack/agent-device) driver
for stim-server hosted apps, selected on the hosting Mac with
`hosting.agentDriver: agent-device`. It implements the
[`@stim-cli/agent-driver`](../agent-driver/README.md) contract.

The [stim-server README](../server/README.md#agent-driver-route) describes how
it starts agent-device, the daemon policy it applies, and how it confines a
client to one hosted app or device.
