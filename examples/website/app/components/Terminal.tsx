"use client";

import { useEffect, useRef } from "react";
import { Bash } from "@ag-bash/bash/browser";
import type { InitialFiles } from "@ag-bash/bash";
import { getTerminalData } from "./TerminalData";
import {
  createStaticCommands,
  createAgentExecutor,
  createInputHandler,
  showWelcome,
} from "./terminal-parts";
import { LiteTerminal } from "./lite-terminal";


async function fetchFiles(bash: Bash) {
  const response = await fetch("/api/fs");
  const files: Record<string, string> = await response.json();
  for (const [path, content] of Object.entries(files)) {
    bash.writeFile(path, content);
  }
}

function getTheme() {
  return {
    background: "#000",
    foreground: "#f0f6fc",
    cursor: "#0ac5b3",
    cyan: "#0AC5B3",
    brightCyan: "#3DD9C8",
    brightBlack: "#666",
  };
}

export default function TerminalComponent({ 
  onInit,
  onFileSystemChange 
}: { 
  onInit?: (execute: (cmd: string) => void) => void,
  onFileSystemChange?: (files: InitialFiles) => void
}) {
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = terminalRef.current;
    if (!container) return;

    const term = new LiteTerminal({
      cursorBlink: true,
      theme: getTheme(),
    });
    term.open(container);

    const { aboutCmd, installCmd, githubCmd } = createStaticCommands();
    const { agentCmd, executeAgentPrompt } = createAgentExecutor(term);

    const files = {
      "/home/user/README.md": getTerminalData("file-readme"),
      "/home/user/LICENSE": getTerminalData("file-license"),
      "/home/user/package.json": getTerminalData("file-package-json"),
      "/home/user/AGENTS.md": getTerminalData("file-agents-md"),
      "/home/user/wtf-is-this.md": getTerminalData("file-wtf-is-this"),
      "/home/user/dirs/are/fun/author/info.txt": "https://x.com/cramforce\n",
    };

    const bash = new Bash({
      customCommands: [aboutCmd, installCmd, githubCmd, agentCmd],
      files,
      cwd: "/home/user",
      persistState: true,
      onCommandNotFound: async (cmd, args) => {
        const fullPrompt = [cmd, ...args].join(" ");
        return executeAgentPrompt(fullPrompt);
      },
    });

    const inputHandler = createInputHandler(term, bash);
    
    // Notify parent and offer execution hook
    if (onInit) {
      onInit((cmd) => {
        void inputHandler.executeCommand(cmd);
      });
    }

    // Initial FS state
    if (onFileSystemChange) onFileSystemChange(files);

    void fetchFiles(bash);

    let disposed = false;

    requestAnimationFrame(() => {
      if (disposed) return;
      showWelcome(term);
      
      const params = new URLSearchParams(window.location.search);
      const agentQuery = params.get("agent");

      if (agentQuery) {
        window.history.replaceState({}, "", window.location.pathname);
        void inputHandler.executeCommand(`agent "${agentQuery}"`);
      } else if (inputHandler.history.length === 0) {
        inputHandler.setInitialCommand('agent "What is ag-bash?"');
      }
    });

    term.focus();

    return () => {
      disposed = true;
      term.dispose();
    };
  }, [onInit, onFileSystemChange]);

  return (
    <div
      ref={terminalRef}
      style={{
        padding:
          "calc(16px + env(safe-area-inset-top, 0px)) calc(16px + env(safe-area-inset-right, 0px)) 16px calc(16px + env(safe-area-inset-left, 0px))",
        boxSizing: "border-box",
      }}
    />
  );
}
