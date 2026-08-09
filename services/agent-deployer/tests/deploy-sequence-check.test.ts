import { describe, it, expect } from 'vitest';
import { validateDeploySequence } from '../src/deploy-sequence-check.js';

describe('validateDeploySequence', () => {
  it('passes the exact expected sequence', () => {
    const result = validateDeploySequence(
      ['write_deploy_config', 'zcli project service-import zerops-service-import.yaml', 'zcli push hello-api'],
      'hello-api',
    );
    expect(result.ok).toBe(true);
  });

  it('fails when write_deploy_config is missing', () => {
    const result = validateDeploySequence(
      ['zcli project service-import zerops-service-import.yaml', 'zcli push hello-api'],
      'hello-api',
    );
    expect(result.ok).toBe(false);
  });

  it('fails when push is missing', () => {
    const result = validateDeploySequence(
      ['write_deploy_config', 'zcli project service-import zerops-service-import.yaml'],
      'hello-api',
    );
    expect(result.ok).toBe(false);
  });

  it('fails when the order is reversed', () => {
    const result = validateDeploySequence(
      [
        'zcli push hello-api',
        'zcli project service-import zerops-service-import.yaml',
        'write_deploy_config',
      ],
      'hello-api',
    );
    expect(result.ok).toBe(false);
  });

  it('fails when the hostname in the push command does not match', () => {
    const result = validateDeploySequence(
      ['write_deploy_config', 'zcli project service-import zerops-service-import.yaml', 'zcli push wrong-name'],
      'hello-api',
    );
    expect(result.ok).toBe(false);
  });

  it('fails on an extra, unexpected command', () => {
    const result = validateDeploySequence(
      [
        'write_deploy_config',
        'zcli project service-import zerops-service-import.yaml',
        'zcli push hello-api',
        'zcli push hello-api',
      ],
      'hello-api',
    );
    expect(result.ok).toBe(false);
  });

  it('reports the expected and actual sequences on failure', () => {
    const result = validateDeploySequence(['zcli push hello-api'], 'hello-api');
    if (!result.ok) {
      expect(result.expected).toEqual([
        'write_deploy_config',
        'zcli project service-import zerops-service-import.yaml',
        'zcli push hello-api',
      ]);
      expect(result.actual).toEqual(['zcli push hello-api']);
    } else {
      throw new Error('expected validation to fail');
    }
  });
});
