import { Router } from 'express'
import {
  bugReportNotificationEmail,
  resendApiKey,
  resetEmailFrom,
} from '../../config/env.js'
import { db, ensureDb } from '../../database/connection.js'
import { requireAuth } from '../../middleware/requireAuth.js'
import { getValidatedAuthenticatedUserId } from '../auth/session.js'

export const bugReportsRouter = Router()
const resendEmailUrl = 'https://api.resend.com/emails'
const bugReportWindowMs = 1000 * 60 * 60
const bugReportLimit = 5
const bugReportRequests = new Map()

const isBugReportRateLimited = (req) => {
  const now = Date.now()
  const key = req.ip || 'unknown'
  const recentRequests = (bugReportRequests.get(key) || [])
    .filter((timestamp) => now - timestamp < bugReportWindowMs)

  if (recentRequests.length >= bugReportLimit) {
    bugReportRequests.set(key, recentRequests)
    return true
  }

  recentRequests.push(now)
  bugReportRequests.set(key, recentRequests)
  return false
}

const trimOptionalText = (value, maxLength) => {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maxLength) : null
}

const normalizeEmail = (value) => {
  const email = trimOptionalText(value, 150)?.toLowerCase() || null

  if (!email) {
    return null
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error('Ingresá un email válido o dejá el campo vacío.')

    error.statusCode = 400
    throw error
  }

  return email
}

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;')

const sendBugReportNotification = async ({
  bugReport,
  contactEmail,
  description,
  pageUrl,
  userAgent,
}) => {
  if (!resendApiKey || !resetEmailFrom || !bugReportNotificationEmail) {
    console.warn('Notificación de bugs desactivada: faltan variables de email.')
    return false
  }

  const contactLabel = contactEmail || 'No informado'
  const pageLabel = pageUrl || 'No informada'
  const userAgentLabel = userAgent || 'No informado'
  const response = await fetch(resendEmailUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: resetEmailFrom,
      to: [bugReportNotificationEmail],
      subject: `Nuevo reporte de bug en Handys #${bugReport.id}`,
      text: `Nuevo reporte de bug #${bugReport.id}

Descripción:
${description}

Email de contacto: ${contactLabel}
Página: ${pageLabel}
Navegador: ${userAgentLabel}
Fecha: ${bugReport.created_at}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#19352d">
          <h1 style="font-size:22px">Nuevo reporte de bug #${bugReport.id}</h1>
          <div style="margin:20px 0;padding:16px;background:#f3f7f5;border-radius:10px;white-space:pre-wrap">${escapeHtml(description)}</div>
          <p><strong>Email de contacto:</strong> ${escapeHtml(contactLabel)}</p>
          <p><strong>Página:</strong> ${escapeHtml(pageLabel)}</p>
          <p><strong>Navegador:</strong> ${escapeHtml(userAgentLabel)}</p>
          <p><strong>Fecha:</strong> ${escapeHtml(bugReport.created_at)}</p>
        </div>
      `,
    }),
    signal: AbortSignal.timeout(8000),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Resend respondio ${response.status}: ${errorBody}`)
  }

  return true
}

bugReportsRouter.get('/me', requireAuth, async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  try {
    const [rows] = await db.execute(
      `SELECT id, description, status, created_at, updated_at
      FROM bugReports
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 50`,
      [req.userId],
    )

    return res.json({
      bugReports: rows.map((row) => ({
        id: row.id,
        description: row.description,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    })
  } catch (error) {
    console.error('Error cargando reportes del usuario:', error)
    return res.status(500).json({ message: 'No se pudieron cargar tus reportes.' })
  }
})

bugReportsRouter.post('/', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  if (isBugReportRateLimited(req)) {
    return res.status(429).json({
      message: 'Alcanzaste el límite de reportes. Intentá nuevamente más tarde.',
    })
  }

  try {
    const authenticatedUserId = await getValidatedAuthenticatedUserId(req)
    const description = trimOptionalText(req.body.description, 1200)
    const contactEmail = normalizeEmail(req.body.contactEmail)
    const pageUrl = trimOptionalText(req.body.pageUrl, 500)
    const userAgent = trimOptionalText(req.headers['user-agent'], 500)

    if (!description || description.length < 10) {
      return res.status(400).json({ message: 'Contame un poco más sobre el problema.' })
    }

    let userId = null

    if (authenticatedUserId) {
      const [users] = await db.execute(
        'SELECT id FROM users WHERE id = ? LIMIT 1',
        [authenticatedUserId],
      )

      userId = users[0]?.id || null
    }

    const [result] = await db.execute(
      `INSERT INTO bugReports (user_id, contact_email, description, page_url, user_agent)
      VALUES (?, ?, ?, ?, ?)`,
      [userId, contactEmail, description, pageUrl, userAgent],
    )
    const [rows] = await db.execute(
      `SELECT id, status, created_at
      FROM bugReports
      WHERE id = ?
      LIMIT 1`,
      [result.insertId],
    )
    const bugReport = rows[0]
    let notificationSent = false

    try {
      notificationSent = await sendBugReportNotification({
        bugReport,
        contactEmail,
        description,
        pageUrl,
        userAgent,
      })
    } catch (notificationError) {
      console.error('Error enviando notificación de bug:', notificationError)
    }

    return res.status(201).json({
      bugReport: {
        id: bugReport.id,
        status: bugReport.status,
        createdAt: bugReport.created_at,
      },
      notificationSent,
    })
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ message: error.message })
    }

    console.error('Error guardando reporte de bug:', error)
    return res.status(500).json({ message: 'No se pudo guardar el reporte.' })
  }
})
