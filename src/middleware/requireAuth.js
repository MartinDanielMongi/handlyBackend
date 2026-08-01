import { getValidatedAuthenticatedUserId } from '../modules/auth/session.js'

export const requireAuth = async (req, res, next) => {
  const userId = await getValidatedAuthenticatedUserId(req)

  if (!userId) {
    return res.status(401).json({ message: 'Iniciá sesión para continuar.' })
  }

  req.userId = userId
  return next()
}
