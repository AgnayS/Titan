import { chromium } from 'patchright';
import { startBrowserAgent } from '../../packages/magnitude-core/dist/index.mjs';

async function main() {
    console.log('1. Launching browser...');
    const context = await chromium.launchPersistentContext("", {
        channel: "chrome",
        headless: false,
        viewport: { width: 1024, height: 768 }
    });
    console.log('2. Browser launched');

    console.log('3. Creating agent...');
    const agent = await startBrowserAgent({
        browser: { context },
        llm: { provider: 'claude-code', options: { model: 'claude-sonnet-4-20250514' } },
        url: 'https://www.allrecipes.com/'
    });
    console.log('4. Agent created!');

    console.log('5. Running task...');
    await agent.act('Find a vegetarian lasagna recipe');
    console.log('6. Done!');

    await context.close();
}

main().catch(console.error);
