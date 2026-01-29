#!/usr/bin/env node
// Single task runner - run as a separate process
import { startBrowserAgent, createAction } from "../../packages/magnitude-core/dist/index.mjs";
import { createAgentBrowserActions, setPage } from "./agent-browser-actions.js";
import * as fs from "fs";
import * as path from "path";
import z from "zod";
import { chromium } from "patchright";

interface Task {
    web_name: string;
    id: string;
    ques: string;
    web: string;
}

async function main() {
    const taskFile = process.argv[2];
    const runEval = process.argv[3] === 'true';

    if (!taskFile) {
        console.error("No task file provided");
        process.exit(1);
    }

    const task: Task = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
    const MAX_CRASH_RETRIES = 3;
    let crashAttempts = 0;
    
    // Remove old evaluation file if it exists
    const evalPath = path.join("results", `${task.id}.eval.json`);
    if (fs.existsSync(evalPath)) {
        fs.unlinkSync(evalPath);
        console.log(`[Runner] Removed old evaluation file: ${evalPath}`);
    }
    
    while (crashAttempts < MAX_CRASH_RETRIES) {
        console.log(`[Runner] Running task: ${task.id} - ${task.ques}`);
        console.log(`[Runner] URL: ${task.web}`);

        let startTime = Date.now();
        let context: any = null;
        let agent: any = null;
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalInputCost = 0.0;
        let totalOutputCost = 0.0;
        let actionCount = 0;

        try {
        const date = new Date();
        const formattedDate = date.toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric'
        });

        // Launch browser (no CDP needed - we use library directly)
        context = await chromium.launchPersistentContext("", {
            channel: "chrome",
            headless: false,
            viewport: { width: 1024, height: 768 },
            deviceScaleFactor: process.platform === 'darwin' ? 2 : 1,
        });

        // Get or create page and set it for agent-browser actions
        const page = context.pages()[0] || await context.newPage();
        setPage(page);
        console.log(`[Runner] Page set for agent-browser actions`);

        // Create agent-browser actions (uses library directly, not CLI)
        const agentBrowserActions = createAgentBrowserActions();

        agent = await startBrowserAgent({
            browser: { context: context },
            llm: {
                provider: "claude-code",
                options: {
                    model: "claude-opus-4-5-20251101",
                    temperature: 0.5
                },
            },
            url: task.web,
            actions: [
                createAction({
                    name: "answer",
                    description: "Give final answer",
                    schema: z.string(),
                    resolver: async ({ input, agent }: { input: string; agent: any }) => {
                        console.log("ANSWER GIVEN:", input);
                        await agent.queueDone();
                    },
                }),
                // Add agent-browser actions (via CDP) for faster element targeting
                ...agentBrowserActions,
            ],
            narrate: true,
            prompt: `Be careful to satisfy the task criteria precisely. If sequences of actions are failing, go one action at at time.
Consider that today is ${formattedDate}.

IMPORTANT: ALWAYS use 'snapshot' first to get element refs (@e1, @e2, etc.), then use click_ref, fill_ref, type_ref instead of vision-based clicking.
This is MUCH faster and more reliable than pixel coordinates. Only fall back to vision (mouse:click) if refs don't work.

Workflow:
1. snapshot - get interactive elements as refs
2. click_ref @e5 - click by ref
3. fill_ref @e3 "text" - fill input by ref
4. If page changes, run snapshot again to get new refs`,
            screenshotMemoryLimit: 3,
        });

        agent.events.on("tokensUsed", async (usage: { inputTokens: number; outputTokens: number; inputCost?: number; outputCost?: number }) => {
            totalInputTokens += usage.inputTokens;
            totalOutputTokens += usage.outputTokens;
            totalInputCost += usage.inputCost ?? 0.0;
            totalOutputCost += usage.outputCost ?? 0.0;
        });

        agent.events.on("actionDone", async () => {
            const memory = await agent.memory.toJSON();
            actionCount += 1;

            fs.writeFileSync(
                path.join("results", `${task.id}.json`),
                JSON.stringify(
                    {
                        time: Date.now() - startTime,
                        actionCount,
                        totalInputTokens,
                        totalOutputTokens,
                        totalInputCost,
                        totalOutputCost,
                        memory,
                    },
                    null,
                    4,
                ),
            );
        });

        // Set up timeout
        const TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
        await Promise.race([
            agent.act(task.ques),
            new Promise<void>((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`Task timed out after 20 minutes`));
                }, TIMEOUT_MS);
            })
        ]);

            console.log(`[Runner] Finished task: ${task.id}`);
            
            // Explicitly save final state before exit - ensure answer gets written out
            const finalMemory = await agent.memory.toJSON();
            fs.writeFileSync(
                path.join("results", `${task.id}.json`),
                JSON.stringify(
                    {
                        time: Date.now() - startTime,
                        actionCount,
                        totalInputTokens,
                        totalOutputTokens,
                        totalInputCost,
                        totalOutputCost,
                        memory: finalMemory,
                    },
                    null,
                    4,
                ),
            );
            
            // Delay to ensure file write completes
            await new Promise(resolve => setTimeout(resolve, 1000));
            process.exit(0);

        } catch (error) {
            const errorMessage = (error as Error).message;
            console.error(`[Runner] Error in task ${task.id}:`, error);
            
            // Check if it's a recoverable crash
            const isRecoverableCrash = errorMessage.includes('net::ERR_ABORTED') || 
                                      errorMessage.includes('Target page, context or browser has been closed') ||
                                      errorMessage.includes('Failed to connect') ||
                                      errorMessage.includes('ENOENT') ||
                                      errorMessage.includes('ECONNREFUSED');
            
            if (isRecoverableCrash && crashAttempts < MAX_CRASH_RETRIES - 1) {
                crashAttempts++;
                console.log(`[Runner] 🔄 Retrying crashed task ${task.id} (crash attempt ${crashAttempts}/${MAX_CRASH_RETRIES})...`);
                // Small delay before retrying
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue; // Retry the task
            }
            
            // Save error state before failing
            const memory = agent ? await agent.memory.toJSON() : null;
            fs.writeFileSync(
                path.join("results", `${task.id}.json`),
                JSON.stringify(
                    {
                        time: Date.now() - startTime,
                        actionCount,
                        totalInputTokens,
                        totalOutputTokens,
                        totalInputCost,
                        totalOutputCost,
                        memory,
                        error: errorMessage,
                        timedOut: errorMessage.includes('timed out'),
                        crashAttempts: crashAttempts + 1
                    },
                    null,
                    4,
                ),
            );
            
            process.exit(1); // Failed after retries
        } finally {
            // Cleanup
            try {
                if (agent) await agent.stop();
            } catch (e) {
                console.error("[Runner] Error stopping agent:", e);
            }
            
            try {
                if (context) await context.close();
            } catch (e) {
                console.error("[Runner] Error closing context:", e);
            }
        }
    }
    
    // Should never reach here
    process.exit(1);
}

main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});