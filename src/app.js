import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config/index.js';
import { AVATAR_DIR } from './services/profileService.js';
import { WALLPAPER_DIR } from './services/wallpaperService.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';
import { rateLimiters } from './middleware/security.js';
import { apiRouter } from './routes/index.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(helmet());
  app.use(
    cors({
      origin: config.clientOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Device-Id'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());
  app.use(requestLogger);

  app.use('/api', rateLimiters.api, apiRouter());

  // Profile photos and wallpapers: random 128-bit file names, image bytes verified on upload.
  // Served as inert files (no sniffing, no scripts) and usable from the app's origin.
  const inertImages = (dir) =>
    express.static(dir, {
      index: false,
      dotfiles: 'deny',
      redirect: false,
      immutable: true,
      maxAge: '30d',
      setHeaders(res) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      },
    });
  app.use('/uploads/avatars', inertImages(AVATAR_DIR));
  app.use('/uploads/wallpapers', inertImages(WALLPAPER_DIR));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
