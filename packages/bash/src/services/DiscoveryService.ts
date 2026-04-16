import type { Bash } from "../Bash.js";

export interface ProjectBrief {
  type: string;
  name: string;
  entryPoints: string[];
  scripts: Record<string, string>;
  dependencies: string[];
}

export class DiscoveryService {
  constructor(private bash: Bash) {}

  async scan(): Promise<ProjectBrief> {
    const brief: ProjectBrief = {
      type: "Unknown",
      name: "Unnamed Project",
      entryPoints: [],
      scripts: Object.create(null),
      dependencies: [],
    };

    try {
      // 1. Check for Node.js
      const pkgResult = await this.bash.exec("cat package.json");
      if (pkgResult.exitCode === 0) {
        const pkg = JSON.parse(pkgResult.stdout);
        brief.type = "Node.js";
        brief.name = pkg.name || brief.name;
        brief.scripts = pkg.scripts || Object.create(null);
        brief.dependencies = Object.keys(
          pkg.dependencies || Object.create(null),
        );

        // Detect common entry points
        if (pkg.main) brief.entryPoints.push(pkg.main);
        return brief;
      }

      // 2. Check for Python
      const pyResult = await this.bash.exec(
        "ls requirements.txt pyproject.toml",
      );
      if (pyResult.exitCode === 0) {
        brief.type = "Python";
        return brief;
      }

      // 3. Check for Rust
      const rustResult = await this.bash.exec("ls Cargo.toml");
      if (rustResult.exitCode === 0) {
        brief.type = "Rust";
        return brief;
      }
    } catch (_e) {
      // Ignore scan errors
    }

    return brief;
  }

  getSummary(brief: ProjectBrief): string {
    if (brief.type === "Unknown") {
      return "Unable to determine project type. Local files are visible but not indexed.";
    }

    let summary = `Detected ${brief.type} project: ${brief.name}\n`;
    if (brief.entryPoints.length > 0) {
      summary += `Main entry point: ${brief.entryPoints[0]}\n`;
    }
    const scripts = Object.keys(brief.scripts);
    if (scripts.length > 0) {
      summary += `Available scripts: ${scripts.join(", ")}\n`;
    }
    return summary;
  }
}
