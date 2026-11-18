import type { FastifyInstance } from 'fastify';
import { problem } from './problem.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated writes. SameSite=Lax is not enough on
 * its own: every *.swayam.space host counts as the same site. So a write must
 * come from the console origin exactly, and must be JSON, which a plain HTML
 * form cannot send and which forces a CORS preflight from scripts.
 *
 * Webhook and simulated-provider routes are exempt: they are called by servers,
 * which authenticate with signatures or API keys instead.
 */
export function registerWriteGuards(app: FastifyInstance, consoleOrigin: string): void {
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;
    // Server-to-server routes authenticate with signatures or API keys instead.
    if (request.url.startsWith('/v1/webhooks/') || request.url.startsWith('/sim/')) return;

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
