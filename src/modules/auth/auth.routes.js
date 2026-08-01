import { Router } from 'express'
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import {
  frontendUrl,
  googleClientId,
  googleClientSecret,
  googleRedirectUri,
  resendApiKey,
  resetEmailFrom,
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
  email_verified_at,
  google_id,
  avatar_url,
  contact_phone,
  work_hours,
  profile_description,
  session_version,
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
  emailVerified: Boolean(user.email_verified_at),
  email_verified: Boolean(user.email_verified_at),
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
    throw badRequest('La imagen es demasiado pesada. Usá una imagen de hasta 2 MB.')
  }

  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) {
    return trimmed
  }

  if (imageDataUrlPattern.test(trimmed)) {
    return trimmed
  }

  throw badRequest('La foto debe ser una imagen válida.')
}

const googleAuthUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
const googleTokenUrl = 'https://oauth2.googleapis.com/token'
const googleUserInfoUrl = 'https://openidconnect.googleapis.com/v1/userinfo'
const resendEmailUrl = 'https://api.resend.com/emails'
const passwordResetLifetimeMs = 1000 * 60 * 20
const emailVerificationLifetimeMs = 1000 * 60 * 60 * 24
const passwordResetRequestWindowMs = 1000 * 60 * 60
const passwordResetRequestLimit = 5
const emailVerificationCooldownMs = 1000 * 60
const passwordResetRequests = new Map()
const emailVerificationRequests = new Map()

const getPrimaryFrontendUrl = () => frontendUrl
  .split(',')
  .map((url) => url.trim())
  .find(Boolean)
  ?.replace(/\/$/, '') || 'http://localhost:3000'

const hashResetToken = (token) => createHash('sha256').update(token).digest('hex')

const isEmailActionRateLimited = (requestStore, req, email, minimumIntervalMs = 0) => {
  const now = Date.now()
  const key = `${req.ip || 'unknown'}:${email}`
  const recentRequests = (requestStore.get(key) || [])
    .filter((timestamp) => now - timestamp < passwordResetRequestWindowMs)
  const lastRequestAt = recentRequests.at(-1) || 0

  requestStore.set(key, recentRequests)

  if (
    recentRequests.length >= passwordResetRequestLimit
    || (lastRequestAt && now - lastRequestAt < minimumIntervalMs)
  ) {
    return true
  }

  recentRequests.push(now)
  return false
}

const isPasswordResetRateLimited = (req, email) => (
  isEmailActionRateLimited(passwordResetRequests, req, email)
)

const isEmailVerificationRateLimited = (req, email) => (
  isEmailActionRateLimited(
    emailVerificationRequests,
    req,
    email,
    emailVerificationCooldownMs,
  )
)

const sendPasswordResetEmail = async (email, resetUrl) => {
  const response = await fetch(resendEmailUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: resetEmailFrom,
      to: [email],
      subject: 'Recuperá tu contraseña de Handys',
      text: `Recibimos un pedido para cambiar tu contraseña de Handys.\n\nCrea una nueva contraseña desde este enlace:\n${resetUrl}\n\nEl enlace vence en 20 minutos. Si no fuiste vos, ignora este mensaje.`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#19352d">
          <h1 style="font-size:24px">Recuperá tu contraseña</h1>
          <p>Recibimos un pedido para cambiar tu contraseña de Handys.</p>
          <p style="margin:28px 0">
            <a href="${resetUrl}" style="background:#198754;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700">
              Crear nueva contraseña
            </a>
          </p>
          <p>El enlace vence en 20 minutos. Si no fuiste vos, ignora este mensaje.</p>
        </div>
      `,
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Resend respondio ${response.status}: ${errorBody}`)
  }
}

