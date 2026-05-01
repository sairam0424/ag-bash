/**
 * TeamManager - Multi-agent team and messaging service.
 *
 * Manages agent teams (logical groupings), inter-agent messaging,
 * and broadcasts via SharedStateBus.
 */

import type { SharedStateBus } from "./SharedStateBus.js";

export interface Team {
  id: string;
  name: string;
  description?: string;
  agents: string[];
  createdAt: number;
}

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
}

let nextTeamId = 1;
let nextMsgId = 1;

export class TeamManager {
  private teams: Map<string, Team> = new Map();
  private messages: AgentMessage[] = [];
  private bus: SharedStateBus | undefined;
  private maxTeams: number;
  private maxMessages: number;

  constructor(options?: { maxTeams?: number; maxMessages?: number }) {
    this.maxTeams = options?.maxTeams ?? 10;
    this.maxMessages = options?.maxMessages ?? 1000;
  }

  setBus(bus: SharedStateBus): void {
    this.bus = bus;
  }

  createTeam(opts: {
    name: string;
    description?: string;
    agents?: string[];
  }): Team {
    if (this.teams.size >= this.maxTeams) {
      throw new Error(`Maximum team limit reached (${this.maxTeams})`);
    }

    for (const team of this.teams.values()) {
      if (team.name === opts.name) {
        throw new Error(`Team "${opts.name}" already exists`);
      }
    }

    const team: Team = {
      id: `team_${nextTeamId++}`,
      name: opts.name,
      description: opts.description,
      agents: opts.agents || [],
      createdAt: Date.now(),
    };

    this.teams.set(team.id, team);
    this.bus?.publish("state:teams", "teamManager", {
      action: "created",
      team: { ...team },
    });
    return team;
  }

  deleteTeam(idOrName: string): boolean {
    let team: Team | undefined;
    for (const t of this.teams.values()) {
      if (t.id === idOrName || t.name === idOrName) {
        team = t;
        break;
      }
    }
    if (!team) return false;

    this.teams.delete(team.id);
    this.bus?.publish("state:teams", "teamManager", {
      action: "deleted",
      team: { ...team },
    });
    return true;
  }

  getTeam(idOrName: string): Team | undefined {
    for (const t of this.teams.values()) {
      if (t.id === idOrName || t.name === idOrName) return t;
    }
    return undefined;
  }

  listTeams(): Team[] {
    return Array.from(this.teams.values());
  }

  addAgentToTeam(teamIdOrName: string, agentId: string): void {
    const team = this.getTeam(teamIdOrName);
    if (!team) throw new Error(`Team "${teamIdOrName}" not found`);
    if (!team.agents.includes(agentId)) {
      team.agents.push(agentId);
    }
  }

  removeAgentFromTeam(teamIdOrName: string, agentId: string): void {
    const team = this.getTeam(teamIdOrName);
    if (!team) throw new Error(`Team "${teamIdOrName}" not found`);
    team.agents = team.agents.filter((a) => a !== agentId);
  }

  sendMessage(from: string, to: string, content: string): AgentMessage {
    if (this.messages.length >= this.maxMessages) {
      this.messages.splice(0, Math.floor(this.maxMessages * 0.1));
    }

    const msg: AgentMessage = {
      id: `msg_${nextMsgId++}`,
      from,
      to,
      content,
      timestamp: Date.now(),
    };

    this.messages.push(msg);
    this.bus?.publish("agent:message", from, msg);
    return msg;
  }

  broadcast(from: string, teamIdOrName: string, content: string): AgentMessage[] {
    const team = this.getTeam(teamIdOrName);
    if (!team) throw new Error(`Team "${teamIdOrName}" not found`);

    const sent: AgentMessage[] = [];
    for (const agentId of team.agents) {
      if (agentId !== from) {
        sent.push(this.sendMessage(from, agentId, content));
      }
    }
    return sent;
  }

  getInbox(agentId: string): AgentMessage[] {
    return this.messages.filter(
      (m) => m.to === agentId || m.to === "*",
    );
  }

  getConversation(agent1: string, agent2: string): AgentMessage[] {
    return this.messages.filter(
      (m) =>
        (m.from === agent1 && m.to === agent2) ||
        (m.from === agent2 && m.to === agent1),
    );
  }
}
