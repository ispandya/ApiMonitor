import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { errorHandler } from '../../src/middleware/errorHandler';

function fakeResponse(headersSent = false) {
  const res = {
    headersSent,
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}
const run = (err: unknown, res = fakeResponse()) => {
  const next = mock.fn();
  errorHandler(err, {} as Request, res as unknown as Response, next as unknown as NextFunction);
  return { res, next };
};

describe('errorHandler', () => {
  it('answers a client error from the body parser (4xx) with a generic 400 body', () => {
    const { res } = run(Object.assign(new SyntaxError('Unexpected end of JSON input'), { status: 400 }));
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'Malformed request' });
  });

  it('hides the details of an unexpected error from the caller, and logs them instead', () => {
    const log = mock.method(console, 'error', () => {});
    try {
      const { res } = run(new Error('password authentication failed for user "monitor" at /srv/app/db.ts:42'));
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.body, { error: 'Internal server error' });
      assert.equal(log.mock.callCount(), 1, 'the real error must be logged for the developer');
    } finally {
      log.mock.restore();
    }
  });

  it('only trusts 4xx statuses: an error claiming 503 is still reported as a plain 500', () => {
    const log = mock.method(console, 'error', () => {});
    try {
      const { res } = run(Object.assign(new Error('upstream'), { status: 503 }));
      assert.equal(res.statusCode, 500);
    } finally {
      log.mock.restore();
    }
  });

  it('handles errors that are not Error objects', () => {
    const log = mock.method(console, 'error', () => {});
    try {
      assert.equal(run('a string').res.statusCode, 500);
      assert.equal(run(undefined).res.statusCode, 500);
    } finally {
      log.mock.restore();
    }
  });

  it('hands over to Express when the response has already started', () => {
    const err = new Error('too late');
    const { res, next } = run(err, fakeResponse(true));
    assert.equal(res.statusCode, 0, 'must not try to send a second response');
    assert.equal(next.mock.callCount(), 1);
    assert.equal(next.mock.calls[0]?.arguments[0], err);
  });
});
