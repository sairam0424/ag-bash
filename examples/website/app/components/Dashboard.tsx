"use client";

import { ReactNode } from "react";

interface DashboardProps {
  children: ReactNode;
  sidebar?: ReactNode;
  actions?: ReactNode;
}

export function Dashboard({ children, sidebar, actions }: DashboardProps) {
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background">
      {/* Top Navigation */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-border glass z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center font-bold text-background">
            AG
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight">Ag-Bash <span className="text-accent">Playground</span></h1>
            <p className="text-[10px] text-dim font-mono leading-none">v1.1.0 Digital Architect</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <a href="https://github.com/sairam0424/ag-bash" target="_blank" className="text-xs text-dim hover:text-foreground transition-colors">GitHub</a>
          <div className="h-4 w-[1px] bg-border" />
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent-dim text-accent border border-accent/20">WASM Runtime</span>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Resource Sidebar */}
        <aside className="w-72 border-r border-border glass flex flex-col hidden lg:flex">
          <div className="p-4 border-b border-border">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-dim">Virtual Resources</h2>
          </div>
          <div className="flex-1 overflow-y-auto">
            {sidebar}
          </div>
          <div className="p-4 border-t border-border bg-accent-dim/20">
            {actions}
          </div>
        </aside>

        {/* Main Terminal Area */}
        <main className="flex-1 relative overflow-hidden bg-[#000]">
          {children}
        </main>
      </div>
    </div>
  );
}
