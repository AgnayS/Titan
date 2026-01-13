/**
 * Claude Pro/Max OAuth Authentication
 *
 * Allows using Claude Pro/Max subscription for API access instead of API keys.
 * Uses OAuth 2.0 with PKCE flow.
 *
 * Usage:
 *   const token = await getClaudeAccessToken();
 *   // Use with API: Authorization: Bearer ${token}
 *   // Header: anthropic-beta: oauth-2025-04-20
 */

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import crypto from 'crypto';
import { exec } from 'node:child_process';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CREDS_PATH = join(homedir(), '.titan', 'credentials', 'claude.json');

interface Credentials {
    access_token: string;
    refresh_token: string;
    expires_at: number; // timestamp in ms
}

interface PKCEPair {
    verifier: string;
    challenge: string;
}

// Generate PKCE pair for OAuth
function generatePKCE(): PKCEPair {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');

    return { verifier, challenge };
}

// Get OAuth authorization URL
function getAuthorizationURL(pkce: PKCEPair): string {
    const url = new URL('https://claude.ai/oauth/authorize');

    url.searchParams.set('code', 'true');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', 'https://console.anthropic.com/oauth/code/callback');
    url.searchParams.set('scope', 'org:create_api_key user:profile user:inference');
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', pkce.verifier);

    return url.toString();
}

// Exchange authorization code for tokens
async function exchangeCodeForTokens(
    code: string,
    verifier: string
): Promise<Credentials> {
    const [authCode, state] = code.split('#');

    const response = await fetch('https://console.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            code: authCode,
            state: state,
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            redirect_uri: 'https://console.anthropic.com/oauth/code/callback',
            code_verifier: verifier,
        }),
    });

    if (!response.ok) {
        throw new Error(`Token exchange failed: ${response.statusText}`);
    }

    const data = await response.json();

    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in * 1000),
    };
}

// Refresh access token
async function refreshAccessToken(refreshToken: string): Promise<Credentials> {
    const response = await fetch('https://console.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: CLIENT_ID,
        }),
    });

    if (!response.ok) {
        throw new Error(`Token refresh failed: ${response.statusText}`);
    }

    const data = await response.json();

    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in * 1000),
    };
}

async function saveCredentials(creds: Credentials): Promise<void> {
    await fs.mkdir(dirname(CREDS_PATH), { recursive: true });
    await fs.writeFile(CREDS_PATH, JSON.stringify(creds, null, 2));
    try {
        await fs.chmod(CREDS_PATH, 0o600); // Read/write for owner only
    } catch {
        // chmod may fail on Windows, that's ok
    }
}

async function loadCredentials(): Promise<Credentials | null> {
    try {
        const data = await fs.readFile(CREDS_PATH, 'utf-8');
        return JSON.parse(data);
    } catch {
        return null;
    }
}

/**
 * Get a valid Claude access token.
 * Returns cached token if valid, refreshes if expired, or null if not authenticated.
 */
export async function getClaudeAccessToken(): Promise<string | null> {
    const creds = await loadCredentials();
    if (!creds) return null;

    // If token is still valid, return it
    if (creds.expires_at > Date.now() + 60000) { // 1 minute buffer
        return creds.access_token;
    }

    // Otherwise, refresh it
    try {
        const newCreds = await refreshAccessToken(creds.refresh_token);
        await saveCredentials(newCreds);
        return newCreds.access_token;
    } catch {
        return null;
    }
}

/**
 * Check if user is authenticated with Claude
 */
export async function isAuthenticated(): Promise<boolean> {
    const token = await getClaudeAccessToken();
    return token !== null;
}

function openUrl(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let command: string;

        switch (process.platform) {
            case 'darwin':
                command = `open "${url}"`;
                break;
            case 'win32':
                command = `start "" "${url}"`;
                break;
            default:
                command = `xdg-open "${url}"`;
                break;
        }

        exec(command, (error) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

export interface AuthFlowCallbacks {
    onAuthUrlReady?: (url: string) => void;
    promptForCode?: () => Promise<string>;
    onSuccess?: () => void;
    onError?: (error: Error) => void;
}

/**
 * Complete the OAuth flow to authenticate with Claude.
 *
 * @param callbacks - Optional callbacks for UI integration
 * @returns Access token on success
 */
export async function authenticateWithClaude(callbacks?: AuthFlowCallbacks): Promise<string> {
    // Try to get existing valid token
    const existingToken = await getClaudeAccessToken();
    if (existingToken) return existingToken;

    // Generate PKCE and auth URL
    const pkce = generatePKCE();
    const authUrl = getAuthorizationURL(pkce);

    // Open browser
    try {
        await openUrl(authUrl);
    } catch (err) {
        // Browser failed to open, user will need to manually visit URL
    }

    // Notify about auth URL
    if (callbacks?.onAuthUrlReady) {
        callbacks.onAuthUrlReady(authUrl);
    } else {
        console.log('\nTo authenticate, visit:');
        console.log(authUrl);
        console.log('\nPaste the authorization code below:');
    }

    // Get code from user
    let code: string;
    if (callbacks?.promptForCode) {
        code = await callbacks.promptForCode();
    } else {
        // Default: read from stdin
        code = await new Promise<string>((resolve) => {
            process.stdin.once('data', (data) => {
                resolve(data.toString().trim());
            });
        });
    }

    // Exchange code for tokens
    const creds = await exchangeCodeForTokens(code, pkce.verifier);
    await saveCredentials(creds);

    if (callbacks?.onSuccess) {
        callbacks.onSuccess();
    }

    return creds.access_token;
}

/**
 * Clear stored credentials (logout)
 */
export async function clearCredentials(): Promise<void> {
    try {
        await fs.unlink(CREDS_PATH);
    } catch {
        // File may not exist, that's ok
    }
}
