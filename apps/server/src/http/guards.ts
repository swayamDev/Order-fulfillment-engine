import type { FastifyInstance } from 'fastify';
import { problem } from './problem.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated writes. SameSite=Lax is not enough on
 * its own: every *.swayam.space host counts as the same site. So a write must
 * come from the console origin exactly, and must be JSON, which a plain HTML
 * form cannot send and which forces a CORS preflight from scripts.
 *
 * Webhook routes are exempt: providers authenticate with signatures instead.
 */
export function registerWriteGuards(app: FastifyInstance, consoleOrigin: string): void {
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (request.url.startsWith('/v1/webhooks/')) return;

    if (request.headers.origin !== consoleOrigin) {
      await problem(reply, 403, 'bad_origin', 'Writes are only accepted from the Sethu console.');
      return;
    }
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.startsWith('application/json')) {
      await problem(
        reply,
        415,
        'json_required',
        'Send a JSON body with Content-Type application/json.',
      );
    }
  });
}
