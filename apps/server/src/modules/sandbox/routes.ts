import type { Db } from '@sethu/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { problem } from '../../http/problem.ts';
import { createSandbox, resolveSandbox, SANDBOX_HARD_TTL_SECONDS } from './service.ts';
import type { SandboxTokenCodec } from './token.ts';

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

export type SandboxGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Registers the sandbox routes and returns the preHandler that every
 * sandbox-scoped route uses. The cookie's signature and its secret are checked
 * on every request.
 */
export function sandboxRoutes(
  app: FastifyInstance,
  db: Db,
  codec: SandboxTokenCodec,
): SandboxGuard {
  app.decorateRequest('sandboxId', '');

  const requireSandbox: SandboxGuard = async (request, reply) => {
    const token = codec.verify(request.cookies[SANDBOX_COOKIE]);
    const session = token === undefined ? undefined : await resolveSandbox(db, token);
    if (session === undefined) {
      await problem(reply, 401, 'no_sandbox', 'No live sandbox. Start a new one to continue.');
      return;
    }
    request.sandboxId = session.sandboxId;
  };

  app.post('/v1/sandboxes', async (request, reply) => {
    const existing = codec.verify(request.cookies[SANDBOX_COOKIE]);
    if (existing !== undefined) {
      const session = await resolveSandbox(db, existing);
      if (session !== undefined) return reply.code(200).send(session);
    }
    const { token, session } = await createSandbox(db, codec);
    reply.setCookie(SANDBOX_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SANDBOX_HARD_TTL_SECONDS,
    });
    return reply.code(201).send(session);
  });

  app.get('/v1/sandboxes/current', { preHandler: requireSandbox }, async (request) => {
    const token = codec.verify(request.cookies[SANDBOX_COOKIE]);
    if (token === undefined) throw new Error('unreachable: requireSandbox checked the cookie');
    return resolveSandbox(db, token);
  });

  return requireSandbox;
}
