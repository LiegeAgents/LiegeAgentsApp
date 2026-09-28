import type { NextFunction, Request, Response } from 'express'
import { adminWallets } from './config.js'
import { ApiError } from './http.js'

export function requireAdmin(request: Request, _response: Response, next: NextFunction) {
  if (!request.auth || !adminWallets.has(request.auth.walletAddress)) return next(new ApiError(403, 'admin_required', 'A Liege administrator wallet is required.'))
  next()
}
