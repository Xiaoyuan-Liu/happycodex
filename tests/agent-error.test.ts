import { describe, expect, it } from 'vitest';

import { isNonRetryableAgentError, preferAgentError } from '../src/agent-error.js';
import { GENERIC_AGENT_FAILURE_MESSAGE } from '../src/container-output.js';

describe('agent error helpers', () => {
  it('keeps a specific error when a later generic failure arrives', () => {
    expect(preferAgentError('refresh token was already used', GENERIC_AGENT_FAILURE_MESSAGE)).toBe(
      'refresh token was already used',
    );
  });

  it('replaces a generic failure when a later specific error arrives', () => {
    expect(preferAgentError(GENERIC_AGENT_FAILURE_MESSAGE, 'Please log out and sign in again.')).toBe(
      'Please log out and sign in again.',
    );
  });

  it('classifies auth/login failures as non-retryable', () => {
    expect(
      isNonRetryableAgentError(
        'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
      ),
    ).toBe(true);
    expect(isNonRetryableAgentError('unauthorized')).toBe(true);
    expect(isNonRetryableAgentError('login required')).toBe(true);
  });

  it('does not classify transient generic failures as non-retryable', () => {
    expect(isNonRetryableAgentError(GENERIC_AGENT_FAILURE_MESSAGE)).toBe(false);
    expect(isNonRetryableAgentError('server overloaded')).toBe(false);
  });
});
