const express = require('express');
const helmet = require('helmet');
const { Redis } = require("ioredis");

const redis = new Redis(process.env.REDIS_URL);

const yieldRoutes = require('./routes/yield');
const holderRoutes = require('./routes/holders');
const config = require('./routes/config');
const median = require('./routes/median');
const perp = require('./routes/perp');
const enriched = require('./routes/enriched');
const lsd = require('./routes/lsd');
const pools = require('./routes/pools');
const { getCacheDates } = require('../utils/headers');
const volatility = require('./routes/volatility');
const tokenAddress = require('./routes/tokenAddress');

const app = express();
app.use(require('morgan')('dev'));
app.use(helmet());
app.use(express.json());

async function redisCache (req, res, next) {
  // Bound the cache key. `req.url` is fully attacker-controlled and is embedded
  // in the Redis key verbatim, so an unbounded keyspace let any client grow
  // Redis without limit. Only the path and query are used; the host is dropped
  // because it is not needed for the cache identity.
  const cacheKey = req.path + (req.url.indexOf('?') !== -1 ? req.url.slice(req.url.indexOf('?')) : '');
  const dataKey = 'data#' + cacheKey;
  const stampKey = 'lastUpdate#' + cacheKey;

  const lastCacheUpdate = await redis.get(stampKey)
  const {headers, nextCacheDate} = getCacheDates()
  if(lastCacheUpdate !== null && Number(lastCacheUpdate) > (nextCacheDate.getTime() - 3600e3)){
    const cacheObject = await redis.get(dataKey)
    res.set(headers)
      .status(200)
      .send(cacheObject);
  } else {
    res._apicache = {
        dataKey,
        stampKey,
        end: res.end
    }
    res.end = function(content, encoding) {
      if(res.statusCode === 200){
        // Both keys are given a TTL so an entry can never outlive the window in
        // which it is considered fresh, and so an unbounded keyspace is reclaimed
        // instead of persisting for the lifetime of the process.
        const ttlSeconds = Math.max(
          1,
          Math.ceil((nextCacheDate.getTime() + 3600e3 - Date.now()) / 1000)
        )
        redis.set(dataKey, content.toString(), 'EX', ttlSeconds)
        redis.set(stampKey, Date.now(), 'EX', ttlSeconds)
        res.set(headers)
      }
      return res._apicache.end.apply(this, arguments)
    }
    next()
  }
}

// Public, unauthenticated API surface. Without a limit a single client can
// saturate the Redis connection pool and the Postgres pool behind it.
const rateLimit = require('express-rate-limit')
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { status: 429, message: 'Too many requests, please retry later.' } },
})
app.use(apiLimiter)

// Any promise rejected inside an async route handler does NOT reach the Express
// error handler on its own in Express 4 -- the request simply hangs until the
// client times out, and an unhandled rejection can terminate the Lambda. Each
// mounted router is therefore wrapped so a rejected promise is forwarded to
// `next(err)` like any synchronous throw.
function asyncHandler (fn) {
  return function wrapped (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.use('/', [volatility, holderRoutes, tokenAddress].map(asyncHandler));

app.use(redisCache)

app.use('/', [yieldRoutes, config, median, perp, enriched, lsd, pools].map(asyncHandler));

function errorHandler (err, req, res, next) {
  // `next` is part of the Express error-handler signature. It is unused because
  // this is the terminal handler, but omitting it does not make it a 4-arity
  // error handler, and Express falls back to its built-in handler when `err` is
  // set and no 4-arity handler is registered.
  console.error('Unhandled error while serving', req.method, req.originalUrl, err);

  // `res.render('error', ...)` threw a second error: this app has no view engine,
  // so every genuine 500 turned into a confusing Express "no view engine" failure
  // and the real error was lost. Respond with JSON instead.
  if (res.headersSent) {
    // The response has already started streaming (the redisCache middleware
    // hooks res.end), so the status line can no longer be changed. Delegate the
    // connection teardown to Express so the client sees a truncated body rather
    // than a silently corrupted one.
    return next(err);
  }

  const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
  res.status(statusCode).json({
    error: {
      status: statusCode,
      // Only 4xx messages come from our own code and are safe to surface. A 5xx
      // message may contain internal detail (SQL, file paths, upstream URLs),
      // so it is logged but never returned to the client.
      message: statusCode < 500 ? err.message : 'Internal server error',
    },
  });
}

// NOTE: `errorHandler` is registered directly, NOT through `asyncHandler`.
// Express identifies an error handler by its arity: `fn.length === 4`. Wrapping it
// in `asyncHandler` would reduce the arity to 3, so Express would stop treating it
// as an error handler and fall back to its own default response.
app.use(errorHandler);

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err.message);
  process.exit(1);
});

module.exports = app;
