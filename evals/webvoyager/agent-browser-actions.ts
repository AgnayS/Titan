/**
 * Agent-browser integration for Magnitude
 *
 * Uses agent-browser's snapshot and ref system directly via the library
 * instead of going through CLI/CDP (which has connection issues).
 */

import { createAction } from "../../packages/magnitude-core/dist/index.mjs";
import { z } from "zod";
import type { Page, Locator } from "patchright";

// Import agent-browser's snapshot functionality directly
// Note: We use dynamic import since agent-browser uses playwright-core types
// but patchright is API-compatible
import { getEnhancedSnapshot, parseRef, type RefMap, type EnhancedSnapshot } from "agent-browser/dist/snapshot.js";

// Store the current page reference and ref map
let currentPage: Page | null = null;
let refMap: RefMap = {};

export function setPage(page: Page): void {
    currentPage = page;
    refMap = {}; // Clear ref map when page changes
}

function getPage(): Page {
    if (!currentPage) {
        throw new Error("Page not set. Call setPage() first.");
    }
    return currentPage;
}

function getLocatorFromRef(ref: string): Locator | null {
    const parsedRef = parseRef(ref);
    if (!parsedRef) return null;

    const refData = refMap[parsedRef];
    if (!refData) return null;

    const page = getPage();

    // Build locator using getByRole (same as agent-browser does)
    let locator: Locator;
    if (refData.name) {
        locator = page.getByRole(refData.role as any, { name: refData.name, exact: true });
    } else {
        locator = page.getByRole(refData.role as any);
    }

    // Apply nth index if needed for disambiguation
    if (refData.nth !== undefined) {
        locator = locator.nth(refData.nth);
    }

    return locator;
}

// ============ Actions ============

