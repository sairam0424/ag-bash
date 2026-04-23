import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { hasHelpFlag, showHelp } from "../help.js";

const agTodoHelp = {
  name: "ag-todo",
  summary: "manage project tasks and todos",
  usage: "ag-todo [add|list|update|rm] [args]",
  options: [
    "    --help        display this help and exit",
  ],
};

interface Todo {
  id: string;
  task: string;
  status: "pending" | "doing" | "done";
  createdAt: number;
}

export const agTodoCommand: Command = {
  name: "ag-todo",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(agTodoHelp);

    const subcommand = args[0] || "list";
    const todosPath = "/.ag-bash/todos.json";

    const loadTodos = async (): Promise<Todo[]> => {
      if (!(await ctx.fs.exists(todosPath))) return [];
      try {
        const content = await ctx.fs.readFile(todosPath, "utf8");
        return JSON.parse(content);
      } catch {
        return [];
      }
    };

    const saveTodos = async (todos: Todo[]): Promise<void> => {
      await ctx.fs.mkdir("/.ag-bash", { recursive: true });
      await ctx.fs.writeFile(todosPath, JSON.stringify(todos, null, 2));
    };

    switch (subcommand) {
      case "list": {
        const todos = await loadTodos();
        if (todos.length === 0) {
          return { stdout: "No todos found.\n", stderr: "", exitCode: 0 };
        }
        let output = "Project TODO List:\n";
        todos.forEach(t => {
          const marker = t.status === "done" ? "[x]" : t.status === "doing" ? "[/]" : "[ ]";
          output += `${t.id.padEnd(4)} ${marker} ${t.task}\n`;
        });
        return { stdout: output, stderr: "", exitCode: 0 };
      }

      case "add": {
        const task = args.slice(1).join(" ");
        if (!task) return { stdout: "", stderr: "ag-todo: missing task description\n", exitCode: 1 };
        const todos = await loadTodos();
        const newTodo: Todo = {
          id: (todos.length + 1).toString(),
          task,
          status: "pending",
          createdAt: Date.now()
        };
        todos.push(newTodo);
        await saveTodos(todos);
        return { stdout: `Added todo ${newTodo.id}\n`, stderr: "", exitCode: 0 };
      }

      case "update": {
        const id = args[1];
        const status = args[2] as any;
        if (!id || !["pending", "doing", "done"].includes(status)) {
          return { stdout: "", stderr: "Usage: ag-todo update <id> <pending|doing|done>\n", exitCode: 1 };
        }
        const todos = await loadTodos();
        const todo = todos.find(t => t.id === id);
        if (!todo) return { stdout: "", stderr: `ag-todo: todo ${id} not found\n`, exitCode: 1 };
        todo.status = status;
        await saveTodos(todos);
        return { stdout: `Updated todo ${id} status to ${status}\n`, stderr: "", exitCode: 0 };
      }

      case "rm": {
        const id = args[1];
        if (!id) return { stdout: "", stderr: "Usage: ag-todo rm <id>\n", exitCode: 1 };
        let todos = await loadTodos();
        const initialLen = todos.length;
        todos = todos.filter(t => t.id !== id);
        if (todos.length === initialLen) {
          return { stdout: "", stderr: `ag-todo: todo ${id} not found\n`, exitCode: 1 };
        }
        await saveTodos(todos);
        return { stdout: `Removed todo ${id}\n`, stderr: "", exitCode: 0 };
      }

      default:
        return { stdout: "", stderr: `ag-todo: unknown subcommand: ${subcommand}\n`, exitCode: 1 };
    }
  },
};
