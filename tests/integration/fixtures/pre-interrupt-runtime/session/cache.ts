import { SessionCache as RuntimeCache } from '../../../../../src/session/cache.js';

export class SessionCache extends RuntimeCache {
  constructor(cwd: string, sessionId?: string) {
    super(cwd, sessionId);
    // A read-only cache lookup can leave the filesystem unchanged.
    console.error('SessionCache constructed');
  }
}