export function createAgentBrowserActions() {

    const snapshotAction = createAction({
        name: 'snapshot',
        description: 'Get interactive elements on the page as refs (@e1, @e2, etc.). Use before click_ref/fill_ref. Returns accessibility tree.',
        schema: z.object({
            interactive: z.boolean().optional().describe('Only interactive elements (default true)'),
            depth: z.number().optional().describe('Max tree depth'),
            selector: z.string().optional().describe('CSS selector to scope snapshot'),
        }).nullable().optional(),
        resolver: async ({ input }: { input?: { interactive?: boolean; depth?: number; selector?: string } | null }) => {
            const page = getPage();
            try {
                const snapshot = await getEnhancedSnapshot(page as any, {
                    interactive: input?.interactive !== false,
                    maxDepth: input?.depth,
                    selector: input?.selector,
                });
                refMap = snapshot.refs;
                return snapshot.tree || '(no elements found)';
            } catch (error) {
                console.error('[snapshot] Error:', error);
                return `(snapshot error: ${error})`;
            }
        },
        render: () => `snapshot`
    });

    const clickRefAction = createAction({
        name: 'click_ref',
        description: 'Click element by ref (e.g., @e5). Run snapshot first.',
        schema: z.object({
            ref: z.string().describe('Element ref like @e1'),
        }),
        resolver: async ({ input }: { input: { ref: string } }) => {
            const locator = getLocatorFromRef(input.ref);
            if (!locator) {
                return `Error: ref ${input.ref} not found. Run snapshot first.`;
            }
            try {
                await locator.click();
                return `Clicked ${input.ref}`;
            } catch (error) {
                return `Error clicking ${input.ref}: ${error}`;
            }
        },
        render: ({ ref }: { ref: string }) => `click ${ref}`
    });

    const fillRefAction = createAction({
        name: 'fill_ref',
        description: 'Fill text input by ref. Clears existing content first.',
        schema: z.object({
            ref: z.string().describe('Element ref like @e1'),
            value: z.string().describe('Text to fill'),
        }),
        resolver: async ({ input }: { input: { ref: string; value: string } }) => {
            const locator = getLocatorFromRef(input.ref);
            if (!locator) {
                return `Error: ref ${input.ref} not found. Run snapshot first.`;
            }
            try {
                await locator.fill(input.value);
                return `Filled ${input.ref} with "${input.value}"`;
            } catch (error) {
                return `Error filling ${input.ref}: ${error}`;
            }
        },
        render: ({ ref, value }: { ref: string; value: string }) => `fill ${ref} "${value}"`
    });

    const typeRefAction = createAction({
        name: 'type_ref',
        description: 'Type into element (does not clear first, good for search boxes).',
        schema: z.object({
            ref: z.string().describe('Element ref'),
            value: z.string().describe('Text to type'),
        }),
        resolver: async ({ input }: { input: { ref: string; value: string } }) => {
            const locator = getLocatorFromRef(input.ref);
            if (!locator) {
                return `Error: ref ${input.ref} not found. Run snapshot first.`;
            }
            try {
                await locator.pressSequentially(input.value);
                return `Typed "${input.value}" into ${input.ref}`;
            } catch (error) {
                return `Error typing into ${input.ref}: ${error}`;
            }
        },
        render: ({ ref, value }: { ref: string; value: string }) => `type ${ref} "${value}"`
    });

    const selectRefAction = createAction({
        name: 'select_ref',
        description: 'Select dropdown option by ref.',
        schema: z.object({
            ref: z.string().describe('Dropdown ref'),
            value: z.string().describe('Option value or label'),
        }),
        resolver: async ({ input }: { input: { ref: string; value: string } }) => {
            const locator = getLocatorFromRef(input.ref);
            if (!locator) {
                return `Error: ref ${input.ref} not found. Run snapshot first.`;
            }
            try {
                await locator.selectOption(input.value);
                return `Selected "${input.value}" in ${input.ref}`;
            } catch (error) {
                return `Error selecting in ${input.ref}: ${error}`;
            }
        },
        render: ({ ref, value }: { ref: string; value: string }) => `select ${ref} "${value}"`
    });

    const checkRefAction = createAction({
        name: 'check_ref',
        description: 'Check a checkbox or radio by ref.',
        schema: z.object({
            ref: z.string().describe('Checkbox/radio ref'),
        }),
        resolver: async ({ input }: { input: { ref: string } }) => {
            const locator = getLocatorFromRef(input.ref);
            if (!locator) {
                return `Error: ref ${input.ref} not found. Run snapshot first.`;
            }
            try {
                await locator.check();
                return `Checked ${input.ref}`;
            } catch (error) {
                return `Error checking ${input.ref}: ${error}`;
            }
        },
        render: ({ ref }: { ref: string }) => `check ${ref}`
    });

    const hoverRefAction = createAction({
        name: 'hover_ref',
        description: 'Hover over element (for dropdowns/menus).',
        schema: z.object({
            ref: z.string().describe('Element ref'),
        }),
        resolver: async ({ input }: { input: { ref: string } }) => {
            const locator = getLocatorFromRef(input.ref);
            if (!locator) {
                return `Error: ref ${input.ref} not found. Run snapshot first.`;
            }
            try {
                await locator.hover();
                return `Hovered over ${input.ref}`;
            } catch (error) {
                return `Error hovering ${input.ref}: ${error}`;
            }
        },
        render: ({ ref }: { ref: string }) => `hover ${ref}`
    });

    const pressKeyAction = createAction({
        name: 'press_key',
        description: 'Press keyboard key (Enter, Tab, Escape, ArrowDown, etc.).',
        schema: z.object({
            key: z.string().describe('Key to press'),
        }),
        resolver: async ({ input }: { input: { key: string } }) => {
            const page = getPage();
            try {
                await page.keyboard.press(input.key);
                return `Pressed ${input.key}`;
            } catch (error) {
                return `Error pressing ${input.key}: ${error}`;
            }
        },
        render: ({ key }: { key: string }) => `press ${key}`
    });

    const scrollAction = createAction({
        name: 'scroll_page',
        description: 'Scroll the page.',
        schema: z.object({
            direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
            amount: z.number().optional().describe('Pixels to scroll (default 300)'),
        }),
        resolver: async ({ input }: { input: { direction: 'up' | 'down' | 'left' | 'right'; amount?: number } }) => {
            const page = getPage();
            const px = input.amount ?? 300;
            let deltaX = 0, deltaY = 0;
            if (input.direction === 'down') deltaY = px;
            if (input.direction === 'up') deltaY = -px;
            if (input.direction === 'right') deltaX = px;
            if (input.direction === 'left') deltaX = -px;

            try {
                await page.mouse.wheel(deltaX, deltaY);
                return `Scrolled ${input.direction} by ${px}px`;
            } catch (error) {
                return `Error scrolling: ${error}`;
            }
        },
        render: ({ direction }: { direction: string }) => `scroll ${direction}`
    });

    const evalAction = createAction({
        name: 'eval_js',
        description: 'Execute JavaScript in page context. Use for complex queries.',
        schema: z.object({
            code: z.string().describe('JavaScript code to execute'),
        }),
        resolver: async ({ input }: { input: { code: string } }) => {
            const page = getPage();
            try {
                const result = await page.evaluate(input.code);
                return JSON.stringify(result);
            } catch (error) {
                return `Error evaluating JS: ${error}`;
            }
        },
        render: ({ code }: { code: string }) => `eval ${code.slice(0, 50)}...`
    });

    const getTextAction = createAction({
        name: 'get_text_ref',
        description: 'Get text content of element by ref.',
        schema: z.object({
            ref: z.string().describe('Element ref'),
        }),
        resolver: async ({ input }: { input: { ref: string } }) => {
            const locator = getLocatorFromRef(input.ref);
            if (!locator) {
                return `Error: ref ${input.ref} not found. Run snapshot first.`;
            }
            try {
                const text = await locator.textContent();
                return text || '(empty)';
            } catch (error) {
                return `Error getting text from ${input.ref}: ${error}`;
            }
        },
        render: ({ ref }: { ref: string }) => `get text ${ref}`
    });

    const waitAction = createAction({
        name: 'wait_for',
        description: 'Wait for element, navigation, or time.',
        schema: z.object({
            type: z.enum(['element', 'navigation', 'time']).describe('What to wait for'),
            value: z.string().describe('Selector, URL pattern, or milliseconds'),
        }),
        resolver: async ({ input }: { input: { type: 'element' | 'navigation' | 'time'; value: string } }) => {
            const page = getPage();
            try {
                if (input.type === 'time') {
                    const ms = parseInt(input.value, 10);
                    await new Promise(resolve => setTimeout(resolve, ms));
                    return `Waited ${ms}ms`;
                } else if (input.type === 'navigation') {
                    await page.waitForURL(input.value);
                    return `Navigation to ${input.value} complete`;
                } else {
                    await page.waitForSelector(input.value);
                    return `Element ${input.value} appeared`;
                }
            } catch (error) {
                return `Error waiting: ${error}`;
            }
        },
        render: ({ type, value }: { type: string; value: string }) => `wait ${type} ${value}`
    });

    return [
        snapshotAction,
        clickRefAction,
        fillRefAction,
        typeRefAction,
        selectRefAction,
        checkRefAction,
        hoverRefAction,
        pressKeyAction,
        scrollAction,
        evalAction,
        getTextAction,
        waitAction,
    ];
}
