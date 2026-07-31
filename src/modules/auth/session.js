import { createHmac, timingSafeEqual } from 'node:crypto'
import { sessionSecret } from '../../config/env.js'
import { db } from '../../database/connection.js'

const signTokenPayload = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', sessionSecret).update(body).digest('base64url')

  return `${body}.${signature}`
}

const safeCompare = (left, right) => {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export const createSessionToken = (user) => signTokenPayload({
  sub: user.id,
  name: user.name,
  email: user.email,
  ver: Number(user.session_version || 0),
  exp: Date.now() + 1000 * 60 * 60 * 24 * 7,
})

const getAuthenticatedPayload = (req) => {
  try {
    const authorization = req.headers.authorization || ''
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    const [body, signature] = token.split('.')

    if (!body || !signature) {
      return null
    }

    const expectedSignature = createHmac('sha256', sessionSecret).update(body).digest('base64url')

    if (!safeCompare(signature, expectedSignature)) {
      return null
    }

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))

    if (!payload.sub || payload.exp < Date.now()) {
      return null
    }

    return payload
  } catch {
    return null
  }
}

export const getAuthenticatedUserId = (req) => {
  const payload = getAuthenticatedPayload(req)
  return payload ? Number(payload.sub) : null
}

export const getValidatedAuthenticatedUserId = async (req) => {
  const payload = getAuthenticatedPayload(req)

  if (!payload || !db) {
    return null
  }

  const [users] = await db.execute(
    'SELECT session_version, email_verified_at FROM users WHERE id = ? LIMIT 1',
    [Number(payload.sub)],
  )
  const user = users[0]

  if (
    !user
    || !user.email_verified_at
    || Number(payload.ver || 0) !== Number(user.session_version || 0)
  ) {
    return null
  }

  return Number(payload.sub)
}
