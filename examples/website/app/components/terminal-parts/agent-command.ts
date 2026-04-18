import { createAgentBridge } from "@ag-bash/agent-bridge";

type TerminalWriter = {
  write: (data: string) => void;
};

export function createAgentExecutor(term: TerminalWriter) {
  const bridge = createAgentBridge(term, {
    apiEndpoint: "/api/agent",
  });

  return { 
    agentCmd: bridge.agentCmd, 
    executeAgentPrompt: bridge.executeAgentPrompt 
  };
}

