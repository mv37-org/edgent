# Changelog

## 0.2.0

- Added lifecycle hooks for model calls, tool calls, and runtime errors. Hooks can inspect and safely mutate model requests, model outputs, tool calls, and tool results.
- Added context compaction for long browser-agent runs. Hosts can set a context-window threshold, provide a compaction model adapter and prompt, estimate tokens, and preserve recent messages while replacing older history with a summary.
- Added hook and compaction events so host apps can render these lifecycle steps in timelines and debug panels.
- Updated the core docs and type exports for the new hook and compaction APIs.

## 0.1.0

- Initial browser-only headless SDK scaffold.
- Added core agent loop, schema-first tools, CodeMirror adapter, Pyodide helper, tests, and example app.
