import { createHmac, timingSafeEqual } from 'node:crypto'
import { sessionSecret } from '../../config/env.js'

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
  exp: Date.now() + 1000 * 60 * 60 * 24 * 7,
})

export const getAuthenticatedUserId = (req) => {
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

    return Number(payload.sub)
  } catch {
    return null
  }
}
