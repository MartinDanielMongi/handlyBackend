import { Router } from 'express'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  frontendUrl,
  googleClientId,
  googleClientSecret,
  googleRedirectUri,
  sessionSecret,
} from '../../config/env.js'
import { db, ensureDb } from '../../database/connection.js'
import { requireAuth } from '../../middleware/requireAuth.js'
import { createSessionToken } from './session.js'
import { hashPassword, verifyPassword } from './password.js'

export const authRouter = Router()

const userSelectFields = `
  id,
  name,
  email,
  google_id,
  avatar_url,
  contact_phone,
  work_hours,
  profile_description,
  premium_status,
  premium_plan,
  premium_started_at,
  premium_expires_at,
  CASE
    WHEN premium_status = 'active'
      AND (premium_expires_at IS NULL OR premium_expires_at > NOW())
    THEN 1
    ELSE 0
  END AS is_premium,
  created_at
`

const getPremiumStatus = (user) => {
  const premiumStatus = user.premium_status || 'free'

  if (premiumStatus === 'active' && !Number(user.is_premium || 0)) {
    return 'expired'
  }

  return premiumStatus
}

const toUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  googleId: user.google_id || null,
  google_id: user.google_id || null,
  avatarUrl: user.avatar_url || null,
  avatar_url: user.avatar_url || null,
  contactPhone: user.contact_phone || '',
  contact_phone: user.contact_phone || '',
  workHours: user.work_hours || '',
  work_hours: user.work_hours || '',
  profileDescription: user.profile_description || '',
  profile_description: user.profile_description || '',
  isPremium: Boolean(Number(user.is_premium || 0)),
  is_premium: Boolean(Number(user.is_premium || 0)),
  premiumStatus: getPremiumStatus(user),
  premium_status: getPremiumStatus(user),
  premiumPlan: user.premium_plan || null,
  premium_plan: user.premium_plan || null,
  premiumStartedAt: user.premium_started_at || null,
  premium_started_at: user.premium_started_at || null,
  premiumExpiresAt: user.premium_expires_at || null,
  premium_expires_at: user.premium_expires_at || null,
  createdAt: user.created_at,
  created_at: user.created_at,
})

const trimOptionalText = (value, maxLength) => {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maxLength) : null
}

const maxAvatarTextLength = 2_800_000
const imageDataUrlPattern = /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i

const badRequest = (message) => {
  const error = new Error(message)

  error.statusCode = 400
  return error
}

const normalizeAvatarValue = (value) => {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()

  if (!trimmed) {
    return null
  }

  if (trimmed.length > maxAvatarTextLength) {
    throw badRequest('La imagen es demasiado pesada. Usa una imagen de hasta 2 MB.')
  }

  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) {
    return trimmed
  }

  if (imageDataUrlPattern.test(trimmed)) {
    return trimmed
  }

  throw badRequest('La foto debe ser una imagen valida.')
}

const googleAuthUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
const googleTokenUrl = 'https://oauth2.googleapis.com/token'
const googleUserInfoUrl = 'https://openidconnect.googleapis.com/v1/userinfo'

const signPayload = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', sessionSecret).update(body).digest('base64url')

  return `${body}.${signature}`
}

const safeCompare = (left, right) => {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

const verifySignedPayload = (tokenValue) => {
  try {
    const [body, signature] = String(tokenValue || '').split('.')

    if (!body || !signature) {
      return null
    }

    const expectedSignature = createHmac('sha256', sessionSecret).update(body).digest('base64url')

    if (!safeCompare(signature, expectedSignature)) {
      return null
    }

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))

    if (!payload.exp || payload.exp < Date.now()) {
      return null
    }

    return payload
  } catch {
    return null
  }
}

const isGoogleAuthConfigured = () => Boolean(googleClientId && googleClientSecret && googleRedirectUri)

const getFrontendCallbackUrl = () => `${frontendUrl.replace(/\/$/, '')}/auth/google/callback`

const redirectToGoogleCallback = (res, query) => {
  const callbackUrl = new URL(getFrontendCallbackUrl())

  Object.entries(query).forEach(([key, value]) => {
    if (value) {
      callbackUrl.hash = `${key}=${encodeURIComponent(value)}`
    }
  })

  return res.redirect(callbackUrl.toString())
}

