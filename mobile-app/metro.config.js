/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module, __dirname */

const { getDefaultConfig } = require('expo/metro-config');
const http = require('node:http');

const config = getDefaultConfig(__dirname);
const zustandMiddleware = require.resolve('zustand/middleware');
const pnpmTemporaryPackagePath = /(?:^|[\\/])[^\\/]+_tmp_\d+_\d+(?:[\\/]|$)/;

// pnpm replaces package directories through short-lived *_tmp_<pid>_<n>
// siblings. Metro's Windows fallback watcher can discover one between its
// directory scan and fs.watch call, then crash when pnpm has already renamed
// it. These paths are install artifacts and must never be bundled.
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList)
    ? config.resolver.blockList
    : config.resolver.blockList
      ? [config.resolver.blockList]
      : []),
  pnpmTemporaryPackagePath,
];

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Zustand's ESM middleware currently leaves import.meta in Metro's web bundle.
  if (moduleName === 'zustand/middleware') {
    return { filePath: zustandMiddleware, type: 'sourceFile' };
  }
  return context.resolveRequest(context, moduleName, platform);
};

const defaultEnhanceMiddleware = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (middleware, server) => {
  const nextMiddleware = defaultEnhanceMiddleware
    ? defaultEnhanceMiddleware(middleware, server)
    : middleware;
  return (request, response, next) => {
    if (!request.url?.startsWith('/api/v1/')) {
      return nextMiddleware(request, response, next);
    }

    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: 3000,
        method: request.method,
        path: request.url,
        headers: { ...request.headers, host: '127.0.0.1:3000' },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (response.headersSent) return response.destroy();
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'TexasRenters backend is unavailable.' }));
    });
    request.pipe(upstream);
  };
};

module.exports = config;
