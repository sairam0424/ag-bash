"use client";

import { useState, useEffect } from "react";

interface VfsExplorerProps {
  files: Record<string, any>;
  onFileClick: (path: string) => void;
}

export function VfsExplorer({ files, onFileClick }: VfsExplorerProps) {
  // Simple tree construction from flat paths
  const [tree, setTree] = useState<any>({});

  useEffect(() => {
    const newTree: any = {};
    Object.keys(files).forEach(path => {
      const parts = path.split("/").filter(Boolean);
      let current = newTree;
      parts.forEach((part, i) => {
        if (!current[part]) {
          current[part] = i === parts.length - 1 ? { _type: "file", _path: path } : {};
        }
        current = current[part];
      });
    });
    setTree(newTree);
  }, [files]);

  const renderTree = (node: any, name: string, depth = 0) => {
    if (node._type === "file") {
      return (
        <div 
          key={node._path}
          onClick={() => onFileClick(node._path)}
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
          renderTree(node[key], key, depth + 1)
        )}
      </div>
    );
  };

  return (
    <div className="py-2">
      {Object.keys(tree).sort().map(key => renderTree(tree[key], key))}
    </div>
  );
}
