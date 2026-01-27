import { readdir, readFile } from "fs/promises";
import { join } from "path";
import * as readline from "readline";
import * as fs from "fs";
import * as http from "http";
import * as url from "url";

const port = 8000;
const resultsDir = "./results";
const TASKS_PATH = join(__dirname, "data", "patchedTasks.jsonl");

interface Task {
  web_name: string;
  id: string;
  ques: string;
  web: string;
}

interface EvalData {
  result: string;
  reasoning?: string;
}

async function findTaskById(taskId: string): Promise<Task | null> {
  const fileStream = fs.createReadStream(TASKS_PATH);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    try {
      const task: Task = JSON.parse(line);
      if (task.id === taskId) {
        return task;
      }
    } catch (error) {
      console.error("Error parsing JSON line:", error);
    }
  }
  return null;
}

async function getTasksList(): Promise<{ status: number; body: string; contentType: string }> {
  try {
    const files = await readdir(resultsDir);
    const tasks = files
      .filter(file => file.endsWith(".json") && !file.endsWith(".eval.json") && !file.endsWith(".task.json"))
      .map(file => file.slice(0, -5))
      .sort();

    return { status: 200, body: JSON.stringify(tasks), contentType: "application/json" };
  } catch (error: any) {
    return { status: 500, body: JSON.stringify({ error: error.message }), contentType: "application/json" };
  }
}

async function getTasksSummary(): Promise<{ status: number; body: string; contentType: string }> {
  try {
    const files = await readdir(resultsDir);
    const taskFiles = files.filter(file => file.endsWith(".json") && !file.endsWith(".eval.json") && !file.endsWith(".task.json"));

    const categorizedTasks: Record<string, Array<{
      id: string;
      success?: boolean;
      time?: number;
      cost?: number;
      tokens?: number;
      actions?: number;
    }>> = {};

    for (const file of taskFiles) {
      const taskId = file.slice(0, -5);
      const [category] = taskId.split("--");

      if (!categorizedTasks[category]) {
        categorizedTasks[category] = [];
      }

      try {
        const taskData = JSON.parse(await readFile(join(resultsDir, file), "utf-8"));

        let evalData: EvalData | null = null;
        try {
          const evalContent = await readFile(join(resultsDir, `${taskId}.eval.json`), "utf-8");
          evalData = JSON.parse(evalContent) as EvalData;
        } catch {
          // No eval data
        }

        categorizedTasks[category].push({
          id: taskId,
          success: evalData ? evalData.result === "SUCCESS" : undefined,
          time: taskData.time,
          cost: (taskData.totalInputCost || 0) + (taskData.totalOutputCost || 0),
          tokens: (taskData.totalInputTokens || 0) + (taskData.totalOutputTokens || 0),
          actions: taskData.actionCount
        });
      } catch (error) {
        console.error(`Error processing ${taskId}:`, error);
        categorizedTasks[category].push({ id: taskId });
      }
    }

    for (const category in categorizedTasks) {
      categorizedTasks[category].sort((a, b) => {
        const aNum = parseInt(a.id.split("--")[1] || "0");
        const bNum = parseInt(b.id.split("--")[1] || "0");
        return aNum - bNum;
      });
    }

    return { status: 200, body: JSON.stringify(categorizedTasks), contentType: "application/json" };
  } catch (error: any) {
    return { status: 500, body: JSON.stringify({ error: error.message }), contentType: "application/json" };
  }
}

async function getTaskData(taskName: string): Promise<{ status: number; body: string; contentType: string }> {
  try {
    const filePath = join(resultsDir, `${taskName}.json`);
    const evalFilePath = join(resultsDir, `${taskName}.eval.json`);

    const data = await readFile(filePath, "utf-8");
    const parsedData = JSON.parse(data);

    let evalData: EvalData | null = null;
    try {
      const evalContent = await readFile(evalFilePath, "utf-8");
      evalData = JSON.parse(evalContent) as EvalData;
    } catch {
      // Eval file doesn't exist
    }

    const task = await findTaskById(taskName);

    const combinedData = {
      ...parsedData,
      evaluation: evalData,
      task: task
    };

    return { status: 200, body: JSON.stringify(combinedData), contentType: "application/json" };
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return { status: 404, body: JSON.stringify({ error: `Task not found: ${taskName}` }), contentType: "application/json" };
    }
    return { status: 500, body: JSON.stringify({ error: error.message }), contentType: "application/json" };
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url || "", true);
  const path = parsedUrl.pathname || "/";

  let response: { status: number; body: string; contentType: string };

  if (path === "/api/tasks") {
    response = await getTasksList();
  } else if (path === "/api/tasks-summary") {
    response = await getTasksSummary();
  } else if (path.startsWith("/api/task/")) {
    const taskName = decodeURIComponent(path.slice(10));
    response = await getTaskData(taskName);
  } else if (path === "/" || path === "") {
    try {
      const html = await readFile(join(__dirname, "viewer.html"), "utf-8");
      response = { status: 200, body: html, contentType: "text/html" };
    } catch {
      response = { status: 404, body: "viewer.html not found", contentType: "text/plain" };
    }
  } else {
    response = { status: 404, body: "Not found", contentType: "text/plain" };
  }

  res.writeHead(response.status, { "Content-Type": response.contentType });
  res.end(response.body);
});

server.listen(port, () => {
  console.log(`WebVoyager visualizer server running at http://localhost:${port}`);
  console.log("Press Ctrl+C to stop the server");
});
