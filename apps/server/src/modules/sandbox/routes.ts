import type { Db } from '@sethu/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { problem } from '../../http/problem.ts';
import { createSandbox, resolveSandbox, SANDBOX_HARD_TTL_SECONDS } from './service.ts';
import { parseToken } from './token.ts';

/**
 * Host-only cookie for the API origin. The __Host- prefix makes the browser
 * insist on Secure, Path=/ and no Domain attribute, so the console's own host
 * and every other subdomain never see it.
 */
export const SANDBOX_COOKIE = '__Host-sethu_sandbox';

declare module 'fastify' {
  interface FastifyRequest {
    sandboxId: string;
  }
}

export function sandboxRoutes(app: FastifyInstance, db: Db): void {
  app.decorateRequest('sandboxId', '');

  app.post('/v1/sandboxes', async (request, reply) => {
    const existing = parseToken(request.cookies[SANDBOX_COOKIE]);
    if (existing !== undefined) {
      const session = await resolveSandbox(db, existing);
      if (session !== undefined) return reply.code(200).send(session);
    }
    const { token, session } = await createSandbox(db);
    reply.setCookie(SANDBOX_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SANDBOX_HARD_TTL_SECONDS,
    });
    return reply.code(201).send(session);
  });

  app.get('/v1/sandboxes/current', { preHandler: requireSandbox(db) }, async (request) => {
    const token = parseToken(request.cookies[SANDBOX_COOKIE]);
    if (token === undefined) throw new Error('unreachable: requireSandbox checked the cookie');
    return resolveSandbox(db, token);
  });
}

/** preHandler that rejects requests without a live sandbox and sets request.sandboxId. */
export function requireSandbox(db: Db) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = parseToken(request.cookies[SANDBOX_COOKIE]);
    const session = token === undefined ? undefined : await resolveSandbox(db, token);
    if (session === undefined) {
      await problem(reply, 401, 'no_sandbox', 'No live sandbox. Start a new one to continue.');
      return;
    }
    request.sandboxId = session.sandboxId;
  };
}
