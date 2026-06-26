import { GENERIC_AGENT_FAILURE_MESSAGE } from './container-output.js';

export function preferAgentError(current: string, incoming: string | undefined): string {
  if (!incoming) return current;
  if (!current) return incoming;
  if (current !== GENERIC_AGENT_FAILURE_MESSAGE && incoming === GENERIC_AGENT_FAILURE_MESSAGE) {
    return current;
  }
  return incoming;
}

export function isNonRetryableAgentError(error: string): boolean {
  return /access token could not be refreshed|refresh token was already used|please log out and sign in again|unauthorized|authentication|required login|login required/i.test(
    error,
  );
}
