# REA AI Studio

REA AI Studio is an optional, separate local chat dashboard. It does not replace or modify REA's CLI, MCP server, skills, analysis providers, or existing Codex/Claude integrations.

## Current providers

- OpenAI API (server-side API key)
- Anthropic API / Claude (server-side API key)

The dashboard streams responses and keeps provider secrets on the local server. It does not expose API keys to browser JavaScript and does not persist chat history after the page is closed.

> API billing is separate from ChatGPT, Codex, Claude, or Claude Code subscriptions. An API key and provider account with API access may be required. Existing Codex and Claude Code integrations remain separate and continue to use their supported agent/MCP setup.

## Requirements

- Node.js 22.23.4 or newer (matching the main REA runtime requirement)
- An OpenAI API key and/or Anthropic API key

## Run locally

From the repository root:

```bash
cd studio
cp .env.example .env
```

Add your keys to `.env`. Do not commit that file. Then export the values into your shell (or use your operating system's environment-variable settings) and run:

```bash
npm start
```

The server listens on `http://127.0.0.1:4177` by default.

PowerShell example:

```powershell
$env:OPENAI_API_KEY = "your-api-key"
$env:ANTHROPIC_API_KEY = "your-api-key"
npm start
```

Optional model defaults:

- `OPENAI_MODEL` (default: `gpt-4.1`)
- `ANTHROPIC_MODEL` (default: `claude-sonnet-4-5`)

## Security notes

- The server binds to loopback (127.0.0.1) by default.
- Provider keys are read only from server environment variables.
- The browser never receives provider keys.
- Cross-origin chat requests are rejected.
- Request bodies and conversation sizes are bounded.
- No chat history or API credentials are written to disk.
- Do not expose this server on a public interface or VPS until authentication, HTTPS, per-user isolation, rate limits, and secret management have been implemented and reviewed.

## Scope of this first increment

This is the AI chat shell and provider adapter foundation. It does not yet invoke REA MCP tools from chat. The next integration step is to connect the existing REA MCP server through a scoped MCP client/tool bridge, with explicit user approval for tool actions. Existing REA functionality is untouched.
