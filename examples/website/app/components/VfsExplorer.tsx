"use client";

import { useMemo } from "react";
import type { InitialFiles } from "@ag-bash/bash";

interface VfsNode {
  _type?: "file";
  _path?: string;
  [key: string]: VfsNode | string | undefined;
}

interface VfsExplorerProps {
  files: InitialFiles;
  onFileClick: (path: string) => void;
}

export function VfsExplorer({ files, onFileClick }: VfsExplorerProps) {
  // Simple tree construction from flat paths
  const tree = useMemo(() => {
    const newTree: VfsNode = {};
    Object.keys(files).forEach(path => {
      const parts = path.split("/").filter(Boolean);
      let current = newTree;
      parts.forEach((part, i) => {
        if (!current[part]) {
          current[part] = i === parts.length - 1 ? { _type: "file", _path: path } : {};
        }
        current = current[part] as VfsNode;
      });
    });
    return newTree;
  }, [files]);

  const renderTree = (node: VfsNode, name: string, depth = 0) => {
    if (node._type === "file") {
      return (
        <div 
          key={node._path}
          onClick={() => onFileClick(node._path!)}
          className="flex items-center gap-2 px-4 py-1.5 hover:bg-accent-dim cursor-pointer group transition-colors"
          style={{ paddingLeft: `${(depth + 1) * 12 + 16}px` }}
        >
          <span className="text-dim group-hover:text-accent">📄</span>
          <span className="text-xs text-foreground/80 group-hover:text-foreground font-mono truncate">{name}</span>
        </div>
      );
    }

    return (
      <div key={name}>
        <div 
          className="flex items-center gap-2 px-4 py-1.5 hover:bg-accent-dim/10 cursor-default select-none group"
          style={{ paddingLeft: `${depth * 12 + 16}px` }}
        >
          <span className="text-dim/50 group-hover:text-accent/50">📁</span>
          <span className="text-xs font-bold text-dim group-hover:text-foreground truncate uppercase tracking-tighter">{name}</span>
        </div>
        {Object.keys(node).filter(k => k !== "_type" && k !== "_path").sort().map(key => 
          renderTree(node[key] as VfsNode, key, depth + 1)
        )}
      </div>
    );
  };

  return (
    <div className="py-2">
      {Object.keys(tree).sort().map(key => renderTree(tree[key] as VfsNode, key))}
    </div>
  );
}
