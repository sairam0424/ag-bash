"use client";

import { useState, useCallback } from "react";
import TerminalComponent from "./components/Terminal";
import { Dashboard } from "./components/Dashboard";
import { VfsExplorer } from "./components/VfsExplorer";
import { ActionPanel } from "./components/ActionPanel";

/**
 * Ag-Bash Playground
 * 
 * The main entry point for the interactive WASM sandbox.
 * Features a split-pane dashboard with terminal, VFS explorer, and quick actions.
 */
export default function Home() {
  const [terminalExecutor, setTerminalExecutor] = useState<((cmd: string) => void) | null>(null);
  const [vfs, setVfs] = useState<Record<string, any>>({});

  // Initialize terminal hook
  const handleInit = useCallback((execute: (cmd: string) => void) => {
    setTerminalExecutor(() => execute);
  }, []);

  // Sync VFS state
  const handleFileSystemChange = useCallback((files: Record<string, any>) => {
    setVfs(files);
  }, []);

  // Handle clicking a file in the sidebar
  const handleFileClick = (path: string) => {
    if (terminalExecutor) {
      terminalExecutor(`cat ${path}`);
    }
  };

  // Handle clicking a scenario card
  const handleActionClick = (command: string) => {
    if (terminalExecutor) {
      terminalExecutor(command);
    }
  };

  return (
    <Dashboard 
      sidebar={<VfsExplorer files={vfs} onFileClick={handleFileClick} />}
      actions={<ActionPanel onActionClick={handleActionClick} />}
    >
      <div className="h-full w-full">
        <TerminalComponent 
          onInit={handleInit} 
          onFileSystemChange={handleFileSystemChange} 
        />
      </div>
    </Dashboard>
  );
}