const sendEmailVerification = async (email, verificationUrl) => {
  const response = await fetch(resendEmailUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: resetEmailFrom,
      to: [email],
      subject: 'Verificá tu email en Handys',
      text: `Confirmá tu email para activar tu cuenta de Handys:\n${verificationUrl}\n\nEl enlace vence en 24 horas. Si no creaste esta cuenta, ignorá este mensaje.`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#19352d">
          <h1 style="font-size:24px">Verificá tu email</h1>
          <p>Confirmá tu dirección de email para activar tu cuenta de Handys.</p>
          <p style="margin:28px 0">
            <a href="${verificationUrl}" style="background:#198754;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700">
              Verificar email
            </a>
          </p>
          <p>El enlace vence en 24 horas. Si no creaste esta cuenta, ignorá este mensaje.</p>
        </div>
      `,
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Resend respondio ${response.status}: ${errorBody}`)
  }
}

const createAndSendEmailVerification = async (user) => {
  const token = randomBytes(32).toString('base64url')
  const tokenHash = hashResetToken(token)
  const expiresAt = new Date(Date.now() + emailVerificationLifetimeMs)
  const verificationUrl = new URL('/verify-email', getPrimaryFrontendUrl())

  verificationUrl.searchParams.set('token', token)

  await db.execute(
    'UPDATE emailVerificationTokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
    [user.id],
  )
  await db.execute(
    `INSERT INTO emailVerificationTokens (user_id, token_hash, expires_at)
    VALUES (?, ?, ?)`,
    [user.id, tokenHash, expiresAt],
  )

  try {
    await sendEmailVerification(user.email, verificationUrl.toString())
  } catch (error) {
    await db.execute(
      'UPDATE emailVerificationTokens SET used_at = NOW() WHERE token_hash = ?',
      [tokenHash],
    )
    throw error
  }
}

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

