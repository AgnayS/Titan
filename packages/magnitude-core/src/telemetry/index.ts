import logger from '@/logger';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { init as cuid2Init, createId as cuid2CreateId } from '@paralleldrive/cuid2';
import { PostHog } from 'posthog-node';
import { VERSION } from '@/version';
import { createHash } from 'crypto';

export const createId = cuid2Init({ length: 12 });

export const posthog = new PostHog(
    'phc_BTdnTtG68V5QG6sqUNGqGfmjXk8g0ePBRu9FIr9upNu',
    {
        host: 'https://us.i.posthog.com'
    }
);

export function getMachineId(): string {
    // Define storage location
    const dir = path.join(os.homedir(), '.magnitude');
    const filePath = path.join(dir, 'user.json');

    try {
        // Read existing ID if available
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (data.id) return data.id;
        }

        // Generate new ID if needed
        //console.log(`generating new ID in ${filePath}`)
        fs.mkdirSync(dir, { recursive: true });
        const id = createId();
        fs.writeFileSync(filePath, JSON.stringify({ id }));
        return id;
    } catch {
        // Fallback to temporary ID if storage fails
        return createId();
    }
}

export function getCodebaseId(): string | undefined {
    try {
        const command = 'git rev-list --max-parents=0 HEAD';
        const firstCommitHash = execSync(command, {
            encoding: 'utf8',
            stdio: 'pipe',
        }).trim();

        //return firstCommitHash;
        return createHash('sha256').update(firstCommitHash).digest('hex').substring(0, 12);

    } catch (error) {
        // ID representing no git repo detected
        return undefined;//'000000000000';
    }
}

export async function sendTelemetry(eventName: string, properties: Record<string, any>) {
    /**
     * Send telemetry to Posthog with given event name and properites
     * - automatically grouped by codebase derived from SHA256 hash of first git commit if available
     * - telemetryVersion, packageVersion, and codebase all added to properties automatically
     */
    const userId = getMachineId();
    const codebaseId = getCodebaseId();
    
    if (codebaseId) {
        try {
            posthog.groupIdentify({
                groupType: 'codebase',
                groupKey: codebaseId,
                //properties: {}
            });
        } catch (error) {
            logger.warn(`Failed to identify group: ${(error as Error).message}`);
        }
    }

    try {
        const props = {
            source: "magnitude-core",
            packageVersion: VERSION,
            //telemetryVersion: "0.1",
            codebase: codebaseId,
            ...properties,
        };

        posthog.capture({
            distinctId: userId,
            event: eventName,
            properties: props,
            ...(codebaseId ? { groups: { codebase: codebaseId }} : {})
        });
        await posthog.shutdown();
    } catch (error) {
        logger.warn(`Failed to send telemetry (may have timed out): ${(error as Error).message}`);
    }
}



