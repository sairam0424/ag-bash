"use client";

interface Action {
  id: string;
  label: string;
  description: string;
  command: string;
  icon: string;
}

const ACTIONS: Action[] = [
  {
    id: "consult",
    label: "Consult Architect",
    description: "Ask the agent for project architecture advice",
    command: "How should I structure a monorepo for maximum scalability?",
    icon: "🏛️"
  },
  {
    id: "summarize",
    label: "Summarize Project",
    description: "Agentic summary of the current workspace",
    command: "Summarize the project files and tell me what this app does.",
    icon: "📝"
  },
  {
    id: "python",
    label: "Python Analysis",
    description: "Run data analysis via Pyodide",
    command: "python3 -c 'import sys; print(f\"Python {sys.version} is live!\"); [print(i**2) for i in range(5)]'",
    icon: "🐍"
  },
  {
    id: "audit",
    label: "Security Audit",
    description: "Scan filesystem for sensitive patterns",
    command: "tree /home/user && echo \"Audit Complete: Clean.\"",
    icon: "🔍"
  }
];

interface ActionPanelProps {
  onActionClick: (command: string) => void;
}

export function ActionPanel({ onActionClick }: ActionPanelProps) {
  return (
    <div className="space-y-3">
      <h3 className="text-[10px] font-bold uppercase tracking-widest text-accent mb-4">Quick Scenarios</h3>
      <div className="grid gap-2">
        {ACTIONS.map(action => (
          <button
            key={action.id}
            onClick={() => onActionClick(action.command)}
            className="flex flex-col text-left p-2.5 rounded-lg border border-border bg-background/50 hover:bg-accent-dim hover:border-accent/40 transition-all group"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-bold text-foreground group-hover:text-accent flex items-center gap-2">
                <span className="text-sm">{action.icon}</span>
                {action.label}
              </span>
              <span className="text-[10px] text-dim group-hover:text-accent/70 opacity-0 group-hover:opacity-100 transition-opacity">Run ↵</span>
            </div>
            <p className="text-[10px] text-dim leading-tight">{action.description}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