const encodeFrontendSession = (session) => Buffer
  .from(JSON.stringify(session), 'utf8')
  .toString('base64url')

const exchangeGoogleCode = async (code) => {
  const body = new URLSearchParams({
    client_id: googleClientId,
    client_secret: googleClientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: googleRedirectUri,
  })

  const response = await fetch(googleTokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  const data = await response.json().catch(() => ({}))

  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'No se pudo validar Google.')
  }

  return data
}

const loadGoogleProfile = async (accessToken) => {
  const response = await fetch(googleUserInfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
  const profile = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(profile.error_description || profile.error || 'No se pudo leer el perfil de Google.')
  }

  return profile
}

const findOrCreateGoogleUser = async (profile) => {
  const googleId = String(profile.sub || '').trim()
  const email = String(profile.email || '').trim().toLowerCase()
  const name = String(profile.name || email.split('@')[0] || 'Usuario').trim().slice(0, 100)
  const avatarUrl = trimOptionalText(profile.picture, 500)

  if (!googleId || !email) {
    throw new Error('Google no devolvio los datos necesarios del usuario.')
  }

  const emailVerified = profile.email_verified === true || profile.email_verified === 'true'

  if (!emailVerified) {
    throw new Error('El email de Google no esta verificado.')
  }

  const [usersByGoogleId] = await db.execute(
    `SELECT ${userSelectFields} FROM users WHERE google_id = ? LIMIT 1`,
    [googleId],
  )

  if (usersByGoogleId.length) {
    return usersByGoogleId[0]
  }

  const [usersByEmail] = await db.execute(
    `SELECT ${userSelectFields} FROM users WHERE LOWER(email) = ? LIMIT 1`,
    [email],
  )

  if (usersByEmail.length) {
    await db.execute(
      `UPDATE users
      SET google_id = COALESCE(google_id, ?),
        avatar_url = COALESCE(avatar_url, ?)
      WHERE id = ?`,
      [googleId, avatarUrl, usersByEmail[0].id],
    )

    const [linkedUsers] = await db.execute(
      `SELECT ${userSelectFields} FROM users WHERE id = ? LIMIT 1`,
      [usersByEmail[0].id],
    )

    return linkedUsers[0]
  }

  const passwordHash = await hashPassword(`google:${googleId}:${randomUUID()}`)
  const [result] = await db.execute(
    `INSERT INTO users (name, email, password, google_id, avatar_url)
    VALUES (?, ?, ?, ?, ?)`,
    [name, email, passwordHash, googleId, avatarUrl],
  )
  const [createdUsers] = await db.execute(
    `SELECT ${userSelectFields} FROM users WHERE id = ? LIMIT 1`,
    [result.insertId],
  )

  return createdUsers[0]
}

authRouter.get('/auth/google', (req, res) => {
  if (!isGoogleAuthConfigured()) {
    return redirectToGoogleCallback(res, {
      error: 'Google todavia no esta configurado en el servidor.',
    })
  }

  const state = signPayload({
    nonce: randomUUID(),
    exp: Date.now() + 1000 * 60 * 10,
  })
  const url = new URL(googleAuthUrl)

  url.searchParams.set('client_id', googleClientId)
  url.searchParams.set('redirect_uri', googleRedirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  url.searchParams.set('prompt', 'select_account')

  return res.redirect(url.toString())
})

authRouter.get('/auth/google/callback', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  if (!isGoogleAuthConfigured()) {
    return redirectToGoogleCallback(res, {
      error: 'Google todavia no esta configurado en el servidor.',
    })
  }

  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  const googleError = typeof req.query.error === 'string' ? req.query.error : ''

  if (googleError) {
    return redirectToGoogleCallback(res, {
      error: 'No se pudo iniciar sesion con Google.',
    })
  }

  if (!code || !verifySignedPayload(state)) {
    return redirectToGoogleCallback(res, {
      error: 'La sesion de Google expiro. Intentalo de nuevo.',
    })
  }

  try {
    const tokenData = await exchangeGoogleCode(code)
    const profile = await loadGoogleProfile(tokenData.access_token)
    const user = await findOrCreateGoogleUser(profile)

    return redirectToGoogleCallback(res, {
      session: encodeFrontendSession({
        user: toUser(user),
        token: createSessionToken(user),
      }),
    })
  } catch (error) {
    console.error('Error iniciando sesion con Google:', error)
    return redirectToGoogleCallback(res, {
      error: error.message || 'No se pudo iniciar sesion con Google.',
    })
  }
})

