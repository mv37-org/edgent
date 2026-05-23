# Security

## Supported Versions

The project is pre-1.0. Security fixes target the latest published version.

## Browser Credentials

Edgent does not include provider clients or hidden service credentials. If a host app lets users enter API keys in the browser, those keys are visible to that user's browser runtime by design. Do not ship private provider keys in browser bundles.

For production apps, prefer a backend proxy when you need to enforce quotas, hide service credentials, audit requests, or apply organization policy.

## Tool Permissions

Tools are the permission boundary. The agent can only call tools registered by the host app. Keep destructive or sensitive tools behind host-side approval flows.

## Reporting Issues

Please report security issues privately to the maintainers before opening public issues when possible.
