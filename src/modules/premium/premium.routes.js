import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { premiumDemoEnabled } from '../../config/env.js'
import { db, ensureDb } from '../../database/connection.js'
import { requireAuth } from '../../middleware/requireAuth.js'

export const premiumRouter = Router()

const premiumSelectSql = `
  SELECT
    id,
    premium_status,
    premium_plan,
    premium_started_at,
    premium_expires_at,
    CASE
      WHEN premium_status = 'active'
        AND (premium_expires_at IS NULL OR premium_expires_at > NOW())
      THEN 1
      ELSE 0
    END AS is_premium
  FROM users
  WHERE id = ?
  LIMIT 1
`

const getPremiumStatus = (row) => {
  const premiumStatus = row?.premium_status || 'free'

  if (premiumStatus === 'active' && !Number(row?.is_premium || 0)) {
    return 'expired'
  }

  return premiumStatus
}

const toPremium = (row) => ({
  isActive: Boolean(Number(row?.is_premium || 0)),
  is_active: Boolean(Number(row?.is_premium || 0)),
  status: getPremiumStatus(row),
  plan: row?.premium_plan || null,
  startedAt: row?.premium_started_at || null,
  started_at: row?.premium_started_at || null,
  expiresAt: row?.premium_expires_at || null,
  expires_at: row?.premium_expires_at || null,
  demoEnabled: premiumDemoEnabled,
  demo_enabled: premiumDemoEnabled,
})

const toPremiumUserPatch = (row) => ({
  isPremium: Boolean(Number(row?.is_premium || 0)),
  is_premium: Boolean(Number(row?.is_premium || 0)),
  premiumStatus: getPremiumStatus(row),
  premium_status: getPremiumStatus(row),
  premiumPlan: row?.premium_plan || null,
  premium_plan: row?.premium_plan || null,
  premiumStartedAt: row?.premium_started_at || null,
  premium_started_at: row?.premium_started_at || null,
  premiumExpiresAt: row?.premium_expires_at || null,
  premium_expires_at: row?.premium_expires_at || null,
})

const loadPremium = async (userId) => {
  const [rows] = await db.execute(premiumSelectSql, [userId])

  return rows[0] || null
}

premiumRouter.use(requireAuth)

premiumRouter.get('/me', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  try {
    const premium = await loadPremium(req.userId)

    if (!premium) {
      return res.status(404).json({ message: 'El usuario no existe.' })
    }

    return res.json({
      premium: toPremium(premium),
      user: toPremiumUserPatch(premium),
    })
  } catch (error) {
    console.error('Error cargando Premium:', error)
    return res.status(500).json({ message: 'No se pudo cargar Premium.' })
  }
})

premiumRouter.post('/demo/activate', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  if (!premiumDemoEnabled) {
    return res.status(403).json({ message: 'La activacion demo de Premium no esta habilitada.' })
  }

  try {
    await db.execute(
      `UPDATE users
      SET premium_status = 'active',
        premium_plan = 'premium_monthly',
        premium_started_at = COALESCE(premium_started_at, NOW()),
        premium_expires_at = DATE_ADD(NOW(), INTERVAL 30 DAY)
      WHERE id = ?`,
      [req.userId],
    )

    await db.execute(
      `INSERT INTO premiumSubscriptions (
        user_id,
        plan_code,
        status,
        provider,
        provider_subscription_id,
        current_period_start,
        current_period_end
      )
      VALUES (?, 'premium_monthly', 'active', 'demo', ?, NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY))`,
      [req.userId, `demo-${req.userId}-${randomUUID()}`],
    )

    const premium = await loadPremium(req.userId)

    return res.json({
      premium: toPremium(premium),
      user: toPremiumUserPatch(premium),
    })
  } catch (error) {
    console.error('Error activando Premium demo:', error)
    return res.status(500).json({ message: 'No se pudo activar Premium.' })
  }
})

premiumRouter.post('/demo/cancel', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  if (!premiumDemoEnabled) {
    return res.status(403).json({ message: 'La baja demo de Premium no esta habilitada.' })
  }

  try {
    await db.execute(
      `UPDATE users
      SET premium_status = 'canceled',
        premium_expires_at = NOW()
      WHERE id = ?`,
      [req.userId],
    )

    await db.execute(
      `UPDATE premiumSubscriptions
      SET status = 'canceled',
        current_period_end = NOW()
      WHERE user_id = ?
        AND provider = 'demo'
        AND status = 'active'`,
      [req.userId],
    )

    const premium = await loadPremium(req.userId)

    return res.json({
      premium: toPremium(premium),
      user: toPremiumUserPatch(premium),
    })
  } catch (error) {
    console.error('Error cancelando Premium demo:', error)
    return res.status(500).json({ message: 'No se pudo cancelar Premium.' })
  }
})
