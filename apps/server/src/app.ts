import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import type { Db } from '@sethu/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from './config.ts';
import { registerWriteGuards } from './http/guards.ts';
import { problem } from './http/problem.ts';
import { sandboxRoutes } from './modules/sandbox/index.ts';

export interface AppDeps {
  readonly config: Pick<Config, 'CONSOLE_ORIGIN'>;
  readonly db: Db;
  readonly logger?: boolean;
}

export async function buildApp({ config, db, logger = false }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger, bodyLimit: 64 * 1024 });

  await app.register(cookie);
  await app.register(cors, {
    origin: config.CONSOLE_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'If-Match', 'Last-Event-ID'],
    maxAge: 600,
  });
  registerWriteGuards(app, config.CONSOLE_ORIGIN);

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof ZodError) {
      return problem(reply, 400, 'invalid_request', 'The request body is not valid.', {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return problem(reply, status, 'bad_request', (error as Error).message);
    }
    reply.log.error(error);
    return problem(reply, 500, 'internal', 'Something went wrong on our side.');
  });

  app.get('/v1/health', () => ({ ok: true }));
  sandboxRoutes(app, db);

  return app;
}
