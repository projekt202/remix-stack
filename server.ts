import express from "express";
import compression from "compression";
import morgan from "morgan";
import path from "path";
import { createRequestHandler } from "@remix-run/express";

const app = express();

app.use((req, res, next) => {
  res.set('x-fly-region', process.env.FLY_REGION ?? 'unknown');
  res.set('Strict-Transport-Security', `max-age=${60 * 60 * 24 * 365 * 100}`);

  if (req.path.endsWith('/') && req.path.length > 1) {
    const query = req.url.slice(req.path.length);
    const safepath = req.path.slice(0, -1).replace(/\/+/g, '/');
    res.redirect(301, safepath + query);
    return;
  }
  next();
});

app.all('*', function getReplaceResponse(req, res, next) {
  const { method, path: pathname } = req;
  const { PRIMARY_REGION, FLY_REGION } = process.env;

  const isMethodReplayable = !['GET', 'OPTIONS', 'HEAD'].includes(method);
  const isReadOnlyRegion = FLY_REGION && PRIMARY_REGION && FLY_REGION !== PRIMARY_REGION;
  const shouldReply = isMethodReplayable && isReadOnlyRegion;

  if (!shouldReply) return next();

  const logInfo = {
    pathname,
    method,
    PRIMARY_REGION,
    FLY_REGION
  };
  console.info('Replaying', logInfo);
  res.set('fly-replay', `region=${PRIMARY_REGION}`);
  return res.sendStatus(409);
});

app.use(compression());

app.disable('x-powered-by');

app.use('/build', express.static('public/build', { immutable: true, maxAge: '1y' }));

app.use(express.static('public', { maxAge: '1h' }));

app.use(morgan('tiny'));

const MODE = process.env.NODE_ENV;
const BUILD_DIR = path.join(process.cwd(), 'build');

app.all('*', MODE === 'production'
  ? createRequestHandler({ build: require(BUILD_DIR) })
  : (...args) => {
    purgeRequiredCache();
    const requestHandler = createRequestHandler({
      build: require(BUILD_DIR),
      mode: MODE
    });
    return requestHandler(...args);
  }
);

const port = process.env.PORT || 3000;

app.listen(port, () => {
  require(BUILD_DIR);
  console.log(`✅ app ready: http://localhost:${port}`);
});

function purgeRequiredCache() {
  for (const key in require.cache) {
    if (key.startsWith(BUILD_DIR)) {
      delete require.cache[key];
    }
  }
}