import { Router } from 'express'
import { db, ensureDb } from '../../database/connection.js'
import { getValidatedAuthenticatedUserId } from '../auth/session.js'

export const bugReportsRouter = Router()

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
    const error = new Error('Ingresa un email valido o deja el campo vacio.')

    error.statusCode = 400
    throw error
  }

  return email
}

bugReportsRouter.post('/', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  try {
    const authenticatedUserId = await getValidatedAuthenticatedUserId(req)
    const description = trimOptionalText(req.body.description, 1200)
    const contactEmail = normalizeEmail(req.body.contactEmail)
    const pageUrl = trimOptionalText(req.body.pageUrl, 500)
    const userAgent = trimOptionalText(req.headers['user-agent'], 500)

    if (!description || description.length < 10) {
      return res.status(400).json({ message: 'Contame un poco mas sobre el problema.' })
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

    return res.status(201).json({
      bugReport: {
        id: bugReport.id,
        status: bugReport.status,
        createdAt: bugReport.created_at,
      },
    })
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ message: error.message })
    }

    console.error('Error guardando reporte de bug:', error)
    return res.status(500).json({ message: 'No se pudo guardar el reporte.' })
  }
})
