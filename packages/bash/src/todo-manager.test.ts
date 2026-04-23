import { beforeEach, describe, expect, it } from "vitest";
import { BashToolbox } from "./agentic/BashToolbox.js";
import { Bash } from "./Bash.js";
import { InMemoryFs } from "./fs/in-memory-fs/index.js";

describe("Todo Manager (Phase 7)", () => {
  let bash: Bash;
  let tools: any;

  beforeEach(() => {
    bash = new Bash({
      parserEngine: "legacy",
      fs: new InMemoryFs(),
    });
    const toolbox = new BashToolbox();
    tools = toolbox.getAgenticTools(bash);
  });

  it("should add and list todos", async () => {
    const res1 = await tools.add_todo.execute({ task: "Task 1" });
    expect(res1.success).toBe(true);
    expect(res1.id).toBe("1");

    const res2 = await tools.add_todo.execute({
      task: "Task 2",
      status: "doing",
    });
    expect(res2.id).toBe("2");

    const list = await tools.list_todos.execute({});
    expect(list.todos.length).toBe(2);
    expect(list.todos[0].task).toBe("Task 1");
    expect(list.todos[0].status).toBe("pending");
    expect(list.todos[1].status).toBe("doing");
  });

  it("should update todo status", async () => {
    await tools.add_todo.execute({ task: "Task to update" });
    const res = await tools.update_todo.execute({ id: "1", status: "done" });
    expect(res.success).toBe(true);

    const list = await tools.list_todos.execute({});
    expect(list.todos[0].status).toBe("done");
  });

  it("should return error if todo not found", async () => {
    const res = await tools.update_todo.execute({ id: "99", status: "done" });
    expect(res.error).toContain("not found");
  });

  it("should persist todos in the sandbox filesystem", async () => {
    await tools.add_todo.execute({ task: "Persistent Task" });
    const exists = await bash.fs.exists("/.ag-bash/todos.json");
    expect(exists).toBe(true);

    const content = await bash.readFileDirect("/.ag-bash/todos.json");
    expect(content).toContain("Persistent Task");
  });
});
