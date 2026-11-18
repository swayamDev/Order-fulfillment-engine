import type { FastifyReply } from 'fastify';

/** Sends an RFC 9457 problem details response. */
export function problem(
  reply: FastifyReply,
  status: number,
  type: string,
  detail: string,
  extra: Record<string, unknown> = {},
): FastifyReply {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({ type, title: type.replaceAll('_', ' '), status, detail, ...extra });
}