authRouter.post('/users', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  const name = typeof req.body.name === 'string' ? req.body.name.trim() : ''
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const password = typeof req.body.password === 'string' ? req.body.password : ''

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Usuario, email y contraseña son obligatorios.' })
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: 'Ingresa un email valido.' })
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres.' })
  }

  try {
    const passwordHash = await hashPassword(password)
    const [result] = await db.execute(
      'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
      [name, email, passwordHash],
    )
    const [users] = await db.execute(
      `SELECT ${userSelectFields} FROM users WHERE id = ?`,
      [result.insertId],
    )

    return res.status(201).json({
      user: toUser(users[0]),
      token: createSessionToken(users[0]),
    })
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
      return res.status(409).json({ message: 'Ya existe un usuario con ese email.' })
    }

    console.error('Error creando usuario:', error)
    return res.status(500).json({ message: 'No se pudo crear el usuario.' })
  }
})

authRouter.post('/login', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  const identifier = typeof req.body.identifier === 'string' ? req.body.identifier.trim().toLowerCase() : ''
  const password = typeof req.body.password === 'string' ? req.body.password : ''

  if (!identifier || !password) {
    return res.status(400).json({ message: 'Usuario/email y contraseña son obligatorios.' })
  }

  try {
    const [users] = await db.execute(
      `SELECT ${userSelectFields}, password FROM users WHERE LOWER(email) = ? OR LOWER(name) = ? LIMIT 1`,
      [identifier, identifier],
    )
    const user = users[0]

    if (!user || !(await verifyPassword(password, user.password))) {
      return res.status(401).json({ message: 'Usuario o contraseña incorrectos.' })
    }

    return res.json({
      user: toUser(user),
      token: createSessionToken(user),
    })
  } catch (error) {
    console.error('Error iniciando sesion:', error)
    return res.status(500).json({ message: 'No se pudo iniciar sesion.' })
  }
})

authRouter.get('/me', requireAuth, async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  try {
    const [users] = await db.execute(
      `SELECT ${userSelectFields} FROM users WHERE id = ? LIMIT 1`,
      [req.userId],
    )

    if (!users.length) {
      return res.status(404).json({ message: 'El usuario no existe.' })
    }

    return res.json({ user: toUser(users[0]) })
  } catch (error) {
    console.error('Error cargando perfil:', error)
    return res.status(500).json({ message: 'No se pudo cargar el perfil.' })
  }
})

authRouter.patch('/users/me', requireAuth, async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  try {
    const avatarUrl = normalizeAvatarValue(req.body.avatarUrl ?? req.body.avatar_url)
    const contactPhone = trimOptionalText(req.body.contactPhone ?? req.body.contact_phone, 40)
    const workHours = trimOptionalText(req.body.workHours ?? req.body.work_hours, 160)
    const profileDescription = trimOptionalText(
      req.body.profileDescription ?? req.body.profile_description,
      500,
    )

    await db.execute(
      `UPDATE users
      SET avatar_url = ?,
        contact_phone = ?,
        work_hours = ?,
        profile_description = ?
      WHERE id = ?`,
      [avatarUrl, contactPhone, workHours, profileDescription, req.userId],
    )

    const [users] = await db.execute(
      `SELECT ${userSelectFields} FROM users WHERE id = ? LIMIT 1`,
      [req.userId],
    )

    if (!users.length) {
      return res.status(404).json({ message: 'El usuario no existe.' })
    }

    return res.json({ user: toUser(users[0]) })
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ message: error.message })
    }

    console.error('Error actualizando perfil:', error)
    return res.status(500).json({ message: 'No se pudo actualizar el perfil.' })
  }
})
