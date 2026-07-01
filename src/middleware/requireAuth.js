import { getAuthenticatedUserId } from '../modules/auth/session.js'

export const requireAuth = (req, res, next) => {
  const userId = getAuthenticatedUserId(req)

  if (!userId) {
    return res.status(401).json({ message: 'Inicia sesion para continuar.' })
  }

  req.userId = userId
  return next()
}