const getFrontendCallbackUrl = () => `${getPrimaryFrontendUrl()}/auth/google/callback`

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
    if (usersByGoogleId[0].email_verified_at) {
      return usersByGoogleId[0]
    }

    await db.execute(
      'UPDATE users SET email_verified_at = NOW() WHERE id = ?',
      [usersByGoogleId[0].id],
    )
    const [verifiedUsers] = await db.execute(
      `SELECT ${userSelectFields} FROM users WHERE id = ? LIMIT 1`,
      [usersByGoogleId[0].id],
    )

    return verifiedUsers[0]
  }

  const [usersByEmail] = await db.execute(
    `SELECT ${userSelectFields} FROM users WHERE LOWER(email) = ? LIMIT 1`,
    [email],
  )

  if (usersByEmail.length) {
    await db.execute(
      `UPDATE users
      SET google_id = COALESCE(google_id, ?),
        avatar_url = COALESCE(avatar_url, ?),
        email_verified_at = COALESCE(email_verified_at, NOW())
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
    `INSERT INTO users (name, email, email_verified_at, password, google_id, avatar_url)
    VALUES (?, ?, NOW(), ?, ?, ?)`,
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
      error: 'Google todavía no está configurado en el servidor.',
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
      error: 'Google todavía no está configurado en el servidor.',
    })
  }

  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  const googleError = typeof req.query.error === 'string' ? req.query.error : ''

  if (googleError) {
    return redirectToGoogleCallback(res, {
      error: 'No se pudo iniciar sesión con Google.',
    })
  }

  if (!code || !verifySignedPayload(state)) {
    return redirectToGoogleCallback(res, {
      error: 'La sesión de Google expiró. Intentá de nuevo.',
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
    console.error('Error iniciando sesión con Google:', error)
    return redirectToGoogleCallback(res, {
      error: error.message || 'No se pudo iniciar sesión con Google.',
    })
  }
})

authRouter.post('/users', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  if (!resendApiKey || !resetEmailFrom) {
    return res.status(503).json({
      message: 'La verificación de email todavía no está configurada.',
    })
  }

  const name = typeof req.body.name === 'string' ? req.body.name.trim() : ''
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const password = typeof req.body.password === 'string' ? req.body.password : ''

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Nombre, email y contraseña son obligatorios.' })
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: 'Ingresá un email válido.' })
  }

  if (name.length > 100) {
    return res.status(400).json({ message: 'El nombre es demasiado largo.' })
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres.' })
  }

  if (password.length > 128) {
    return res.status(400).json({ message: 'La contraseña es demasiado larga.' })
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
    let emailSent = true

    try {
      await createAndSendEmailVerification(users[0])
    } catch (emailError) {
      emailSent = false
      console.error('Error enviando verificación de email:', emailError)
    }

    return res.status(201).json({
      emailVerificationRequired: true,
      emailSent,
      message: emailSent
        ? 'Te enviamos un enlace para verificar tu email.'
        : 'La cuenta fue creada, pero no pudimos enviar el correo. Usá la opción de reenviar verificación.',
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

  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const password = typeof req.body.password === 'string' ? req.body.password : ''

  if (!email || !password) {
    return res.status(400).json({ message: 'Email y contraseña son obligatorios.' })
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: 'Ingresá un email válido.' })
  }

  try {
    const [users] = await db.execute(
      `SELECT ${userSelectFields}, password FROM users WHERE LOWER(email) = ? LIMIT 1`,
      [email],
    )
    const user = users[0]

    if (!user || !(await verifyPassword(password, user.password))) {
      return res.status(401).json({ message: 'Email o contraseña incorrectos.' })
    }

    if (!user.email_verified_at) {
      return res.status(403).json({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Verificá tu email antes de iniciar sesión.',
      })
    }

    return res.json({
      user: toUser(user),
      token: createSessionToken(user),
    })
  } catch (error) {
    console.error('Error iniciando sesión:', error)
    return res.status(500).json({ message: 'No se pudo iniciar sesión.' })
  }
})

authRouter.post('/auth/resend-verification', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  if (!resendApiKey || !resetEmailFrom) {
    return res.status(503).json({
      message: 'La verificación de email todavía no está configurada.',
    })
  }

  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const genericMessage = 'Si la cuenta existe y falta verificarla, te enviamos un nuevo enlace.'

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: 'Ingresá un email válido.' })
  }

  if (isEmailVerificationRateLimited(req, email)) {
    return res.status(429).json({
      message: 'Esperá al menos un minuto antes de reenviar el email.',
    })
  }

  try {
    const [users] = await db.execute(
      `SELECT id, email
      FROM users
      WHERE LOWER(email) = ?
        AND email_verified_at IS NULL
      LIMIT 1`,
      [email],
    )

    if (users[0]) {
      try {
        await createAndSendEmailVerification(users[0])
      } catch (emailError) {
        console.error('Error reenviando verificación de email:', emailError)
      }
    }

    return res.json({ message: genericMessage })
  } catch (error) {
    console.error('Error solicitando reenvío de verificación:', error)
    return res.status(500).json({ message: 'No se pudo procesar la solicitud.' })
  }
})

authRouter.post('/auth/verify-email', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  const token = typeof req.body.token === 'string' ? req.body.token.trim() : ''

  if (!token) {
    return res.status(400).json({ message: 'El enlace de verificación no es válido.' })
  }

  const connection = await db.getConnection()

  try {
    await connection.beginTransaction()

    const tokenHash = hashResetToken(token)
    const [tokens] = await connection.execute(
      `SELECT id, user_id
      FROM emailVerificationTokens
      WHERE token_hash = ?
        AND used_at IS NULL
        AND expires_at > NOW()
      LIMIT 1
      FOR UPDATE`,
      [tokenHash],
    )
    const verificationToken = tokens[0]

    if (!verificationToken) {
      await connection.rollback()
      return res.status(400).json({
        message: 'El enlace es inválido o venció. Solicitá uno nuevo.',
      })
    }

    await connection.execute(
      'UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = ?',
      [verificationToken.user_id],
    )
    await connection.execute(
      'UPDATE emailVerificationTokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
      [verificationToken.user_id],
    )
    await connection.commit()

    return res.json({ message: 'Email verificado. Ya podés iniciar sesión.' })
  } catch (error) {
    await connection.rollback()
    console.error('Error verificando email:', error)
    return res.status(500).json({ message: 'No se pudo verificar el email.' })
  } finally {
    connection.release()
  }
})

authRouter.post('/auth/forgot-password', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  if (!resendApiKey || !resetEmailFrom) {
    return res.status(503).json({
      message: 'La recuperación de contraseña todavía no está configurada.',
    })
  }

  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const genericMessage = 'Si existe una cuenta con ese email, te enviamos un enlace para recuperar tu contraseña.'

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: 'Ingresá un email válido.' })
  }

  if (isPasswordResetRateLimited(req, email)) {
    return res.status(429).json({ message: 'Esperá unos minutos antes de volver a intentarlo.' })
  }

  try {
    const [users] = await db.execute(
      'SELECT id, email FROM users WHERE LOWER(email) = ? LIMIT 1',
      [email],
    )
    const user = users[0]

    if (user) {
      const token = randomBytes(32).toString('base64url')
      const tokenHash = hashResetToken(token)
      const expiresAt = new Date(Date.now() + passwordResetLifetimeMs)
      const resetUrl = new URL('/reset-password', getPrimaryFrontendUrl())

      resetUrl.searchParams.set('token', token)

      await db.execute(
        'UPDATE passwordResetTokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
        [user.id],
      )
      await db.execute(
        `INSERT INTO passwordResetTokens (user_id, token_hash, expires_at)
        VALUES (?, ?, ?)`,
        [user.id, tokenHash, expiresAt],
      )

      try {
        await sendPasswordResetEmail(user.email, resetUrl.toString())
      } catch (emailError) {
        await db.execute(
          'UPDATE passwordResetTokens SET used_at = NOW() WHERE token_hash = ?',
          [tokenHash],
        )
        console.error('Error enviando recuperación de contraseña:', emailError)
      }
    }

    return res.json({ message: genericMessage })
  } catch (error) {
    console.error('Error solicitando recuperación de contraseña:', error)
    return res.status(500).json({ message: 'No se pudo procesar la solicitud.' })
  }
})

authRouter.post('/auth/reset-password', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  const token = typeof req.body.token === 'string' ? req.body.token.trim() : ''
  const password = typeof req.body.password === 'string' ? req.body.password : ''

  if (!token || !password) {
    return res.status(400).json({ message: 'El enlace y la nueva contraseña son obligatorios.' })
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres.' })
  }

  if (password.length > 128) {
    return res.status(400).json({ message: 'La contraseña es demasiado larga.' })
  }

  const connection = await db.getConnection()

  try {
    await connection.beginTransaction()

    const tokenHash = hashResetToken(token)
    const [tokens] = await connection.execute(
      `SELECT id, user_id
      FROM passwordResetTokens
      WHERE token_hash = ?
        AND used_at IS NULL
        AND expires_at > NOW()
      LIMIT 1
      FOR UPDATE`,
      [tokenHash],
    )
    const resetToken = tokens[0]

    if (!resetToken) {
      await connection.rollback()
      return res.status(400).json({
        message: 'El enlace es inválido o venció. Solicitá uno nuevo.',
      })
    }

    const passwordHash = await hashPassword(password)

    await connection.execute(
      'UPDATE users SET password = ?, session_version = session_version + 1 WHERE id = ?',
      [passwordHash, resetToken.user_id],
    )
    await connection.execute(
      'UPDATE passwordResetTokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
      [resetToken.user_id],
    )
    await connection.commit()

    return res.json({ message: 'Contraseña actualizada. Ya podés iniciar sesión.' })
  } catch (error) {
    await connection.rollback()
    console.error('Error restableciendo contraseña:', error)
    return res.status(500).json({ message: 'No se pudo actualizar la contraseña.' })
  } finally {
    connection.release()
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
