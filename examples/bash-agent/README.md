# File Explorer Agent

An interactive AI agent that lets you explore files and directories using natural language.

Uses [@ag-bash/bash](https://github.com/ag-ai/@ag-bash/bash) for the AI SDK integration.

## Files

- `main.ts` - Entry point
- `agent.ts` - Agent logic (@ag-bash/bash + AI SDK)
- `shell.ts` - Interactive readline shell

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Set your Anthropic API key:

   ```bash
   export ANTHROPIC_API_KEY=your-key-here
   ```

3. Run:
   ```bash
   npm start
   ```

## Usage

```bash
# Explore a specific directory
npx tsx main.ts /path/to/directory

# Explore the @ag-bash/bash project (default)
npx tsx main.ts
```

Ask questions like:

- "What files are in here?"
- "Show me the contents of config.json"
- "Find all CSV files"
- "How many lines are in each file?"
- "Search for 'TODO' in the code"

Type `exit` to quit.

## Development

```bash
npm run typecheck
```
