import { defineMiddleware } from 'daroyan/app';

import {
  beginMiddlewareChain,
  continueMiddlewareChain,
} from '../middlewares/middleware-order.ts';

export default defineMiddleware(beginMiddlewareChain, continueMiddlewareChain);
