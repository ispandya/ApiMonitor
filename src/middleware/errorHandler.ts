import type { ErrorRequestHandler } from 'express';

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  // If a response is already partly sent, Express must close the connection itself.
  if (res.headersSent) {
    next(err);
    return;
  }

  // Errors raised by body parsing (malformed JSON, body too large) carry a 4xx status.
  const status: number =
    typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;

  if (status < 500) {
    res.status(status).json({ error: 'Malformed request' });
    return;
  }

  // Log the details for us, tell the caller nothing about the internals.
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
};
